import { Buffer } from "node:buffer";
import type {
  MediaRecognitionProfile,
  MediaRecognitionTask,
  MediaVisualUnderstanding,
} from "@myceliasdk/media.ts";
import { zMediaVisualUnderstanding } from "@myceliasdk/media.ts";
import { env } from "#/env.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { assertGoogleAccess } from "@myceliasdk/google-policy.ts";
import {
  analyzeGeneralPhoto,
  resolvePhotoConnection,
} from "./general-provider.ts";
import {
  fetchGoogleWithPolicy,
  getGoogleAccessToken,
  sanitizeGoogleError,
} from "@/lib/gcp/auth.server.ts";
import {
  googleDocumentAiProcessUrl,
  googleMediaLocationSummary,
  googleMediaServiceSummary,
  googleVertexEmbeddingUrl,
  googleVertexModelUrl,
  googleVisionEuAnnotateUrl,
} from "./google-contract.ts";

export type NormalizedMediaPage = {
  pageNumber: number;
  text: string;
  width?: number;
  height?: number;
  blocks: Array<{
    text?: string;
    confidence?: number;
    boundingBox?: Array<{ x?: number; y?: number }>;
  }>;
  languages: string[];
};

export type NormalizedMediaAnnotation = {
  type: "label" | "object";
  label: string;
  confidence?: number;
  boundingBox?: Array<{ x?: number; y?: number }>;
  dataBoundary: "eu" | "global_opt_in" | "self_hosted";
};

export type NormalizedMediaAnalysis = {
  pages: NormalizedMediaPage[];
  annotations: NormalizedMediaAnnotation[];
  visualUnderstanding?: MediaVisualUnderstanding;
  searchText?: string;
  embedding?: {
    model: string;
    dimensions: number;
    values: number[];
    tokenCount?: number;
  };
  provenance: {
    providerType: MediaRecognitionProfile["providerType"];
    providerProfileId: string;
    service: string;
    location: string;
    modelVersion?: string;
    responseId?: string;
    processedAt: string;
    promptVersion?: string;
    schemaVersion?: string;
  };
  usage: {
    service:
      | "google-cloud"
      | "vision"
      | "document-ai"
      | "self-hosted"
      | "openai-compatible";
    ocrUnits: number;
    labelUnits: number;
    objectUnits: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    embeddingTokens: number;
    grossListPriceUsd: number | null;
  };
};

export type MediaQueryEmbedding = {
  model: string;
  dimensions: number;
  values: number[];
  tokenCount?: number;
  grossListPriceUsd: number;
};

export type AnalyzeInput = {
  beforeDispatch?: () => Promise<void>;
  profile: MediaRecognitionProfile;
  bytes: Uint8Array;
  mimeType: string;
  pageCount: number;
  requestedTasks: MediaRecognitionTask[];
  requestId: string;
};

const GOOGLE_VISUAL_INPUT_PER_MILLION_TOKENS_USD = 0.33;
const GOOGLE_VISUAL_OUTPUT_PER_MILLION_TOKENS_USD = 2.75;
const GOOGLE_EMBEDDING_PER_THOUSAND_TOKENS_USD = 0.00015;

const VISUAL_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: [
    "shortCaption",
    "description",
    "scene",
    "objects",
    "activities",
    "peopleCount",
    "keywords",
    "possibleEvent",
    "confidence",
    "warnings",
  ],
  properties: {
    shortCaption: { type: "STRING" },
    description: { type: "STRING" },
    scene: {
      type: "OBJECT",
      required: [
        "summary",
        "environment",
        "placeType",
        "timeOfDay",
        "confidence",
      ],
      properties: {
        summary: { type: "STRING" },
        environment: {
          type: "STRING",
          enum: ["indoor", "outdoor", "mixed", "unknown"],
        },
        placeType: { type: "STRING" },
        timeOfDay: {
          type: "STRING",
          enum: ["day", "night", "dawn_dusk", "unknown"],
        },
        confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
      },
    },
    objects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["name", "attributes", "confidence"],
        properties: {
          name: { type: "STRING" },
          count: { type: "INTEGER", minimum: 1 },
          attributes: { type: "ARRAY", items: { type: "STRING" } },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
        },
      },
    },
    activities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["description", "confidence"],
        properties: {
          description: { type: "STRING" },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
        },
      },
    },
    peopleCount: { type: "INTEGER", minimum: 0 },
    keywords: { type: "ARRAY", items: { type: "STRING" } },
    possibleEvent: { type: "STRING" },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
} as const;

export function buildVisualSearchText(
  visual: MediaVisualUnderstanding,
): string {
  return [
    visual.shortCaption,
    visual.description,
    visual.scene.summary,
    visual.scene.placeType,
    ...visual.objects.flatMap((item) => [item.name, ...item.attributes]),
    ...visual.activities.map((item) => item.description),
    ...visual.keywords,
    visual.possibleEvent ?? "",
  ].filter(Boolean).join("\n");
}

function vertices(value: any): Array<{ x?: number; y?: number }> | undefined {
  const points = value?.normalizedVertices ?? value?.vertices;
  if (!Array.isArray(points)) return undefined;
  return points.map((point) => ({
    ...(Number.isFinite(point?.x) ? { x: Number(point.x) } : {}),
    ...(Number.isFinite(point?.y) ? { y: Number(point.y) } : {}),
  }));
}

function textFromVisionBlock(block: any): string {
  return (block?.paragraphs ?? []).flatMap((paragraph: any) =>
    paragraph?.words ?? []
  ).map((word: any) =>
    (word?.symbols ?? []).map((symbol: any) => symbol?.text ?? "").join("")
  ).join(" ");
}

function normalizeVisionPages(response: any): NormalizedMediaPage[] {
  const annotation = response?.responses?.[0]?.fullTextAnnotation;
  if (!annotation) {
    return [{ pageNumber: 1, text: "", blocks: [], languages: [] }];
  }
  const pages = Array.isArray(annotation.pages) ? annotation.pages : [];
  if (pages.length === 0) {
    return [{
      pageNumber: 1,
      text: annotation.text ?? "",
      blocks: [],
      languages: [],
    }];
  }
  return pages.map((page: any, index: number) => ({
    pageNumber: index + 1,
    text: index === 0 ? String(annotation.text ?? "") : "",
    width: Number(page?.width) || undefined,
    height: Number(page?.height) || undefined,
    blocks: (page?.blocks ?? []).map((block: any) => ({
      text: textFromVisionBlock(block),
      confidence: Number.isFinite(block?.confidence)
        ? Number(block.confidence)
        : undefined,
      boundingBox: vertices(block?.boundingBox),
    })),
    languages: [
      ...new Set(
        (page?.property?.detectedLanguages ?? []).map((item: any) =>
          String(item?.languageCode ?? "")
        ).filter(Boolean),
      ),
    ] as string[],
  }));
}

function normalizeVisionAnnotations(
  response: any,
): NormalizedMediaAnnotation[] {
  const first = response?.responses?.[0] ?? {};
  return [
    ...(first.labelAnnotations ?? []).map((item: any) => ({
      type: "label" as const,
      label: String(item?.description ?? ""),
      confidence: Number.isFinite(item?.score) ? Number(item.score) : undefined,
      dataBoundary: "global_opt_in" as const,
    })),
    ...(first.localizedObjectAnnotations ?? []).map((item: any) => ({
      type: "object" as const,
      label: String(item?.name ?? ""),
      confidence: Number.isFinite(item?.score) ? Number(item.score) : undefined,
      boundingBox: vertices(item?.boundingPoly),
      dataBoundary: "global_opt_in" as const,
    })),
  ].filter((item) => item.label);
}

function anchorText(documentText: string, anchor: any): string {
  return (anchor?.textSegments ?? []).map((segment: any) => {
    const start = Number(segment?.startIndex ?? 0);
    const end = Number(segment?.endIndex ?? start);
    return documentText.slice(start, end);
  }).join("");
}

function normalizeDocumentAi(response: any): NormalizedMediaPage[] {
  const document = response?.document ?? {};
  const documentText = String(document?.text ?? "");
  return (document?.pages ?? []).map((page: any, index: number) => ({
    pageNumber: Number(page?.pageNumber) || index + 1,
    text: anchorText(documentText, page?.layout?.textAnchor),
    width: Number(page?.dimension?.width) || undefined,
    height: Number(page?.dimension?.height) || undefined,
    blocks: (page?.blocks ?? []).map((block: any) => ({
      text: anchorText(documentText, block?.layout?.textAnchor),
      confidence: Number.isFinite(block?.layout?.confidence)
        ? Number(block.layout.confidence)
        : undefined,
      boundingBox: vertices(block?.layout?.boundingPoly),
    })),
    languages: [
      ...new Set(
        (page?.detectedLanguages ?? []).map((item: any) =>
          String(item?.languageCode ?? "")
        ).filter(Boolean),
      ),
    ] as string[],
  }));
}

async function googleRequest(url: string, projectId: string, body: unknown) {
  assertGoogleAccess(await getServerConfig(), {
    baseUrl: url,
    providerType: "google-cloud",
  });
  const token = await getGoogleAccessToken();
  const response = await fetchGoogleWithPolicy(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-goog-user-project": projectId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Google ${response.status}: ${sanitizeGoogleError(text).slice(0, 400)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

function candidateText(response: any): string {
  return (response?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim();
}

async function embedGoogleText(
  profile: Extract<MediaRecognitionProfile, { providerType: "google-cloud" }>,
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<MediaQueryEmbedding> {
  const response = await googleRequest(
    googleVertexEmbeddingUrl(
      profile.projectId,
      profile.embeddingModel,
      profile.embeddingLocation,
    ),
    profile.projectId,
    {
      instances: [{ content: text, task_type: taskType }],
      parameters: { autoTruncate: false, outputDimensionality: 768 },
    },
  );
  const embedding = response?.predictions?.[0]?.embeddings;
  const values = Array.isArray(embedding?.values)
    ? embedding.values.map(Number).filter(Number.isFinite)
    : [];
  if (values.length === 0) {
    throw new Error("Vertex embedding response did not contain a vector");
  }
  const tokenCount = Number(
    embedding?.statistics?.token_count ??
      embedding?.statistics?.tokenCount ?? 0,
  );
  return {
    model: profile.embeddingModel,
    dimensions: values.length,
    values,
    ...(Number.isFinite(tokenCount) && tokenCount > 0 ? { tokenCount } : {}),
    grossListPriceUsd: Math.max(0, tokenCount) / 1_000 *
      GOOGLE_EMBEDDING_PER_THOUSAND_TOKENS_USD,
  };
}

async function analyzeGoogleVisual(
  input: AnalyzeInput & {
    profile: Extract<MediaRecognitionProfile, { providerType: "google-cloud" }>;
  },
): Promise<{
  visual: MediaVisualUnderstanding;
  searchText: string;
  embedding: MediaQueryEmbedding;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    embeddingTokens: number;
    grossListPriceUsd: number;
  };
  provenance: {
    modelVersion: string;
    responseId?: string;
    processedAt: string;
  };
}> {
  const response = await googleRequest(
    googleVertexModelUrl(
      input.profile.projectId,
      input.profile.vertexModel,
      "generateContent",
    ),
    input.profile.projectId,
    {
      contents: [{
        role: "user",
        parts: [
          {
            text: "Проанализируй изображение для личной фототеки Mycelia. " +
              "Все текстовые поля верни на русском языке. Описывай только " +
              "то, что визуально наблюдаемо; неопределённость отражай через " +
              "confidence и warnings. Не устанавливай личности людей, не " +
              "угадывай имена, этничность, здоровье, религию, политику, " +
              "сексуальность или другие чувствительные признаки. peopleCount " +
              "— только видимое приблизительное число людей. possibleEvent " +
              "оставь пустой строкой, если событие нельзя обоснованно описать.",
          },
          {
            inlineData: {
              mimeType: input.mimeType,
              data: Buffer.from(input.bytes).toString("base64"),
            },
          },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1_600,
        responseMimeType: "application/json",
        responseSchema: VISUAL_RESPONSE_SCHEMA,
      },
    },
  );
  const raw = candidateText(response);
  if (!raw) {
    const reason = response?.candidates?.[0]?.finishReason ?? "empty response";
    throw new Error(`Vertex visual response is empty (${String(reason)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Vertex visual response was not valid JSON");
  }
  if (
    parsed && typeof parsed === "object" &&
    (parsed as any).possibleEvent === ""
  ) {
    (parsed as any).possibleEvent = null;
  }
  const visual = zMediaVisualUnderstanding.parse(parsed);
  const searchText = buildVisualSearchText(visual);
  const embedding = await embedGoogleText(
    input.profile,
    searchText,
    "RETRIEVAL_DOCUMENT",
  );
  const usage = response?.usageMetadata ?? {};
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  const reasoningTokens = Number(usage.thoughtsTokenCount ?? 0);
  const generationCost = Math.max(0, inputTokens) / 1_000_000 *
      GOOGLE_VISUAL_INPUT_PER_MILLION_TOKENS_USD +
    Math.max(0, outputTokens + reasoningTokens) / 1_000_000 *
      GOOGLE_VISUAL_OUTPUT_PER_MILLION_TOKENS_USD;
  return {
    visual,
    searchText,
    embedding,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      embeddingTokens: embedding.tokenCount ?? 0,
      grossListPriceUsd: generationCost + embedding.grossListPriceUsd,
    },
    provenance: {
      modelVersion: String(response?.modelVersion ?? input.profile.vertexModel),
      ...(response?.responseId
        ? { responseId: String(response.responseId) }
        : {}),
      processedAt: String(response?.createTime ?? new Date().toISOString()),
    },
  };
}

async function analyzeGoogle(
  input: AnalyzeInput & {
    profile: Extract<MediaRecognitionProfile, { providerType: "google-cloud" }>;
  },
): Promise<NormalizedMediaAnalysis> {
  const content = Buffer.from(input.bytes).toString("base64");
  if (input.mimeType === "application/pdf") {
    if (input.requestedTasks.some((task) => task !== "ocr")) {
      throw new Error("PDF recognition currently supports only the OCR task");
    }
    if (!input.profile.documentAiProcessorId) {
      throw new Error("Document AI processor ID is required for PDF OCR");
    }
    const url = googleDocumentAiProcessUrl(input.profile);
    const response = await googleRequest(url, input.profile.projectId, {
      rawDocument: { content, mimeType: input.mimeType },
    });
    return {
      pages: normalizeDocumentAi(response),
      annotations: [],
      provenance: {
        providerType: "google-cloud",
        providerProfileId: input.profile.id,
        service: "document-ai-enterprise-ocr",
        location: "eu",
        modelVersion: input.profile.documentAiProcessorVersion,
        processedAt: new Date().toISOString(),
      },
      usage: {
        service: "document-ai",
        ocrUnits: input.pageCount,
        labelUnits: 0,
        objectUnits: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        embeddingTokens: 0,
        grossListPriceUsd: input.pageCount * 0.0015,
      },
    };
  }

  const wantsVisual = input.requestedTasks.includes("visual-understanding");
  const wantsOcr = input.requestedTasks.includes("ocr");
  const wantsLabels = input.requestedTasks.includes("labels");
  const wantsObjects = input.requestedTasks.includes("objects");
  let pages: NormalizedMediaPage[] = [];
  const visualResult = wantsVisual ? await analyzeGoogleVisual(input) : null;
  if (wantsOcr) {
    const euUrl = googleVisionEuAnnotateUrl(input.profile.projectId);
    const ocrResponse = await googleRequest(euUrl, input.profile.projectId, {
      requests: [{
        image: { content },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
      }],
    });
    const apiError = ocrResponse?.responses?.[0]?.error;
    if (apiError) {
      throw new Error(
        `Vision OCR: ${sanitizeGoogleError(JSON.stringify(apiError))}`,
      );
    }
    pages = normalizeVisionPages(ocrResponse);
  }

  let annotations: NormalizedMediaAnnotation[] = [];
  if (wantsLabels || wantsObjects) {
    if (!input.profile.allowGlobalPhotoAnalysis) {
      throw new Error("Global photo analysis is disabled for this profile");
    }
    const globalResponse = await googleRequest(
      "https://vision.googleapis.com/v1/images:annotate",
      input.profile.projectId,
      {
        requests: [{
          image: { content },
          features: [
            ...(wantsLabels
              ? [{ type: "LABEL_DETECTION", maxResults: 20 }]
              : []),
            ...(wantsObjects
              ? [{ type: "OBJECT_LOCALIZATION", maxResults: 20 }]
              : []),
          ],
        }],
      },
    );
    const globalError = globalResponse?.responses?.[0]?.error;
    if (globalError) {
      throw new Error(
        `Vision global analysis: ${
          sanitizeGoogleError(JSON.stringify(globalError))
        }`,
      );
    }
    annotations = normalizeVisionAnnotations(globalResponse);
  }

  return {
    pages,
    annotations,
    ...(visualResult
      ? {
        visualUnderstanding: visualResult.visual,
        searchText: visualResult.searchText,
        embedding: {
          model: visualResult.embedding.model,
          dimensions: visualResult.embedding.dimensions,
          values: visualResult.embedding.values,
          tokenCount: visualResult.embedding.tokenCount,
        },
      }
      : {}),
    provenance: {
      providerType: "google-cloud",
      providerProfileId: input.profile.id,
      service: googleMediaServiceSummary(input.requestedTasks),
      location: googleMediaLocationSummary(
        input.profile,
        input.requestedTasks,
      ),
      ...(visualResult?.provenance.modelVersion
        ? { modelVersion: visualResult.provenance.modelVersion }
        : {}),
      ...(visualResult?.provenance.responseId
        ? { responseId: visualResult.provenance.responseId }
        : {}),
      processedAt: visualResult?.provenance.processedAt ??
        new Date().toISOString(),
    },
    usage: {
      service: wantsVisual ? "google-cloud" : "vision",
      ocrUnits: wantsOcr ? 1 : 0,
      labelUnits: wantsLabels ? 1 : 0,
      objectUnits: wantsObjects ? 1 : 0,
      inputTokens: visualResult?.usage.inputTokens ?? 0,
      outputTokens: visualResult?.usage.outputTokens ?? 0,
      reasoningTokens: visualResult?.usage.reasoningTokens ?? 0,
      embeddingTokens: visualResult?.usage.embeddingTokens ?? 0,
      grossListPriceUsd: (wantsOcr ? 0.0015 : 0) +
        (wantsLabels ? 0.0015 : 0) + (wantsObjects ? 0.00225 : 0) +
        (visualResult?.usage.grossListPriceUsd ?? 0),
    },
  };
}

async function analyzeSelfHosted(
  input: AnalyzeInput & {
    profile: Extract<MediaRecognitionProfile, { providerType: "self-hosted" }>;
  },
): Promise<NormalizedMediaAnalysis> {
  const form = new FormData();
  const fileBytes = input.bytes.slice().buffer as ArrayBuffer;
  form.set(
    "file",
    new Blob([fileBytes], { type: input.mimeType }),
    input.mimeType === "application/pdf" ? "document.pdf" : "image",
  );
  form.set("request_id", input.requestId);
  form.set(
    "features",
    JSON.stringify(input.requestedTasks),
  );
  const headers = new Headers();
  if (env.MEDIA_SELF_HOSTED_API_KEY) {
    headers.set("Authorization", `Bearer ${env.MEDIA_SELF_HOSTED_API_KEY}`);
  }
  const response = await fetch(
    `${input.profile.baseUrl.replace(/\/$/, "")}/v1/media/analyze`,
    {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(120_000),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Self-hosted media provider ${response.status}: ${text.slice(0, 400)}`,
    );
  }
  const result = JSON.parse(text);
  let visualUnderstanding: MediaVisualUnderstanding | undefined;
  if (result?.visualUnderstanding) {
    if (result.visualUnderstanding.possibleEvent === "") {
      result.visualUnderstanding.possibleEvent = null;
    }
    visualUnderstanding = zMediaVisualUnderstanding.parse(
      result.visualUnderstanding,
    );
  }
  const embeddingValues = Array.isArray(result?.embedding?.values)
    ? result.embedding.values.map(Number).filter(Number.isFinite)
    : [];
  if (
    input.requestedTasks.includes("visual-understanding") &&
    (!visualUnderstanding || embeddingValues.length === 0)
  ) {
    throw new Error(
      "Self-hosted visual provider must return visualUnderstanding and embedding",
    );
  }
  return {
    pages: Array.isArray(result.pages) ? result.pages : [],
    annotations: (Array.isArray(result.annotations) ? result.annotations : [])
      .map((item: any) => ({ ...item, dataBoundary: "self_hosted" })),
    ...(visualUnderstanding
      ? {
        visualUnderstanding,
        searchText: String(
          result?.searchText ?? buildVisualSearchText(visualUnderstanding),
        ),
      }
      : {}),
    ...(embeddingValues.length > 0
      ? {
        embedding: {
          model: String(result?.embedding?.model ?? "self-hosted"),
          dimensions: embeddingValues.length,
          values: embeddingValues,
          tokenCount: Number(result?.embedding?.tokenCount) || undefined,
        },
      }
      : {}),
    provenance: {
      providerType: "self-hosted",
      providerProfileId: input.profile.id,
      service: String(result?.provider?.service ?? "self-hosted-media"),
      location: "self-hosted",
      modelVersion: result?.provider?.modelVersion,
      processedAt: String(
        result?.provider?.processedAt ?? new Date().toISOString(),
      ),
    },
    usage: {
      service: "self-hosted",
      ocrUnits: input.requestedTasks.includes("ocr") ? input.pageCount : 0,
      labelUnits: input.requestedTasks.includes("labels") ? 1 : 0,
      objectUnits: input.requestedTasks.includes("objects") ? 1 : 0,
      inputTokens: Number(result?.usage?.inputTokens ?? 0),
      outputTokens: Number(result?.usage?.outputTokens ?? 0),
      reasoningTokens: Number(result?.usage?.reasoningTokens ?? 0),
      embeddingTokens: Number(result?.usage?.embeddingTokens ?? 0),
      grossListPriceUsd: 0,
    },
  };
}

async function embedSelfHostedQuery(
  profile: Extract<MediaRecognitionProfile, { providerType: "self-hosted" }>,
  query: string,
): Promise<MediaQueryEmbedding> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (env.MEDIA_SELF_HOSTED_API_KEY) {
    headers.set("Authorization", `Bearer ${env.MEDIA_SELF_HOSTED_API_KEY}`);
  }
  const response = await fetch(
    `${profile.baseUrl.replace(/\/$/, "")}/v1/media/embed`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: query, purpose: "query" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Self-hosted embedding provider ${response.status}: ${
        text.slice(0, 400)
      }`,
    );
  }
  const result = JSON.parse(text);
  const values = Array.isArray(result?.values)
    ? result.values.map(Number).filter(Number.isFinite)
    : [];
  if (values.length === 0) {
    throw new Error("Self-hosted embedding response did not contain a vector");
  }
  return {
    model: String(result?.model ?? "self-hosted"),
    dimensions: values.length,
    values,
    tokenCount: Number(result?.tokenCount) || undefined,
    grossListPriceUsd: 0,
  };
}

export async function embedMediaQuery(
  profile: MediaRecognitionProfile,
  query: string,
): Promise<MediaQueryEmbedding> {
  if (profile.providerType === "openai-compatible") {
    throw new Error(
      "This photo provider uses local text search; embeddings are not configured",
    );
  }
  return profile.providerType === "google-cloud"
    ? await embedGoogleText(profile, query, "RETRIEVAL_QUERY")
    : await embedSelfHostedQuery(profile, query);
}

export async function analyzeWithMediaProvider(
  input: AnalyzeInput,
): Promise<NormalizedMediaAnalysis> {
  if (input.profile.providerType === "openai-compatible") {
    const profile = input.profile;
    const connection = resolvePhotoConnection(await getServerConfig(), profile);
    return await analyzeGeneralPhoto(input, connection, {
      beforeDispatch: async () => {
        await input.beforeDispatch?.();
        Object.assign(
          connection,
          resolvePhotoConnection(await getServerConfig(), profile),
        );
      },
    });
  }
  return input.profile.providerType === "google-cloud"
    ? await analyzeGoogle({ ...input, profile: input.profile })
    : await analyzeSelfHosted({ ...input, profile: input.profile });
}

export async function testSelfHostedProfile(
  profile: Extract<MediaRecognitionProfile, { providerType: "self-hosted" }>,
) {
  const headers = new Headers();
  if (env.MEDIA_SELF_HOSTED_API_KEY) {
    headers.set("Authorization", `Bearer ${env.MEDIA_SELF_HOSTED_API_KEY}`);
  }
  const started = performance.now();
  const response = await fetch(
    `${profile.baseUrl.replace(/\/$/, "")}/v1/capabilities`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) {
    throw new Error(`Self-hosted provider returned ${response.status}`);
  }
  const result = await response.json();
  if (
    !Array.isArray((result as any)?.features) ||
    !(result as any).features.includes("visual-understanding")
  ) {
    throw new Error(
      "Self-hosted provider does not advertise visual-understanding",
    );
  }
  const embedding = await embedSelfHostedQuery(
    profile,
    "Mycelia semantic connector test",
  );
  return {
    ok: true,
    latencyMs: Math.round(performance.now() - started),
    result,
    embedding: { model: embedding.model, dimensions: embedding.dimensions },
  };
}
