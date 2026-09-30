import { Buffer } from "node:buffer";
import { z } from "zod";
import type { MediaRecognitionProfile } from "@myceliasdk/media.ts";
import {
  type MediaEventUnderstanding,
  zMediaEventUnderstanding,
} from "@myceliasdk/media-events.ts";
import { env } from "#/env.ts";
import {
  fetchGoogleWithPolicy,
  getGoogleAccessToken,
  sanitizeGoogleError,
} from "@/lib/gcp/auth.server.ts";
import { googleVertexModelUrl } from "@/lib/media/google-contract.ts";

const GOOGLE_EVENT_INPUT_PER_MILLION_TOKENS_USD = 0.33;
const GOOGLE_EVENT_OUTPUT_PER_MILLION_TOKENS_USD = 2.75;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const GOOGLE_AUTH_TIMEOUT_MS = 30_000;
export const MEDIA_EVENT_PROVIDER_FETCH_TIMEOUT_MS = 120_000;
export const MEDIA_EVENT_PROMPT_VERSION = "media-event-v1";
export const MEDIA_EVENT_PRIVACY_VERSION = "preview-only-no-identity-v1";

export type MediaEventProviderPreview = {
  ref: string;
  bytes: Uint8Array;
  mimeType: "image/webp";
  width: number;
  height: number;
  offsetSeconds: number;
};

export type AnalyzeMediaEventInput = {
  profile: MediaRecognitionProfile;
  requestId: string;
  previews: MediaEventProviderPreview[];
  totalAssetCount: number;
  durationSeconds: number;
};

export type PreparedMediaEventProviderCall =
  | { providerType: "google-cloud"; accessToken: string }
  | { providerType: "self-hosted" };

export type MediaEventProviderCallBoundary = {
  prepared: PreparedMediaEventProviderCall;
  assertPermission: () => Promise<void>;
};

export type NormalizedMediaEventAnalysis = {
  understanding: MediaEventUnderstanding;
  provenance: {
    providerType: MediaRecognitionProfile["providerType"];
    providerProfileId: string;
    service: string;
    location: string;
    modelVersion?: string;
    responseId?: string;
    processedAt: string;
    promptVersion: string;
    privacyVersion: string;
  };
  usage: {
    service: "google-cloud" | "self-hosted";
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    grossListPriceUsd: number;
  };
};

const zNormalizedMediaEventAnalysis = z.object({
  understanding: zMediaEventUnderstanding,
  provenance: z.object({
    providerType: z.enum(["google-cloud", "self-hosted"]),
    providerProfileId: z.string().trim().min(1).max(240),
    service: z.string().trim().min(1).max(240),
    location: z.string().trim().min(1).max(240),
    modelVersion: z.string().trim().min(1).max(240).optional(),
    responseId: z.string().trim().min(1).max(512).optional(),
    processedAt: z.string().datetime(),
    promptVersion: z.string().trim().min(1).max(120),
    privacyVersion: z.string().trim().min(1).max(120),
  }).strict(),
  usage: z.object({
    service: z.enum(["google-cloud", "self-hosted"]),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    grossListPriceUsd: z.number().nonnegative().max(10),
  }).strict(),
}).strict();

export function validateNormalizedMediaEventAnalysis(
  value: unknown,
): NormalizedMediaEventAnalysis {
  return zNormalizedMediaEventAnalysis.parse(value);
}

const EVENT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: [
    "schemaVersion",
    "title",
    "eventType",
    "description",
    "temporalLabel",
    "place",
    "participants",
    "keyActions",
    "highlights",
    "keywords",
    "confidence",
    "warnings",
  ],
  properties: {
    schemaVersion: {
      type: "STRING",
      enum: ["mycelia.media-event-output.v1"],
    },
    title: { type: "STRING" },
    eventType: {
      type: "STRING",
      enum: [
        "trip",
        "meeting",
        "walk",
        "concert",
        "work_session",
        "meal",
        "celebration",
        "sports",
        "nature",
        "other",
        "unknown",
      ],
    },
    description: { type: "STRING" },
    temporalLabel: { type: "STRING" },
    place: {
      type: "OBJECT",
      required: ["kind", "visualSummary", "confidence", "evidenceRefs"],
      properties: {
        kind: {
          type: "STRING",
          enum: [
            "home",
            "office",
            "street",
            "park",
            "venue",
            "restaurant",
            "transport",
            "nature",
            "other",
            "unknown",
          ],
        },
        visualSummary: { type: "STRING" },
        confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
        evidenceRefs: { type: "ARRAY", items: { type: "STRING" } },
      },
    },
    participants: {
      type: "OBJECT",
      required: ["visiblePeopleRange", "groups"],
      properties: {
        visiblePeopleRange: {
          type: "OBJECT",
          required: ["min", "max"],
          properties: {
            min: { type: "INTEGER", minimum: 0 },
            max: { type: "INTEGER", minimum: 0 },
          },
        },
        groups: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            required: [
              "role",
              "visibleCountRange",
              "evidenceRefs",
              "confidence",
            ],
            properties: {
              role: {
                type: "STRING",
                enum: [
                  "participants",
                  "audience",
                  "performers",
                  "speakers",
                  "staff",
                  "bystanders",
                  "unknown",
                ],
              },
              visibleCountRange: {
                type: "OBJECT",
                required: ["min", "max"],
                properties: {
                  min: { type: "INTEGER", minimum: 0 },
                  max: { type: "INTEGER", minimum: 0 },
                },
              },
              evidenceRefs: { type: "ARRAY", items: { type: "STRING" } },
              confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
    keyActions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["text", "evidenceRefs", "confidence"],
        properties: {
          text: { type: "STRING" },
          evidenceRefs: { type: "ARRAY", items: { type: "STRING" } },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
        },
      },
    },
    highlights: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["ref", "rank", "reason", "confidence"],
        properties: {
          ref: { type: "STRING" },
          rank: { type: "INTEGER", minimum: 1 },
          reason: { type: "STRING" },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
        },
      },
    },
    keywords: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
} as const;

function manifest(input: AnalyzeMediaEventInput) {
  return {
    schemaVersion: "mycelia.media-event-input.v1",
    requestId: input.requestId,
    locale: "ru",
    durationSeconds: input.durationSeconds,
    selection: {
      method: "temporal-diversity-v1",
      totalAssetCount: input.totalAssetCount,
      analyzedAssetCount: input.previews.length,
    },
    items: input.previews.map((preview) => ({
      ref: preview.ref,
      offsetSeconds: preview.offsetSeconds,
      width: preview.width,
      height: preview.height,
    })),
    privacy: {
      originalsIncluded: false,
      identityResolution: "forbidden",
      sensitiveAttributeInference: "forbidden",
      exactLocationIncluded: false,
      transcriptTextIncluded: false,
      objectDataIncluded: false,
    },
  } as const;
}

function prompt(input: AnalyzeMediaEventInput): string {
  return [
    "Проанализируй группу очищенных превью как одно событие личной памяти Mycelia.",
    "Все текстовые поля верни по-русски. Состав группы, период и координаты определяет сервер; не изменяй их.",
    "Запрещено устанавливать личности, сопоставлять лица между кадрами, угадывать имена, возраст, пол, этничность, здоровье, религию, политику, сексуальность или другие чувствительные признаки.",
    "Участников описывай только функциональными ролями и диапазоном одновременно видимых людей. Не утверждай число уникальных людей между кадрами.",
    "evidenceRefs и highlight.ref могут содержать только refs из manifest. Если данных недостаточно, используй unknown, низкий confidence и warnings.",
    JSON.stringify(manifest(input)),
  ].join("\n");
}

async function readLimitedText(
  response: Response,
  maximumBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("Media event provider response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("Media event provider response is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function candidateText(response: any): string {
  return (response?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim();
}

export function validateMediaEventUnderstanding(
  value: unknown,
  allowedRefs: string[],
): MediaEventUnderstanding {
  const result = zMediaEventUnderstanding.parse(value);
  const allowed = new Set(allowedRefs);
  const evidence = [
    ...result.place.evidenceRefs,
    ...result.participants.groups.flatMap((group) => group.evidenceRefs),
    ...result.keyActions.flatMap((action) => action.evidenceRefs),
    ...result.highlights.map((highlight) => highlight.ref),
  ];
  if (evidence.some((ref) => !allowed.has(ref))) {
    throw new Error("Media event response contains an unknown evidence ref");
  }
  const ranks = result.highlights.map((highlight) => highlight.rank);
  if (new Set(ranks).size !== ranks.length) {
    throw new Error("Media event highlight ranks must be unique");
  }
  if (
    result.participants.visiblePeopleRange.min >
      result.participants.visiblePeopleRange.max ||
    result.participants.groups.some((group) =>
      group.visibleCountRange.min > group.visibleCountRange.max
    )
  ) {
    throw new Error("Media event people ranges are invalid");
  }
  return result;
}

export function buildGoogleMediaEventRequest(input: AnalyzeMediaEventInput) {
  return {
    contents: [{
      role: "user",
      parts: [
        { text: prompt(input) },
        ...input.previews.flatMap((preview) => [
          { text: `Превью ${preview.ref}` },
          {
            inlineData: {
              mimeType: preview.mimeType,
              data: Buffer.from(preview.bytes).toString("base64"),
            },
          },
        ]),
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1_800,
      responseMimeType: "application/json",
      responseSchema: EVENT_RESPONSE_SCHEMA,
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Resolves provider authentication before a deletion-blocking call permit is
 * acquired. The returned credential is ephemeral and must never be persisted.
 */
export async function prepareMediaEventProviderCall(
  profile: MediaRecognitionProfile,
): Promise<PreparedMediaEventProviderCall> {
  if (profile.providerType === "openai-compatible") {
    throw new Error(
      "General vision profiles analyze individual photos; event analysis requires a compatible event connector",
    );
  }
  if (profile.providerType === "self-hosted") {
    return { providerType: "self-hosted" };
  }
  return {
    providerType: "google-cloud",
    accessToken: await withTimeout(
      getGoogleAccessToken(),
      GOOGLE_AUTH_TIMEOUT_MS,
      "Google ADC token preparation timed out before the provider boundary",
    ),
  };
}

async function analyzeGoogle(
  input: AnalyzeMediaEventInput & {
    profile: Extract<MediaRecognitionProfile, { providerType: "google-cloud" }>;
  },
  boundary: MediaEventProviderCallBoundary & {
    prepared: Extract<
      PreparedMediaEventProviderCall,
      { providerType: "google-cloud" }
    >;
  },
): Promise<NormalizedMediaEventAnalysis> {
  await boundary.assertPermission();
  const response = await fetchGoogleWithPolicy(
    googleVertexModelUrl(
      input.profile.projectId,
      input.profile.vertexModel,
      "generateContent",
    ),
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${boundary.prepared.accessToken}`,
        "Content-Type": "application/json",
        "x-goog-user-project": input.profile.projectId,
      },
      body: JSON.stringify(buildGoogleMediaEventRequest(input)),
      signal: AbortSignal.timeout(MEDIA_EVENT_PROVIDER_FETCH_TIMEOUT_MS),
    },
  );
  const text = await readLimitedText(response);
  if (!response.ok) {
    throw new Error(
      `Google ${response.status}: ${sanitizeGoogleError(text).slice(0, 400)}`,
    );
  }
  const responseBody = text ? JSON.parse(text) : {};
  const raw = candidateText(responseBody);
  if (!raw) throw new Error("Vertex media event response is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Vertex media event response was not valid JSON");
  }
  const understanding = validateMediaEventUnderstanding(
    parsed,
    input.previews.map((preview) => preview.ref),
  );
  const usage = responseBody?.usageMetadata ?? {};
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  const reasoningTokens = Number(usage.thoughtsTokenCount ?? 0);
  return validateNormalizedMediaEventAnalysis({
    understanding,
    provenance: {
      providerType: "google-cloud",
      providerProfileId: input.profile.id,
      service: "vertex-ai-media-event-understanding",
      location: input.profile.location,
      modelVersion: String(
        responseBody?.modelVersion ?? input.profile.vertexModel,
      ),
      ...(responseBody?.responseId
        ? { responseId: String(responseBody.responseId) }
        : {}),
      processedAt: String(
        responseBody?.createTime ?? new Date().toISOString(),
      ),
      promptVersion: MEDIA_EVENT_PROMPT_VERSION,
      privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
    },
    usage: {
      service: "google-cloud",
      inputTokens,
      outputTokens,
      reasoningTokens,
      grossListPriceUsd: Math.max(0, inputTokens) / 1_000_000 *
          GOOGLE_EVENT_INPUT_PER_MILLION_TOKENS_USD +
        Math.max(0, outputTokens + reasoningTokens) / 1_000_000 *
          GOOGLE_EVENT_OUTPUT_PER_MILLION_TOKENS_USD,
    },
  });
}

async function analyzeSelfHosted(
  input: AnalyzeMediaEventInput & {
    profile: Extract<MediaRecognitionProfile, { providerType: "self-hosted" }>;
  },
  boundary: MediaEventProviderCallBoundary & {
    prepared: Extract<
      PreparedMediaEventProviderCall,
      { providerType: "self-hosted" }
    >;
  },
): Promise<NormalizedMediaEventAnalysis> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (env.MEDIA_SELF_HOSTED_API_KEY) {
    headers.set("Authorization", `Bearer ${env.MEDIA_SELF_HOSTED_API_KEY}`);
  }
  await boundary.assertPermission();
  const response = await fetch(
    `${input.profile.baseUrl.replace(/\/$/, "")}/v1/media/events/analyze`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        manifest: manifest(input),
        previews: input.previews.map((preview) => ({
          ref: preview.ref,
          mimeType: preview.mimeType,
          data: Buffer.from(preview.bytes).toString("base64"),
        })),
      }),
      signal: AbortSignal.timeout(MEDIA_EVENT_PROVIDER_FETCH_TIMEOUT_MS),
    },
  );
  const text = await readLimitedText(response);
  if (!response.ok) {
    throw new Error(
      `Self-hosted media event provider returned ${response.status}`,
    );
  }
  const body = text ? JSON.parse(text) : {};
  const understanding = validateMediaEventUnderstanding(
    body?.understanding ?? body,
    input.previews.map((preview) => preview.ref),
  );
  return validateNormalizedMediaEventAnalysis({
    understanding,
    provenance: {
      providerType: "self-hosted",
      providerProfileId: input.profile.id,
      service: typeof body?.provider?.service === "string"
        ? body.provider.service
        : "self-hosted-media-event-understanding",
      location: "self-hosted",
      ...(typeof body?.provider?.modelVersion === "string"
        ? { modelVersion: body.provider.modelVersion }
        : {}),
      processedAt: typeof body?.provider?.processedAt === "string"
        ? body.provider.processedAt
        : new Date().toISOString(),
      promptVersion: MEDIA_EVENT_PROMPT_VERSION,
      privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
    },
    usage: {
      service: "self-hosted",
      inputTokens: Number(body?.usage?.inputTokens ?? 0),
      outputTokens: Number(body?.usage?.outputTokens ?? 0),
      reasoningTokens: Number(body?.usage?.reasoningTokens ?? 0),
      grossListPriceUsd: 0,
    },
  });
}

export async function analyzeWithMediaEventProvider(
  input: AnalyzeMediaEventInput,
  boundary: MediaEventProviderCallBoundary,
): Promise<NormalizedMediaEventAnalysis> {
  if (input.previews.length < 2 || input.previews.length > 12) {
    throw new Error("Media event analysis requires between 2 and 12 previews");
  }
  const totalBytes = input.previews.reduce(
    (sum, preview) => sum + preview.bytes.byteLength,
    0,
  );
  if (totalBytes > 6_000_000) {
    throw new Error("Media event previews exceed the 6 MB provider limit");
  }
  if (boundary.prepared.providerType !== input.profile.providerType) {
    throw new Error("Media event provider preflight no longer matches profile");
  }
  if (
    input.profile.providerType === "google-cloud" &&
    boundary.prepared.providerType === "google-cloud"
  ) {
    return await analyzeGoogle(
      { ...input, profile: input.profile },
      { ...boundary, prepared: boundary.prepared },
    );
  }
  if (
    input.profile.providerType === "self-hosted" &&
    boundary.prepared.providerType === "self-hosted"
  ) {
    return await analyzeSelfHosted(
      { ...input, profile: input.profile },
      { ...boundary, prepared: boundary.prepared },
    );
  }
  throw new Error("Media event provider preflight type is invalid");
}
