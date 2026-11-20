import { z } from "zod";
import { ObjectId } from "mongodb";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import { env } from "#/env.ts";
import { callResource } from "@myceliasdk/resources.ts";

import {
  MAX_GAP_MS,
  MAX_SEQUENCE_LENGTH,
} from "@/lib/transcription-constants.ts";
import { mongoCursor } from "@/lib/mongo/cursor.ts";
import { getTriggerTiming } from "@/lib/jobs/trigger-config.ts";

export const schema = z.object({
  type: z.literal("transcription_sequence_creator"),
});

interface SpeechSequence {
  originalId: ObjectId;
  chunks: any[]; // Chunks in reverse chronological order (as added)
  isPartial: boolean; // True if sequence was split due to reaching MAX_LENGTH
  isContinuation: boolean; // True if this is a continuation of a previous sequence
}

export const transcriptionSequencePendingQuery = {
  "vad.has_speech": true,
  transcribed_at: { $eq: null },
  processing_by: { $eq: null },
  // The null bound skips assigned sequences in the index. The existence check
  // keeps explicitly null values out of the queue.
  transcription_sequence_id: { $eq: null, $exists: false },
  original_id: { $exists: true, $ne: null },
} as const;

function getLastChunk(seq: SpeechSequence) {
  return seq.chunks[seq.chunks.length - 1];
}

function getSequenceStart(seq: SpeechSequence): Date {
  return new Date(getLastChunk(seq).start);
}

function getMinIndex(seq: SpeechSequence): number {
  return getLastChunk(seq).index;
}

async function* getSpeechSequences(
  mongo: any,
  limit: number | null = null,
): AsyncIterableIterator<SpeechSequence> {
  const sequencesById = new Map<string, SpeechSequence>();
  let yielded = 0;

  const cursor = mongoCursor(
    mongo,
    "audio_chunks",
    transcriptionSequencePendingQuery,
    {
      sort: { start: -1 }, // DESCENDING - newest first
      projection: {
        _id: 1,
        original_id: 1,
        start: 1,
        index: 1,
        vad: 1,
        transcription_sequence_id: 1,
      },
    },
    200, // batch size
  );

  for await (const chunk of cursor) {
    if (limit !== null && yielded >= limit) {
      break;
    }

    if (!chunk || !chunk.vad?.has_speech) {
      continue;
    }

    const originalId = chunk.original_id;
    if (!originalId) {
      continue;
    }

    const originalIdStr = originalId.toString();
    const chunkStart = new Date(chunk.start);

    // Check for stale sequences (time gap > MAX_GAP_MS from current processing position)
    for (const [key, seq] of Array.from(sequencesById.entries())) {
      const seqStart = getSequenceStart(seq);
      const gapMs = seqStart.getTime() - chunkStart.getTime();

      if (gapMs > MAX_GAP_MS) {
        // Yield stale sequence unless it's a single-chunk continuation
        if (!seq.isContinuation || seq.chunks.length > 1) {
          yield seq;
          yielded++;
        }
        sequencesById.delete(key);
      }
    }

    const existingSeq = sequencesById.get(originalIdStr);

    // Check index continuity
    if (existingSeq) {
      const minIndex = getMinIndex(existingSeq);
      const expectedIndex = minIndex - 1; // Going backwards in time

      if (chunk.index !== expectedIndex) {
        // Index gap detected - yield the existing sequence and start fresh
        yield existingSeq;
        sequencesById.delete(originalIdStr);
        yielded++;
      }
    }

    // Get or create sequence for this original_id
    let seq = sequencesById.get(originalIdStr);
    if (!seq) {
      seq = {
        originalId: originalId,
        chunks: [],
        isPartial: false,
        isContinuation: false,
      };
      sequencesById.set(originalIdStr, seq);
    }

    // Add chunk to sequence (appending as we go backwards in time)
    seq.chunks.push(chunk);

    // Check if sequence exceeded maximum length
    if (seq.chunks.length > MAX_SEQUENCE_LENGTH) {
      // We have 31 chunks. The 31st chunk is the 'chunk' we just added.
      // The 30th chunk is the overlap chunk.
      const newChunk = seq.chunks.pop()!;
      const overlapChunk = seq.chunks[seq.chunks.length - 1];

      seq.isPartial = true;
      yield seq;
      yielded++;

      // Create continuation sequence with overlap chunk + the chunk we popped
      const continuationSeq: SpeechSequence = {
        originalId: originalId,
        chunks: [overlapChunk, newChunk],
        isPartial: false,
        isContinuation: true,
      };
      sequencesById.set(originalIdStr, continuationSeq);
    }
  }

  // Yield all remaining sequences
  for (const seq of sequencesById.values()) {
    yield seq;
  }
}

/**
 * Create database records for a sequence and update chunks.
 *
 * For partial sequences (isPartial=true):
 * - Mark all chunks EXCEPT the overlap chunk (last added)
 */
async function persistSequence(
  mongo: any,
  seq: SpeechSequence,
): Promise<number> {
  // Chunks are in reverse chronological order, reverse to get chronological
  const chunksInOrder = [...seq.chunks].reverse();
  let fromIndex = chunksInOrder[0].index;
  const toIndex = chunksInOrder[chunksInOrder.length - 1].index;
  let chunkCount = chunksInOrder.length;
  let start = chunksInOrder[0].start;

  // SPECIAL CASE: Single chunk sequence with index > 0
  // Include previous chunk as context/neighbor
  const isSingleChunkWithNeighbor = chunkCount === 1 && fromIndex > 0;
  if (isSingleChunkWithNeighbor) {
    fromIndex--;
    chunkCount++;
    // Estimate start time for N-1 (10s chunk duration)
    start = new Date(new Date(start).getTime() - 10000);
  }

  const sequenceId = new ObjectId();

  // Create sequence record
  await mongo({
    action: "insertOne",
    collection: "transcription_sequences",
    doc: {
      _id: sequenceId,
      original_id: seq.originalId,
      fromIndex,
      toIndex,
      chunk_count: chunkCount,
      start,
      end: chunksInOrder[chunksInOrder.length - 1].start,
      state: "ready",
      createdAt: new Date(),
      updatedAt: new Date(),
      is_continuation: seq.isContinuation,
    },
  });

  // Update chunks with sequence ID
  // For partial sequences: exclude the overlap chunk (last added)
  const chunksToUpdate = seq.isPartial
    ? seq.chunks.slice(0, -1) // All but the last added (the overlap)
    : seq.chunks;

  if (chunksToUpdate.length > 0) {
    const idsToUpdate = chunksToUpdate.map((c) => c._id);
    const query: any = isSingleChunkWithNeighbor
      ? {
        $or: [
          { _id: { $in: idsToUpdate } },
          {
            original_id: seq.originalId,
            index: fromIndex,
            transcription_sequence_id: { $exists: false },
          },
        ],
      }
      : {
        _id: { $in: idsToUpdate },
      };

    await mongo({
      action: "updateMany",
      collection: "audio_chunks",
      query,
      update: {
        $set: { transcription_sequence_id: sequenceId },
      },
    });
    return isSingleChunkWithNeighbor
      ? chunksToUpdate.length + 1
      : chunksToUpdate.length;
  }

  return 0;
}

const capability: JobCapability = {
  name: "transcription_sequence_creator",
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(z.object({
    status: z.literal("success"),
    processed: z.number(),
    hasMore: z.boolean(),
  })),
  policies: [
    { resource: "db/audio_chunks", action: "read", effect: "allow" },
    { resource: "db/audio_chunks", action: "update", effect: "allow" },
    {
      resource: "db/transcription_sequences",
      action: "write",
      effect: "allow",
    },
  ],
  maxConcurrency: 1,
  hasPendingWork: async ({ mongo }) => {
    const pending = await mongo({
      action: "find",
      collection: "audio_chunks",
      query: transcriptionSequencePendingQuery,
      options: {
        projection: { _id: 1 },
        hint: "audio_chunks_sequence_pending_stats",
        limit: 1,
      },
    }) as unknown[];
    return pending.length > 0 ? 1 : 0;
  },
  use: async (job) => {
    const jwt = Deno.env.get("MYCELIA_JWT")!;
    const myceliaUrl = Deno.env.get("MYCELIA_URL")!;
    const mongo = (input: any) =>
      callResource("mongo", input, { jwt, myceliaUrl });

    console.log(`[transcription_sequence_creator] Job ${job.id}: starting`);

    let processedCount = 0;
    let sequencesCreated = 0;
    let hasMore = false;
    const maxSequences = 30;

    for await (const seq of getSpeechSequences(mongo, maxSequences + 1)) {
      if (sequencesCreated >= maxSequences) {
        hasMore = true;
        break;
      }

      const seqStart = getSequenceStart(seq);
      const firstChunk = seq.chunks[0];
      const lastChunk = getLastChunk(seq);
      console.log(
        `[transcription_sequence_creator] Job ${job.id}: creating sequence for original ${seq.originalId} - ${seq.chunks.length} chunks (idx ${lastChunk.index}-${firstChunk.index}), start: ${seqStart.toISOString()}`,
      );

      processedCount += await persistSequence(mongo, seq);
      sequencesCreated++;

      await job.updateProgress({
        processed: processedCount,
        sequencesCreated,
      });
    }

    return { status: "success", processed: processedCount, hasMore };
  },
  triggers: {
    sources: [
      {
        channel: "mycelia:mongo:audio_chunks",
        name: "new_speech_chunk",
        filter: {
          event: "mongo.change",
          "data.operationType": { $in: ["insert", "update"] },
          "data.document.vad.has_speech": true,
          "data.document.transcription_sequence_id": { $exists: false },
        },
      },
    ],
    ...getTriggerTiming("transcription_sequence_creator"),
  },
};

export default capability;
