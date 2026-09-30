import type { JobData } from "./types.ts";

export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;
export const MEDIA_RECOGNITION_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MEDIA_FOLDER_IMPORT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TRANSCRIPTION_TIMEOUT_BASE_MS = 2 * 60 * 1000;
export const DEFAULT_TRANSCRIPTION_TIMEOUT_PER_SEQUENCE_MS = 60 * 1000;
export const MAX_TRANSCRIPTION_BATCH_SIZE = 32;
export const SUMMARIZATION_TIMEOUT_BASE_MS = 5 * 60 * 1000;
export const SUMMARIZATION_TIMEOUT_PER_ITEM_MS = 90 * 1000;
export const DEFAULT_SUMMARIZATION_BATCH_SIZE = 25;
export const MAX_SUMMARIZATION_BATCH_SIZE = 100;
export const MAX_DIARIZATION_BATCH_SIZE = 32;
export const MAX_DIARIZATION_SEQUENCE_CHUNKS = 32;
export const DEFAULT_DIARIZATION_BATCH_SIZE = 4;
export const DEFAULT_DIARIZATION_MAX_SEQUENCE_CHUNKS = 6;
export const DIARIZATION_TIMEOUT_BASE_SECONDS = 300;
export const DIARIZATION_TIMEOUT_PER_SEQUENCE_SECONDS = 360;
export const DIARIZATION_TIMEOUT_PER_CHUNK_SECONDS = 3;
export const MAX_DIARIZATION_TIMEOUT_SECONDS = 4 * 60 * 60;

function readBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min
    ? Math.min(parsed, max)
    : fallback;
}

function getSummarizationTimeoutMs(
  data?: Record<string, unknown>,
): number {
  // Manual jobs (explicit objectId or start/end range) process exactly one
  // conversation regardless of batchSize.
  const isManual = Boolean(data?.objectId) ||
    (data?.start != null && data?.end != null);
  const items = isManual ? 1 : readBoundedInteger(
    data?.batchSize,
    DEFAULT_SUMMARIZATION_BATCH_SIZE,
    1,
    MAX_SUMMARIZATION_BATCH_SIZE,
  );
  // The 15-minute floor keeps manual jobs at their previous behavior and keeps
  // the maintenance-manager pre-filter (DEFAULT_JOB_TIMEOUT_MS cutoff) a
  // superset of the per-job check.
  return Math.max(
    DEFAULT_JOB_TIMEOUT_MS,
    SUMMARIZATION_TIMEOUT_BASE_MS + SUMMARIZATION_TIMEOUT_PER_ITEM_MS * items,
  );
}

function getDiarizationTimeoutMs(
  data?: Record<string, unknown>,
): number {
  // Jobs created before maxSequenceChunks was snapshotted must retain the
  // historical 15-minute timeout; their actual Python environment is unknown.
  if (data?.maxSequenceChunks === undefined) return DEFAULT_JOB_TIMEOUT_MS;

  const batchSize = readBoundedInteger(
    data.batchSize,
    DEFAULT_DIARIZATION_BATCH_SIZE,
    1,
    MAX_DIARIZATION_BATCH_SIZE,
  );
  const maxSequenceChunks = readBoundedInteger(
    data.maxSequenceChunks,
    DEFAULT_DIARIZATION_MAX_SEQUENCE_CHUNKS,
    1,
    MAX_DIARIZATION_SEQUENCE_CHUNKS,
  );
  const timeoutSeconds = DIARIZATION_TIMEOUT_BASE_SECONDS + batchSize *
      (
        DIARIZATION_TIMEOUT_PER_SEQUENCE_SECONDS +
        DIARIZATION_TIMEOUT_PER_CHUNK_SECONDS * maxSequenceChunks
      );
  return Math.min(
    MAX_DIARIZATION_TIMEOUT_SECONDS * 1000,
    Math.max(DEFAULT_JOB_TIMEOUT_MS, timeoutSeconds * 1000),
  );
}

export function getJobTimeoutMs(
  jobType: string,
  data?: Partial<JobData> | Record<string, unknown>,
): number {
  if (jobType === "mediaRecognitionBatch") {
    return MEDIA_RECOGNITION_BATCH_TIMEOUT_MS;
  }
  if (jobType === "mediaFolderImport") return MEDIA_FOLDER_IMPORT_TIMEOUT_MS;
  if (jobType === "objectTimelineDensityRebuild") {
    return 60 * 60 * 1000;
  }
  if (jobType === "summarization") {
    return getSummarizationTimeoutMs(data as Record<string, unknown>);
  }
  if (jobType === "diarization") {
    return getDiarizationTimeoutMs(data as Record<string, unknown>);
  }
  if (jobType !== "transcription") return DEFAULT_JOB_TIMEOUT_MS;

  const transcriptionData = data as Record<string, unknown> | undefined;
  const batchSize = readBoundedInteger(
    transcriptionData?.batchSize,
    1,
    1,
    MAX_TRANSCRIPTION_BATCH_SIZE,
  );
  const baseMs = readBoundedInteger(
    transcriptionData?.batchTimeoutBaseSeconds,
    DEFAULT_TRANSCRIPTION_TIMEOUT_BASE_MS / 1000,
    60,
    1800,
  ) * 1000;
  const perSequenceMs = readBoundedInteger(
    transcriptionData?.batchTimeoutPerSequenceSeconds,
    DEFAULT_TRANSCRIPTION_TIMEOUT_PER_SEQUENCE_MS / 1000,
    15,
    300,
  ) * 1000;
  return baseMs + perSequenceMs * batchSize;
}

export function getJobTimeoutMinutes(
  jobType: string,
  data?: Partial<JobData> | Record<string, unknown>,
): number {
  return getJobTimeoutMs(jobType, data) / 60_000;
}
