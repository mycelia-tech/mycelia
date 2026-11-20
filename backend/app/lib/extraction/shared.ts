import { ObjectId } from "bson";
import { extractJsonFromText } from "../llm/worker-response.ts";
import { isSubtitleCreditArtifact } from "../transcription-filters.ts";

/**
 * Extraction-domain code shared by the conversation extractor, entity typing
 * and tagging workers: the entity taxonomy, transcript→prompt formatting,
 * segmentation-response parsing, and the persistence helpers that turn
 * extracted entities/tags into objects and relationships.
 *
 * Moved out of the legacy conversation_extractor worker when it was removed;
 * conversation_extractor_merged is the only extractor.
 */

// ============================================================================
// Types
// ============================================================================

export interface Utterance {
  start: Date;
  end: Date;
  text: string;
}

export interface TranscriptionInput {
  start: Date | string;
  end: Date | string;
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
}

export const DEFAULT_EXTRACTION_MAX_PROMPT_CHARS = 32_000;

export type PromptTranscriptionInput = TranscriptionInput & {
  _id?: unknown;
  original?: unknown;
};

export type PromptWindow<T extends PromptTranscriptionInput> = {
  transcriptions: T[];
  utterances: Utterance[];
  utterancesByLine: ReadonlyMap<number, Utterance>;
  prompt: string;
  start: Date;
  end: Date;
  promptChars: number;
  sourceKey: string;
  boundaryReason:
    | "initial"
    | "source_change"
    | "prompt_limit"
    | "segment_limit"
    | "adaptive_truncation";
};

export interface Segment {
  title: string;
  start: Date;
  end: Date;
}

export interface ConversationError {
  type: string;
  message: string;
  conversationId?: string;
  entity?: string;
}

export interface ConversationChunk {
  _id: ObjectId;
  chunkKey: string;
  start: Date;
  end: Date;
  transcriptionIds: ObjectId[];
  totalTextLength: number;
  state: string;
  extractionRetryCount?: number;
  extractionRetryAfter?: Date;
  params: {
    model: string;
    force: boolean;
  };
}

export interface ExtractionTag {
  _id: ObjectId;
  name: string;
  details?: string;
}

// ============================================================================
// Entity taxonomy
// ============================================================================

export const ENTITY_TYPES = [
  "person",
  "place",
  "organization",
  "product",
  "project",
  "event",
  "animal",
  "concept",
  "media",
  "other",
] as const;
export type EntityType = typeof ENTITY_TYPES[number];

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export const ENTITY_TYPE_FLAG: Partial<Record<EntityType, string>> = {
  person: "isPerson",
  place: "isPlace",
  organization: "isOrganization",
  product: "isProduct",
  project: "isProject",
  event: "isEvent",
  animal: "isAnimal",
  concept: "isConcept",
  media: "isMedia",
};

// Every type flag on objects. A key that exists — even with value false —
// means someone (user or job) already made a typing decision.
export const TYPE_FLAG_FIELDS = [
  "isPerson",
  "isEvent",
  "isRelationship",
  "isPromise",
  "isConversation",
  "isTag",
  "isPlace",
  "isOrganization",
  "isProduct",
  "isProject",
  "isAnimal",
  "isConcept",
  "isMedia",
];

export function hasAnyTypeFlagKey(obj: Record<string, unknown>): boolean {
  return TYPE_FLAG_FIELDS.some((field) =>
    field in obj && obj[field] !== undefined
  );
}

// ============================================================================
// Retry policy
// ============================================================================

const EXTRACTION_RETRY_BASE_MS = 5 * 60 * 1000;
const EXTRACTION_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

export function getExtractionRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(
    EXTRACTION_RETRY_BASE_MS * 2 ** (safeAttempt - 1),
    EXTRACTION_RETRY_MAX_MS,
  );
}

// ============================================================================
// Transcript → prompt
// ============================================================================

export function transcriptionToUtterances(
  transcription: TranscriptionInput,
): Utterance[] {
  const transcriptionStart = new Date(transcription.start);
  const transcriptionEnd = new Date(transcription.end);
  const segments = transcription.segments ?? [];

  const utterances = segments.flatMap((segment) => {
    const text = segment.text?.trim();
    if (!text) return [];

    const start = typeof segment.start === "number"
      ? new Date(transcriptionStart.getTime() + segment.start * 1000)
      : transcriptionStart;
    const end = typeof segment.end === "number"
      ? new Date(transcriptionStart.getTime() + segment.end * 1000)
      : transcriptionEnd;

    return [{
      start,
      end: new Date(Math.min(end.getTime(), transcriptionEnd.getTime())),
      text,
    }];
  });

  if (utterances.length > 0) {
    // Keep legacy ASR boilerplate out of extraction even on a replay. The
    // aggregate text often contains the very same discarded segment.
    return utterances.filter(({ text }) => !isSubtitleCreditArtifact(text));
  }

  const fallbackText = transcription.text?.trim() ||
    segments.map((segment) => segment.text ?? "").join("").trim();
  return fallbackText && !isSubtitleCreditArtifact(fallbackText)
    ? [{ start: transcriptionStart, end: transcriptionEnd, text: fallbackText }]
    : [];
}

export function formatChunkAsPrompt(
  utterances: Utterance[],
  utterancesByLine?: Map<number, Utterance>,
): { prompt: string; start: Date; end: Date } {
  if (utterances.length === 0) {
    throw new Error("Cannot format empty utterances array");
  }

  const sorted = [...utterances].sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const strings: string[] = [];
  let latest = new Date(sorted[0].start);

  strings.push(`[time: ${new Date(sorted[0].start).toISOString()}]`);

  for (let index = 0; index < sorted.length; index++) {
    const u = sorted[index];
    const uStart = new Date(u.start);
    const gap = uStart.getTime() - latest.getTime();

    if (index > 0) {
      if (gap > 30 * 1000) { // > 30 seconds
        strings.push(`[time: ${latest.toISOString()}]`);
        const minutes = Math.floor(gap / 1000 / 60);
        const seconds = Math.floor((gap / 1000) % 60);
        strings.push(`[silence ${minutes}m ${seconds}s]`);
      }
      strings.push(`[time: ${uStart.toISOString()}]`);
    }

    for (const line of u.text.split("\n")) {
      utterancesByLine?.set(strings.length, u);
      strings.push(line);
    }
    latest = new Date(Math.max(latest.getTime(), new Date(u.end).getTime()));
  }

  strings.push(`[time: ${latest.toISOString()}]`);

  return {
    prompt: strings.join("\n"),
    start: new Date(sorted[0].start),
    end: latest,
  };
}

function sourceKeyForTranscription(
  transcription: PromptTranscriptionInput,
): string {
  return transcription.original == null
    ? "__none__"
    : String(transcription.original);
}

function promptWindow<T extends PromptTranscriptionInput>(
  transcriptions: T[],
  utterances: Utterance[],
  sourceKey: string,
  boundaryReason: PromptWindow<T>["boundaryReason"],
): PromptWindow<T> {
  const utterancesByLine = new Map<number, Utterance>();
  const formatted = formatChunkAsPrompt(utterances, utterancesByLine);
  return {
    transcriptions,
    utterances,
    utterancesByLine,
    prompt: formatted.prompt,
    start: formatted.start,
    end: formatted.end,
    promptChars: formatted.prompt.length,
    sourceKey,
    boundaryReason,
  };
}

function partitionOversizedTranscription<T extends PromptTranscriptionInput>(
  transcription: T,
  utterances: Utterance[],
  maxPromptChars: number,
  sourceKey: string,
): PromptWindow<T>[] {
  const windows: PromptWindow<T>[] = [];
  let current: Utterance[] = [];

  for (const utterance of utterances) {
    const candidate = [...current, utterance];
    const candidateChars = formatChunkAsPrompt(candidate).prompt.length;

    if (current.length > 0 && candidateChars > maxPromptChars) {
      windows.push(
        promptWindow(
          [transcription],
          current,
          sourceKey,
          windows.length === 0 ? "prompt_limit" : "segment_limit",
        ),
      );
      current = [];
    }

    const singleChars = formatChunkAsPrompt([utterance]).prompt.length;
    if (singleChars > maxPromptChars) {
      throw new Error(
        `EXTRACTION_PROMPT_UNIT_TOO_LARGE: one utterance requires ${singleChars} characters (maxPromptChars=${maxPromptChars})`,
      );
    }
    current.push(utterance);
  }

  if (current.length > 0) {
    windows.push(
      promptWindow(
        [transcription],
        current,
        sourceKey,
        windows.length === 0 ? "prompt_limit" : "segment_limit",
      ),
    );
  }

  return windows;
}

/**
 * Partition complete transcription documents into deterministic extraction
 * windows. Source-file changes are always hard boundaries. Whole
 * transcription documents stay together unless one document alone exceeds
 * the cap, in which case its STT utterances are divided without modifying the
 * canonical transcription record.
 */
export function partitionTranscriptionsForPrompt<
  T extends PromptTranscriptionInput,
>(
  transcriptions: T[],
  maxPromptChars = DEFAULT_EXTRACTION_MAX_PROMPT_CHARS,
): PromptWindow<T>[] {
  if (!Number.isFinite(maxPromptChars) || maxPromptChars <= 0) {
    throw new Error("maxPromptChars must be a positive finite number");
  }

  const sorted = [...transcriptions].sort((a, b) => {
    const byStart = new Date(a.start).getTime() - new Date(b.start).getTime();
    if (byStart !== 0) return byStart;
    return String(a._id ?? "").localeCompare(String(b._id ?? ""));
  });
  const windows: PromptWindow<T>[] = [];
  let currentTranscriptions: T[] = [];
  let currentUtterances: Utterance[] = [];
  let currentSourceKey = "__none__";
  let nextBoundaryReason: PromptWindow<T>["boundaryReason"] = "initial";

  const flush = () => {
    if (currentUtterances.length === 0) return;
    windows.push(
      promptWindow(
        currentTranscriptions,
        currentUtterances,
        currentSourceKey,
        nextBoundaryReason,
      ),
    );
    currentTranscriptions = [];
    currentUtterances = [];
  };

  for (const transcription of sorted) {
    const utterances = transcriptionToUtterances(transcription);
    if (utterances.length === 0) continue;
    const sourceKey = sourceKeyForTranscription(transcription);

    if (
      currentUtterances.length > 0 && sourceKey !== currentSourceKey
    ) {
      flush();
      nextBoundaryReason = "source_change";
    }

    const transcriptionChars = formatChunkAsPrompt(utterances).prompt.length;
    if (transcriptionChars > maxPromptChars) {
      flush();
      windows.push(
        ...partitionOversizedTranscription(
          transcription,
          utterances,
          maxPromptChars,
          sourceKey,
        ),
      );
      nextBoundaryReason = "prompt_limit";
      currentSourceKey = sourceKey;
      continue;
    }

    const candidateUtterances = [...currentUtterances, ...utterances];
    if (
      currentUtterances.length > 0 &&
      formatChunkAsPrompt(candidateUtterances).prompt.length > maxPromptChars
    ) {
      flush();
      nextBoundaryReason = "prompt_limit";
    }

    if (currentUtterances.length === 0) currentSourceKey = sourceKey;
    currentTranscriptions.push(transcription);
    currentUtterances.push(...utterances);
  }

  flush();
  return windows;
}

/**
 * Bisect an already materialized prompt window after the provider exhausted
 * its output-token budget. This operates on the window's actual utterances,
 * so it is safe even when the window is already a subset of one oversized
 * transcription. The split point minimizes the larger child prompt.
 */
export function bisectPromptWindow<T extends PromptTranscriptionInput>(
  window: PromptWindow<T>,
): [PromptWindow<T>, PromptWindow<T>] | null {
  if (window.utterances.length === 1) {
    const utterance = window.utterances[0];
    const text = utterance.text.trim();
    if (text.length < 2) return null;

    const midpoint = Math.floor(text.length / 2);
    const before = text.lastIndexOf(" ", midpoint);
    const after = text.indexOf(" ", midpoint);
    const candidates = [before, after].filter((index) =>
      index > 0 && index < text.length - 1
    );
    const splitIndex = candidates.length > 0
      ? candidates.reduce((best, index) =>
        Math.abs(index - midpoint) < Math.abs(best - midpoint) ? index : best
      )
      : midpoint;
    const leftText = text.slice(0, splitIndex).trimEnd();
    const rightText = text.slice(splitIndex).trimStart();
    if (!leftText || !rightText) return null;

    const startMs = utterance.start.getTime();
    const endMs = utterance.end.getTime();
    const boundary = new Date(
      startMs + (endMs - startMs) * (splitIndex / text.length),
    );
    return [
      promptWindow(
        window.transcriptions,
        [{ ...utterance, end: boundary, text: leftText }],
        window.sourceKey,
        window.boundaryReason,
      ),
      promptWindow(
        window.transcriptions,
        [{ ...utterance, start: boundary, text: rightText }],
        window.sourceKey,
        "adaptive_truncation",
      ),
    ];
  }

  if (window.utterances.length < 2) return null;

  let bestIndex = 1;
  let bestLargestChild = Number.POSITIVE_INFINITY;
  for (let index = 1; index < window.utterances.length; index++) {
    const leftChars = formatChunkAsPrompt(
      window.utterances.slice(0, index),
    ).prompt.length;
    const rightChars = formatChunkAsPrompt(
      window.utterances.slice(index),
    ).prompt.length;
    const largestChild = Math.max(leftChars, rightChars);
    if (largestChild < bestLargestChild) {
      bestLargestChild = largestChild;
      bestIndex = index;
    }
  }

  return [
    promptWindow(
      window.transcriptions,
      window.utterances.slice(0, bestIndex),
      window.sourceKey,
      window.boundaryReason,
    ),
    promptWindow(
      window.transcriptions,
      window.utterances.slice(bestIndex),
      window.sourceKey,
      "adaptive_truncation",
    ),
  ];
}

/**
 * Tag selection happens inside the metadata call: the transcript is already
 * being sent for entities/emoji, so the tag list is the only extra cost.
 * The tagger worker remains as a manual/backfill pass for tags added later.
 */
export function buildTagListPrompt(tags: ExtractionTag[]): string {
  if (tags.length === 0) return "";
  const lines = tags.map((tag) =>
    tag.details ? `- ${tag.name}: ${tag.details}` : `- ${tag.name}`
  );
  return `\n\nAvailable tags:\n${
    lines.join("\n")
  }\n- tags: array of tag names from the list above that clearly apply to this conversation. Use exact names, be conservative, and return [] when none apply.`;
}

// ============================================================================
// Segmentation-response parsing
// ============================================================================

/**
 * Parses prompt lines to extract time markers with their line indices.
 * Time markers are in the format: [time: ISO8601]
 */
function extractTimeMarkersFromPrompt(
  promptLines: string[],
): Array<{ lineIdx: number; time: Date }> {
  const markers: Array<{ lineIdx: number; time: Date }> = [];
  const timeRegex = /^\[time:\s*(.+)\]$/;

  for (let i = 0; i < promptLines.length; i++) {
    const match = promptLines[i].match(timeRegex);
    if (match) {
      const time = new Date(match[1]);
      if (!isNaN(time.getTime())) {
        markers.push({ lineIdx: i, time });
      }
    }
  }

  return markers;
}

/** Last marker at or before the given line, if any. */
function findTimeAtOrBeforeLine(
  markers: Array<{ lineIdx: number; time: Date }>,
  lineIdx: number,
): Date | undefined {
  let result: Date | undefined;
  for (const marker of markers) {
    if (marker.lineIdx <= lineIdx) {
      result = marker.time;
    } else {
      break;
    }
  }
  return result;
}

/** First marker at or after the given line, if any. */
function findTimeAtOrAfterLine(
  markers: Array<{ lineIdx: number; time: Date }>,
  lineIdx: number,
): Date | undefined {
  for (const marker of markers) {
    if (marker.lineIdx >= lineIdx) {
      return marker.time;
    }
  }
  return undefined;
}

/**
 * Finds attribute value by prefix (case-insensitive).
 * Returns the value of the first key starting with the prefix, or undefined.
 */
function findAttrStartingWith(obj: Record<string, any>, prefix: string): any {
  const lowerPrefix = prefix.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase().startsWith(lowerPrefix)) {
      return obj[key];
    }
  }
  return undefined;
}

function findPhraseLine(
  foldedLines: string[],
  phrase: string,
  fromLine = 0,
): number {
  const needle = phrase.trim().toLocaleLowerCase();
  if (!needle) return -1;
  const exact = foldedLines.indexOf(needle, fromLine);
  if (exact >= 0) return exact;
  return foldedLines.findIndex((line, index) =>
    index >= fromLine && line.includes(needle)
  );
}

/**
 * Creates a segment parser that can handle various LLM response formats.
 * Finds any key containing "start" and "end", then parses both as either
 * dates (valid date strings), line indices (numbers), or verbatim phrase
 * boundaries resolved against the timestamped transcript lines.
 */
export function createSegmentParser(
  promptLines: string[],
  chunkStart: Date,
  chunkEnd: Date,
  utterancesByLine?: ReadonlyMap<number, Utterance>,
) {
  const timeMarkers = extractTimeMarkersFromPrompt(promptLines);
  const phraseLines = promptLines.map((line, index) =>
    !utterancesByLine || utterancesByLine.has(index)
      ? line.trim().toLocaleLowerCase()
      : ""
  );

  return function parseSegmentationResponse(content: string): Segment[] {
    const parsed = extractJsonFromText(content);
    const segments = parsed.segments || [];
    let nextPhraseLine = 0;
    return segments.map((s: any, index: number) => {
      // Handle null, undefined, non-string, or empty string titles
      let title = `Segment ${index + 1}`;
      if (s.title != null && typeof s.title === "string") {
        const trimmed = s.title.trim();
        if (trimmed.length > 0) {
          title = trimmed;
        }
      }

      // Find any key starting with "start" and "end" (case-insensitive)
      const startVal = findAttrStartingWith(s, "start");
      const endVal = findAttrStartingWith(s, "end");

      if (startVal != null && endVal != null) {
        // Both numbers → line indices
        if (typeof startVal === "number" && typeof endVal === "number") {
          const start = utterancesByLine?.get(startVal)?.start ??
            findTimeAtOrBeforeLine(timeMarkers, startVal) ??
            findTimeAtOrAfterLine(timeMarkers, startVal) ??
            chunkStart;
          const end = utterancesByLine?.get(endVal)?.end ??
            findTimeAtOrAfterLine(timeMarkers, endVal) ??
            findTimeAtOrBeforeLine(timeMarkers, endVal) ??
            chunkEnd;
          if (utterancesByLine?.has(endVal)) nextPhraseLine = endVal + 1;
          return { title, start, end };
        }

        if (typeof startVal === "string" && typeof endVal === "string") {
          // Resolve repeated phrases in transcript order. Some responses
          // describe overlapping segments, so retain the full-window fallback.
          let startLine = findPhraseLine(phraseLines, startVal, nextPhraseLine);
          if (startLine < 0 && nextPhraseLine > 0) {
            startLine = findPhraseLine(phraseLines, startVal);
          }
          const endLine = findPhraseLine(
            phraseLines,
            endVal,
            Math.max(0, startLine),
          );
          const first = utterancesByLine?.get(startLine);
          const last = utterancesByLine?.get(endLine);
          if (first && last) {
            nextPhraseLine = endLine + 1;
            // The next prompt marker can be the start of a later utterance.
            return { title, start: first.start, end: last.end };
          }

          // Legacy providers may return timestamps. Literal dates spoken in
          // the transcript have already been matched to their ASR positions.
          const start = new Date(startVal);
          const end = new Date(endVal);
          const windowStart = chunkStart.getTime() - 24 * 60 * 60 * 1000;
          const windowEnd = chunkEnd.getTime() + 24 * 60 * 60 * 1000;
          const plausible = (date: Date) =>
            !isNaN(date.getTime()) &&
            date.getTime() >= windowStart && date.getTime() <= windowEnd;
          if (plausible(start) && plausible(end)) {
            return { title, start, end };
          }

          // Imported prompts may contain markers without source utterances.
          if (startLine >= 0 && endLine >= startLine) {
            const phraseStart =
              findTimeAtOrBeforeLine(timeMarkers, startLine) ?? chunkStart;
            const phraseEnd = findTimeAtOrAfterLine(timeMarkers, endLine + 1) ??
              chunkEnd;
            return { title, start: phraseStart, end: phraseEnd };
          }
        }
      }

      // Fallback: use chunk boundaries
      console.warn(
        `[Extraction] Segment "${title}" has no valid time info (start=${
          JSON.stringify(startVal)
        }, end=${JSON.stringify(endVal)}), using chunk boundaries`,
      );
      return { title, start: chunkStart, end: chunkEnd };
    });
  };
}

export function normalizeEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const emojiPattern =
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(trimmed);
  for (const { segment } of graphemes) {
    if (emojiPattern.test(segment)) return segment;
  }
  return undefined;
}

// ============================================================================
// Entity/tag persistence
// ============================================================================

interface EntityRelationshipResult {
  attempted: number;
  created: number;
  failed: number;
}

const entityCache = new Map<string, ObjectId>();

async function findOrCreateEntity(
  objects: (input: any) => Promise<any>,
  name: string,
  type: EntityType,
  generatedWith: Record<string, unknown>,
): Promise<ObjectId> {
  // Check cache first
  const cached = entityCache.get(name);
  if (cached) return cached;

  const flagField = ENTITY_TYPE_FLAG[type];

  // Check DB
  const existing = await objects({
    action: "list",
    filters: { name },
    options: { limit: 1 },
  });

  if (existing && existing.length > 0) {
    const doc = existing[0];
    // Backfill-on-touch: type an existing untyped entity, but only when no
    // type-flag key exists at all — an explicit false is a manual decision.
    if (flagField && !hasAnyTypeFlagKey(doc)) {
      try {
        await objects({
          action: "update",
          id: doc._id.toString(),
          version: doc.version ?? 0,
          field: flagField,
          value: true,
        });
      } catch {
        // Concurrent edit — keep whatever the other writer decided.
      }
    }
    entityCache.set(name, doc._id);
    return doc._id;
  }

  // Create new
  const result = await objects({
    action: "create",
    object: {
      name,
      ...(flagField ? { [flagField]: true } : {}),
      metadata: { generatedWith: { ...generatedWith, entityType: type } },
    },
  });

  entityCache.set(name, result.insertedId);
  return result.insertedId;
}

export async function createEntityRelationships(
  objects: (input: any) => Promise<any>,
  conversationId: ObjectId,
  entities: ExtractedEntity[],
  errors: ConversationError[],
  generatedWith: Record<string, unknown>,
): Promise<EntityRelationshipResult> {
  const result: EntityRelationshipResult = {
    attempted: entities.length,
    created: 0,
    failed: 0,
  };

  for (const entity of entities) {
    try {
      const entityId = await findOrCreateEntity(
        objects,
        entity.name,
        entity.type,
        generatedWith,
      );
      await objects({
        action: "create",
        object: {
          isRelationship: true,
          name: "mentioned in",
          relationship: {
            subject: conversationId,
            object: entityId,
            symmetrical: false,
          },
          metadata: { generatedWith },
        },
      });
      result.created++;
    } catch (error) {
      result.failed++;
      console.error(
        `Failed to create entity relationship for "${entity.name}":`,
        error,
      );
      errors.push({
        type: "entity_relationship",
        message: error instanceof Error ? error.message : String(error),
        conversationId: conversationId.toString(),
        entity: entity.name,
      });
    }
  }

  return result;
}

export async function createTagRelationships(
  objects: (input: any) => Promise<any>,
  conversationId: ObjectId,
  tagNames: string[],
  tagsByName: Map<string, ObjectId>,
  errors: ConversationError[],
  generatedWith: Record<string, unknown>,
): Promise<{ created: number; failed: number }> {
  const result = { created: 0, failed: 0 };
  for (const tagName of tagNames) {
    const tagId = tagsByName.get(tagName);
    if (!tagId) continue;
    try {
      await objects({
        action: "create",
        object: {
          isRelationship: true,
          name: "tagged",
          relationship: {
            subject: conversationId,
            object: tagId,
            symmetrical: false,
          },
          metadata: { generatedWith },
        },
      });
      result.created++;
    } catch (error) {
      result.failed++;
      errors.push({
        type: "tag_relationship",
        message: error instanceof Error ? error.message : String(error),
        conversationId: conversationId.toString(),
        entity: tagName,
      });
    }
  }
  return result;
}

// ============================================================================
// Idempotency
// ============================================================================

export async function deleteConversationsForChunk(
  objects: (input: any) => Promise<any>,
  chunkId: ObjectId,
): Promise<number> {
  // Delete only artifacts created from this chunk. Range-based deletion can
  // remove valid conversations from overlapping chunks or manual imports.
  const conversations = await objects({
    action: "list",
    filters: {
      isConversation: true,
      "metadata.extractedWith.chunkId": chunkId.toString(),
    },
  });

  if (!conversations || conversations.length === 0) return 0;

  const conversationIds = conversations.map((c: any) => c._id);

  // Delete relationships first
  const relationships = await objects({
    action: "list",
    filters: {
      isRelationship: true,
      "relationship.subject": { $in: conversationIds },
    },
  });

  for (const rel of relationships || []) {
    await objects({
      action: "delete",
      id: rel._id.toString(),
    });
  }

  // Delete conversations
  for (const conv of conversations) {
    await objects({
      action: "delete",
      id: conv._id.toString(),
    });
  }

  return conversations.length;
}
