import { expect } from "@std/expect";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  getJobTimeoutMs,
  MEDIA_RECOGNITION_BATCH_TIMEOUT_MS,
} from "./job-timeouts.ts";

Deno.test("transcription timeout uses the snapshotted base and sequence allowance", () => {
  expect(getJobTimeoutMs("transcription", { batchSize: 8 })).toBe(
    10 * 60 * 1000,
  );
  expect(getJobTimeoutMs("transcription", {
    batchSize: 16,
    batchTimeoutBaseSeconds: 300,
    batchTimeoutPerSequenceSeconds: 120,
  })).toBe(
    37 * 60 * 1000,
  );
  expect(getJobTimeoutMs("transcription", { batchSize: 99 })).toBe(
    34 * 60 * 1000,
  );
  expect(getJobTimeoutMs("tagger", { batchSize: 8 })).toBe(
    DEFAULT_JOB_TIMEOUT_MS,
  );
});

Deno.test("folder imports are not terminated by the generic 15-minute timeout", () => {
  expect(getJobTimeoutMs("mediaFolderImport", {})).toBe(24 * 60 * 60 * 1000);
});

Deno.test("summarization timeout scales with batch size", () => {
  // Default batch of 25: 5 min base + 25 * 90s = 42.5 min
  expect(getJobTimeoutMs("summarization", {})).toBe(2_550_000);
  expect(getJobTimeoutMs("summarization", { batchSize: 25 })).toBe(2_550_000);
  // Small batches never drop below the legacy flat timeout
  expect(getJobTimeoutMs("summarization", { batchSize: 5 })).toBe(
    DEFAULT_JOB_TIMEOUT_MS,
  );
  // Out-of-bounds batch size is clamped to 100
  expect(getJobTimeoutMs("summarization", { batchSize: 9999 })).toBe(
    5 * 60 * 1000 + 100 * 90 * 1000,
  );
});

Deno.test("diarization timeout uses snapshotted batch and sequence bounds", () => {
  expect(getJobTimeoutMs("diarization", {
    batchSize: 4,
    maxSequenceChunks: 6,
  })).toBe(1_812_000);
  expect(getJobTimeoutMs("diarization", {
    batchSize: 8,
    maxSequenceChunks: 8,
  })).toBe(3_372_000);
  // Small jobs keep the 15-minute safety floor.
  expect(getJobTimeoutMs("diarization", {
    batchSize: 1,
    maxSequenceChunks: 1,
  })).toBe(DEFAULT_JOB_TIMEOUT_MS);
  // The largest accepted snapshot is capped at four hours.
  expect(getJobTimeoutMs("diarization", {
    batchSize: 32,
    maxSequenceChunks: 32,
  })).toBe(4 * 60 * 60 * 1000);
});

Deno.test("legacy diarization jobs retain the flat timeout", () => {
  expect(getJobTimeoutMs("diarization", { batchSize: 32 })).toBe(
    DEFAULT_JOB_TIMEOUT_MS,
  );
  expect(getJobTimeoutMs("diarization", {})).toBe(DEFAULT_JOB_TIMEOUT_MS);
});

Deno.test("manual summarization jobs keep the flat timeout", () => {
  expect(getJobTimeoutMs("summarization", { objectId: "abc", batchSize: 25 }))
    .toBe(DEFAULT_JOB_TIMEOUT_MS);
  expect(getJobTimeoutMs("summarization", {
    start: "2026-01-01T00:00:00Z",
    end: "2026-01-01T01:00:00Z",
    batchSize: 25,
  })).toBe(DEFAULT_JOB_TIMEOUT_MS);
});

Deno.test("object density rebuild has a controlled one-hour timeout", () => {
  expect(getJobTimeoutMs("objectTimelineDensityRebuild", {})).toBe(3_600_000);
});

Deno.test("media recognition coordinator has a controlled 24-hour timeout", () => {
  expect(getJobTimeoutMs("mediaRecognitionBatch", {})).toBe(
    MEDIA_RECOGNITION_BATCH_TIMEOUT_MS,
  );
  expect(MEDIA_RECOGNITION_BATCH_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
});
