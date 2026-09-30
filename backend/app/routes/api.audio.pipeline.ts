import type { Request, Response } from "express";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { EJSON } from "bson";
import { ObjectId } from "mongodb";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { saveAudioOperations } from "@/lib/audio-operations.ts";

const PIPELINE_STAGES = [
  { type: "ingestion", label: "Ingestion" },
  { type: "vad", label: "Voice activity" },
  { type: "transcription_sequence_creator", label: "Sequence creation" },
  { type: "transcription", label: "Transcription" },
  { type: "conversation_chunk_creator", label: "Conversation chunks" },
  { type: "conversation_extractor_merged", label: "Conversation extraction" },
  { type: "summarization", label: "Summarization" },
  { type: "diarization", label: "Speaker diarization" },
  { type: "speakerMatching", label: "Legacy speaker matching" },
  { type: "speakerIdentity", label: "Speaker identity" },
  { type: "enrollment", label: "Voice enrollment" },
] as const;

const PIPELINE_STATS_MAX_TIME_MS = 6_000;
const PIPELINE_DETAILS_MAX_TIME_MS = 2_000;
const DIARIZATION_BACKLOG_PROBE_MAX_TIME_MS = 1_000;
const MAX_AUDIO_CHUNK_SECONDS = 10;
const PIPELINE_SNAPSHOT_CACHE_MS = 5 * 60_000;
const PIPELINE_PARTIAL_SNAPSHOT_CACHE_MS = 60_000;
const pipelineSnapshotCache = new Map<
  string,
  { expiresAt: number; value: unknown }
>();
const pipelineSnapshotInFlight = new Map<
  string,
  Promise<unknown | undefined>
>();
const pipelineSnapshotBackoffUntil = new Map<string, number>();
const PIPELINE_SNAPSHOT_RETRY_BACKOFF_MS = 2 * 60_000;

function isMissingIndexHint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(
    "hint provided does not correspond to an existing index",
  );
}

async function aggregatePipelineStats(
  mongo: ReturnType<typeof getMongoResource>,
  collection: string,
  pipeline: Record<string, unknown>[],
  hint: string,
  maxTimeMS = PIPELINE_STATS_MAX_TIME_MS,
): Promise<any[]> {
  try {
    return await mongo({
      action: "aggregate",
      collection,
      pipeline,
      options: { hint, maxTimeMS },
    });
  } catch (error) {
    if (!isMissingIndexHint(error)) throw error;

    console.warn(
      `[audio-pipeline] Statistics index ${hint} is unavailable; retrying without a hint`,
    );
    return await mongo({
      action: "aggregate",
      collection,
      pipeline,
      options: { maxTimeMS },
    });
  }
}

function countPipelineStats(
  mongo: ReturnType<typeof getMongoResource>,
  collection: string,
  query: Record<string, unknown>,
): Promise<number> {
  return mongo({
    action: "count" as const,
    collection,
    query,
    options: { maxTimeMS: PIPELINE_STATS_MAX_TIME_MS },
  }) as Promise<number>;
}

async function hasDiarizationBacklog(
  mongo: ReturnType<typeof getMongoResource>,
): Promise<boolean> {
  const request = {
    action: "findOne" as const,
    collection: "audio_chunks",
    query: {
      "vad.has_speech": true,
      diarized_at: null,
      processing_by: null,
      "diarizationFailure.status": { $ne: "needs_attention" },
      "diarizationFailure.retryAt": { $not: { $gt: new Date() } },
    },
    options: {
      hint: "audio_chunks_diarization_ready_backlog_v1",
      projection: { _id: 1 },
      maxTimeMS: DIARIZATION_BACKLOG_PROBE_MAX_TIME_MS,
    },
  };
  try {
    return Boolean(await mongo(request));
  } catch (error) {
    if (!isMissingIndexHint(error)) throw error;
    return Boolean(
      await mongo({
        ...request,
        options: {
          projection: { _id: 1 },
          maxTimeMS: DIARIZATION_BACKLOG_PROBE_MAX_TIME_MS,
        },
      }),
    );
  }
}

async function hasSpeakerIdentityBacklog(
  mongo: ReturnType<typeof getMongoResource>,
): Promise<boolean> {
  const request = {
    action: "findOne" as const,
    collection: "diarizations",
    query: {
      lifecycleStatus: "active",
      embedding: { $exists: true },
      "speakerIdentity.identityState": { $exists: false },
    },
    options: {
      hint: "pipeline_speaker_identity_state",
      projection: { _id: 1 },
      maxTimeMS: DIARIZATION_BACKLOG_PROBE_MAX_TIME_MS,
    },
  };
  try {
    return Boolean(await mongo(request));
  } catch (error) {
    if (!isMissingIndexHint(error)) throw error;
    return Boolean(
      await mongo({
        ...request,
        options: {
          projection: { _id: 1 },
          maxTimeMS: DIARIZATION_BACKLOG_PROBE_MAX_TIME_MS,
        },
      }),
    );
  }
}

interface PipelineSession {
  _id: string;
  start?: Date;
  lastActivityAt?: Date;
  path?: string;
  sourceKind: string;
  ingested: boolean;
  ingestionError?: string;
  client_id?: string;
  device?: string;
  metadata?: {
    format?: string;
    rate?: number;
    width?: number;
    channels?: number;
    source?: string;
    codec?: string;
  };
  processing_status?: string;
  chunks: {
    total: number;
    vadProcessed: number;
    withSpeech: number;
  };
  sequences: Array<{
    _id: string;
    state: string;
    chunk_count: number;
    fromIndex: number;
    toIndex: number;
    updatedAt?: Date;
    error?: string;
  }>;
  transcriptions: number;
  conversationChunks: Array<{
    _id: string;
    state: string;
    mode?: string;
    transcriptionCount: number;
    totalTextLength: number;
    start?: Date;
    end?: Date;
    updatedAt?: Date;
    error?: string;
    emptyReason?: string;
    segmentsFound?: number;
    conversationsCreated?: number;
  }>;
  transcriptionDetails: Array<{
    _id: string;
    start: Date;
    end: Date;
    text: string;
  }>;
  conversations: Array<{
    _id: string;
    name: string;
    icon?: { text?: string };
    timeRanges?: Array<{ start: string; end: string }>;
    createdAt?: Date;
  }>;
}

interface PipelineStats {
  warnings?: string[];
  totalSessions: number;
  totalChunks: number;
  chunksVadProcessed: number;
  chunksAwaitingVad: number;
  vadProcessedLast15Minutes: number;
  vadRatePerMinute: number;
  vadEtaSeconds?: number;
  vadLastProcessedAt?: Date;
  vadJobs: {
    active: number;
    waiting: number;
    delayed: number;
    completed: number;
    failed: number;
    cancelled: number;
    latestFailure?: string;
    latestFailureAt?: Date;
    recentFailures: Array<{
      id: string;
      failedAt?: Date;
      reason?: string;
    }>;
  };
  sequencesReady: number;
  sequencesProcessing: number;
  sequencesError: number;
  transcriptionPendingChunks: number;
  transcriptionPendingMaximumHours: number;
  convChunksReady: number;
  convChunksProcessing: number;
  convChunksError: number;
  totalConversations: number;
  sourceFiles: {
    total: number;
    ingested: number;
    pending: number;
    errors: number;
    byKind: Array<{ kind: string; count: number }>;
  };
  diarizationCampaign: DiarizationCampaignSummary | null;
  stages: Array<{
    type: string;
    label: string;
    backlog: number;
    backlogStatus: "exact" | "estimated" | "exists" | "unavailable";
    backlogAsOf?: Date;
    errors: number;
    paused: boolean;
    active: number;
    waiting: number;
    delayed: number;
    failed: number;
    latestJob?: {
      id: string;
      state: string;
      updatedAt?: Date;
      failedReason?: string;
    };
  }>;
  recentJobs: Array<{
    id: string;
    type: string;
    state: string;
    createdAt?: Date;
    updatedAt?: Date;
    startedAt?: Date;
    finishedAt?: Date;
    failedReason?: string;
    progress?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
}

export interface DiarizationCampaignSummary {
  campaignId: string;
  status: string;
  updatedAt?: Date;
  processedChunks: number;
  totalChunks: number | null;
  pendingChunks: number | null;
  processedSequences: number;
  segmentsCreated: number;
  errorCount: number;
  chunksPerSecond: number | null;
  rateStatus: "live" | "aggregate" | "warming" | "legacy";
  rateSampleCount: number;
  sampledLanes: number;
  activeRateJobCount: number;
  activeRateReportingJobCount: number;
  activeRateLaneCount: number;
  usefulAudioRealtimeMultiple: number | null;
  rateWindowSeconds: number | null;
  successfulSequences: number;
  skippedSequences: number;
  recordingLeaseBusyOriginals: number;
  recordingLeaseSkippedSequences: number;
  chunkClaimSkips: number;
  skipRatio: number | null;
  leaseSkipRatio: number | null;
  claimSkipRatio: number | null;
  stageTimingsMs: Record<string, DiarizationStageTimingSummary>;
  etaSeconds: number | null;
  batchNumber: number | null;
  estimatedBatches: number | null;
  totalEstimated: boolean;
}

interface DiarizationStageTimingSummary {
  count: number;
  total: number;
  avg: number;
  max: number;
}

export const DIARIZATION_RATE_WINDOW_SECONDS = 5 * 60;
const DIARIZATION_RATE_WINDOW_MS = DIARIZATION_RATE_WINDOW_SECONDS * 1000;
const DIARIZATION_RATE_SAMPLE_LIMIT = 500;

interface PipelineBacklogSnapshot {
  count: number;
  status: "exact" | "estimated" | "exists" | "unavailable";
  asOf?: Date;
}

function getDiarizationBacklogSnapshot(
  hasPending: boolean | null,
  campaign: DiarizationCampaignSummary | null,
): PipelineBacklogSnapshot {
  if (hasPending === false) {
    return { count: 0, status: "exact" };
  }

  if (campaign?.pendingChunks != null) {
    return {
      count: hasPending === true
        ? Math.max(campaign.pendingChunks, 1)
        : campaign.pendingChunks,
      status: "estimated",
      asOf: campaign.updatedAt,
    };
  }

  if (hasPending === true) {
    return { count: 1, status: "exists" };
  }

  return { count: 0, status: "unavailable" };
}

const GLOBAL_DIARIZATION_CAMPAIGN_QUERY = {
  mode: "missing",
  $or: [{ originalId: null }, { originalId: { $exists: false } }],
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function getDiarizationCampaignSummary(
  mongo: ReturnType<typeof getMongoResource>,
): Promise<DiarizationCampaignSummary | null> {
  const findLatest = async (statuses: string[]) => {
    return (await mongo({
      action: "find",
      collection: "diarization_campaigns",
      query: {
        ...GLOBAL_DIARIZATION_CAMPAIGN_QUERY,
        status: { $in: statuses },
      },
      options: {
        sort: { updatedAt: -1 },
        limit: 1,
        projection: {
          campaignId: 1,
          status: 1,
          updatedAt: 1,
          processedChunks: 1,
          totalChunks: 1,
          pendingChunks: 1,
          processedSequences: 1,
          segmentsCreated: 1,
          errorCount: 1,
          chunksPerSecond: 1,
          etaSeconds: 1,
          batchNumber: 1,
          estimatedBatches: 1,
          totalEstimated: 1,
        },
      },
    }) as Record<string, unknown>[])?.[0];
  };

  const campaign = await findLatest(["counting", "running", "interrupted"]) ??
    await findLatest(["completed", "completed_with_errors"]);
  if (!campaign || typeof campaign.campaignId !== "string") return null;

  const rateWindowEndMs = Date.now();
  const rateWindowStart = new Date(
    rateWindowEndMs - DIARIZATION_RATE_WINDOW_MS,
  );
  const rateSamples = await mongo({
    action: "find",
    collection: "diarization_campaign_rate_samples",
    query: {
      campaignId: campaign.campaignId,
      finishedAt: { $gte: rateWindowStart },
    },
    options: {
      // Bound work to the freshest samples. Aggregation does not depend on
      // result order, but ascending+limit would silently discard current rate.
      sort: { finishedAt: -1 },
      limit: DIARIZATION_RATE_SAMPLE_LIMIT,
      projection: {
        startedAt: 1,
        finishedAt: 1,
        chunksProcessed: 1,
        audioSecondsProcessed: 1,
        providerProfileId: 1,
        successfulSequences: 1,
        skippedSequences: 1,
        recordingLeaseBusyOriginals: 1,
        recordingLeaseSkippedSequences: 1,
        chunkClaimSkips: 1,
        stageTimingsMs: 1,
      },
    },
  }) as Record<string, unknown>[];

  const timedSamples = (rateSamples ?? []).filter((sample) =>
    sample.startedAt instanceof Date && sample.finishedAt instanceof Date &&
    sample.finishedAt.getTime() >= sample.startedAt.getTime()
  );
  const rollingSamples = timedSamples.flatMap((sample) => {
    const startedAtMs = (sample.startedAt as Date).getTime();
    const finishedAtMs = (sample.finishedAt as Date).getTime();
    const durationSeconds = (finishedAtMs - startedAtMs) / 1000;
    const overlapStartedAtMs = Math.max(
      startedAtMs,
      rateWindowStart.getTime(),
    );
    const overlapFinishedAtMs = Math.min(finishedAtMs, rateWindowEndMs);
    const overlapSeconds = (overlapFinishedAtMs - overlapStartedAtMs) / 1000;
    if (durationSeconds <= 0 || overlapSeconds <= 0) return [];
    const overlapShare = overlapSeconds / durationSeconds;
    return [{
      overlapStartedAtMs,
      chunks: Math.max(finiteNumber(sample.chunksProcessed) ?? 0, 0) *
        overlapShare,
      audioSeconds:
        Math.max(finiteNumber(sample.audioSecondsProcessed) ?? 0, 0) *
        overlapShare,
    }];
  });
  const sampleWindowSeconds = rollingSamples.length > 0
    ? Math.max(
      1,
      (rateWindowEndMs - Math.min(
        ...rollingSamples.map((sample) => sample.overlapStartedAtMs),
      )) / 1000,
    )
    : null;
  const sampleChunks = rollingSamples.reduce(
    (total, sample) => total + sample.chunks,
    0,
  );
  const sampleAudioSeconds = rollingSamples.reduce(
    (total, sample) => total + sample.audioSeconds,
    0,
  );
  const successfulSequences = timedSamples.reduce(
    (total, sample) =>
      total + Math.max(finiteNumber(sample.successfulSequences) ?? 0, 0),
    0,
  );
  const skippedSequences = timedSamples.reduce(
    (total, sample) =>
      total + Math.max(
        finiteNumber(sample.skippedSequences) ??
          (finiteNumber(sample.recordingLeaseSkippedSequences) ?? 0) +
            (finiteNumber(sample.chunkClaimSkips) ?? 0),
        0,
      ),
    0,
  );
  const recordingLeaseBusyOriginals = timedSamples.reduce(
    (total, sample) =>
      total + Math.max(
        finiteNumber(sample.recordingLeaseBusyOriginals) ?? 0,
        0,
      ),
    0,
  );
  const recordingLeaseSkippedSequences = timedSamples.reduce(
    (total, sample) =>
      total + Math.max(
        finiteNumber(sample.recordingLeaseSkippedSequences) ?? 0,
        0,
      ),
    0,
  );
  const chunkClaimSkips = timedSamples.reduce(
    (total, sample) =>
      total + Math.max(finiteNumber(sample.chunkClaimSkips) ?? 0, 0),
    0,
  );
  const stageTimingTotals = new Map<
    string,
    { count: number; total: number; max: number }
  >();
  for (const sample of timedSamples) {
    const sampleTimings = sample.stageTimingsMs;
    if (
      typeof sampleTimings !== "object" || sampleTimings === null ||
      Array.isArray(sampleTimings)
    ) {
      continue;
    }
    for (const [stage, timing] of Object.entries(sampleTimings)) {
      if (
        typeof timing !== "object" || timing === null || Array.isArray(timing)
      ) {
        continue;
      }
      const value = timing as Record<string, unknown>;
      const count = Math.max(finiteNumber(value.count) ?? 0, 0);
      const total = Math.max(finiteNumber(value.total) ?? 0, 0);
      const max = Math.max(finiteNumber(value.max) ?? 0, 0);
      if (count <= 0) continue;
      const aggregate = stageTimingTotals.get(stage) ?? {
        count: 0,
        total: 0,
        max: 0,
      };
      aggregate.count += count;
      aggregate.total += total;
      aggregate.max = Math.max(aggregate.max, max);
      stageTimingTotals.set(stage, aggregate);
    }
  }
  const stageTimingsMs = Object.fromEntries(
    [...stageTimingTotals.entries()].map(([stage, timing]) => [
      stage,
      {
        count: timing.count,
        total: timing.total,
        avg: timing.total / timing.count,
        max: timing.max,
      },
    ]),
  );
  const aggregateChunksPerSecond =
    sampleWindowSeconds != null && sampleChunks > 0
      ? sampleChunks / sampleWindowSeconds
      : null;
  const usefulAudioRealtimeMultiple = sampleWindowSeconds != null &&
      sampleAudioSeconds > 0
    ? sampleAudioSeconds / sampleWindowSeconds
    : null;
  const sampledLanes = new Set(
    timedSamples
      .map((sample) => sample.providerProfileId)
      .filter((value): value is string =>
        typeof value === "string" && value.length > 0
      ),
  ).size;
  const ratioToSuccessfulSequences = (skips: number): number | null =>
    successfulSequences > 0
      ? skips / successfulSequences
      : skips > 0
      ? 1
      : null;

  const processedChunks = Math.max(
    finiteNumber(campaign.processedChunks) ?? 0,
    0,
  );
  const totalChunksValue = finiteNumber(campaign.totalChunks);
  const totalChunks = totalChunksValue == null
    ? null
    : Math.max(totalChunksValue, 0);
  const pendingChunksValue = finiteNumber(campaign.pendingChunks);
  const pendingChunks = pendingChunksValue != null
    ? Math.max(pendingChunksValue, 0)
    : totalChunks != null
    ? Math.max(totalChunks - processedChunks, 0)
    : null;
  const chunksPerSecondValue = aggregateChunksPerSecond ??
    finiteNumber(campaign.chunksPerSecond);
  const rateStatus = aggregateChunksPerSecond != null
    ? "aggregate"
    : chunksPerSecondValue != null
    ? "legacy"
    : "warming";
  const etaSecondsValue =
    chunksPerSecondValue != null && chunksPerSecondValue > 0 &&
      pendingChunks != null
      ? pendingChunks / chunksPerSecondValue
      : finiteNumber(campaign.etaSeconds);

  return {
    campaignId: campaign.campaignId,
    status: typeof campaign.status === "string" ? campaign.status : "unknown",
    updatedAt: campaign.updatedAt instanceof Date
      ? campaign.updatedAt
      : undefined,
    processedChunks,
    totalChunks,
    pendingChunks,
    processedSequences: Math.max(
      finiteNumber(campaign.processedSequences) ?? 0,
      0,
    ),
    segmentsCreated: Math.max(
      finiteNumber(campaign.segmentsCreated) ?? 0,
      0,
    ),
    errorCount: Math.max(finiteNumber(campaign.errorCount) ?? 0, 0),
    chunksPerSecond: chunksPerSecondValue != null && chunksPerSecondValue > 0
      ? chunksPerSecondValue
      : null,
    rateStatus,
    rateSampleCount: timedSamples.length,
    sampledLanes,
    activeRateJobCount: 0,
    activeRateReportingJobCount: 0,
    activeRateLaneCount: 0,
    usefulAudioRealtimeMultiple,
    rateWindowSeconds: sampleWindowSeconds,
    successfulSequences,
    skippedSequences,
    recordingLeaseBusyOriginals,
    recordingLeaseSkippedSequences,
    chunkClaimSkips,
    skipRatio: ratioToSuccessfulSequences(skippedSequences),
    leaseSkipRatio: ratioToSuccessfulSequences(
      recordingLeaseSkippedSequences,
    ),
    claimSkipRatio: ratioToSuccessfulSequences(chunkClaimSkips),
    stageTimingsMs,
    etaSeconds: etaSecondsValue != null && etaSecondsValue >= 0
      ? etaSecondsValue
      : null,
    batchNumber: finiteNumber(campaign.batchNumber),
    estimatedBatches: finiteNumber(campaign.estimatedBatches),
    totalEstimated: campaign.totalEstimated === true,
  };
}

function sourceKind(sourceFile: any): string {
  return sourceFile.metadata?.source ?? sourceFile.importer ??
    sourceFile.platform?.importer ?? sourceFile.platform?.system ?? "unknown";
}

function ingestionError(sourceFile: any): string | undefined {
  // Older daemon versions retained the cached error after a successful retry.
  // The completed state is authoritative; do not present stale history as a
  // current pipeline failure.
  if (sourceFile.ingested === true) return undefined;
  const error = sourceFile.ingestion?.error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  return error.message ?? JSON.stringify(error);
}

type VadPipelineStats = Pick<
  PipelineStats,
  | "totalChunks"
  | "chunksVadProcessed"
  | "chunksAwaitingVad"
  | "vadProcessedLast15Minutes"
  | "vadRatePerMinute"
  | "vadEtaSeconds"
  | "vadLastProcessedAt"
  | "vadJobs"
>;

type VadChunkStats = Pick<
  PipelineStats,
  "totalChunks" | "chunksVadProcessed" | "chunksAwaitingVad"
>;

const VAD_CHUNK_STATS_CACHE_MS = 30_000;
let vadChunkStatsCache:
  | { expiresAt: number; value: VadChunkStats }
  | undefined;
let vadChunkStatsInFlight: Promise<VadChunkStats> | undefined;

async function getVadChunkStats(
  mongo: ReturnType<typeof getMongoResource>,
): Promise<VadChunkStats> {
  if (vadChunkStatsCache && vadChunkStatsCache.expiresAt > Date.now()) {
    return vadChunkStatsCache.value;
  }

  if (!vadChunkStatsInFlight) {
    vadChunkStatsInFlight = (async () => {
      const processedVadPipeline = [
        { $match: { "vad.ran_at": { $lte: new Date() } } },
        { $count: "count" },
      ];
      const loadProcessedVadStats = async () => {
        try {
          return await mongo({
            action: "aggregate",
            collection: "audio_chunks",
            pipeline: processedVadPipeline,
            options: {
              hint: "audio_chunks_vad_processed",
              maxTimeMS: PIPELINE_STATS_MAX_TIME_MS,
            },
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          if (
            !message.includes(
              "hint provided does not correspond to an existing index",
            )
          ) {
            throw error;
          }

          console.warn(
            "[audio-pipeline] VAD statistics index is unavailable; retrying without a hint",
          );
          return await mongo({
            action: "aggregate",
            collection: "audio_chunks",
            pipeline: processedVadPipeline,
            options: { maxTimeMS: PIPELINE_STATS_MAX_TIME_MS },
          });
        }
      };

      const [totalChunkStats, processedVadStats] = await Promise.all([
        mongo({
          action: "aggregate",
          collection: "audio_chunks",
          pipeline: [
            { $collStats: { count: {} } },
            { $project: { _id: 0, count: "$count" } },
          ],
        }),
        loadProcessedVadStats(),
      ]);

      const totalChunks = totalChunkStats[0]?.count ?? 0;
      const chunksVadProcessed = processedVadStats[0]?.count ?? 0;
      const chunksAwaitingVad = Math.max(totalChunks - chunksVadProcessed, 0);

      const value: VadChunkStats = {
        totalChunks,
        chunksVadProcessed,
        chunksAwaitingVad,
      };

      vadChunkStatsCache = {
        expiresAt: Date.now() + VAD_CHUNK_STATS_CACHE_MS,
        value,
      };
      return value;
    })().finally(() => {
      vadChunkStatsInFlight = undefined;
    });
  }

  return vadChunkStatsInFlight;
}

async function getVadPipelineStats(
  mongo: ReturnType<typeof getMongoResource>,
): Promise<VadPipelineStats> {
  const vadRateWindowMinutes = 15;
  const vadRateWindowStart = new Date(
    Date.now() - vadRateWindowMinutes * 60 * 1000,
  );
  const [chunkStats, vadJobStatsResult, recentFailedVadJobs] = await Promise
    .all([
      getVadChunkStats(mongo),
      mongo({
        action: "aggregate",
        collection: "jobs",
        pipeline: [
          {
            $match: {
              type: "vad",
              dismissedAt: { $exists: false },
            },
          },
          {
            $group: {
              _id: null,
              active: {
                $sum: { $cond: [{ $eq: ["$state", "active"] }, 1, 0] },
              },
              waiting: {
                $sum: { $cond: [{ $eq: ["$state", "waiting"] }, 1, 0] },
              },
              delayed: {
                $sum: { $cond: [{ $eq: ["$state", "delayed"] }, 1, 0] },
              },
              completed: {
                $sum: { $cond: [{ $eq: ["$state", "completed"] }, 1, 0] },
              },
              failed: {
                $sum: { $cond: [{ $eq: ["$state", "failed"] }, 1, 0] },
              },
              cancelled: {
                $sum: { $cond: [{ $eq: ["$state", "cancelled"] }, 1, 0] },
              },
              vadProcessedLast15Minutes: {
                $sum: {
                  $cond: [
                    { $gte: ["$finishedAt", vadRateWindowStart] },
                    { $ifNull: ["$result.processed", 0] },
                    0,
                  ],
                },
              },
              vadLastProcessedAt: { $max: "$finishedAt" },
            },
          },
          { $project: { _id: 0 } },
        ],
      }),
      mongo({
        action: "find",
        collection: "jobs",
        query: {
          type: "vad",
          state: "failed",
          dismissedAt: { $exists: false },
        },
        options: {
          projection: { failedReason: 1, finishedAt: 1, createdAt: 1 },
          sort: { finishedAt: -1, createdAt: -1 },
          limit: 5,
        },
      }),
    ]);

  const vadJobStats = vadJobStatsResult[0] ?? {};
  const vadProcessedLast15Minutes = vadJobStats.vadProcessedLast15Minutes ?? 0;
  const vadRatePerMinute = vadProcessedLast15Minutes / vadRateWindowMinutes;
  const vadEtaSeconds = vadRatePerMinute > 0 && chunkStats.chunksAwaitingVad > 0
    ? Math.ceil(chunkStats.chunksAwaitingVad / vadRatePerMinute * 60)
    : undefined;
  const recentFailures = recentFailedVadJobs.map((job: any) => ({
    id: job._id.toString(),
    failedAt: job.finishedAt ?? job.createdAt,
    reason: job.failedReason,
  }));

  return {
    ...chunkStats,
    vadProcessedLast15Minutes,
    vadRatePerMinute,
    vadEtaSeconds,
    vadLastProcessedAt: vadJobStats.vadLastProcessedAt,
    vadJobs: {
      active: vadJobStats.active ?? 0,
      waiting: vadJobStats.waiting ?? 0,
      delayed: vadJobStats.delayed ?? 0,
      completed: vadJobStats.completed ?? 0,
      failed: vadJobStats.failed ?? 0,
      cancelled: vadJobStats.cancelled ?? 0,
      latestFailure: recentFailures[0]?.reason,
      latestFailureAt: recentFailures[0]?.failedAt,
      recentFailures,
    },
  };
}

export async function apiAudioPipelineHandler(req: Request, res: Response) {
  let snapshotKey: string | undefined;
  let finishSnapshot: ((value: unknown | undefined) => void) | undefined;
  try {
    const auth = await authenticateOr401(req, res);

    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const includeSources = req.query.includeSources !== "false";
    if (!includeSources) {
      snapshotKey = `stats-only:${limit}`;
      const cachedSnapshot = pipelineSnapshotCache.get(snapshotKey);
      if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) {
        res.json(cachedSnapshot.value);
        return;
      }
      if (
        (pipelineSnapshotBackoffUntil.get(snapshotKey) ?? 0) > Date.now() &&
        cachedSnapshot
      ) {
        res.json(cachedSnapshot.value);
        return;
      }
      const existingSnapshot = pipelineSnapshotInFlight.get(snapshotKey);
      if (existingSnapshot) {
        const shared = await existingSnapshot;
        if (shared !== undefined) {
          res.json(shared);
          return;
        }
      }
      const snapshotPromise = new Promise<unknown | undefined>((resolve) => {
        finishSnapshot = resolve;
      });
      pipelineSnapshotInFlight.set(snapshotKey, snapshotPromise);
    }
    const mongo = getMongoResource(auth);
    const warnings: string[] = [];
    const failedStatsLabels: string[] = [];
    const safeStat = async <T>(
      label: string,
      promise: Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await promise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${label}: ${message}`);
        failedStatsLabels.push(label);
        console.warn(`[audio-pipeline] ${label} unavailable: ${message}`);
        return fallback;
      }
    };

    // Source activity and recording time are different. Imported recordings can
    // be old while their processing is happening now, so order by the newest
    // known activity timestamp and include every source kind.
    const sourceFiles = includeSources
      ? await safeStat(
        "recent audio sources",
        mongo({
          action: "find",
          collection: "source_files",
          query: {},
          options: {
            sort: { updatedAt: -1, start: -1 },
            limit: limit + 1,
            maxTimeMS: PIPELINE_DETAILS_MAX_TIME_MS,
          },
        }) as Promise<any[]>,
        [],
      )
      : [];

    const hasMore = sourceFiles.length > limit;
    const filesToProcess = sourceFiles.slice(0, limit);

    const sourceIds = filesToProcess.map((sourceFile) => sourceFile._id);
    const [
      chunkGroups,
      sequenceDocs,
      transcriptionGroups,
      conversationChunkDocs,
    ] = sourceIds.length > 0
      ? await Promise.all([
        safeStat(
          "recent source chunk coverage",
          aggregatePipelineStats(
            mongo,
            "audio_chunks",
            [
              { $match: { original_id: { $in: sourceIds } } },
              {
                $group: {
                  _id: "$original_id",
                  total: { $sum: 1 },
                  vadProcessed: {
                    $sum: {
                      $cond: [
                        {
                          $ne: [{ $ifNull: ["$vad.ran_at", null] }, null],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  withSpeech: {
                    $sum: { $cond: [{ $eq: ["$vad.has_speech", true] }, 1, 0] },
                  },
                },
              },
            ],
            "audio_chunks_pipeline_source_stats",
            PIPELINE_DETAILS_MAX_TIME_MS,
          ),
          [],
        ),
        safeStat(
          "recent transcription sequences",
          mongo({
            action: "find",
            collection: "transcription_sequences",
            query: { original_id: { $in: sourceIds } },
            options: {
              sort: { start: -1 },
              limit: 5000,
              maxTimeMS: PIPELINE_DETAILS_MAX_TIME_MS,
            },
          }) as Promise<any[]>,
          [],
        ),
        safeStat(
          "recent transcriptions",
          mongo({
            action: "aggregate",
            collection: "transcriptions",
            pipeline: [
              { $match: { original: { $in: sourceIds } } },
              { $sort: { start: 1 } },
              {
                $group: {
                  _id: "$original",
                  count: { $sum: 1 },
                  details: {
                    $push: {
                      _id: "$_id",
                      start: "$start",
                      end: "$end",
                      text: "$text",
                      segments: "$segments",
                    },
                  },
                },
              },
              { $project: { count: 1, details: { $slice: ["$details", 20] } } },
            ],
            options: { maxTimeMS: PIPELINE_DETAILS_MAX_TIME_MS },
          }) as Promise<any[]>,
          [],
        ),
        safeStat(
          "recent conversation chunks",
          mongo({
            action: "find",
            collection: "conversation_chunks",
            query: { original_id: { $in: sourceIds } },
            options: {
              sort: { createdAt: -1 },
              limit: 5000,
              maxTimeMS: PIPELINE_DETAILS_MAX_TIME_MS,
            },
          }) as Promise<any[]>,
          [],
        ),
      ])
      : [[], [], [], []];

    const chunkIds = conversationChunkDocs.map((chunk: any) =>
      chunk._id.toString()
    );
    const conversationDocs = chunkIds.length > 0
      ? await safeStat(
        "recent conversations",
        mongo({
          action: "find",
          collection: "objects",
          query: {
            isConversation: true,
            "metadata.extractedWith.chunkId": { $in: chunkIds },
          },
          options: {
            sort: { createdAt: -1 },
            limit: 5000,
            maxTimeMS: PIPELINE_DETAILS_MAX_TIME_MS,
          },
        }) as Promise<any[]>,
        [],
      )
      : [];

    const groupBy = (docs: any[], field: string) => {
      const grouped = new Map<string, any[]>();
      for (const doc of docs) {
        const key = doc[field]?.toString();
        if (!key) continue;
        grouped.set(key, [...(grouped.get(key) ?? []), doc]);
      }
      return grouped;
    };
    const chunkStatsBySource = new Map<string, any>(
      chunkGroups.map((group: any) => [group._id.toString(), group]),
    );
    const sequencesBySource = groupBy(sequenceDocs, "original_id");
    const transcriptionBySource = new Map<string, any>(
      transcriptionGroups.map((group: any) => [group._id.toString(), group]),
    );
    const conversationChunksBySource = groupBy(
      conversationChunkDocs,
      "original_id",
    );
    const conversationsByChunk = groupBy(
      conversationDocs.map((conversation: any) => ({
        ...conversation,
        chunkId: conversation.metadata?.extractedWith?.chunkId,
      })),
      "chunkId",
    );

    const sessions: PipelineSession[] = filesToProcess.map((sf) => {
      const id = sf._id.toString();
      const chunkStats = chunkStatsBySource.get(id) ?? {};
      const sequences = sequencesBySource.get(id) ?? [];
      const transcriptionGroup = transcriptionBySource.get(id) ?? {
        count: 0,
        details: [],
      };
      const conversationChunks = conversationChunksBySource.get(id) ?? [];
      const conversations = conversationChunks.flatMap((chunk: any) =>
        conversationsByChunk.get(chunk._id.toString()) ?? []
      );

      return {
        _id: sf._id.toString(),
        start: sf.start,
        lastActivityAt: sf.updatedAt ?? sf.ingested_at ??
          sf.ingestion?.last_attempt ?? sf.createdAt ?? sf.start,
        path: sf.path,
        sourceKind: sourceKind(sf),
        ingested: sf.ingested === true,
        ingestionError: ingestionError(sf),
        client_id: sf.client_id,
        device: sf.device,
        metadata: sf.metadata,
        processing_status: sf.processing_status,
        chunks: {
          total: chunkStats.total ?? 0,
          vadProcessed: chunkStats.vadProcessed ?? 0,
          withSpeech: chunkStats.withSpeech ?? 0,
        },
        sequences: sequences.map((s: any) => ({
          _id: s._id.toString(),
          state: s.state,
          chunk_count: s.chunk_count,
          fromIndex: s.fromIndex,
          toIndex: s.toIndex,
          updatedAt: s.updatedAt,
          error: s.error,
        })),
        transcriptions: transcriptionGroup.count,
        conversationChunks: conversationChunks.map((c: any) => ({
          _id: c._id.toString(),
          state: c.state,
          mode: c.mode,
          transcriptionCount: c.transcriptionCount || 0,
          totalTextLength: c.totalTextLength || 0,
          start: c.start,
          end: c.end,
          updatedAt: c.updatedAt,
          error: c.error,
          emptyReason: c.emptyReason,
          segmentsFound: c.segmentsFound,
          conversationsCreated: c.conversationsCreated,
        })),
        transcriptionDetails: transcriptionGroup.details.map((t: any) => ({
          _id: t._id.toString(),
          start: t.start,
          end: t.end,
          text: t.segments?.map((s: any) => s.text).join("") || t.text || "",
        })),
        conversations: conversations.map((c: any) => ({
          _id: c._id.toString(),
          name: c.name,
          icon: c.icon,
          timeRanges: c.timeRanges,
          createdAt: c.createdAt,
        })),
      };
    });

    // Get global stats in parallel. VAD stats are cached because this endpoint
    // auto-refreshes and the chunk collection can contain hundreds of thousands
    // of documents.
    const [
      vadStats,
      sequencesReady,
      sequencesProcessing,
      sequencesError,
      transcriptionPendingChunkStatsResult,
      convChunksReady,
      convChunksProcessing,
      convChunksError,
      totalConversations,
      sourceStatsResult,
      sourceKinds,
      pendingSequenceChunkStatsResult,
      unassignedTranscriptions,
      conversationsAwaitingSummary,
      hasPendingDiarization,
      speakerMatchingBacklog,
      speakerIdentityBacklog,
      enrollmentBacklog,
      diarizationCampaign,
      jobStatsResult,
      recentJobsResult,
      serverConfig,
    ] = await Promise.all([
      safeStat("VAD coverage", getVadPipelineStats(mongo), {
        totalChunks: 0,
        chunksVadProcessed: 0,
        chunksAwaitingVad: 0,
        vadProcessedLast15Minutes: 0,
        vadRatePerMinute: 0,
        vadJobs: {
          active: 0,
          waiting: 0,
          delayed: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          recentFailures: [],
        },
      }),
      safeStat(
        "ready transcription sequences",
        countPipelineStats(mongo, "transcription_sequences", {
          state: "ready",
        }),
        0,
      ),
      safeStat(
        "processing transcription sequences",
        countPipelineStats(mongo, "transcription_sequences", {
          state: "processing",
        }),
        0,
      ),
      safeStat(
        "failed transcription sequences",
        countPipelineStats(mongo, "transcription_sequences", {
          state: "error",
        }),
        0,
      ),
      safeStat(
        "transcription backlog",
        aggregatePipelineStats(
          mongo,
          "audio_chunks",
          [
            {
              $match: {
                transcribed_at: null,
                processing_by: null,
                "vad.has_speech": true,
              },
            },
            { $count: "count" },
          ],
          "audio_chunks_pending_work",
        ),
        [],
      ),
      safeStat(
        "ready conversation chunks",
        countPipelineStats(mongo, "conversation_chunks", { state: "ready" }),
        0,
      ),
      safeStat(
        "processing conversation chunks",
        countPipelineStats(mongo, "conversation_chunks", {
          state: "processing",
        }),
        0,
      ),
      safeStat(
        "failed conversation chunks",
        countPipelineStats(mongo, "conversation_chunks", { state: "error" }),
        0,
      ),
      safeStat(
        "total conversations",
        countPipelineStats(mongo, "objects", { isConversation: true }),
        0,
      ),
      safeStat(
        "audio source totals",
        mongo({
          action: "aggregate",
          collection: "source_files",
          pipeline: [{
            $group: {
              _id: null,
              total: { $sum: 1 },
              ingested: {
                $sum: { $cond: [{ $eq: ["$ingested", true] }, 1, 0] },
              },
              errors: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$ingested", true] },
                        {
                          $ne: [
                            { $ifNull: ["$ingestion.error", null] },
                            null,
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              pending: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$ingested", true] },
                        {
                          $eq: [
                            { $ifNull: ["$ingestion.error", null] },
                            null,
                          ],
                        },
                        {
                          $or: [
                            {
                              $ne: [
                                { $ifNull: ["$path", null] },
                                null,
                              ],
                            },
                            {
                              $ne: [
                                { $ifNull: ["$platform.importer", null] },
                                null,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              blocked: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$ingested", true] },
                        {
                          $eq: [
                            { $ifNull: ["$ingestion.error", null] },
                            null,
                          ],
                        },
                        {
                          $eq: [{ $ifNull: ["$path", null] }, null],
                        },
                        {
                          $eq: [
                            { $ifNull: ["$platform.importer", null] },
                            null,
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          }],
          options: { maxTimeMS: PIPELINE_STATS_MAX_TIME_MS },
        }) as Promise<any[]>,
        [],
      ),
      safeStat(
        "audio source kinds",
        mongo({
          action: "aggregate",
          collection: "source_files",
          pipeline: [
            {
              $project: {
                kind: {
                  $ifNull: [
                    "$metadata.source",
                    {
                      $ifNull: [
                        "$importer",
                        {
                          $ifNull: [
                            "$platform.importer",
                            { $ifNull: ["$platform.system", "unknown"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $group: { _id: "$kind", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          options: { maxTimeMS: PIPELINE_STATS_MAX_TIME_MS },
        }) as Promise<any[]>,
        [],
      ),
      safeStat(
        "sequence creation backlog",
        aggregatePipelineStats(
          mongo,
          "audio_chunks",
          [
            {
              $match: {
                "vad.has_speech": true,
                transcribed_at: null,
                transcription_sequence_id: { $exists: false },
              },
            },
            { $count: "count" },
          ],
          "audio_chunks_sequence_pending_stats",
        ),
        [],
      ),
      safeStat(
        "unassigned transcriptions",
        countPipelineStats(mongo, "transcriptions", {
          chunk_id: { $exists: false },
        }),
        0,
      ),
      safeStat(
        "conversations awaiting summary",
        countPipelineStats(
          mongo,
          "objects", // Subfield predicate matches the conversation_missing_summary index.
          { isConversation: true, "summaries.0.date": { $exists: false } },
        ),
        0,
      ),
      safeStat(
        "diarization backlog",
        hasDiarizationBacklog(mongo),
        null,
      ),
      Promise.resolve(0),
      safeStat(
        "speaker identity backlog",
        hasSpeakerIdentityBacklog(mongo),
        null,
      ),
      safeStat(
        "voice enrollment backlog",
        countPipelineStats(mongo, "voice_samples.files", {
          "metadata.profile_id": { $exists: false },
        }),
        0,
      ),
      safeStat(
        "diarization campaign",
        getDiarizationCampaignSummary(mongo),
        null,
      ),
      safeStat(
        "pipeline job state",
        mongo({
          action: "aggregate",
          collection: "jobs",
          pipeline: [
            {
              $match: {
                type: { $in: PIPELINE_STAGES.map((stage) => stage.type) },
                dismissedAt: { $exists: false },
              },
            },
            { $sort: { updatedAt: -1, createdAt: -1 } },
            {
              $group: {
                _id: "$type",
                active: {
                  $sum: { $cond: [{ $eq: ["$state", "active"] }, 1, 0] },
                },
                waiting: {
                  $sum: { $cond: [{ $eq: ["$state", "waiting"] }, 1, 0] },
                },
                delayed: {
                  $sum: { $cond: [{ $eq: ["$state", "delayed"] }, 1, 0] },
                },
                failed: {
                  $sum: { $cond: [{ $eq: ["$state", "failed"] }, 1, 0] },
                },
                latestJob: {
                  $first: {
                    id: "$_id",
                    state: "$state",
                    updatedAt: { $ifNull: ["$updatedAt", "$createdAt"] },
                    failedReason: "$failedReason",
                  },
                },
              },
            },
          ],
          options: { maxTimeMS: PIPELINE_STATS_MAX_TIME_MS },
        }) as Promise<any[]>,
        [],
      ),
      safeStat(
        "recent pipeline jobs",
        mongo({
          action: "find",
          collection: "jobs",
          query: {
            type: { $in: PIPELINE_STAGES.map((stage) => stage.type) },
            dismissedAt: { $exists: false },
          },
          options: {
            sort: { updatedAt: -1, createdAt: -1 },
            limit: 12,
            projection: {
              type: 1,
              state: 1,
              createdAt: 1,
              updatedAt: 1,
              startedAt: 1,
              finishedAt: 1,
              failedReason: 1,
              progress: 1,
              result: 1,
            },
            maxTimeMS: PIPELINE_STATS_MAX_TIME_MS,
          },
        }) as Promise<any[]>,
        [],
      ),
      getServerConfig().catch((error: unknown) => {
        console.warn("[apiAudioPipelineHandler] config unavailable:", error);
        return { workers: {} } as any;
      }),
    ]);

    const pendingSequenceChunks = pendingSequenceChunkStatsResult[0]?.count ??
      0;
    const transcriptionPendingChunks =
      transcriptionPendingChunkStatsResult[0]?.count ?? 0;
    const sourceTotals = sourceStatsResult[0] ?? {};
    const sourceFilesStats = {
      total: sourceTotals.total ?? 0,
      ingested: sourceTotals.ingested ?? 0,
      pending: sourceTotals.pending ?? 0,
      blocked: sourceTotals.blocked ?? 0,
      errors: sourceTotals.errors ?? 0,
      byKind: sourceKinds.map((row: any) => ({
        kind: row._id ?? "unknown",
        count: row.count,
      })),
    };
    const jobStats = new Map<string, any>(
      jobStatsResult.map((row: any) => [row._id, row]),
    );
    const diarizationBacklog = getDiarizationBacklogSnapshot(
      hasPendingDiarization,
      diarizationCampaign,
    );
    const backlogs: Record<string, number> = {
      ingestion: sourceFilesStats.pending,
      vad: vadStats.chunksAwaitingVad,
      transcription_sequence_creator: pendingSequenceChunks,
      transcription: sequencesReady + sequencesProcessing + sequencesError,
      conversation_chunk_creator: unassignedTranscriptions,
      conversation_extractor_merged: convChunksReady + convChunksProcessing +
        convChunksError,
      summarization: conversationsAwaitingSummary,
      diarization: diarizationBacklog.count,
      speakerMatching: speakerMatchingBacklog,
      speakerIdentity: speakerIdentityBacklog === true ? 1 : 0,
      enrollment: enrollmentBacklog,
    };
    const stageErrors: Record<string, number> = {
      ingestion: sourceFilesStats.errors,
      vad: vadStats.vadJobs.failed,
      transcription: sequencesError,
      conversation_extractor_merged: convChunksError,
    };
    const stages = PIPELINE_STAGES.map(({ type, label }) => {
      const jobs = jobStats.get(type) ?? {};
      const latestJob = jobs.latestJob
        ? {
          ...jobs.latestJob,
          id: jobs.latestJob.id.toString(),
        }
        : undefined;
      return {
        type,
        label,
        backlog: backlogs[type] ?? 0,
        backlogStatus: type === "diarization"
          ? diarizationBacklog.status
          : type === "speakerIdentity"
          ? speakerIdentityBacklog == null
            ? "unavailable"
            : speakerIdentityBacklog
            ? "exists"
            : "exact"
          : "exact",
        backlogAsOf: type === "diarization"
          ? diarizationBacklog.asOf
          : undefined,
        errors: stageErrors[type] ?? 0,
        paused: serverConfig.workers?.[type]?.paused === true,
        active: jobs.active ?? 0,
        waiting: jobs.waiting ?? 0,
        delayed: jobs.delayed ?? 0,
        failed: jobs.failed ?? 0,
        latestJob,
      };
    });

    const stats: PipelineStats = {
      warnings,
      totalSessions: sourceFilesStats.total,
      ...vadStats,
      sequencesReady,
      sequencesProcessing,
      sequencesError,
      transcriptionPendingChunks,
      transcriptionPendingMaximumHours: transcriptionPendingChunks *
        MAX_AUDIO_CHUNK_SECONDS / 3600,
      convChunksReady,
      convChunksProcessing,
      convChunksError,
      totalConversations,
      sourceFiles: sourceFilesStats,
      diarizationCampaign,
      stages,
      recentJobs: recentJobsResult.map((job: any) => ({
        id: job._id.toString(),
        type: job.type,
        state: job.state,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        failedReason: job.failedReason,
        progress: job.progress,
        result: job.result,
      })),
    };

    if (!includeSources) {
      await saveAudioOperations(mongo, stats, failedStatsLabels).catch((error) => {
        console.warn("[audio-pipeline] could not save operations snapshot", error);
      });
    }

    // Serialize dates properly
    const response = EJSON.serialize({
      sessions,
      hasMore,
      stats,
      snapshot: {
        calculatedAt: new Date(),
        cacheSeconds: warnings.length > 0
          ? PIPELINE_PARTIAL_SNAPSHOT_CACHE_MS / 1_000
          : PIPELINE_SNAPSHOT_CACHE_MS / 1_000,
        partial: warnings.length > 0,
      },
    });

    if (snapshotKey) {
      pipelineSnapshotCache.set(snapshotKey, {
        expiresAt: Date.now() +
          (warnings.length > 0
            ? PIPELINE_PARTIAL_SNAPSHOT_CACHE_MS
            : PIPELINE_SNAPSHOT_CACHE_MS),
        value: response,
      });
      if (warnings.length > 0) {
        pipelineSnapshotBackoffUntil.set(
          snapshotKey,
          Date.now() + PIPELINE_SNAPSHOT_RETRY_BACKOFF_MS,
        );
      } else {
        pipelineSnapshotBackoffUntil.delete(snapshotKey);
      }
    }
    finishSnapshot?.(response);
    res.json(response);
  } catch (error) {
    finishSnapshot?.(undefined);
    if (snapshotKey) {
      pipelineSnapshotBackoffUntil.set(
        snapshotKey,
        Date.now() + PIPELINE_SNAPSHOT_RETRY_BACKOFF_MS,
      );
      const staleSnapshot = pipelineSnapshotCache.get(snapshotKey);
      if (staleSnapshot) {
        console.warn(
          "[apiAudioPipelineHandler] returning the last cached snapshot after a refresh failure",
        );
        res.json(staleSnapshot.value);
        return;
      }
    }
    console.error("[apiAudioPipelineHandler] error:", error);
    throw error;
  } finally {
    if (snapshotKey && finishSnapshot) {
      pipelineSnapshotInFlight.delete(snapshotKey);
    }
  }
}
