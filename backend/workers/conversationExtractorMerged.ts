import { z } from "zod";
import { ObjectId } from "bson";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import { callResource } from "@myceliasdk/resources.ts";
import { zDateOrString, zObjectId } from "@myceliasdk/zod-json-schema.ts";
import { createHash } from "node:crypto";
import {
  getInferenceProvenance,
  type InferenceProvenance,
  summarizeInferenceUsage,
} from "@/lib/llm/provenance.ts";
import { createPromptCacheSessionId } from "@/lib/llm/prompt-cache-session.ts";
import { getTriggerTiming } from "@/lib/jobs/trigger-config.ts";
import {
  assertCompletionNotTruncated,
  LLM_TRUNCATED_RESPONSE_CODE,
} from "@/lib/llm/completion-response.ts";
import { hasIndexedPendingWork } from "@/lib/jobs/pending-work.ts";
import {
  buildJsonSchemaResponseFormat,
  extractJsonFromText,
  resolveWorkerFallbackModel,
} from "@/lib/llm/worker-response.ts";
import {
  bisectPromptWindow,
  buildTagListPrompt,
  type ConversationChunk,
  type ConversationError,
  createEntityRelationships,
  createSegmentParser,
  createTagRelationships,
  DEFAULT_EXTRACTION_MAX_PROMPT_CHARS,
  deleteConversationsForChunk,
  ENTITY_TYPES,
  type EntityType,
  type ExtractedEntity,
  type ExtractionTag,
  formatChunkAsPrompt,
  getExtractionRetryDelayMs,
  normalizeEmoji,
  partitionTranscriptionsForPrompt,
  transcriptionToUtterances,
  type Utterance,
} from "@/lib/extraction/shared.ts";

/**
 * Merged Conversation Extractor — the PRIMARY extraction worker.
 *
 * One LLM call per size-bounded extraction window instead of 1 segmentation
 * call + 1 metadata call per segment: the model segments each window AND
 * returns per-segment metadata (emoji, agreement, typed entities, tags) in a
 * single structured response. Normal chunks remain one call; oversized
 * legacy chunks are partitioned before inference.
 *
 * The legacy two-call `conversation_extractor` is DEPRECATED (paused by
 * migration 0029, kept for rollback). Both claim the same ready chunks
 * atomically, so never run both at once — the Jobs page warns when both are
 * enabled. Every run records detailed per-segment diagnostics in the job
 * result for review on the job details page.
 */

const MERGED_EXTRACTOR_VERSION = "merged-v2-windowed";
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ADAPTIVE_SPLITS_PER_CHUNK = 8;

// ============================================================================
// Schema
// ============================================================================

const DEFAULT_MERGED_PROMPT =
  `You segment one transcript into distinct conversations and extract metadata for each conversation in a single pass.

Return JSON: {"segments": [...]} where every segment has:
- title: a short descriptive title for the conversation.
- start, end: the EXACT full text of the first and last phrase of the conversation, copied verbatim from the transcript (used to locate the boundaries).
- emoji: exactly one emoji that best represents the main subject.
- agreed_upon_something: true only when the speakers made a concrete agreement, commitment, or decision.
- entities: deduplicated named things explicitly mentioned in this conversation, each as {"name": string, "type": string}. type is exactly one of "person", "place", "organization", "product", "project", "event", "animal", "concept", "media", "other". Use concise canonical names. Do not include pronouns, unnamed people, generic common nouns, or conversation topics. Return [] when none qualify.

Return {"segments": []} when the transcript contains no usable conversation.
Do not summarize and do not add fields outside the schema.`;

export const schema = z.object({
  type: z.literal("conversation_extractor_merged"),
  chunkId: zObjectId().optional(),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  limit: z.number().default(1),
  model: z.string().default("medium")
    .describe(
      "Model alias or exact model resolved from current extraction settings when this extraction job is dispatched",
    ),
  force: z.boolean().default(false)
    .describe(
      "Replace existing artifacts for the explicitly selected chunkId; force requires chunkId",
    ),
  fallbackModel: z.string().optional()
    .describe(
      "Optional model retried once after a primary LLM error; leave empty to use the provider route's configured fallback",
    ),
  providerProfileId: z.string().optional()
    .describe(
      "Pin the LLM call to one provider profile (no cross-provider failover)",
    ),
  retryNow: z.boolean().default(false)
    .describe(
      "Manual recovery: retry errored chunks immediately instead of waiting for backoff",
    ),
  maxTokens: z.number().int().min(256).max(32768).default(8192)
    .describe(
      "Output-token cap for each composite window call; a truncated response fails loudly with LLM_TRUNCATED_RESPONSE",
    ),
  maxPromptChars: z.number().int().min(4_000).max(200_000)
    .default(DEFAULT_EXTRACTION_MAX_PROMPT_CHARS)
    .describe(
      "Maximum transcript characters sent in one extraction call; larger chunks are partitioned at source/transcription/utterance boundaries",
    ),
  reasoning: z.enum(["off", "default", "on"]).default("off")
    .describe(
      "Reasoning/thinking mode for the LLM call; recorded in provenance for later analysis",
    ),
  merged_system_prompt: z.string().default(DEFAULT_MERGED_PROMPT)
    .describe(
      "System prompt for the single segmentation+metadata call. The tag list is appended automatically.",
    ),
}).superRefine((value, ctx) => {
  if (value.force && !value.chunkId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "force requires an explicit chunkId",
      path: ["chunkId"],
    });
  }
});

export type MergedExtractorJobData = z.infer<typeof schema>;

export function buildConversationChunkClaimQuery(
  input: Partial<
    Pick<MergedExtractorJobData, "start" | "end" | "retryNow">
  > = {},
  now = new Date(),
): Record<string, unknown> {
  const query: Record<string, any> = {
    $or: [
      { state: "ready" },
      ...(input.retryNow ? [{ state: "error" }] : [
        { state: "error", extractionRetryAfter: { $lte: now } },
        { state: "error", extractionRetryAfter: { $exists: false } },
      ]),
      {
        state: "processing",
        processingStartedAt: {
          $lt: new Date(now.getTime() - PROCESSING_TIMEOUT_MS),
        },
      },
    ],
  };

  if (input.start || input.end) {
    query.start = {
      ...(input.start ? { $gte: new Date(input.start) } : {}),
      ...(input.end ? { $lt: new Date(input.end) } : {}),
    };
  }

  return query;
}

export function buildConversationChunkClaimRequest(
  input: Partial<
    Pick<MergedExtractorJobData, "start" | "end" | "retryNow">
  >,
  jobId: string,
  now = new Date(),
): Record<string, unknown> {
  return {
    action: "findOneAndUpdate",
    collection: "conversation_chunks",
    query: buildConversationChunkClaimQuery(input, now),
    update: {
      $set: {
        state: "processing",
        processingStartedAt: now,
        processedByJobId: jobId,
      },
    },
    options: {
      sort: { start: -1 },
      returnDocument: "before",
    },
  };
}

// ============================================================================
// Response schema & parsing
// ============================================================================

export const mergedResponseSchema = z.object({
  segments: z.array(z.object({
    title: z.string(),
    start: z.string(),
    end: z.string(),
    emoji: z.string(),
    agreed_upon_something: z.boolean(),
    entities: z.array(z.object({
      name: z.string(),
      type: z.enum(ENTITY_TYPES),
    })),
    tags: z.array(z.string()),
  })),
});

export interface MergedSegment {
  title: string;
  start: Date;
  end: Date;
  rawStart: string;
  rawEnd: string;
  boundaryResolved: boolean;
  emoji: string | undefined;
  rawEmoji: string;
  agreed_upon_something: boolean;
  entities: ExtractedEntity[];
  droppedEntities: number;
  tags: string[];
  droppedTags: number;
}

/**
 * Parses the composite response. Boundary phrases are resolved to timestamps
 * with the same phrase-matching used by the regular extractor; everything the
 * model got wrong is recorded (not silently dropped) so the job details page
 * can show exactly what the merged call did and did not manage.
 */
export function parseMergedResponse(
  content: string,
  promptLines: string[],
  chunkStart: Date,
  chunkEnd: Date,
  validTagNames: Set<string>,
  utterancesByLine?: ReadonlyMap<number, Utterance>,
): MergedSegment[] {
  const parsed = extractJsonFromText(content);
  const rawSegments: any[] = Array.isArray(parsed?.segments)
    ? parsed.segments
    : [];

  // Boundary resolution reuses the regular extractor's parser: it consumes
  // the same {segments: [{title, start, end}]} shape and preserves order.
  const resolved = createSegmentParser(
    promptLines,
    chunkStart,
    chunkEnd,
    utterancesByLine,
  )(content);

  return rawSegments.map((raw, index) => {
    const boundaries = resolved[index];
    const start = boundaries?.start ?? chunkStart;
    const end = boundaries?.end ?? chunkEnd;
    const boundaryResolved = Boolean(
      boundaries &&
        !(start.getTime() === chunkStart.getTime() &&
          end.getTime() === chunkEnd.getTime() &&
          rawSegments.length > 1),
    );

    const entities: ExtractedEntity[] = [];
    const seenEntities = new Set<string>();
    let droppedEntities = 0;
    for (const value of Array.isArray(raw.entities) ? raw.entities : []) {
      let name: string;
      let type: EntityType = "other";
      if (typeof value === "string") {
        name = value.trim();
      } else if (
        value && typeof value === "object" &&
        typeof value.name === "string"
      ) {
        name = value.name.trim();
        if (
          typeof value.type === "string" &&
          (ENTITY_TYPES as readonly string[]).includes(value.type)
        ) {
          type = value.type as EntityType;
        }
      } else {
        droppedEntities++;
        continue;
      }
      const key = name.toLocaleLowerCase();
      if (!name || seenEntities.has(key)) {
        droppedEntities++;
        continue;
      }
      seenEntities.add(key);
      entities.push({ name, type });
    }

    const tags: string[] = [];
    const seenTags = new Set<string>();
    let droppedTags = 0;
    for (const value of Array.isArray(raw.tags) ? raw.tags : []) {
      const name = typeof value === "string" ? value.trim() : "";
      if (!name || !validTagNames.has(name) || seenTags.has(name)) {
        droppedTags++;
        continue;
      }
      seenTags.add(name);
      tags.push(name);
    }

    return {
      title: typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : `Conversation ${index + 1}`,
      start,
      end,
      rawStart: typeof raw.start === "string" ? raw.start : "",
      rawEnd: typeof raw.end === "string" ? raw.end : "",
      boundaryResolved,
      emoji: normalizeEmoji(raw.emoji),
      rawEmoji: typeof raw.emoji === "string" ? raw.emoji : "",
      agreed_upon_something: Boolean(raw.agreed_upon_something),
      entities,
      droppedEntities,
      tags,
      droppedTags,
    };
  });
}

// ============================================================================
// Main Worker
// ============================================================================

const capability: JobCapability = {
  name: "conversation_extractor_merged",
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(z.object({
    status: z.literal("completed"),
    success: z.boolean(),
    processed: z.number(),
    chunksProcessed: z.number(),
    conversationsCreated: z.number(),
    segmentsFound: z.number(),
    entityCount: z.number(),
    tagsApplied: z.number(),
    singleCallPerChunk: z.boolean(),
    llmCalls: z.number(),
    hasMore: z.boolean(),
    artifacts: z.array(z.any()).describe(
      "Per-chunk diagnostics: prompt size, raw vs resolved segments, per-segment metadata and link outcomes",
    ),
    errors: z.array(z.object({
      type: z.string(),
      message: z.string(),
      conversationId: z.string().optional(),
      entity: z.string().optional(),
    })).optional(),
  })),
  policies: [
    { resource: "db/conversation_chunks", action: "read", effect: "allow" },
    { resource: "db/conversation_chunks", action: "update", effect: "allow" },
    { resource: "db/transcriptions", action: "read", effect: "allow" },
    { resource: "objects", action: "*", effect: "allow" },
    { resource: "llm/chat", action: "completions", effect: "allow" },
  ],
  maxConcurrency: 1,
  // Return a boolean, not the numeric value 1. TriggerManager interprets a
  // numeric pending-work result as an exact job count, which used to cap this
  // worker at one automatic job even when runtime concurrency was higher.
  // The LLM resource still enforces each local/OpenRouter profile's own
  // concurrency budget while this worker fills its configured BullMQ slots.
  hasPendingWork: async ({ mongo }) =>
    await hasIndexedPendingWork(mongo, {
      collection: "conversation_chunks",
      query: buildConversationChunkClaimQuery(),
    }),
  use: async (job) => {
    const input = job.data as MergedExtractorJobData;
    const maxPromptChars = input.maxPromptChars ??
      DEFAULT_EXTRACTION_MAX_PROMPT_CHARS;
    const jwt = Deno.env.get("MYCELIA_JWT")!;
    const myceliaUrl = Deno.env.get("MYCELIA_URL")!;

    const mongo = (input: any) =>
      callResource("mongo", input, { jwt, myceliaUrl });
    const objects = (input: any) =>
      callResource("objects", input, { jwt, myceliaUrl });
    const llm = (input: any) => callResource("llm", input, { jwt, myceliaUrl });

    const errors: ConversationError[] = [];
    const inferenceRuns: InferenceProvenance[] = [];
    const artifacts: any[] = [];
    let chunksProcessed = 0;
    let conversationsCreated = 0;
    let segmentsFound = 0;
    let entityCount = 0;
    let tagsApplied = 0;
    let llmCalls = 0;
    let singleCallPerChunk = true;

    // Automatic jobs claim their chunks during selection so concurrent jobs
    // cannot all choose the same newest row and then finish as not_claimed.
    // Explicit/manual jobs keep the separate force-aware claim below.
    let chunks: ConversationChunk[];
    if (input.chunkId) {
      const chunk = await mongo({
        action: "findOne",
        collection: "conversation_chunks",
        query: { _id: new ObjectId(input.chunkId) },
      }) as ConversationChunk | null;
      chunks = chunk ? [chunk] : [];
    } else {
      chunks = [];
      for (let index = 0; index < input.limit; index++) {
        const chunk = await mongo(
          buildConversationChunkClaimRequest(input, job.id!),
        ) as ConversationChunk | null;
        if (!chunk) break;
        chunks.push(chunk);
      }
    }

    let hasMore = false;
    const chunksToProcess = chunks;

    console.log(
      `[MergedExtractor] Job ${job.id}: selected ${chunksToProcess.length} chunk(s) for processing`,
    );

    // Tag list is appended to the merged prompt, same as the regular
    // extractor's metadata call.
    let tags: ExtractionTag[] = [];
    if (chunksToProcess.length > 0) {
      try {
        const tagDocs = await objects({
          action: "list",
          filters: { isTag: true },
        }) as Array<{ _id: ObjectId; name?: string; details?: string }>;
        tags = (tagDocs ?? [])
          .filter((tag) => typeof tag.name === "string" && tag.name.trim())
          .map((tag) => ({
            _id: tag._id,
            name: tag.name as string,
            details: tag.details,
          }));
      } catch (error) {
        console.error(
          `[MergedExtractor] Job ${job.id}: failed to load tags, continuing without tagging:`,
          error,
        );
      }
    }
    const validTagNames = new Set(tags.map((tag) => tag.name));
    const tagsByName = new Map<string, ObjectId>(
      tags.map((tag) => [tag.name, tag._id]),
    );

    const promptVersion = createHash("sha256")
      .update(input.merged_system_prompt + buildTagListPrompt(tags))
      .digest("hex")
      .slice(0, 8);

    for (const chunk of chunksToProcess) {
      const chunkDiagnostics: any = {
        chunkId: chunk._id.toString(),
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        transcriptionCount: chunk.transcriptionIds?.length ?? 0,
      };

      try {
        if (input.chunkId) {
          const claim = await mongo({
            action: "updateOne",
            collection: "conversation_chunks",
            query: input.force ? { _id: chunk._id } : {
              _id: chunk._id,
              ...buildConversationChunkClaimQuery(input),
            },
            update: {
              $set: {
                state: "processing",
                processingStartedAt: new Date(),
                processedByJobId: job.id,
              },
            },
          }) as { modifiedCount: number };
          if (claim.modifiedCount === 0) {
            chunkDiagnostics.outcome = "not_claimed";
            artifacts.push(chunkDiagnostics);
            continue;
          }
        }

        if (input.force) {
          const deleted = await deleteConversationsForChunk(objects, chunk._id);
          chunkDiagnostics.deletedPreviousConversations = deleted;
        }

        // Build size-bounded transcript windows. New chunks are bounded by the
        // creator too, but this remains the safety net for legacy chunks and
        // for a single unusually large transcription.
        const transcriptions = await mongo({
          action: "find",
          collection: "transcriptions",
          query: { _id: { $in: chunk.transcriptionIds } },
          options: { sort: { start: 1 } },
        }) as any[];
        const utterances = transcriptions.flatMap((t) =>
          transcriptionToUtterances(t)
        );
        // Missing/blank source data is retryable. A legacy transcript made
        // entirely of filtered ASR artifacts completes with zero windows.
        if (
          utterances.length === 0 &&
          !transcriptions.some((t) =>
            t.text?.trim() ||
            t.segments?.some((s: { text?: string }) => s.text?.trim())
          )
        ) {
          throw new Error(
            `Conversation chunk ${chunk._id} has no usable transcription text`,
          );
        }
        const fullPromptChars = utterances.length
          ? formatChunkAsPrompt(utterances).prompt.length
          : 0;
        const promptWindows = partitionTranscriptionsForPrompt(
          transcriptions,
          maxPromptChars,
        );
        if (utterances.length > 0 && promptWindows.length === 0) {
          throw new Error(
            `Conversation chunk ${chunk._id} produced no extraction windows`,
          );
        }
        chunkDiagnostics.utterances = utterances.length;
        chunkDiagnostics.promptChars = fullPromptChars;
        chunkDiagnostics.maxPromptChars = maxPromptChars;
        chunkDiagnostics.initialPromptWindowCount = promptWindows.length;

        // The creator no longer snapshots a model on the chunk. The extractor
        // job's current defaults/routing decision are authoritative.
        const model = input.model.trim();
        const fallbackModel = resolveWorkerFallbackModel(
          input.fallbackModel,
          "CONVERSATION_EXTRACTION_FALLBACK_MODEL",
        );
        const systemPrompt = input.merged_system_prompt +
          buildTagListPrompt(tags);
        const responseFormat = buildJsonSchemaResponseFormat(
          "merged_conversation_extraction",
          mergedResponseSchema.toJSONSchema() as Record<string, unknown>,
        );

        const extractedSegments: Array<{
          segment: MergedSegment;
          provenance: InferenceProvenance;
          windowIndex: number;
        }> = [];
        const chunkProvenances: InferenceProvenance[] = [];
        const windowDiagnostics: any[] = [];
        const adaptiveTruncationDiagnostics: any[] = [];
        chunkDiagnostics.truncatedWindowAttempts =
          adaptiveTruncationDiagnostics;
        let responseChars = 0;
        let chunkLlmCalls = 0;

        // Complete every LLM window before writing any objects. If one window
        // fails, the chunk remains retryable without partial conversations. A
        // token-truncated window is bisected by utterance and retried; every
        // split strictly reduces the utterance count, so this cannot loop.
        const pendingPromptWindows = [...promptWindows];
        while (pendingPromptWindows.length > 0) {
          const window = pendingPromptWindows.shift()!;
          const plannedWindowCount = windowDiagnostics.length +
            pendingPromptWindows.length + 1;
          await job.updateProgress({
            stage: "merged_extraction",
            chunkId: chunk._id.toString(),
            promptChars: fullPromptChars,
            windowPromptChars: window.promptChars,
            windowIndex: windowDiagnostics.length + 1,
            windowCount: plannedWindowCount,
            adaptiveSplits: adaptiveTruncationDiagnostics.length,
          });

          let response: any;
          try {
            response = await llm({
              action: "completions",
              model,
              ...(fallbackModel ? { fallbackModel } : {}),
              ...(input.providerProfileId
                ? { provider_profile_id: input.providerProfileId }
                : {}),
              ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
              reasoning: input.reasoning ?? "off",
              category: "extraction",
              session_id: createPromptCacheSessionId(
                "conversation-extractor-merged",
                {
                  system: systemPrompt,
                  responseFormat,
                  reasoning: input.reasoning ?? "off",
                },
              ),
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: window.prompt },
              ],
              response_format: responseFormat,
            }) as any;
            llmCalls++;
            chunkLlmCalls++;
            assertCompletionNotTruncated(response, {
              requestedModel: model,
              maxTokens: input.maxTokens,
              purpose: `merged extraction chunk ${chunk._id} window ${
                windowDiagnostics.length + 1
              }/${plannedWindowCount}`,
            });
          } catch (error) {
            const isTruncated = error instanceof Error &&
              error.message.includes(LLM_TRUNCATED_RESPONSE_CODE);
            const children = isTruncated &&
                adaptiveTruncationDiagnostics.length <
                  MAX_ADAPTIVE_SPLITS_PER_CHUNK
              ? bisectPromptWindow(window)
              : null;
            if (children) {
              adaptiveTruncationDiagnostics.push({
                promptChars: window.promptChars,
                utterances: window.utterances.length,
                childPromptChars: children.map((child) => child.promptChars),
              });
              pendingPromptWindows.unshift(...children);
              continue;
            }
            if (isTruncated && error instanceof Error) {
              throw new Error(
                `${error.message} Adaptive prompt splitting stopped after ${adaptiveTruncationDiagnostics.length} split(s); the window cannot be divided further or the per-chunk safety limit (${MAX_ADAPTIVE_SPLITS_PER_CHUNK}) was reached.`,
                { cause: error },
              );
            }
            throw error;
          }

          const windowIndex = windowDiagnostics.length;
          const provenance = getInferenceProvenance(
            response,
            model,
            fallbackModel,
          );
          inferenceRuns.push(provenance);
          chunkProvenances.push(provenance);
          const content = response.choices[0]?.message?.content;
          if (!content) throw new Error("Empty response from LLM");
          responseChars += content.length;

          const segments = parseMergedResponse(
            content,
            window.prompt.split("\n"),
            window.start,
            window.end,
            validTagNames,
            window.utterancesByLine,
          );
          extractedSegments.push(
            ...segments.map((segment) => ({
              segment,
              provenance,
              windowIndex,
            })),
          );
          windowDiagnostics.push({
            index: windowIndex + 1,
            start: window.start,
            end: window.end,
            sourceKey: window.sourceKey,
            boundaryReason: window.boundaryReason,
            transcriptionCount: window.transcriptions.length,
            utterances: window.utterances.length,
            promptChars: window.promptChars,
            responseChars: content.length,
            segmentsReturned: segments.length,
          });
        }

        singleCallPerChunk &&= chunkLlmCalls === 1;
        chunkDiagnostics.promptWindowCount = windowDiagnostics.length;
        chunkDiagnostics.adaptiveSplitCount =
          adaptiveTruncationDiagnostics.length;
        chunkDiagnostics.truncatedWindowAttempts =
          adaptiveTruncationDiagnostics;
        chunkDiagnostics.windows = windowDiagnostics;
        chunkDiagnostics.responseChars = responseChars;
        chunkDiagnostics.segmentsReturned = extractedSegments.length;
        segmentsFound += extractedSegments.length;

        const generatedAt = new Date();
        const extractionKey = createHash("sha256")
          .update(
            `${chunk._id}:${promptVersion}:${model}:${MERGED_EXTRACTOR_VERSION}`,
          )
          .digest("hex")
          .slice(0, 16);

        const segmentDiagnostics: any[] = [];
        for (const extracted of extractedSegments) {
          const { segment, provenance, windowIndex } = extracted;
          const segDiag: any = {
            title: segment.title,
            rawStart: segment.rawStart,
            rawEnd: segment.rawEnd,
            resolvedStart: segment.start,
            resolvedEnd: segment.end,
            boundaryResolved: segment.boundaryResolved,
            emoji: segment.emoji ?? "",
            emojiValid: Boolean(segment.emoji),
            rawEmoji: segment.rawEmoji,
            agreementDetected: segment.agreed_upon_something,
            entities: segment.entities,
            droppedEntities: segment.droppedEntities,
            tags: segment.tags,
            droppedTags: segment.droppedTags,
            windowIndex: windowIndex + 1,
          };

          try {
            const extractionProvenance = {
              task: "conversation_extraction_merged",
              ...provenance,
              extractorVersion: MERGED_EXTRACTOR_VERSION,
            };
            const conversationObject: any = {
              isConversation: true,
              name: segment.title,
              timeRanges: [{ start: segment.start, end: segment.end }],
              agreed_upon_something: segment.agreed_upon_something,
              metadata: {
                extractedWith: {
                  ...provenance,
                  extractorVersion: MERGED_EXTRACTOR_VERSION,
                  chunkId: chunk._id.toString(),
                  jobId: job.id,
                  timestamp: generatedAt,
                  result: {
                    schemaVersion: "merged-v2-windowed",
                    status: "completed",
                    windowIndex: windowIndex + 1,
                    windowCount: windowDiagnostics.length,
                    emojiPresent: Boolean(segment.emoji),
                    entityCount: segment.entities.length,
                    tagsApplied: segment.tags.length,
                  },
                },
              },
            };
            if (segment.emoji) {
              conversationObject.icon = { text: segment.emoji };
            }

            const convResult = await objects({
              action: "create",
              object: conversationObject,
            }) as { insertedId: ObjectId };
            const conversationId = convResult.insertedId;
            segDiag.conversationId = conversationId.toString();
            conversationsCreated++;

            const relationshipResult = await createEntityRelationships(
              objects,
              conversationId,
              segment.entities,
              errors,
              {
                ...extractionProvenance,
                task: "entity_extraction",
                subjectId: conversationId.toString(),
              },
            );
            segDiag.entityLinksCreated = relationshipResult.created;
            segDiag.entityLinksFailed = relationshipResult.failed;
            entityCount += segment.entities.length;

            const tagResult = await createTagRelationships(
              objects,
              conversationId,
              segment.tags,
              tagsByName,
              errors,
              {
                ...extractionProvenance,
                task: "tagging",
                subjectId: conversationId.toString(),
              },
            );
            segDiag.tagLinksCreated = tagResult.created;
            segDiag.tagLinksFailed = tagResult.failed;
            tagsApplied += tagResult.created;

            if (tags.length > 0) {
              try {
                const fresh = await objects({
                  action: "get",
                  id: conversationId.toString(),
                }) as { version?: number };
                await objects({
                  action: "update",
                  id: conversationId.toString(),
                  version: fresh.version ?? 0,
                  field: "metadata.aiProvenance.taggingRuns",
                  value: [{
                    task: "tagging",
                    ...provenance,
                    selectedTags: segment.tags,
                    selectedTagCount: segment.tags.length,
                    jobId: job.id,
                    generatedAt,
                    source: "conversation_extraction_merged",
                  }],
                });
              } catch (error) {
                errors.push({
                  type: "tagging_run_marker",
                  message: error instanceof Error
                    ? error.message
                    : String(error),
                  conversationId: conversationId.toString(),
                });
              }
            }
          } catch (error) {
            segDiag.error = error instanceof Error
              ? error.message
              : String(error);
            errors.push({
              type: "conversation_creation",
              message: segDiag.error,
            });
          }

          segmentDiagnostics.push(segDiag);
        }

        chunkDiagnostics.segments = segmentDiagnostics;
        chunkDiagnostics.outcome = "completed";

        await mongo({
          action: "updateOne",
          collection: "conversation_chunks",
          query: { _id: chunk._id },
          update: {
            $set: {
              state: "completed",
              segmentsFound: extractedSegments.length,
              conversationsCreated: segmentDiagnostics.filter((s) =>
                s.conversationId
              ).length,
              extractionKey,
              inferenceProvenance: {
                merged: {
                  task: "conversation_extraction_merged",
                  ...(summarizeInferenceUsage(chunkProvenances) ?? {}),
                  jobId: job.id,
                  generatedAt,
                  windowCount: windowDiagnostics.length,
                },
              },
            },
            $unset: {
              processingStartedAt: "",
              extractionRetryAfter: "",
              error: "",
            },
          },
        });

        chunksProcessed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chunkDiagnostics.outcome = "error";
        chunkDiagnostics.error = message;
        errors.push({ type: "chunk_processing", message });

        const retryCount = (chunk.extractionRetryCount ?? 0) + 1;
        const failedAt = new Date();
        await mongo({
          action: "updateOne",
          collection: "conversation_chunks",
          query: { _id: chunk._id },
          update: {
            $set: {
              state: "error",
              error: message,
              extractionRetryCount: retryCount,
              extractionLastErrorAt: failedAt,
              extractionRetryAfter: new Date(
                failedAt.getTime() + getExtractionRetryDelayMs(retryCount),
              ),
            },
            $unset: { processingStartedAt: "" },
          },
        });
      }

      artifacts.push(chunkDiagnostics);
    }

    if (!input.chunkId) {
      hasMore = await hasIndexedPendingWork(mongo, {
        collection: "conversation_chunks",
        query: buildConversationChunkClaimQuery(input),
      });
    }

    // Every claimed chunk failed: fail the job instead of reporting a green
    // "completed" run. Chunk states/backoff are already persisted above.
    if (chunksProcessed === 0 && errors.length > 0) {
      throw new Error(
        `merged extraction failed: 0 chunks processed, ${errors.length} error(s); first: ${
          errors[0].message
        }`,
      );
    }

    const inference = summarizeInferenceUsage(inferenceRuns);
    console.log(
      `[MergedExtractor] Job ${job.id}: completed - chunks=${chunksProcessed}, conversations=${conversationsCreated}, segments=${segmentsFound}, entities=${entityCount}, tags=${tagsApplied}, errors=${errors.length}`,
    );

    return {
      status: "completed" as const,
      success: errors.length === 0,
      processed: chunksProcessed,
      chunksProcessed,
      conversationsCreated,
      segmentsFound,
      entityCount,
      tagsApplied,
      singleCallPerChunk,
      llmCalls,
      hasMore,
      artifacts,
      ...(inference ? { inference } : {}),
      ...(errors.length > 0 && { errors }),
    };
  },
  triggers: {
    sources: [
      {
        channel: "mycelia:mongo:conversation_chunks",
        name: "chunk_ready",
        filter: {
          event: "mongo.change",
          "data.operationType": { $in: ["insert", "update"] },
          "data.document.state": "ready",
        },
      },
    ],
    ...getTriggerTiming("conversation_extractor_merged"),
  },
};

export default capability;
