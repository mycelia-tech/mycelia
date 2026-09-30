import { z } from "zod";
import { ObjectId } from "bson";
import { type Auth, getServerAuth } from "@/lib/auth/core.server.ts";
import type { Resource, ResourcePath } from "@/lib/auth/resources.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { jobRegistry } from "@/lib/jobs/job-registry.ts";
import { enqueueJob, EnqueueJobOptions, getQueue } from "@/lib/jobs/queue.ts";
import { publishJobUpdate } from "@/lib/events/publisher.ts";
import { workerPauseManager } from "@/lib/jobs/worker-pause-manager.ts";
import { getConfigResource } from "@/lib/config/resource.server.ts";
import { getJobTimeoutMinutes } from "@/lib/jobs/job-timeouts.ts";
import { env } from "#/env.ts";
import { buildTaggerConversationQuery } from "../../../workers/tagger.ts";
import {
  assertJobServicesHealthy,
  getExternalServicesHealth,
} from "@/lib/jobs/service-health.ts";
import { cancelRunningJob } from "@/lib/jobs/processor.ts";
import { diarizationCampaignIdForJob } from "@/lib/jobs/job-state.ts";
import {
  cancelActiveWorkerJob,
  getWorkerRuntimeStatus,
  setWorkerRuntimeConcurrency,
} from "@/lib/jobs/workers.ts";
import {
  assertWorkerConcurrency,
  getAvailableForceStartSlots,
} from "@/lib/jobs/worker-concurrency.ts";
import {
  buildTimelineRebuildRangeBatches,
  findTimelineRepairRanges,
  normalizeTimelineRebuildRanges,
  timelineCampaignStatus,
  timelineVerificationOutcome,
} from "@/lib/jobs/timeline-recovery.ts";
import {
  ensureTimelineCampaignDocument,
  reconcileTimelineCampaign,
  syncTimelineCampaign,
  TIMELINE_REBUILD_CAMPAIGNS,
} from "@/lib/jobs/timeline-campaign-recovery.ts";
import { resolveLiveJobState } from "@/lib/jobs/job-live-state.ts";
import { runExactCount } from "@/lib/jobs/exact-count.ts";
import { deriveDiarizationErrorOutcomes } from "@/lib/jobs/diarization-error-outcome.ts";
import { buildWorkerCatalog } from "@/lib/jobs/worker-catalog.ts";
import {
  assertCanRunWorkerFromJobs,
  assertCanUseGenericQueueAction,
  DOMAIN_MANAGED_MEDIA_JOB_TYPES,
  globalQueueClearJobsQuery,
  jobTypesForGlobalQueueClear,
  manualJobSchemas,
} from "@/lib/jobs/job-action-policy.ts";
import {
  beginDashboardRefresh,
  completeDashboardRefresh,
  EXACT_BACKLOG_SNAPSHOT_ID,
  failDashboardRefresh,
  readDashboardSnapshot,
  refreshRunHistorySnapshot,
  RUN_HISTORY_SNAPSHOT_ID,
  serializeDashboardSnapshot,
  TIMELINE_INTEGRITY_SNAPSHOT_ID,
  WORKER_CATALOG_SNAPSHOT_ID,
} from "@/lib/jobs/jobs-dashboard-snapshots.ts";

import {
  buildSummaryRerunPipeline,
  ReprocessModelArtifactsSchema,
} from "@/lib/jobs/summary-rerun.ts";

const STALE_JOB_AGE_MS = 15 * 60 * 1000;

const WORKER_SPECIFIC_IDLE_TYPES = [
  "vad",
  "conversation_chunk_creator",
  "conversation_extractor",
  "transcription_sequence_creator",
  "transcription",
] as const;

/**
 * A conservative aggregation expression for a run that touched no source
 * work. Keep this separate from semantic-empty results: a worker that
 * processed an input but produced no artifact is still useful history.
 */
export const IDLE_JOB_RESULT_EXPRESSION = {
  $or: [
    {
      $and: [
        { $eq: ["$type", "vad"] },
        {
          $eq: [{
            $ifNull: ["$result.hasSpeech", {
              $ifNull: ["$progress.hasSpeech", -1],
            }],
          }, 0],
        },
        {
          $eq: [{
            $ifNull: ["$result.processed", {
              $ifNull: ["$progress.processed", -1],
            }],
          }, 0],
        },
      ],
    },
    {
      $and: [
        { $eq: ["$type", "conversation_chunk_creator"] },
        { $eq: [{ $ifNull: ["$result.finalized", 0] }, 0] },
        { $eq: [{ $ifNull: ["$result.streamed", 0] }, 0] },
        { $eq: [{ $ifNull: ["$result.chunksCreated", 0] }, 0] },
      ],
    },
    {
      $and: [
        { $eq: ["$type", "conversation_extractor"] },
        { $eq: [{ $ifNull: ["$result.conversationsCreated", 0] }, 0] },
        { $eq: [{ $ifNull: ["$result.chunksProcessed", 0] }, 0] },
      ],
    },
    {
      $and: [
        { $eq: ["$type", "transcription_sequence_creator"] },
        { $eq: [{ $ifNull: ["$result.processed", 0] }, 0] },
      ],
    },
    {
      $and: [
        { $eq: ["$type", "transcription"] },
        {
          $eq: [{
            $ifNull: ["$result.processed", {
              $ifNull: ["$progress.processed", -1],
            }],
          }, 0],
        },
      ],
    },
    {
      $and: [
        { $not: [{ $in: ["$type", WORKER_SPECIFIC_IDLE_TYPES] }] },
        {
          $eq: [{
            $ifNull: ["$result.processed", {
              $ifNull: ["$progress.processed", -1],
            }],
          }, 0],
        },
        {
          $in: [{
            $ifNull: ["$result.total", {
              $ifNull: ["$progress.total", null],
            }],
          }, [null, 0]],
        },
      ],
    },
  ],
} as const;

export function getIdleAutoJobQuery() {
  return {
    state: "completed",
    "trigger.type": "auto",
    $expr: IDLE_JOB_RESULT_EXPRESSION,
  };
}

const TIMELINE_SOURCE_COLLECTIONS = [
  ["audio_chunks", "Audio chunks"],
  ["transcriptions", "Transcriptions"],
] as const;
const TIMELINE_RESOLUTIONS = ["5min", "1hour", "1day", "1week"] as const;

function validDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date;
}

const UpdateProgressSchema = z.object({
  action: z.literal("progressUpdate"),
  jobId: z.string(),
  progress: z.record(z.string(), z.any()),
});

const ListJobsSchema = z.object({
  action: z.literal("list"),
  view: z.enum(["all", "operational", "idle_auto"]).default("all"),
  types: z.array(z.string()).nullable().optional(),
  statuses: z
    .array(
      z.enum([
        "active",
        "waiting",
        "completed",
        "failed",
        "cancelled",
        "delayed",
        "paused",
      ]),
    )
    .nullable()
    .optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  providerProfileId: z.string().trim().min(1).max(200).optional(),
  campaignId: z.string().trim().min(1).max(200).optional(),
});

const DEFAULT_HIDDEN_JOB_TYPES = new Set(["mediaRecognition"]);
const LOGICAL_CAMPAIGN_JOB_TYPES = [
  "mediaFolderImport",
  "mediaRecognitionBatch",
] as const;
const DEFAULT_JOBS_LIST_LIMIT = 200;
const JOBS_LIST_MAX_TIME_MS = 5_000;

// Keep the list payload bounded to fields that the Jobs UI actually renders.
// In particular, logical campaign grouping must not retain every complete job
// document in memory through `$$ROOT`.
const JOB_LIST_PROJECTION = {
  _id: 1,
  type: 1,
  data: 1,
  state: 1,
  progress: 1,
  result: 1,
  trigger: 1,
  createdAt: 1,
  finishedAt: 1,
  startedAt: 1,
  failedReason: 1,
  restartInfo: 1,
  restartedFromJobId: 1,
  restartJobId: 1,
  updatedAt: 1,
  dismissedAt: 1,
  archivedAt: 1,
} as const;

const COMPACT_JOB_EXPRESSION = {
  _id: "$_id",
  type: "$type",
  data: "$data",
  state: "$state",
  progress: "$progress",
  result: "$result",
  trigger: "$trigger",
  createdAt: "$createdAt",
  finishedAt: "$finishedAt",
  startedAt: "$startedAt",
  failedReason: "$failedReason",
  restartInfo: "$restartInfo",
  restartedFromJobId: "$restartedFromJobId",
  restartJobId: "$restartJobId",
  updatedAt: "$updatedAt",
  dismissedAt: "$dismissedAt",
  archivedAt: "$archivedAt",
} as const;

export function defaultVisibleJobTypes(types: Iterable<string>): string[] {
  return [...types].filter((type) => !DEFAULT_HIDDEN_JOB_TYPES.has(type));
}

export function logicalJobListPipeline(
  candidateQuery: Record<string, unknown>,
  visibleQuery: Record<string, unknown>,
  limit: number,
) {
  return [
    // Ordinary jobs are already one logical row each. Filter them before the
    // indexed recent-first scan, then cap the branch before merging campaigns.
    // This avoids sorting/grouping the complete jobs history.
    {
      $match: {
        $and: [
          candidateQuery,
          visibleQuery,
          { type: { $nin: LOGICAL_CAMPAIGN_JOB_TYPES } },
        ],
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit },
    { $project: JOB_LIST_PROJECTION },
    {
      $unionWith: {
        coll: "jobs",
        pipeline: [
          // Only these durable campaign types need logical grouping. Their
          // latest attempt determines lifecycle/view membership, so that
          // filter intentionally remains after the compact group.
          {
            $match: {
              $and: [
                candidateQuery,
                { type: { $in: LOGICAL_CAMPAIGN_JOB_TYPES } },
              ],
            },
          },
          {
            $set: {
              _jobsLogicalId: {
                $ifNull: [
                  "$data.campaignId",
                  {
                    $ifNull: [
                      "$progress.campaignId",
                      {
                        $ifNull: [
                          "$result.campaignId",
                          {
                            $ifNull: [
                              "$data.batchId",
                              {
                                $ifNull: [
                                  "$progress.batchId",
                                  {
                                    $ifNull: [
                                      "$result.batchId",
                                      { $toString: "$_id" },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            $project: {
              ...JOB_LIST_PROJECTION,
              _jobsLogicalId: 1,
            },
          },
          {
            $group: {
              _id: { type: "$type", logicalId: "$_jobsLogicalId" },
              job: {
                $top: {
                  sortBy: { createdAt: -1, _id: -1 },
                  output: COMPACT_JOB_EXPRESSION,
                },
              },
            },
          },
          { $replaceRoot: { newRoot: "$job" } },
          { $match: visibleQuery },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: limit },
        ],
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: limit },
  ];
}

const CancelAllJobsSchema = z.object({
  action: z.literal("cancel_all"),
});

const ClearCompletedJobsSchema = z.object({
  action: z.literal("clear_completed"),
});

const ClearFailedJobsSchema = z.object({
  action: z.literal("clear_failed"),
  workerType: z.string(),
});

const ClearQueueSchema = z.object({
  action: z.literal("clear_queue"),
  workerType: z.string(),
});

const ResetWorkerSchema = z.object({
  action: z.literal("reset_worker"),
  workerType: z.string(),
  restart: z.boolean().optional().default(false),
});

const CancelJobSchema = z.object({
  action: z.literal("cancel"),
  id: z.string(),
});

const DismissFailedJobSchema = z.object({
  action: z.literal("dismiss_failed"),
  id: z.string(),
  reason: z.string().max(500).optional(),
});

const GetJobSchema = z.object({
  action: z.literal("get"),
  id: z.string(),
});

interface JobModelProvenanceEntry {
  stage: string;
  requestedModel?: string;
  executedModel?: string;
  responseModel?: string;
  fallbackModel?: string;
  fallbackUsed: boolean;
  providerBaseUrl?: string;
  providerProfileId?: string;
  providerProfileName?: string;
  provenanceQuality: "exact" | "requested_only";
}

function addModelProvenanceEntry(
  entries: JobModelProvenanceEntry[],
  value: Record<string, any> | null | undefined,
  stage: string,
) {
  if (!value) return;

  const requestedModel = value.requestedModel || value.model;
  const executedModel = value.resolvedModel || value.responseModel;
  if (!requestedModel && !executedModel) return;

  const entry: JobModelProvenanceEntry = {
    stage,
    requestedModel,
    executedModel,
    responseModel: value.responseModel,
    fallbackModel: value.fallbackModel,
    fallbackUsed: value.fallbackUsed === true,
    providerBaseUrl: value.providerBaseUrl,
    providerProfileId: value.providerProfileId,
    providerProfileName: value.providerProfileName,
    provenanceQuality: executedModel ? "exact" : "requested_only",
  };
  const key = JSON.stringify(entry);
  if (!entries.some((candidate) => JSON.stringify(candidate) === key)) {
    entries.push(entry);
  }
}

const EnqueueJobSchema = z.object({
  action: z.literal("enqueue"),
  data: z.object({ type: z.string() }).passthrough(),
  priority: z.number().optional(),
  trigger: z.object({
    type: z.enum(["manual", "auto"]),
    reason: z.string().optional(),
  }).optional(),
});

const SchemasSchema = z.object({
  action: z.literal("schemas"),
});

const PauseWorkerSchema = z.object({
  action: z.literal("pause_worker"),
  workerType: z.string(),
});

const ResumeWorkerSchema = z.object({
  action: z.literal("resume_worker"),
  workerType: z.string(),
});

const PauseAllSchema = z.object({
  action: z.literal("pause_all"),
});

const ResumeAllSchema = z.object({
  action: z.literal("resume_all"),
});

const GetWorkerStatusSchema = z.object({
  action: z.literal("get_worker_status"),
});

const SetWorkerConcurrencySchema = z.object({
  action: z.literal("set_worker_concurrency"),
  workerType: z.string(),
  concurrency: z.number().int().min(1).max(8),
});

const RestartJobSchema = z.object({
  action: z.literal("restart_job"),
  id: z.string(),
});

const ForceStartSchema = z.object({
  action: z.literal("force_start"),
  workerType: z.string(),
  count: z.number().int().min(1).max(8).default(1),
});

const ListWorkersSchema = z.object({
  action: z.literal("list_workers"),
});

const GetWorkerDefaultsSchema = z.object({
  action: z.literal("get_worker_defaults"),
  workerType: z.string(),
});

const UpdateWorkerDefaultsSchema = z.object({
  action: z.literal("update_worker_defaults"),
  workerType: z.string(),
  defaults: z.record(z.string(), z.any()),
});

const StatsSchema = z.object({
  action: z.literal("stats"),
});

const GetJobsDashboardSchema = z.object({
  action: z.literal("get_jobs_dashboard"),
});

const RefreshRunHistorySchema = z.object({
  action: z.literal("refresh_run_history"),
});

const RefreshExactBacklogSchema = z.object({
  action: z.literal("refresh_exact_backlog"),
});

const RefreshTimelineIntegritySchema = z.object({
  action: z.literal("refresh_timeline_integrity"),
});

const ErrorStatsSchema = z.object({
  action: z.literal("error_stats"),
  sinceDays: z.number().int().min(1).max(90).default(14),
  types: z.array(z.string()).nullable().optional(),
});

const PipelineHealthSchema = z.object({
  action: z.literal("pipeline_health"),
  force: z.boolean().optional(),
});

const ServicesHealthSchema = z.object({
  action: z.literal("services_health"),
  force: z.boolean().optional(),
});

const TimelineIntegrityReportSchema = z.object({
  action: z.literal("timeline_integrity_report"),
});

const TimelineBookkeepingRepairSchema = z.object({
  action: z.literal("timeline_bookkeeping_repair"),
  apply: z.boolean().default(false),
});

const StartTimelineRebuildSchema = z.object({
  action: z.literal("start_timeline_rebuild"),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  ranges: z.array(z.object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })).min(1).max(240).optional(),
  batchDays: z.number().int().min(1).max(62).default(31),
});

const GetTimelineRebuildStatusSchema = z.object({
  action: z.literal("get_timeline_rebuild_status"),
  campaignId: z.string().min(1).optional(),
});

const PauseTimelineRebuildSchema = z.object({
  action: z.literal("pause_timeline_rebuild"),
  campaignId: z.string().min(1),
});

const ResumeTimelineRebuildSchema = z.object({
  action: z.literal("resume_timeline_rebuild"),
  campaignId: z.string().min(1),
});

const RetryFailedJobsSchema = z.object({
  action: z.literal("retry_failed"),
  workerType: z.string(),
  limit: z.number().int().min(1).max(100).default(25),
});

const ModelArtifactTypeSchema = z.enum([
  "summary",
  "conversation_extraction",
  "tagging",
]);

const ModelArtifactsSchema = z.object({
  action: z.literal("model_artifacts"),
  artifactTypes: z.array(ModelArtifactTypeSchema).optional(),
  model: z.string().optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const RequestSchema = z.union([
  UpdateProgressSchema,
  ListJobsSchema,
  CancelAllJobsSchema,
  ClearCompletedJobsSchema,
  ClearFailedJobsSchema,
  ClearQueueSchema,
  ResetWorkerSchema,
  CancelJobSchema,
  DismissFailedJobSchema,
  GetJobSchema,
  EnqueueJobSchema,
  SchemasSchema,
  PauseWorkerSchema,
  ResumeWorkerSchema,
  PauseAllSchema,
  ResumeAllSchema,
  GetWorkerStatusSchema,
  SetWorkerConcurrencySchema,
  RestartJobSchema,
  ForceStartSchema,
  ListWorkersSchema,
  GetWorkerDefaultsSchema,
  UpdateWorkerDefaultsSchema,
  StatsSchema,
  GetJobsDashboardSchema,
  RefreshRunHistorySchema,
  RefreshExactBacklogSchema,
  RefreshTimelineIntegritySchema,
  ErrorStatsSchema,
  PipelineHealthSchema,
  ServicesHealthSchema,
  TimelineIntegrityReportSchema,
  TimelineBookkeepingRepairSchema,
  StartTimelineRebuildSchema,
  GetTimelineRebuildStatusSchema,
  PauseTimelineRebuildSchema,
  ResumeTimelineRebuildSchema,
  RetryFailedJobsSchema,
  ModelArtifactsSchema,
  ReprocessModelArtifactsSchema,
]);

type WorkerProgressRequest = z.infer<typeof RequestSchema>;

// Removed worker types whose historical jobs must stay visible in the jobs
// list and retryable/dismissable. No new jobs of these types are created.
export const LEGACY_JOB_TYPES = ["conversation_extractor"] as const;

// Both extractor generations claim conversation_chunks the same way; the
// legacy type stays here so its historical failed jobs keep chunk-targeted
// retry/supersede behavior.
const EXTRACTOR_JOB_TYPES = new Set([
  "conversation_extractor",
  "conversation_extractor_merged",
]);

export function getFailedJobsQuery(workerType: string) {
  return {
    type: workerType,
    state: "failed",
  } as const;
}

export function getFailedJobRetryData(
  failedJob: {
    data?: Record<string, any>;
    progress?: Record<string, any>;
  },
  workerType: string,
) {
  const data: Record<string, any> & { type: string } = {
    ...(failedJob.data ?? {}),
    type: workerType,
  };

  // Automatic pipeline jobs normally contain only the worker type. Preserve
  // the source claimed by the failed run so a bulk retry targets each failed
  // source exactly once instead of creating many competing discovery jobs.
  if (
    EXTRACTOR_JOB_TYPES.has(workerType) && !data.chunkId &&
    failedJob.progress?.chunkId
  ) {
    data.chunkId = failedJob.progress.chunkId;
  }
  if (
    workerType === "transcription" && !data.sequenceId &&
    failedJob.progress?.sequenceId
  ) {
    data.sequenceId = failedJob.progress.sequenceId;
  }

  return data;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export function groupFailedJobsForRetry(
  failedJobs: Array<{
    _id: { toString(): string };
    data?: Record<string, any>;
    progress?: Record<string, any>;
  }>,
  workerType: string,
) {
  const groups = new Map<
    string,
    {
      data: Record<string, any> & { type: string };
      failedJobs: typeof failedJobs;
    }
  >();

  for (const failedJob of failedJobs) {
    const data = getFailedJobRetryData(failedJob, workerType);
    const key = stableStringify(data);
    const group = groups.get(key);
    if (group) group.failedJobs.push(failedJob);
    else groups.set(key, { data, failedJobs: [failedJob] });
  }

  return [...groups.values()];
}

async function findSupersededFailedJobIds(
  mongo: ReturnType<typeof getMongoResource>,
  failedJobs: Array<{
    _id: { toString(): string };
    data?: Record<string, any>;
    progress?: Record<string, any>;
  }>,
  workerType: string,
): Promise<Set<string>> {
  const sourceToFailedJobs = new Map<string, string[]>();
  const addSource = (sourceId: unknown, failedJobId: string) => {
    if (typeof sourceId !== "string" || !ObjectId.isValid(sourceId)) return;
    const ids = sourceToFailedJobs.get(sourceId) ?? [];
    ids.push(failedJobId);
    sourceToFailedJobs.set(sourceId, ids);
  };

  for (const failedJob of failedJobs) {
    const failedJobId = failedJob._id.toString();
    if (EXTRACTOR_JOB_TYPES.has(workerType)) {
      addSource(
        failedJob.data?.chunkId ?? failedJob.progress?.chunkId,
        failedJobId,
      );
    } else if (workerType === "transcription") {
      addSource(
        failedJob.data?.sequenceId ?? failedJob.progress?.sequenceId,
        failedJobId,
      );
    } else if (workerType === "summarization") {
      addSource(failedJob.data?.objectId, failedJobId);
    }
  }

  if (sourceToFailedJobs.size === 0) return new Set();

  const sourceIds = [...sourceToFailedJobs.keys()].map((id) =>
    new ObjectId(id)
  );
  let completedSources: any[] = [];
  if (EXTRACTOR_JOB_TYPES.has(workerType)) {
    completedSources = await mongo({
      action: "find",
      collection: "conversation_chunks",
      query: {
        _id: { $in: sourceIds },
        state: { $in: ["completed", "empty"] },
      },
      options: { projection: { _id: 1 } },
    });
  } else if (workerType === "transcription") {
    completedSources = await mongo({
      action: "find",
      collection: "transcription_sequences",
      query: { _id: { $in: sourceIds }, state: "completed" },
      options: { projection: { _id: 1 } },
    });
  } else if (workerType === "summarization") {
    completedSources = await mongo({
      action: "find",
      collection: "objects",
      query: {
        _id: { $in: sourceIds },
        "summaries.0": { $exists: true },
      },
      options: { projection: { _id: 1 } },
    });
  }

  const superseded = new Set<string>();
  for (const source of completedSources) {
    for (
      const failedJobId of sourceToFailedJobs.get(source._id.toString()) ??
        []
    ) {
      superseded.add(failedJobId);
    }
  }
  return superseded;
}

export class JobsResource implements Resource<WorkerProgressRequest, any> {
  code = "jobs";
  description = "Update job progress, list jobs, or enqueue a new job";
  private activeWorkerActions = new Set<string>();

  schemas = {
    request: RequestSchema,
    response: z.any(),
  };

  async use(input: WorkerProgressRequest, auth: Auth): Promise<any> {
    switch (input.action) {
      case "get":
        return this.get(input, auth);
      case "enqueue":
        return this.enqueue(input, auth);
      case "cancel":
        return this.cancel(input, auth);
      case "dismiss_failed":
        return this.dismissFailed(input, auth);
      case "cancel_all":
        return this.cancelAll(input, auth);
      case "clear_completed":
        return this.clearCompleted(input, auth);
      case "clear_failed":
        return this.clearFailed(input, auth);
      case "clear_queue":
        return this.clearQueue(input, auth);
      case "reset_worker":
        return this.resetWorker(input, auth);
      case "list":
        return this.list(input, auth);
      case "progressUpdate":
        return this.progressUpdate(input, auth);
      case "schemas":
        return this.schemasAction();
      case "pause_worker":
        return this.pauseWorker(input, auth);
      case "resume_worker":
        return this.resumeWorker(input, auth);
      case "pause_all":
        return this.pauseAll(auth);
      case "resume_all":
        return this.resumeAll(auth);
      case "get_worker_status":
        return this.getWorkerStatus(auth);
      case "set_worker_concurrency":
        return this.setWorkerConcurrency(input, auth);
      case "restart_job":
        return this.restartJob(input, auth);
      case "force_start":
        return this.forceStart(input, auth);
      case "list_workers":
        return this.listWorkers(auth);
      case "get_worker_defaults":
        return this.getWorkerDefaults(input, auth);
      case "update_worker_defaults":
        return this.updateWorkerDefaults(input, auth);
      case "stats":
        return this.stats(auth);
      case "get_jobs_dashboard":
        return this.getJobsDashboard(auth);
      case "refresh_run_history":
        return this.refreshRunHistory(auth);
      case "refresh_exact_backlog":
        return this.refreshExactBacklog(auth);
      case "refresh_timeline_integrity":
        return this.refreshTimelineIntegrity(auth);
      case "error_stats":
        return this.errorStats(input, auth);
      case "pipeline_health":
        return this.pipelineHealth(input, auth);
      case "services_health":
        return this.servicesHealth(input);
      case "timeline_integrity_report":
        return this.timelineIntegrityReport(auth);
      case "timeline_bookkeeping_repair":
        return this.timelineBookkeepingRepair(input, auth);
      case "start_timeline_rebuild":
        return this.startTimelineRebuild(input, auth);
      case "get_timeline_rebuild_status":
        return this.getTimelineRebuildStatus(input, auth);
      case "pause_timeline_rebuild":
        return this.pauseTimelineRebuild(input, auth);
      case "resume_timeline_rebuild":
        return this.resumeTimelineRebuild(input);
      case "retry_failed":
        return this.retryFailed(input, auth);
      case "model_artifacts":
        return this.modelArtifacts(input, auth);
      case "reprocess_model_artifacts":
        return this.reprocessModelArtifacts(input, auth);
      default:
        throw new Error(`Unknown action: ${(input as any).action}`);
    }
  }

  private schemasAction() {
    return manualJobSchemas(jobRegistry.getJobSchemas());
  }

  private async get(input: z.infer<typeof GetJobSchema>, auth: Auth) {
    const mongo = await getMongoResource(auth);

    const jobs = await mongo({
      action: "find",
      collection: "jobs",
      query: { _id: new ObjectId(input.id) },
      options: { limit: 1 },
    });

    const job = jobs[0];
    if (!job) {
      throw new Error(`Job ${input.id} not found`);
    }

    const queueJob = await getQueue(job.type).getJob(input.id);
    let queueState: string | null = null;
    if (queueJob) {
      try {
        queueState = await queueJob.getState();
      } catch {
        queueState = "unknown";
      }
    }

    let modelProvenance: JobModelProvenanceEntry[] | undefined;
    if (job.type === "conversation_extractor") {
      const entries: JobModelProvenanceEntry[] = [];
      const conversations = await mongo({
        action: "find",
        collection: "objects",
        query: { "metadata.extractedWith.jobId": input.id },
        options: {
          limit: 100,
          projection: {
            "metadata.extractedWith": 1,
          },
        },
      });

      for (const conversation of conversations) {
        const extractedWith = conversation.metadata?.extractedWith;
        if (extractedWith?.operations) {
          addModelProvenanceEntry(
            entries,
            extractedWith.operations.segmentation,
            "Segmentation",
          );
          addModelProvenanceEntry(
            entries,
            extractedWith.operations.metadata,
            "Metadata extraction",
          );
        } else {
          addModelProvenanceEntry(
            entries,
            extractedWith,
            "Conversation extraction",
          );
        }
      }

      // Empty or failed jobs may not have created a conversation object. Use
      // chunk provenance only when it belongs to this exact job; otherwise show
      // the requested alias without pretending that an executed model was saved.
      if (entries.length === 0) {
        const failedChunkId = typeof job.failedReason === "string"
          ? job.failedReason.match(/chunk\s+([a-f\d]{24})/i)?.[1]
          : undefined;
        const chunkId = job.data?.chunkId || job.progress?.chunkId ||
          failedChunkId;
        const chunks = await mongo({
          action: "find",
          collection: "conversation_chunks",
          query: chunkId
            ? { _id: new ObjectId(chunkId) }
            : { processedByJobId: input.id },
          options: {
            limit: 100,
            projection: {
              params: 1,
              inferenceProvenance: 1,
            },
          },
        });

        for (const chunk of chunks) {
          const segmentation = chunk.inferenceProvenance?.segmentation;
          if (segmentation?.jobId === input.id) {
            addModelProvenanceEntry(entries, segmentation, "Segmentation");
            for (const metadata of chunk.inferenceProvenance?.metadata ?? []) {
              addModelProvenanceEntry(
                entries,
                metadata,
                "Metadata extraction",
              );
            }
          }
        }

        if (entries.length === 0) {
          const requestedModel = job.data?.model || chunks[0]?.params?.model;
          if (requestedModel) {
            entries.push({
              stage: "Conversation extraction",
              requestedModel,
              fallbackModel: job.data?.fallbackModel,
              fallbackUsed: false,
              provenanceQuality: "requested_only",
            });
          }
        }
      }

      modelProvenance = entries;
    }

    let diarizationErrorOutcomes:
      | ReturnType<typeof deriveDiarizationErrorOutcomes>
      | undefined;
    const diarizationErrors = job.type === "diarization" &&
        Array.isArray(job.result?.errors)
      ? job.result.errors.slice(0, 100)
      : [];
    if (diarizationErrors.length > 0) {
      const errorRanges = diarizationErrors.flatMap((error: any) => {
        if (
          typeof error?.originalId !== "string" ||
          !ObjectId.isValid(error.originalId)
        ) return [];
        const start = validDate(error.start);
        const end = validDate(error.end);
        if (!start || !end) return [];
        return [{
          original_id: new ObjectId(error.originalId),
          start: { $gte: start, $lte: end },
          "vad.has_speech": true,
        }];
      });
      const chunks = errorRanges.length > 0
        ? await mongo({
          action: "find",
          collection: "audio_chunks",
          query: { $or: errorRanges },
          options: {
            sort: { start: 1 },
            limit: Math.min(diarizationErrors.length * 128, 5_000),
            maxTimeMS: 5_000,
            projection: {
              original_id: 1,
              start: 1,
              diarized_at: 1,
              diarizationFailure: 1,
            },
          },
        })
        : [];
      diarizationErrorOutcomes = deriveDiarizationErrorOutcomes(
        diarizationErrors,
        chunks,
      );
    }

    return {
      id: job._id.toString(),
      type: job.type,
      data: job.data,
      state: job.state,
      progress: job.progress,
      result: job.result,
      trigger: job.trigger,
      timestamp: job.createdAt.getTime(),
      finishedOn: job.finishedAt?.getTime(),
      processedOn: job.startedAt?.getTime(),
      failedReason: job.failedReason,
      restarted: job.restartInfo != null,
      restartedFromJobId: job.restartedFromJobId,
      restartJobId: job.restartJobId,
      routingContext: job.data?.routingContext,
      updatedOn: job.updatedAt?.getTime(),
      queueState,
      queuePresent: queueJob != null,
      queueAdmission: job.queueAdmission,
      ...(modelProvenance && { modelProvenance }),
      ...(diarizationErrorOutcomes && { diarizationErrorOutcomes }),
    };
  }

  private async enqueue(input: z.infer<typeof EnqueueJobSchema>, auth: Auth) {
    assertCanRunWorkerFromJobs(input.data.type);
    // Access already checked by ResourceManager - escalate to server auth
    const serverAuth = await getServerAuth();
    const options: EnqueueJobOptions = {
      priority: input.priority,
      trigger: input.trigger,
    };
    const job = await enqueueJob(input.data, options, serverAuth);

    return {
      success: true,
      jobId: job.id,
    };
  }

  private async cancel(input: z.infer<typeof CancelJobSchema>, auth: Auth) {
    const mongo = await getMongoResource(auth);
    const { id } = input;

    const jobDocs = await mongo({
      action: "find",
      collection: "jobs",
      query: { _id: new ObjectId(id) },
      options: { limit: 1 },
    });

    const jobDoc = jobDocs[0];
    if (!jobDoc) {
      throw new Error(`Job ${id} not found`);
    }

    const jobType = jobDoc.type as string;
    // Domain campaign state, billing fences, and recovery live outside BullMQ.
    // Reject before queue removal or any Mongo cancellation write.
    assertCanUseGenericQueueAction(jobType);
    const wasActive = jobDoc.state === "active";
    const queue = getQueue(jobType);
    const job = await queue.getJob(id);

    if (job) {
      try {
        await job.remove();
      } catch (err) {
        console.log(
          `[jobs] Could not remove BullMQ job ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const cancelResult = await mongo({
      action: "updateOne",
      collection: "jobs",
      query: {
        _id: new ObjectId(id),
        state: { $in: ["waiting", "active", "delayed"] },
      },
      update: {
        $set: {
          state: "cancelled",
          cancelReason: "user_cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    });

    if ((cancelResult.modifiedCount ?? 0) === 0) {
      console.warn(
        `[jobs] Job ${id} reached a terminal state before cancellation could be recorded`,
      );
      return { success: true, cancelled: false };
    }

    const processTerminated = wasActive ? cancelRunningJob(id) : false;

    if (jobType === "summarization") {
      await mongo({
        action: "updateMany",
        collection: "objects",
        query: { "_summarizationClaim.jobId": id },
        update: { $unset: { _summarizationClaim: "" } },
      });
    }

    if (jobType === "diarization") {
      await mongo({
        action: "updateOne",
        collection: "diarization_campaigns",
        query: {
          campaignId: diarizationCampaignIdForJob(id, jobDoc.data),
          status: { $in: ["counting", "running"] },
        },
        update: {
          $set: {
            status: "interrupted",
            interruptedAt: new Date(),
            interruptionReason: "Job cancelled by operator",
            updatedAt: new Date(),
          },
        },
      });
    }

    await publishJobUpdate(id, jobType, "job.state", {
      state: "cancelled",
      finishedOn: Date.now(),
    });

    return { success: true, cancelled: true, processTerminated };
  }

  private async dismissFailed(
    input: z.infer<typeof DismissFailedJobSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const dismissedAt = new Date();
    const result = await mongo({
      action: "updateOne",
      collection: "jobs",
      query: {
        _id: new ObjectId(input.id),
        state: "failed",
        dismissedAt: { $exists: false },
      },
      update: {
        $set: {
          dismissedAt,
          dismissedReason: input.reason ?? "user_dismissed",
          updatedAt: dismissedAt,
        },
      },
    });

    if ((result.modifiedCount ?? 0) === 0) {
      throw new Error("Failed job was not found or was already dismissed");
    }

    return { success: true, id: input.id, dismissedAt };
  }

  private async cancelAll(
    _input: z.infer<typeof CancelAllJobsSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);

    // Never force-remove active BullMQ jobs: their processors keep running
    // without a lock and later surface as stalled, even after committing side
    // effects. Drain only jobs that have not started; active work completes.
    const types = jobTypesForGlobalQueueClear(jobRegistry.getJobTypes());
    for (const type of types) {
      const queue = getQueue(type);
      await queue.drain(true);
    }

    const result = await mongo({
      action: "updateMany",
      collection: "jobs",
      query: globalQueueClearJobsQuery(),
      update: {
        $set: {
          state: "cancelled",
          cancelReason: "all_queues_cleared",
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    });

    return {
      success: true,
      cancelledCount: result.modifiedCount ?? 0,
      activeJobsContinued: true,
      protectedJobTypes: [...DOMAIN_MANAGED_MEDIA_JOB_TYPES],
    };
  }

  private async clearCompleted(
    _input: z.infer<typeof ClearCompletedJobsSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);

    const archivedAt = new Date();
    const result = await mongo({
      action: "updateMany",
      collection: "jobs",
      query: {
        state: { $in: ["completed", "failed", "cancelled"] },
        archivedAt: { $exists: false },
      },
      update: {
        $set: {
          archivedAt,
          archivedReason: "user_cleared_terminal_history",
        },
      },
    });

    return {
      success: true,
      archivedCount: result.modifiedCount || 0,
      deletedCount: 0,
    };
  }

  private async clearFailed(
    input: z.infer<typeof ClearFailedJobsSchema>,
    auth: Auth,
  ) {
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }

    const mongo = await getMongoResource(auth);
    const result = await mongo({
      action: "updateMany",
      collection: "jobs",
      query: {
        ...getFailedJobsQuery(input.workerType),
        archivedAt: { $exists: false },
      },
      update: {
        $set: {
          archivedAt: new Date(),
          archivedReason: "user_cleared_failed_history",
        },
      },
    });

    return {
      success: true,
      workerType: input.workerType,
      archivedCount: result.modifiedCount || 0,
      deletedCount: 0,
    };
  }

  private async clearQueue(
    input: z.infer<typeof ClearQueueSchema>,
    auth: Auth,
  ) {
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }
    // Keep domain campaign state and its coordinator/children consistent.
    // This guard runs before queue.drain and before the Mongo update.
    assertCanUseGenericQueueAction(input.workerType);

    // Drain only work that has not started. Removing an active BullMQ job with
    // obliterate(force) invalidates its lock while its processor is still
    // running, which can produce duplicate side effects and requires a worker
    // restart. Active jobs therefore finish normally.
    const queue = getQueue(input.workerType);
    await queue.drain(true);

    const now = new Date();
    const mongo = await getMongoResource(auth);
    const result = await mongo({
      action: "updateMany",
      collection: "jobs",
      query: {
        type: input.workerType,
        state: { $in: ["waiting", "delayed"] },
      },
      update: {
        $set: {
          state: "cancelled",
          cancelReason: "queue_cleared",
          finishedAt: now,
          updatedAt: now,
        },
      },
    });

    return {
      success: true,
      workerType: input.workerType,
      cancelledCount: result.modifiedCount || 0,
    };
  }

  private async retryFailed(
    input: z.infer<typeof RetryFailedJobsSchema>,
    auth: Auth,
  ) {
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }
    assertCanRunWorkerFromJobs(input.workerType);

    // A manual retry must not create another batch of known provider errors.
    await assertJobServicesHealthy(input.workerType, true);

    const mongo = await getMongoResource(auth);
    const failedJobs = await mongo({
      action: "find",
      collection: "jobs",
      query: {
        type: input.workerType,
        state: "failed",
        retriedAt: { $exists: false },
        dismissedAt: { $exists: false },
        archivedAt: { $exists: false },
      },
      options: { sort: { createdAt: 1 }, limit: input.limit },
    }) as any[];

    const supersededIds = await findSupersededFailedJobIds(
      mongo,
      failedJobs,
      input.workerType,
    );
    const retryCandidates = failedJobs.filter((job) =>
      !supersededIds.has(job._id.toString())
    );
    if (supersededIds.size > 0) {
      const dismissedAt = new Date();
      await mongo({
        action: "updateMany",
        collection: "jobs",
        query: {
          _id: {
            $in: [...supersededIds].map((id) => new ObjectId(id)),
          },
          dismissedAt: { $exists: false },
        },
        update: {
          $set: {
            dismissedAt,
            dismissedReason: "source_already_completed",
            updatedAt: dismissedAt,
          },
        },
      });
    }

    const serverAuth = await getServerAuth();
    const retried: Array<{ failedJobId: string; retryJobId: string }> = [];
    const errors: string[] = [];

    for (
      const group of groupFailedJobsForRetry(
        retryCandidates,
        input.workerType,
      )
    ) {
      const firstFailedJob = group.failedJobs[0];
      try {
        const retryJob = await enqueueJob(group.data, {
          trigger: {
            type: "manual",
            reason: `retry_failed:${firstFailedJob._id.toString()}`,
          },
        }, serverAuth);
        const retriedAt = new Date();
        await mongo({
          action: "updateMany",
          collection: "jobs",
          query: {
            _id: { $in: group.failedJobs.map((job) => job._id) },
            retriedAt: { $exists: false },
          },
          update: {
            $set: {
              retriedAt,
              retryJobId: retryJob.id,
              updatedAt: retriedAt,
            },
          },
        });
        retried.push(...group.failedJobs.map((failedJob) => ({
          failedJobId: failedJob._id.toString(),
          retryJobId: retryJob.id!,
        })));
      } catch (error) {
        errors.push(
          `${firstFailedJob._id.toString()}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }
    }

    return {
      success: errors.length === 0,
      workerType: input.workerType,
      retriedCount: retried.length,
      dismissedCount: supersededIds.size,
      handledCount: retried.length + supersededIds.size,
      queuedCount: new Set(retried.map((item) => item.retryJobId)).size,
      retried,
      errors,
    };
  }

  private async modelArtifacts(
    input: z.infer<typeof ModelArtifactsSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const requestedTypes = new Set(
      input.artifactTypes?.length
        ? input.artifactTypes
        : ModelArtifactTypeSchema.options,
    );
    const modelMatch = input.model && input.model !== "all"
      ? { executedModel: input.model }
      : null;
    const generatedAtMatch: Record<string, Date> = {};
    if (input.from) generatedAtMatch.$gte = new Date(`${input.from}T00:00:00`);
    if (input.to) generatedAtMatch.$lte = new Date(`${input.to}T23:59:59.999`);
    if (input.start) generatedAtMatch.$gte = new Date(input.start);
    if (input.end) generatedAtMatch.$lt = new Date(input.end);

    const facetFor = (
      base: Record<string, unknown>[],
      project: Record<string, unknown>,
    ) => [
      ...base,
      { $project: project },
      ...(modelMatch ? [{ $match: modelMatch }] : []),
      ...(Object.keys(generatedAtMatch).length
        ? [{ $match: { generatedAt: generatedAtMatch } }]
        : []),
      {
        $facet: {
          entries: [
            { $sort: { generatedAt: -1 } },
            { $limit: input.limit },
          ],
          models: [
            { $match: { executedModel: { $type: "string", $ne: "" } } },
            {
              $group: {
                _id: "$executedModel",
                count: { $sum: 1 },
                latestAt: { $max: "$generatedAt" },
              },
            },
          ],
          total: [{ $count: "value" }],
        },
      },
    ];

    const queries: Array<Promise<any>> = [];

    if (requestedTypes.has("summary")) {
      queries.push(mongo({
        action: "aggregate",
        collection: "objects",
        pipeline: facetFor(
          [
            { $match: { "summaries.0": { $exists: true } } },
            {
              $unwind: {
                path: "$summaries",
                includeArrayIndex: "artifactIndex",
              },
            },
          ],
          {
            _id: 0,
            id: {
              $concat: [
                { $toString: "$_id" },
                ":summary:",
                { $toString: "$artifactIndex" },
              ],
            },
            artifactType: { $literal: "summary" },
            objectId: { $toString: "$_id" },
            objectName: { $ifNull: ["$name", "Untitled conversation"] },
            generatedAt: "$summaries.date",
            requestedModel: {
              $ifNull: ["$summaries.requestedModel", "$summaries.model"],
            },
            executedModel: {
              $ifNull: [
                "$summaries.resolvedModel",
                { $ifNull: ["$summaries.modelName", "$summaries.model"] },
              ],
            },
            fallbackModel: "$summaries.fallbackModel",
            fallbackUsed: { $ifNull: ["$summaries.fallbackUsed", false] },
            providerBaseUrl: {
              $ifNull: [
                "$summaries.provenance.providerBaseUrl",
                "$summaries.providerBaseUrl",
              ],
            },
            providerProfileId: "$summaries.provenance.providerProfileId",
            providerProfileName: "$summaries.provenance.providerProfileName",
            jobId: "$summaries.jobId",
            provenanceQuality: {
              $cond: [
                {
                  $ne: [{ $ifNull: ["$summaries.resolvedModel", null] }, null],
                },
                "exact",
                "legacy_response_model",
              ],
            },
          },
        ),
      }));
    }

    if (requestedTypes.has("conversation_extraction")) {
      queries.push(mongo({
        action: "aggregate",
        collection: "objects",
        pipeline: facetFor(
          [{
            $match: {
              isConversation: true,
              "metadata.extractedWith": { $exists: true },
            },
          }],
          {
            _id: 0,
            id: {
              $concat: [{ $toString: "$_id" }, ":conversation_extraction"],
            },
            artifactType: { $literal: "conversation_extraction" },
            objectId: { $toString: "$_id" },
            objectName: { $ifNull: ["$name", "Untitled conversation"] },
            generatedAt: {
              $convert: {
                input: "$metadata.extractedWith.timestamp",
                to: "date",
                onError: null,
                onNull: null,
              },
            },
            requestedModel: {
              $ifNull: [
                "$metadata.extractedWith.requestedModel",
                "$metadata.extractedWith.model",
              ],
            },
            executedModel: {
              $ifNull: [
                "$metadata.extractedWith.resolvedModel",
                "$metadata.extractedWith.model",
              ],
            },
            fallbackModel: "$metadata.extractedWith.fallbackModel",
            fallbackUsed: {
              $ifNull: ["$metadata.extractedWith.fallbackUsed", false],
            },
            providerBaseUrl: "$metadata.extractedWith.providerBaseUrl",
            providerProfileId: "$metadata.extractedWith.providerProfileId",
            providerProfileName: "$metadata.extractedWith.providerProfileName",
            jobId: "$metadata.extractedWith.jobId",
            chunkId: "$metadata.extractedWith.chunkId",
            provenanceQuality: {
              $cond: [
                {
                  $ne: [
                    {
                      $ifNull: ["$metadata.extractedWith.resolvedModel", null],
                    },
                    null,
                  ],
                },
                "exact",
                "legacy_requested_only",
              ],
            },
          },
        ),
      }));
    }

    if (requestedTypes.has("tagging")) {
      queries.push(mongo({
        action: "aggregate",
        collection: "objects",
        pipeline: facetFor(
          [
            {
              $match: {
                isConversation: true,
                "metadata.aiProvenance.taggingRuns.0": { $exists: true },
              },
            },
            {
              $unwind: {
                path: "$metadata.aiProvenance.taggingRuns",
                includeArrayIndex: "artifactIndex",
              },
            },
          ],
          {
            _id: 0,
            id: {
              $concat: [
                { $toString: "$_id" },
                ":tagging:",
                { $toString: "$artifactIndex" },
              ],
            },
            artifactType: { $literal: "tagging" },
            objectId: { $toString: "$_id" },
            objectName: { $ifNull: ["$name", "Untitled conversation"] },
            generatedAt: "$metadata.aiProvenance.taggingRuns.generatedAt",
            requestedModel: "$metadata.aiProvenance.taggingRuns.requestedModel",
            executedModel: "$metadata.aiProvenance.taggingRuns.resolvedModel",
            fallbackModel: "$metadata.aiProvenance.taggingRuns.fallbackModel",
            fallbackUsed: {
              $ifNull: [
                "$metadata.aiProvenance.taggingRuns.fallbackUsed",
                false,
              ],
            },
            providerBaseUrl:
              "$metadata.aiProvenance.taggingRuns.providerBaseUrl",
            providerProfileId:
              "$metadata.aiProvenance.taggingRuns.providerProfileId",
            providerProfileName:
              "$metadata.aiProvenance.taggingRuns.providerProfileName",
            jobId: "$metadata.aiProvenance.taggingRuns.jobId",
            parseStatus: "$metadata.aiProvenance.taggingRuns.parseStatus",
            selectedTagCount:
              "$metadata.aiProvenance.taggingRuns.selectedTagCount",
            provenanceQuality: { $literal: "exact" },
          },
        ),
      }));
    }

    const [results, incompleteSummaries, legacyExtractions, legacyTags] =
      await Promise.all([
        Promise.all(queries),
        mongo({
          action: "count",
          collection: "objects",
          query: {
            summaries: {
              $elemMatch: {
                resolvedModel: { $exists: false },
              },
            },
          },
        }),
        mongo({
          action: "count",
          collection: "objects",
          query: {
            isConversation: true,
            "metadata.extractedWith.model": { $exists: true },
            "metadata.extractedWith.resolvedModel": { $exists: false },
          },
        }),
        mongo({
          action: "count",
          collection: "objects",
          query: {
            isRelationship: true,
            name: "tagged",
            "metadata.generatedWith": { $exists: false },
          },
        }),
      ]);

    const entries: any[] = [];
    const models = new Map<string, { count: number; latestAt?: Date }>();
    let total = 0;
    results.forEach((result: any) => {
      const facet = Array.isArray(result) ? result[0] : null;
      for (const entry of facet?.entries ?? []) entries.push(entry);
      total += facet?.total?.[0]?.value ?? 0;
      for (const item of facet?.models ?? []) {
        const current = models.get(item._id) ?? { count: 0 };
        current.count += item.count ?? 0;
        if (!current.latestAt || item.latestAt > current.latestAt) {
          current.latestAt = item.latestAt;
        }
        models.set(item._id, current);
      }
    });

    entries.sort((left, right) =>
      new Date(right.generatedAt ?? 0).getTime() -
      new Date(left.generatedAt ?? 0).getTime()
    );

    return {
      entries: entries.slice(0, input.limit),
      total,
      models: [...models.entries()]
        .map(([model, value]) => ({ model, ...value }))
        .sort((left, right) =>
          new Date(right.latestAt ?? 0).getTime() -
          new Date(left.latestAt ?? 0).getTime()
        ),
      gaps: {
        legacySummariesWithoutExactRouting: incompleteSummaries,
        legacyExtractionsWithRequestedAliasOnly: legacyExtractions,
        legacyTagRelationshipsWithoutProvenance: legacyTags,
      },
    };
  }

  private async reprocessModelArtifacts(
    input: z.infer<typeof ReprocessModelArtifactsSchema>,
    auth: Auth,
  ) {
    if (input.sourceModel === input.targetModel) {
      throw new Error("Choose a target model different from the source model");
    }
    await assertJobServicesHealthy("summarization", true);

    const mongo = await getMongoResource(auth);
    const objects = await mongo({
      action: "aggregate",
      collection: "objects",
      pipeline: buildSummaryRerunPipeline(input),
    }) as Array<{ _id: ObjectId }>;

    const objectIds = objects.map((object) => object._id.toString());
    const unfinishedJobs = objectIds.length
      ? await mongo({
        action: "find",
        collection: "jobs",
        query: {
          type: "summarization",
          state: { $in: ["waiting", "active", "delayed", "paused"] },
          "data.objectId": { $in: objectIds },
          "data.model": input.targetModel,
          ...(input.targetProviderProfileId
            ? { "data.providerProfileId": input.targetProviderProfileId }
            : {}),
        },
        options: { projection: { "data.objectId": 1 } },
      }) as any[]
      : [];
    const alreadyQueued = new Set(
      unfinishedJobs.map((job) => job.data?.objectId?.toString()),
    );

    const serverAuth = await getServerAuth();
    const queued: Array<{ objectId: string; jobId: string }> = [];
    for (const objectId of objectIds) {
      if (alreadyQueued.has(objectId)) continue;
      const job = await enqueueJob({
        type: "summarization",
        objectId,
        model: input.targetModel,
        ...(input.targetProviderProfileId
          ? { providerProfileId: input.targetProviderProfileId }
          : {}),
        allowExisting: true,
      }, {
        trigger: {
          type: "manual",
          reason: `model_quality_rerun:${input.sourceModel ?? "all"}`,
        },
      }, serverAuth);
      queued.push({ objectId, jobId: job.id! });
    }

    return {
      success: true,
      artifactType: input.artifactType,
      sourceModel: input.sourceModel,
      targetModel: input.targetModel,
      matched: objectIds.length,
      nextCursor: objectIds.length === input.limit ? objectIds.at(-1) : null,
      queued,
      skippedAlreadyQueued: objectIds.length - queued.length,
      mode: "append_summary_version",
    };
  }

  private async servicesHealth(
    input: z.infer<typeof ServicesHealthSchema>,
  ) {
    return {
      checkedAt: new Date().toISOString(),
      services: await getExternalServicesHealth(input.force ?? false),
    };
  }

  private async pipelineHealth(
    input: z.infer<typeof PipelineHealthSchema>,
    auth: Auth,
  ): Promise<Record<string, any>> {
    const mongo = await getMongoResource(auth);
    if (input.force) {
      const operationId = new ObjectId().toString();
      await this.runExactBacklogRefresh(operationId, auth);
    }
    const snapshot = await readDashboardSnapshot<any>(
      mongo,
      EXACT_BACKLOG_SNAPSHOT_ID,
    );
    if (snapshot?.data) {
      return {
        ...snapshot.data,
        snapshot: serializeDashboardSnapshot(snapshot),
      };
    }
    return {
      checkedAt: null,
      services: await getExternalServicesHealth(false),
      backlogs: {
        summarization: {
          ready: null,
          readyStatus: "unavailable",
          failedJobsUnretried: 0,
        },
        tagger: {
          ready: null,
          readyStatus: "unavailable",
          failedJobsUnretried: 0,
        },
        entity_typing: {
          ready: null,
          readyStatus: "unavailable",
          readyWarning:
            "Prepare the object-list catalog before calculating this metric.",
          failedJobsUnretried: 0,
        },
      },
      recovery: {
        startupChecks: true,
        periodicRetrySeconds: 300,
        note: "No persisted exact backlog snapshot exists yet.",
      },
      transcriptionRuntime: {
        configuredBatchSize: env.TRANSCRIPTION_BATCH_SIZE,
        configuredTimeoutMinutes: getJobTimeoutMinutes("transcription", {
          batchSize: env.TRANSCRIPTION_BATCH_SIZE,
        }),
        activeBatch: null,
        recentBatches: [],
      },
      snapshot: serializeDashboardSnapshot(snapshot),
    };
  }

  private async refreshExactBacklog(auth: Auth) {
    const operationId = new ObjectId().toString();
    const mongo = await getMongoResource(auth);
    const lease = await beginDashboardRefresh(
      mongo,
      EXACT_BACKLOG_SNAPSHOT_ID,
      operationId,
    );
    if (!lease) {
      const current = await readDashboardSnapshot(
        mongo,
        EXACT_BACKLOG_SNAPSHOT_ID,
      );
      return {
        accepted: false,
        operationId: current?.operationId,
        state: "refreshing",
      };
    }
    void this.runExactBacklogRefresh(operationId, auth, lease).catch(
      (error) => {
        console.error(
          `[jobs-dashboard] Exact backlog ${operationId} failed`,
          error,
        );
      },
    );
    return { accepted: true, operationId, state: "refreshing" };
  }

  private async runExactBacklogRefresh(
    operationId: string,
    auth: Auth,
    acquiredLease?: Record<string, any>,
  ) {
    const mongo = await getMongoResource(auth);
    const lease = acquiredLease ?? await beginDashboardRefresh(
      mongo,
      EXACT_BACKLOG_SNAPSHOT_ID,
      operationId,
    );
    if (!lease) return { accepted: false, reason: "already_refreshing" };
    try {
      const previous = lease.data as Record<string, any> | undefined;
      const next = await this.computePipelineHealth({
        action: "pipeline_health",
        force: true,
      }, auth);
      // A timed-out metric retains its last successful value while being
      // marked stale; other metrics commit normally.
      for (const [type, backlog] of Object.entries(next.backlogs)) {
        const prior = previous?.backlogs?.[type];
        const status = (backlog as any)?.readyStatus;
        if (status === "exact") {
          (backlog as any).readyAsOf = next.checkedAt;
        } else if (status && prior?.ready != null) {
          (backlog as any).ready = prior.ready;
          (backlog as any).readyStatus = `stale-${status}`;
          (backlog as any).readyAsOf = prior.readyAsOf ?? lease.asOf;
          (backlog as any).readyError = (backlog as any).readyWarning;
        }
      }
      await completeDashboardRefresh(
        mongo,
        EXACT_BACKLOG_SNAPSHOT_ID,
        operationId,
        next,
      );
      return { accepted: true };
    } catch (error) {
      await failDashboardRefresh(
        mongo,
        EXACT_BACKLOG_SNAPSHOT_ID,
        operationId,
        error,
      );
      throw error;
    }
  }

  private async computePipelineHealth(
    input: z.infer<typeof PipelineHealthSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);

    const [
      services,
      transcriptionReady,
      transcriptionRetryable,
      transcriptionProcessing,
      extractionReady,
      extractionRetryable,
      extractionProcessing,
      failedByWorker,
      activeTranscriptionJobs,
      recentTranscriptionBatches,
      transcriptionConfig,
    ] = await Promise.all([
      getExternalServicesHealth(input.force ?? false),
      mongo({
        action: "count",
        collection: "transcription_sequences",
        query: { state: "ready" },
      }),
      mongo({
        action: "count",
        collection: "transcription_sequences",
        query: { state: "error" },
      }),
      mongo({
        action: "count",
        collection: "transcription_sequences",
        query: { state: "processing" },
      }),
      mongo({
        action: "count",
        collection: "conversation_chunks",
        query: { state: "ready" },
      }),
      mongo({
        action: "count",
        collection: "conversation_chunks",
        query: { state: "error" },
      }),
      mongo({
        action: "count",
        collection: "conversation_chunks",
        query: { state: "processing" },
      }),
      mongo({
        action: "aggregate",
        collection: "jobs",
        pipeline: [
          {
            $match: {
              state: "failed",
              retriedAt: { $exists: false },
              dismissedAt: { $exists: false },
              type: {
                $in: [
                  "transcription",
                  "conversation_extractor",
                  "conversation_extractor_merged",
                  "summarization",
                  "tagger",
                  "entity_typing",
                ],
              },
            },
          },
          { $group: { _id: "$type", count: { $sum: 1 } } },
        ],
      }),
      mongo({
        action: "find",
        collection: "jobs",
        query: { type: "transcription", state: "active" },
        options: {
          sort: { updatedAt: -1 },
          limit: 1,
          projection: { _id: 1, progress: 1, updatedAt: 1, processedOn: 1 },
        },
      }),
      mongo({
        action: "find",
        collection: "jobs",
        query: {
          type: "transcription",
          state: "completed",
          "result.batchSize": { $exists: true },
        },
        options: {
          sort: { finishedAt: -1 },
          limit: 5,
          projection: {
            _id: 1,
            finishedAt: 1,
            "result.batchSize": 1,
            "result.processed": 1,
            "result.batchSequences": 1,
          },
          hint: "jobs_transcription_completed_finishedAt_v1",
          maxTimeMS: 3_000,
        },
      }),
      getConfigResource(auth).then((configResource) =>
        configResource({ action: "get", path: "transcription" })
      ),
    ]);

    // These are the three corpus-wide object counts behind the explicit
    // "Calculate exact backlog" action. Run them sequentially so one manual
    // click cannot create a three-query CPU burst. A deadline marks only that
    // card unavailable instead of failing the whole snapshot.
    const summariesMissing = await runExactCount(
      () =>
        mongo({
          action: "count",
          collection: "objects",
          query: {
            isConversation: true,
            // Subfield predicate matches the conversation_missing_summary index.
            "summaries.0.date": { $exists: false },
          },
          options: {
            hint: "conversation_missing_summary",
            maxTimeMS: 5_000,
          },
        }),
      5,
    );
    const untaggedConversations = await runExactCount(
      () =>
        mongo({
          action: "count",
          collection: "objects",
          query: buildTaggerConversationQuery(),
          options: {
            hint: "conversation_missing_tagging_marker_v1",
            maxTimeMS: 5_000,
          },
        }),
      5,
    );
    const objectCatalogState = await mongo({
      action: "findOne",
      collection: "object_list_state",
      query: { _id: "catalog" },
      options: { projection: { schemaVersion: 1, entityTypingReady: 1 } },
    });
    const untypedObjects = objectCatalogState?.schemaVersion >= 2 &&
        objectCatalogState?.entityTypingReady === true
      ? await runExactCount(
        () =>
          mongo({
            action: "count",
            collection: "objects",
            query: { _entityTypingPending: true },
            options: {
              hint: "objects_entity_typing_pending_v1",
              maxTimeMS: 5_000,
            },
          }),
        5,
      )
      : {
        value: null,
        status: "unavailable" as const,
        warning:
          "Object catalog v2 is not ready. Run Object-list catalog backfill to prepare the indexed entity-typing count.",
      };

    const failedCounts = Object.fromEntries(
      (failedByWorker as any[]).map((entry) => [entry._id, entry.count]),
    );
    const transcriptionSettings = transcriptionConfig as {
      batchSize?: unknown;
      batchTimeoutBaseSeconds?: unknown;
      batchTimeoutPerSequenceSeconds?: unknown;
    } | undefined;
    const configuredBatchSize = Number(transcriptionSettings?.batchSize);
    const batchSize = Number.isInteger(configuredBatchSize) &&
        configuredBatchSize >= 1 && configuredBatchSize <= 32
      ? configuredBatchSize
      : env.TRANSCRIPTION_BATCH_SIZE;
    const timeoutBaseSeconds = Number(
      transcriptionSettings?.batchTimeoutBaseSeconds,
    );
    const timeoutPerSequenceSeconds = Number(
      transcriptionSettings?.batchTimeoutPerSequenceSeconds,
    );

    return {
      checkedAt: new Date().toISOString(),
      services,
      backlogs: {
        transcription: {
          ready: Number(transcriptionReady),
          retryableErrors: Number(transcriptionRetryable),
          processing: Number(transcriptionProcessing),
          failedJobsUnretried: Number(failedCounts.transcription ?? 0),
        },
        // Chunks are shared between the legacy and the merged extractor;
        // the card is keyed to the merged (primary) worker, failed counts
        // cover both so legacy failures stay visible/retryable.
        conversation_extractor_merged: {
          ready: Number(extractionReady),
          retryableErrors: Number(extractionRetryable),
          processing: Number(extractionProcessing),
          failedJobsUnretried: Number(
            failedCounts.conversation_extractor_merged ?? 0,
          ) + Number(failedCounts.conversation_extractor ?? 0),
        },
        summarization: {
          // Conversation extraction already derives these objects from
          // transcript-backed chunks. Avoid a dashboard-wide range join here:
          // on a large library it can take minutes and block every health card.
          ready: summariesMissing.value,
          readyStatus: summariesMissing.status,
          ...(summariesMissing.status === "timeout"
            ? { readyWarning: summariesMissing.warning }
            : { missingTotal: summariesMissing.value }),
          failedJobsUnretried: Number(failedCounts.summarization ?? 0),
        },
        tagger: {
          ready: untaggedConversations.value,
          readyStatus: untaggedConversations.status,
          ...(untaggedConversations.status === "timeout"
            ? { readyWarning: untaggedConversations.warning }
            : {}),
          failedJobsUnretried: Number(failedCounts.tagger ?? 0),
        },
        entity_typing: {
          ready: untypedObjects.value,
          readyStatus: untypedObjects.status,
          ...(untypedObjects.status !== "exact"
            ? { readyWarning: untypedObjects.warning }
            : {}),
          failedJobsUnretried: Number(failedCounts.entity_typing ?? 0),
        },
      },
      recovery: {
        startupChecks: true,
        periodicRetrySeconds: 300,
        note:
          "Failed job history is retained. Retryable source records are checked on startup and every 5 minutes after dependencies recover.",
      },
      transcriptionRuntime: {
        configuredBatchSize: batchSize,
        configuredTimeoutMinutes: getJobTimeoutMinutes("transcription", {
          batchSize,
          batchTimeoutBaseSeconds: timeoutBaseSeconds,
          batchTimeoutPerSequenceSeconds: timeoutPerSequenceSeconds,
        }),
        activeBatch: (activeTranscriptionJobs as any[]).map((job) => ({
          jobId: job._id?.toString(),
          updatedAt: job.updatedAt,
          processedOn: job.processedOn,
          progress: job.progress || {},
        }))[0] ?? null,
        recentBatches: (recentTranscriptionBatches as any[]).map((job) => ({
          jobId: job._id?.toString(),
          finishedAt: job.finishedAt,
          batchSize: job.result?.batchSize,
          processed: job.result?.processed,
          sequences: job.result?.batchSequences || [],
        })),
      },
    };
  }

  private async timelineSourceStats(auth: Auth, exactCounts = false) {
    const mongo = await getMongoResource(auth);
    return await Promise.all(
      TIMELINE_SOURCE_COLLECTIONS.map(async ([collection, label]) => {
        const [countRows, first, last] = await Promise.all([
          exactCounts
            ? mongo({
              action: "aggregate",
              collection,
              pipeline: [
                { $match: { start: { $type: "date" } } },
                { $count: "count" },
              ],
              options: { allowDiskUse: true, maxTimeMS: 60_000 },
            })
            : mongo({
              action: "aggregate",
              collection,
              pipeline: [{ $collStats: { count: {} } }],
              options: { maxTimeMS: 5_000 },
            }),
          mongo({
            action: "findOne",
            collection,
            query: { start: { $type: "date" } },
            options: {
              sort: { start: 1 },
              projection: { start: 1, end: 1 },
              maxTimeMS: 30_000,
            },
          }),
          mongo({
            action: "findOne",
            collection,
            query: { start: { $type: "date" } },
            options: {
              sort: { start: -1 },
              projection: { start: 1, end: 1 },
              maxTimeMS: 30_000,
            },
          }),
        ]);
        const firstStart = validDate(first?.start);
        const lastStart = validDate(last?.start);
        const lastEnd = validDate(last?.end) ??
          (lastStart ? new Date(lastStart.getTime() + 1) : null);
        return {
          collection,
          label,
          // Campaign planning uses maintained metadata. The operator-triggered
          // exact audit scans date-bearing rows because $collStats can lag
          // behind recent bulk ingestion and produce false mismatches.
          documents: Number(countRows?.[0]?.count ?? 0),
          firstStart: firstStart?.toISOString() ?? null,
          lastStart: lastStart?.toISOString() ?? null,
          lastEnd: lastEnd?.toISOString() ?? null,
        };
      }),
    );
  }

  private async timelineDailyRepairRanges(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const [sourceDays, histogramDays] = await Promise.all([
      Promise.all(
        TIMELINE_SOURCE_COLLECTIONS.map(async ([collection]) => ({
          collection,
          rows: await mongo({
            action: "aggregate",
            collection,
            pipeline: [
              { $match: { start: { $type: "date" } } },
              {
                $group: {
                  _id: { $dateTrunc: { date: "$start", unit: "day" } },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            options: { allowDiskUse: true, maxTimeMS: 60_000 },
          }) as Array<{ _id: Date; count: number }>,
        })),
      ),
      mongo({
        action: "aggregate",
        collection: "histogram_1day",
        pipeline: [
          {
            $group: {
              _id: "$start",
              audio_chunks: {
                $sum: { $ifNull: ["$totals.audio_chunks.count", 0] },
              },
              transcriptions: {
                $sum: { $ifNull: ["$totals.transcriptions.count", 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ],
        options: { allowDiskUse: true, maxTimeMS: 60_000 },
      }) as Promise<
        Array<{
          _id: Date;
          audio_chunks: number;
          transcriptions: number;
        }>
      >,
    ]);

    const rawByDay = new Map<
      number,
      Record<"audio_chunks" | "transcriptions", number>
    >();
    for (const { collection, rows } of sourceDays) {
      for (const row of rows) {
        const start = validDate(row._id);
        if (!start) continue;
        const counts = rawByDay.get(start.getTime()) ?? {
          audio_chunks: 0,
          transcriptions: 0,
        };
        counts[collection] = Number(row.count ?? 0);
        rawByDay.set(start.getTime(), counts);
      }
    }

    return findTimelineRepairRanges(
      [...rawByDay.entries()].map(([start, counts]) => ({
        start: new Date(start),
        counts,
      })),
      histogramDays.flatMap((row) => {
        const start = validDate(row._id);
        return start
          ? [{
            start,
            counts: {
              audio_chunks: Number(row.audio_chunks ?? 0),
              transcriptions: Number(row.transcriptions ?? 0),
            },
          }]
          : [];
      }),
    ).map((range) => ({
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      days: range.days,
      differences: range.differences,
    }));
  }

  private async terminalTranscriptionMarkerStats(
    auth: Auth,
    apply: boolean,
  ) {
    const mongo = await getMongoResource(auth);
    if (!apply) {
      // A batched $in count performs one index seek per terminal sequence and
      // took 38 seconds on the live database when the result was empty. Let
      // MongoDB execute the indexed correlated lookup instead; the same exact
      // reconciliation completes in about 3 seconds and does not inherit the
      // generic find helper's 1,000-document default limit.
      const rows = await mongo({
        action: "aggregate",
        collection: "transcription_sequences",
        pipeline: [
          { $match: { state: { $in: ["completed", "empty"] } } },
          {
            $lookup: {
              from: "audio_chunks",
              let: { sequenceId: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        {
                          $eq: [
                            "$transcription_sequence_id",
                            "$$sequenceId",
                          ],
                        },
                        { $eq: ["$transcribed_at", null] },
                      ],
                    },
                  },
                },
                { $count: "count" },
              ],
              as: "missingChunks",
            },
          },
          {
            $group: {
              _id: null,
              terminalSequences: { $sum: 1 },
              eligibleChunks: {
                $sum: {
                  $ifNull: [{ $first: "$missingChunks.count" }, 0],
                },
              },
            },
          },
        ],
        options: { allowDiskUse: true, maxTimeMS: 60_000 },
      }) as Array<{ terminalSequences?: number; eligibleChunks?: number }>;
      return {
        terminalSequences: Number(rows[0]?.terminalSequences ?? 0),
        eligibleChunks: Number(rows[0]?.eligibleChunks ?? 0),
        modifiedChunks: 0,
        applied: false,
      };
    }

    let terminalSequences = 0;
    let eligibleChunks = 0;
    let modifiedChunks = 0;
    const sequenceBatchSize = 5_000;
    let afterId: ObjectId | null = null;
    while (true) {
      const sequences = await mongo({
        action: "find",
        collection: "transcription_sequences",
        query: {
          state: { $in: ["completed", "empty"] },
          ...(afterId ? { _id: { $gt: afterId } } : {}),
        },
        options: {
          sort: { _id: 1 },
          limit: sequenceBatchSize,
          projection: { _id: 1 },
        },
      }) as Array<{ _id: ObjectId }>;
      if (sequences.length === 0) break;
      terminalSequences += sequences.length;
      afterId = sequences.at(-1)!._id;
      const sequenceIds = sequences.map((sequence) => sequence._id);
      if (sequenceIds.length === 0) continue;
      const query = {
        transcription_sequence_id: { $in: sequenceIds },
        transcribed_at: null,
      };
      const count = Number(
        await mongo({
          action: "count",
          collection: "audio_chunks",
          query,
          options: {
            maxTimeMS: 30_000,
            hint: "audio_chunks_terminal_marker_repair",
          },
        }),
      );
      eligibleChunks += count;
      if (apply && count > 0) {
        const result = await mongo({
          action: "updateMany",
          collection: "audio_chunks",
          query,
          update: {
            $set: {
              transcribed_at: new Date(),
              transcription_marker_repaired_at: new Date(),
            },
          },
        });
        modifiedChunks += Number(result.modifiedCount ?? 0);
      }
    }

    return {
      terminalSequences,
      eligibleChunks,
      modifiedChunks,
      applied: apply,
    };
  }

  private async latestTimelineBookkeepingRepair(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const report = await mongo({
      action: "findOne",
      collection: "timeline_recovery_runs",
      query: {
        kind: "terminal_transcription_bookkeeping",
        applied: true,
      },
      options: {
        sort: { createdAt: -1 },
        projection: { _id: 0 },
        maxTimeMS: 5_000,
      },
    });
    if (!report) return null;
    return {
      checkedAt: validDate(report.checkedAt)?.toISOString() ?? null,
      terminalSequences: Number(report.terminalSequences ?? 0),
      eligibleChunks: Number(report.eligibleChunks ?? 0),
      modifiedChunks: Number(report.modifiedChunks ?? 0),
      applied: true,
      durationMs: Number(report.durationMs ?? 0),
      backfilled: report.backfilled === true,
    };
  }

  private async latestTimelineCampaign(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const latest = await mongo({
      action: "findOne",
      collection: "jobs",
      query: {
        type: "histRecalculation",
        "data.timelineRebuildCampaignId": { $exists: true },
      },
      options: {
        sort: { createdAt: -1 },
        projection: { "data.timelineRebuildCampaignId": 1 },
      },
    });
    const campaignId = latest?.data?.timelineRebuildCampaignId;
    if (!campaignId) return null;
    const campaignDocument = await ensureTimelineCampaignDocument(
      mongo,
      campaignId,
    );
    const durableReport = await syncTimelineCampaign(mongo, campaignId);

    const jobs = await mongo({
      action: "find",
      collection: "jobs",
      query: {
        type: "histRecalculation",
        "data.timelineRebuildCampaignId": campaignId,
      },
      options: {
        sort: { "data.timelineRebuildBatchIndex": 1 },
        projection: {
          state: 1,
          data: 1,
          result: 1,
          createdAt: 1,
          startedAt: 1,
          finishedAt: 1,
          failedReason: 1,
        },
      },
    }) as any[];
    const stateCounts = {
      active: 0,
      waiting: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of jobs) {
      if (job.state in stateCounts) {
        stateCounts[job.state as keyof typeof stateCounts]++;
      }
    }
    const planned = Number(
      jobs[0]?.data?.timelineRebuildBatchCount ?? jobs.length,
    );
    const missingJobs = Math.max(0, planned - jobs.length);
    const latestJob = jobs.at(-1);
    const latestFinishedAt = validDate(latestJob?.finishedAt);
    const continuationPending = missingJobs > 0 &&
      latestJob?.state === "completed" && latestJob?.result?.hasMore === true &&
      (!latestFinishedAt ||
        Date.now() - latestFinishedAt.getTime() < STALE_JOB_AGE_MS);
    const status = stateCounts.active > 0
      ? "running"
      : stateCounts.waiting + stateCounts.delayed > 0
      ? "queued"
      : missingJobs > 0
      ? continuationPending ? "queued" : "completed_with_errors"
      : timelineCampaignStatus({
        total: jobs.length,
        ...stateCounts,
      });
    const firstJob = jobs[0];
    const lastJob = jobs.at(-1);
    return {
      campaignId,
      status,
      plannedJobs: planned,
      queuedJobs: jobs.length,
      missingJobs,
      ...stateCounts,
      start: validDate(firstJob?.data?.start)?.toISOString() ?? null,
      end: validDate(
        firstJob?.data?.timelineRebuildEnd ?? lastJob?.data?.end,
      )?.toISOString() ?? null,
      createdAt: validDate(
        firstJob?.data?.timelineRebuildCreatedAt ?? firstJob?.createdAt,
      )
        ?.toISOString() ?? null,
      finishedAt:
        stateCounts.completed + stateCounts.failed + stateCounts.cancelled ===
            jobs.length
          ? validDate(
            jobs.reduce((latestDate: Date | null, job) => {
              const candidate = validDate(job.finishedAt);
              return candidate && (!latestDate || candidate > latestDate)
                ? candidate
                : latestDate;
            }, null),
          )?.toISOString() ?? null
          : null,
      mode: campaignDocument?.mode ??
        (Array.isArray(campaignDocument?.ranges)
          ? "selected_ranges"
          : "selected_period"),
      ranges: Array.isArray(campaignDocument?.ranges)
        ? campaignDocument.ranges.flatMap((range: any) => {
          const rangeStart = validDate(range?.start);
          const rangeEnd = validDate(range?.end);
          return rangeStart && rangeEnd
            ? [{
              start: rangeStart.toISOString(),
              end: rangeEnd.toISOString(),
            }]
            : [];
        })
        : [],
      failures: jobs.filter((job) =>
        job.state === "failed" || job.state === "cancelled"
      ).slice(0, 5).map((job) => ({
        jobId: job._id?.toString(),
        batchIndex: job.data?.timelineRebuildBatchIndex,
        start: validDate(job.data?.start)?.toISOString() ?? null,
        end: validDate(job.data?.end)?.toISOString() ?? null,
        reason: job.failedReason ?? job.state,
      })),
      ...(durableReport ?? {}),
    };
  }

  private async timelineIntegrityReport(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const [snapshot, campaign] = await Promise.all([
      readDashboardSnapshot<any>(mongo, TIMELINE_INTEGRITY_SNAPSHOT_ID),
      this.latestTimelineCampaign(auth),
    ]);
    if (snapshot?.data) {
      return {
        ...snapshot.data,
        campaign,
        snapshot: serializeDashboardSnapshot(snapshot),
      };
    }
    return {
      checkedAt: null,
      status: "not_checked",
      sources: [],
      histograms: [],
      repairPlan: { ranges: [], days: 0 },
      bookkeeping: {
        checked: false,
        terminalSequences: null,
        eligibleChunks: null,
        modifiedChunks: 0,
        applied: false,
      },
      lastBookkeepingRepair: await this.latestTimelineBookkeepingRepair(auth),
      campaign,
      issues: [],
      scope: {
        verifies: [],
        note: "No persisted Timeline integrity snapshot exists yet.",
      },
      performance: { totalMs: 0, stages: {} },
      snapshot: serializeDashboardSnapshot(snapshot),
    };
  }

  private async refreshTimelineIntegrity(auth: Auth) {
    const operationId = new ObjectId().toString();
    const mongo = await getMongoResource(auth);
    const lease = await beginDashboardRefresh(
      mongo,
      TIMELINE_INTEGRITY_SNAPSHOT_ID,
      operationId,
    );
    if (!lease) {
      const current = await readDashboardSnapshot(
        mongo,
        TIMELINE_INTEGRITY_SNAPSHOT_ID,
      );
      return {
        accepted: false,
        operationId: current?.operationId,
        state: "refreshing",
      };
    }
    void this.runTimelineIntegrityRefresh(operationId, auth, lease).catch(
      (error) => {
        console.error(
          `[jobs-dashboard] Timeline integrity ${operationId} failed`,
          error,
        );
      },
    );
    return { accepted: true, operationId, state: "refreshing" };
  }

  private async runTimelineIntegrityRefresh(
    operationId: string,
    auth: Auth,
    acquiredLease?: Record<string, any>,
  ) {
    const mongo = await getMongoResource(auth);
    const lease = acquiredLease ?? await beginDashboardRefresh(
      mongo,
      TIMELINE_INTEGRITY_SNAPSHOT_ID,
      operationId,
    );
    if (!lease) return { accepted: false, reason: "already_refreshing" };
    try {
      const report = await this.computeTimelineIntegrityReport(auth);
      await completeDashboardRefresh(
        mongo,
        TIMELINE_INTEGRITY_SNAPSHOT_ID,
        operationId,
        report,
      );
      if (report.campaign?.status === "verifying") {
        const verification = timelineVerificationOutcome(
          report.status === "healthy" ? "healthy" : "needs_attention",
        );
        await mongo({
          action: "updateOne",
          collection: TIMELINE_REBUILD_CAMPAIGNS,
          query: { _id: report.campaign.campaignId },
          update: {
            $set: {
              ...verification,
              autoRecover: false,
              completedAt: new Date(),
              verifiedAt: new Date(),
              verificationStatus: report.status,
            },
          },
          options: { touchUpdatedAt: false },
        });
      }
      return { accepted: true };
    } catch (error) {
      await failDashboardRefresh(
        mongo,
        TIMELINE_INTEGRITY_SNAPSHOT_ID,
        operationId,
        error,
      );
      throw error;
    }
  }

  private async computeTimelineIntegrityReport(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const auditStartedAt = performance.now();
    const stageMs: Record<string, number> = {};
    const timed = async <T>(name: string, task: () => Promise<T>) => {
      const startedAt = performance.now();
      try {
        return await task();
      } finally {
        stageMs[name] = Math.round(performance.now() - startedAt);
      }
    };
    const [
      sources,
      histograms,
      campaign,
      lastBookkeepingRepair,
    ] = await Promise.all([
      timed("sourceExactCounts", () => this.timelineSourceStats(auth, true)),
      timed(
        "histogramTotals",
        () =>
          Promise.all(TIMELINE_RESOLUTIONS.map(async (resolution) => {
            const rows = await mongo({
              action: "aggregate",
              collection: `histogram_${resolution}`,
              pipeline: [{
                $group: {
                  _id: null,
                  buckets: { $sum: 1 },
                  stale: {
                    $sum: { $cond: [{ $eq: ["$stale", true] }, 1, 0] },
                  },
                  firstStart: { $min: "$start" },
                  lastStart: { $max: "$start" },
                  audio_chunks: {
                    $sum: { $ifNull: ["$totals.audio_chunks.count", 0] },
                  },
                  transcriptions: {
                    $sum: { $ifNull: ["$totals.transcriptions.count", 0] },
                  },
                },
              }],
              options: { maxTimeMS: 60_000 },
            }) as any[];
            const row = rows[0] ?? {};
            return {
              resolution,
              buckets: Number(row.buckets ?? 0),
              stale: Number(row.stale ?? 0),
              firstStart: validDate(row.firstStart)?.toISOString() ?? null,
              lastStart: validDate(row.lastStart)?.toISOString() ?? null,
              totals: {
                audio_chunks: Number(row.audio_chunks ?? 0),
                transcriptions: Number(row.transcriptions ?? 0),
              },
            };
          })),
      ),
      timed("campaignReport", () => this.latestTimelineCampaign(auth)),
      timed(
        "bookkeepingReport",
        () => this.latestTimelineBookkeepingRepair(auth),
      ),
    ]);

    // Exact marker reconciliation is intentionally kept behind its own
    // Preview button. On a busy million-row audio collection it can take tens
    // of seconds even with an index; it must not block the main timeline audit.
    const bookkeeping = {
      checked: false,
      terminalSequences: null,
      eligibleChunks: null,
      modifiedChunks: 0,
      applied: false,
    };

    const daily = histograms.find((item) => item.resolution === "1day")!;
    const sourcesWithHistogram = sources.map((source) => ({
      ...source,
      histogramDocuments:
        daily.totals[source.collection as keyof typeof daily.totals],
      difference: daily.totals[source.collection as keyof typeof daily.totals] -
        source.documents,
    }));
    const repairRanges =
      sourcesWithHistogram.some((source) => source.difference !== 0)
        ? await timed(
          "repairRangePlan",
          () => this.timelineDailyRepairRanges(auth),
        )
        : [];
    const issues: Array<{
      severity: "warning" | "error";
      code: string;
      message: string;
      action: "repair_ranges" | "stale_only" | "resume_campaign";
      actionLabel: string;
    }> = [];
    for (const source of sourcesWithHistogram) {
      if (source.difference !== 0) {
        issues.push({
          severity: "error",
          code: `histogram_count_${source.collection}`,
          message:
            `${source.label}: Timeline density differs from raw documents by ${source.difference}.`,
          action: "repair_ranges",
          actionLabel: "Repair affected dates",
        });
      }
    }
    const staleBuckets = histograms.reduce((sum, item) => sum + item.stale, 0);
    if (staleBuckets > 0) {
      issues.push({
        severity: "warning",
        code: "stale_histogram_buckets",
        message: `${staleBuckets} histogram bucket(s) are still marked stale.`,
        action: "stale_only",
        actionLabel: "Update stale ranges",
      });
    }
    if (
      campaign && (campaign.status === "completed_with_errors" ||
        campaign.status === "paused_legacy" ||
        campaign.status === "paused_error" ||
        (campaign.missingJobs > 0 &&
          !["queued", "running", "recovering"].includes(campaign.status)))
    ) {
      issues.push({
        severity: "error",
        code: "timeline_rebuild_campaign_failed",
        message:
          "The latest timeline rebuild campaign has failed, cancelled, or missing jobs.",
        action: "resume_campaign",
        actionLabel: `Resume from batch ${(campaign.nextBatchIndex ?? 0) + 1}`,
      });
    }

    return {
      checkedAt: new Date().toISOString(),
      status: issues.length === 0 ? "healthy" : "needs_attention",
      sources: sourcesWithHistogram,
      histograms,
      repairPlan: {
        ranges: repairRanges,
        days: repairRanges.reduce((sum, range) => sum + range.days, 0),
      },
      bookkeeping,
      lastBookkeepingRepair,
      campaign,
      issues,
      scope: {
        verifies: [
          "raw audio/transcription ranges and document counts",
          "stored histogram totals at every resolution",
          "stale histogram flags",
          "terminal transcription bookkeeping when Preview repair is run",
          "latest rebuild campaign completion",
        ],
        note:
          "Matching totals and ranges are a reconciliation check, not a byte-for-byte proof of every bucket. When totals differ, the repair plan identifies exact UTC days and rebuilds only those bounded ranges.",
      },
      performance: {
        totalMs: Math.round(performance.now() - auditStartedAt),
        stages: stageMs,
        note:
          "The manual audit exactly counts date-bearing raw rows and reads indexed ranges. Exact terminal-marker reconciliation runs separately so it cannot stall this report.",
      },
    };
  }

  private async timelineBookkeepingRepair(
    input: z.infer<typeof TimelineBookkeepingRepairSchema>,
    auth: Auth,
  ) {
    const startedAt = performance.now();
    const result = await this.terminalTranscriptionMarkerStats(
      auth,
      input.apply,
    );
    const durationMs = Math.round(performance.now() - startedAt);
    if (input.apply) {
      const mongo = await getMongoResource(auth);
      await mongo({
        action: "insertOne",
        collection: "timeline_recovery_runs",
        doc: {
          kind: "terminal_transcription_bookkeeping",
          checkedAt: new Date(),
          createdAt: new Date(),
          ...result,
          durationMs,
        },
      });
    }
    return {
      checkedAt: new Date().toISOString(),
      ...result,
      durationMs,
      note: input.apply
        ? "Only transcribed_at bookkeeping was repaired; no transcript text was generated or changed."
        : "Preview only. Apply updates transcribed_at only for chunks owned by completed or empty transcription sequences.",
    };
  }

  private async startTimelineRebuild(
    input: z.infer<typeof StartTimelineRebuildSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const existing = await mongo({
      action: "findOne",
      collection: "jobs",
      query: {
        type: "histRecalculation",
        state: { $in: ["active", "waiting", "delayed"] },
      },
      options: { projection: { _id: 1, state: 1, data: 1 } },
    });
    if (existing) {
      throw new Error(
        `A histogram job is already ${existing.state} (${existing._id.toString()}). Wait for it or cancel it before starting another rebuild.`,
      );
    }

    if (input.ranges && (input.start || input.end)) {
      throw new Error("Use either Timeline rebuild ranges or start/end");
    }
    let mode: "affected_dates" | "selected_period" | "full";
    let ranges: Array<{ start: Date; end: Date }>;
    if (input.ranges) {
      mode = "affected_dates";
      ranges = normalizeTimelineRebuildRanges(
        input.ranges.map((range) => ({
          start: new Date(range.start),
          end: new Date(range.end),
        })),
      );
    } else {
      const sources = await this.timelineSourceStats(auth);
      const earliest = sources.map((source) => validDate(source.firstStart))
        .filter((date): date is Date => date != null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const latest = sources.map((source) => validDate(source.lastEnd))
        .filter((date): date is Date => date != null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const start = input.start ? new Date(input.start) : earliest;
      const end = input.end ? new Date(input.end) : latest;
      if (!start || !end) {
        throw new Error("No timeline source range is available to rebuild");
      }
      mode = input.start || input.end ? "selected_period" : "full";
      ranges = [{ start, end }];
    }

    const batches = buildTimelineRebuildRangeBatches(ranges, input.batchDays);
    if (batches.length > 240) {
      throw new Error(
        `Refusing to enqueue ${batches.length} jobs at once; choose a larger batch size or a smaller range.`,
      );
    }

    const campaignId = new ObjectId().toString();
    const createdAt = new Date();
    const firstBatch = batches[0];
    const start = ranges[0].start;
    const end = ranges.at(-1)!.end;
    await mongo({
      action: "insertOne",
      collection: TIMELINE_REBUILD_CAMPAIGNS,
      doc: {
        _id: campaignId,
        status: "queued",
        autoRecover: true,
        legacy: false,
        plannedJobs: batches.length,
        queuedJobs: 0,
        missingJobs: batches.length,
        batchDays: input.batchDays,
        start,
        end,
        mode,
        ranges,
        createdAt,
        lastActivityAt: createdAt,
      },
    });
    let job;
    try {
      job = await enqueueJob({
        type: "histRecalculation",
        start: firstBatch.start,
        end: firstBatch.end,
        staleOnly: false,
        markStale: false,
        timelineRebuildCampaignId: campaignId,
        timelineRebuildBatchIndex: 0,
        timelineRebuildBatchCount: batches.length,
        timelineRebuildCreatedAt: createdAt,
        timelineRebuildEnd: end,
        timelineRebuildBatchDays: input.batchDays,
      }, {
        trigger: {
          type: "manual",
          reason: `timeline_rebuild:${campaignId}`,
        },
      }, await getServerAuth());
      await mongo({
        action: "updateOne",
        collection: TIMELINE_REBUILD_CAMPAIGNS,
        query: { _id: campaignId },
        update: {
          $set: {
            queuedJobs: 1,
            missingJobs: batches.length - 1,
            activeJobId: job.id,
            lastActivityAt: new Date(),
          },
        },
        options: { touchUpdatedAt: false },
      });
    } catch (error) {
      await mongo({
        action: "updateOne",
        collection: TIMELINE_REBUILD_CAMPAIGNS,
        query: { _id: campaignId },
        update: {
          $set: {
            status: "paused_error",
            autoRecover: false,
            blockingReason: error instanceof Error
              ? error.message
              : String(error),
          },
        },
        options: { touchUpdatedAt: false },
      });
      throw error;
    }

    return {
      success: true,
      campaignId,
      status: "queued",
      start: start.toISOString(),
      end: end.toISOString(),
      mode,
      ranges: ranges.map((range) => ({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      })),
      batchDays: input.batchDays,
      plannedJobs: batches.length,
      queuedJobs: 1,
      firstJobId: job.id,
      lastJobId: job.id,
      createdAt: createdAt.toISOString(),
    };
  }

  private async getTimelineRebuildStatus(
    input: z.infer<typeof GetTimelineRebuildStatusSchema>,
    auth: Auth,
  ) {
    if (input.campaignId) {
      const mongo = await getMongoResource(auth);
      await ensureTimelineCampaignDocument(mongo, input.campaignId);
      return await syncTimelineCampaign(mongo, input.campaignId);
    }
    return await this.latestTimelineCampaign(auth);
  }

  private async pauseTimelineRebuild(
    input: z.infer<typeof PauseTimelineRebuildSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const campaign = await ensureTimelineCampaignDocument(
      mongo,
      input.campaignId,
    );
    if (!campaign) throw new Error(`Unknown campaign ${input.campaignId}`);
    await mongo({
      action: "updateOne",
      collection: TIMELINE_REBUILD_CAMPAIGNS,
      query: { _id: input.campaignId },
      update: {
        $set: {
          status: "paused",
          autoRecover: false,
          pausedAt: new Date(),
          blockingReason: "Paused by operator.",
        },
      },
      options: { touchUpdatedAt: false },
    });
    return await syncTimelineCampaign(mongo, input.campaignId);
  }

  private async resumeTimelineRebuild(
    input: z.infer<typeof ResumeTimelineRebuildSchema>,
  ) {
    return await reconcileTimelineCampaign(input.campaignId, {
      manualResume: true,
    });
  }

  private async resetWorker(
    input: z.infer<typeof ResetWorkerSchema>,
    auth: Auth,
  ) {
    const { workerType, restart } = input;
    const types = jobRegistry.getJobTypes();
    if (!types.includes(workerType)) {
      throw new Error(`Unknown worker type: ${workerType}`);
    }
    assertCanRunWorkerFromJobs(workerType);

    // Pause first so draining the queue cannot race with a worker taking the
    // next waiting job.
    await workerPauseManager.pauseWorker(workerType);
    await this.persistWorkerConfig(workerType, { paused: true }, auth);

    const mongo = await getMongoResource(auth);
    const liveJobs = await mongo({
      action: "find",
      collection: "jobs",
      query: {
        type: workerType,
        state: { $in: ["active", "waiting", "delayed"] },
      },
      options: { limit: 5000 },
    });

    const queue = getQueue(workerType);
    await queue.drain(true);

    let terminatedCount = 0;
    for (const job of liveJobs) {
      if (job.state === "active" && cancelRunningJob(job._id.toString())) {
        terminatedCount++;
      }
    }

    const now = new Date();
    const cancelled = await mongo({
      action: "updateMany",
      collection: "jobs",
      query: {
        type: workerType,
        state: { $in: ["active", "waiting", "delayed"] },
      },
      update: {
        $set: {
          state: "cancelled",
          cancelReason: "worker_reset",
          finishedAt: now,
          updatedAt: now,
        },
      },
    });

    let claimsCleared = 0;
    for (const job of liveJobs) {
      if (job.state === "active") {
        claimsCleared += await this.releaseJobClaims(job, mongo, now);
      }
    }
    if (workerType === "summarization") {
      const claimResult = await mongo({
        action: "updateMany",
        collection: "objects",
        query: { "_summarizationClaim.jobId": { $exists: true } },
        update: { $unset: { _summarizationClaim: "" } },
      });
      claimsCleared += claimResult.modifiedCount ?? 0;
    }

    let restartedJobId: string | undefined;
    if (restart) {
      const newJob = await enqueueJob(
        { type: workerType },
        { trigger: { type: "manual", reason: "worker_reset" } },
        await getServerAuth(),
      );
      restartedJobId = newJob.id;
      await workerPauseManager.resumeWorker(workerType);
      await this.persistWorkerConfig(workerType, { paused: false }, auth);
    }

    return {
      success: true,
      workerType,
      cancelledCount: cancelled.modifiedCount ?? 0,
      terminatedCount,
      claimsCleared,
      restartedJobId,
      paused: !restart,
    };
  }

  private async setWorkerConcurrency(
    input: z.infer<typeof SetWorkerConcurrencySchema>,
    auth: Auth,
  ) {
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }
    const concurrency = assertWorkerConcurrency(
      input.workerType,
      input.concurrency,
    );
    const previous = getWorkerRuntimeStatus(input.workerType)
      .effectiveConcurrency;
    const effectiveConcurrency = setWorkerRuntimeConcurrency(
      input.workerType,
      concurrency,
    );

    try {
      await this.persistWorkerConfig(
        input.workerType,
        { concurrency },
        auth,
      );
    } catch (error) {
      if (previous > 0) {
        setWorkerRuntimeConcurrency(input.workerType, previous);
      }
      throw error;
    }

    return {
      success: true,
      workerType: input.workerType,
      desiredConcurrency: concurrency,
      effectiveConcurrency,
    };
  }

  private async releaseJobClaims(
    job: Record<string, any>,
    mongo: Awaited<ReturnType<typeof getMongoResource>>,
    now: Date,
  ): Promise<number> {
    const jobId = job._id.toString();
    if (job.type === "summarization") {
      const result = await mongo({
        action: "updateMany",
        collection: "objects",
        query: { "_summarizationClaim.jobId": jobId },
        update: { $unset: { _summarizationClaim: "" } },
      });
      return result.modifiedCount ?? 0;
    }

    if (job.type === "conversation_extractor_merged") {
      const result = await mongo({
        action: "updateMany",
        collection: "conversation_chunks",
        query: { state: "processing", processedByJobId: jobId },
        update: {
          $set: {
            state: "error",
            error: "Worker job was restarted by the operator",
            extractionLastErrorAt: now,
            extractionRetryAfter: now,
          },
          $unset: { processingStartedAt: "" },
        },
      });
      return result.modifiedCount ?? 0;
    }

    if (job.type === "transcription") {
      const sequenceIds = new Set<string>();
      const addId = (value: unknown) => {
        if (typeof value === "string" && ObjectId.isValid(value)) {
          sequenceIds.add(value);
        }
      };
      addId(job.data?.sequenceId);
      addId(job.progress?.sequenceId);
      addId(job.progress?.prefetch?.sequenceId);
      for (const item of job.progress?.batchSequences ?? []) {
        addId(item?.sequenceId);
      }
      if (sequenceIds.size === 0) return 0;
      const result = await mongo({
        action: "updateMany",
        collection: "transcription_sequences",
        query: {
          _id: {
            $in: [...sequenceIds].map((id) => new ObjectId(id)),
          },
          state: "processing",
        },
        update: { $set: { state: "ready", updatedAt: now } },
      });
      return result.modifiedCount ?? 0;
    }

    return 0;
  }

  private async restartJob(
    input: z.infer<typeof RestartJobSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const jobs = await mongo({
      action: "find",
      collection: "jobs",
      query: { _id: new ObjectId(input.id) },
      options: { limit: 1 },
    });
    const job = jobs[0];
    if (!job) throw new Error(`Job ${input.id} not found`);
    assertCanRunWorkerFromJobs(job.type);
    if (job.state !== "active") {
      throw new Error("Only an active job can be restarted");
    }
    const updatedAt = job.updatedAt ?? job.startedAt ?? job.createdAt;
    if (
      !updatedAt ||
      new Date(updatedAt).getTime() > Date.now() - STALE_JOB_AGE_MS
    ) {
      throw new Error("This job is still updating and is not stale");
    }

    await assertJobServicesHealthy(job.type, true);
    const now = new Date();
    const cancelled = await mongo({
      action: "updateOne",
      collection: "jobs",
      query: { _id: job._id, state: "active" },
      update: {
        $set: {
          state: "cancelled",
          cancelReason: "targeted_restart",
          finishedAt: now,
          updatedAt: now,
        },
      },
    });
    if ((cancelled.modifiedCount ?? 0) === 0) {
      throw new Error("Job state changed before it could be restarted");
    }

    const cancellation = cancelActiveWorkerJob(job.type, input.id);
    const claimsReleased = await this.releaseJobClaims(job, mongo, now);
    const restarted = await enqueueJob(
      job.data,
      {
        trigger: { type: "manual", reason: `targeted_restart:${input.id}` },
        restartedFromJobId: input.id,
      },
      await getServerAuth(),
    );

    await mongo({
      action: "updateOne",
      collection: "jobs",
      query: { _id: job._id },
      update: {
        $set: {
          restartedAt: new Date(),
          restartJobId: restarted.id,
        },
      },
    });
    await publishJobUpdate(input.id, job.type, "job.state", {
      state: "cancelled",
      finishedOn: now.getTime(),
      restartJobId: restarted.id,
    });

    return {
      success: true,
      workerType: job.type,
      originalJobId: input.id,
      restartedJobId: restarted.id,
      claimsReleased,
      ...cancellation,
    };
  }

  private async forceStart(
    input: z.infer<typeof ForceStartSchema>,
    auth: Auth,
  ) {
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }
    assertCanRunWorkerFromJobs(input.workerType);
    if (this.activeWorkerActions.has(input.workerType)) {
      throw new Error(
        `Another ${input.workerType} launch is already in progress`,
      );
    }
    this.activeWorkerActions.add(input.workerType);
    try {
      if (await workerPauseManager.getEffectivePauseState(input.workerType)) {
        throw new Error(
          `Resume ${input.workerType} before force starting jobs`,
        );
      }
      await assertJobServicesHealthy(input.workerType, true);
      const runtime = getWorkerRuntimeStatus(input.workerType);
      if (!runtime.running) {
        throw new Error(`Worker ${input.workerType} is not running`);
      }

      const mongo = await getMongoResource(auth);
      const liveJobs = await mongo({
        action: "count",
        collection: "jobs",
        query: {
          type: input.workerType,
          state: { $in: ["active", "waiting", "delayed"] },
        },
      }) as number;
      const availableSlots = getAvailableForceStartSlots(
        runtime.effectiveConcurrency,
        liveJobs,
      );
      if (input.count > availableSlots) {
        throw new Error(
          `${input.workerType} has ${availableSlots} available slot(s); ` +
            `${liveJobs} live job(s) already use concurrency ` +
            `${runtime.effectiveConcurrency}`,
        );
      }

      const jobIds: string[] = [];
      for (let i = 0; i < input.count; i++) {
        const job = await enqueueJob(
          { type: input.workerType },
          { trigger: { type: "manual", reason: "force_start" } },
          await getServerAuth(),
        );
        if (job.id) jobIds.push(job.id);
      }
      return {
        success: true,
        workerType: input.workerType,
        requestedCount: input.count,
        startedCount: jobIds.length,
        jobIds,
        availableSlotsBefore: availableSlots,
      };
    } finally {
      this.activeWorkerActions.delete(input.workerType);
    }
  }

  private async list(input: z.infer<typeof ListJobsSchema>, auth: Auth) {
    const mongo = await getMongoResource(auth);

    // Legacy types keep historical jobs of removed workers visible.
    const types = input.types ||
      [
        ...defaultVisibleJobTypes(jobRegistry.getJobTypes()),
        ...LEGACY_JOB_TYPES,
      ];
    // "cancelled" belongs here: queue maintenance reaps jobs into that state
    // rather than failing them, and omitting it made those jobs vanish from the
    // list along with the only record of why they stopped.
    const queryStatuses = input.statuses ||
      ["active", "waiting", "delayed", "failed", "cancelled", "completed"];

    const totalLimit = input.limit ?? DEFAULT_JOBS_LIST_LIMIT;
    const idleAutoQuery = getIdleAutoJobQuery();
    const viewQuery = input.view === "idle_auto"
      ? idleAutoQuery
      : input.view === "operational"
      ? { $nor: [idleAutoQuery] }
      : {};
    // Provider filtering belongs in Mongo, before the result limit. The Jobs
    // page otherwise only filters its newest client-side snapshot and can hide
    // older diarization runs from the same route. New routed jobs always carry
    // this immutable enqueue-time provider ID.
    const providerQuery = input.providerProfileId
      ? {
        "data.routingContext.providerProfileId": input.providerProfileId,
      }
      : {};
    const campaignQuery = input.campaignId
      ? { "data.timelineRebuildCampaignId": input.campaignId }
      : {};

    const jobs = await mongo({
      action: "aggregate",
      collection: "jobs",
      pipeline: logicalJobListPipeline({
        type: { $in: types },
        ...providerQuery,
        ...campaignQuery,
      }, {
        state: { $in: queryStatuses },
        dismissedAt: { $exists: false },
        archivedAt: { $exists: false },
        ...viewQuery,
      }, totalLimit),
      options: {
        // A malformed or unexpectedly unselective list query must not consume
        // Mongo resources indefinitely. Campaign grouping may spill, but the
        // ordinary recent-jobs branch is index/limit bounded.
        allowDiskUse: true,
        maxTimeMS: JOBS_LIST_MAX_TIME_MS,
      },
    });

    // QueueEvents can be missed while the backend reloads, leaving a small
    // number of Mongo lifecycle rows behind BullMQ. Reconcile only returned
    // non-terminal rows; completed history does not pay an N+1 queue cost.
    const liveStates = new Map<
      string,
      {
        state: string;
        queueState?: string;
        queuePresent: boolean;
        processedOn?: number;
        finishedOn?: number;
        result?: unknown;
        failedReason?: string;
      }
    >();
    await Promise.all(
      jobs.filter((job: any) =>
        ["active", "waiting", "delayed"].includes(job.state)
      ).map(async (job: any) => {
        const id = job._id.toString();
        try {
          const queueJob = await getQueue(job.type).getJob(id);
          const queueState = queueJob ? await queueJob.getState() : undefined;
          liveStates.set(id, {
            state: resolveLiveJobState(job.state, queueState),
            queueState,
            queuePresent: queueJob != null,
            processedOn: queueJob?.processedOn,
            finishedOn: queueJob?.finishedOn,
            result: queueJob?.returnvalue,
            failedReason: queueJob?.failedReason,
          });
        } catch (error) {
          console.warn(
            `[jobs] Could not reconcile queue state for ${job.type}:${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );

    return jobs.map((job: any) => {
      const live = liveStates.get(job._id.toString());
      return {
        id: job._id.toString(),
        type: job.type,
        data: job.data,
        state: live?.state ?? job.state,
        progress: job.progress,
        result: live?.state === "completed" && live.result !== undefined
          ? live.result
          : job.result,
        trigger: job.trigger,
        timestamp: job.createdAt.getTime(),
        finishedOn: live?.finishedOn ?? job.finishedAt?.getTime(),
        processedOn: live?.processedOn ?? job.startedAt?.getTime(),
        failedReason: live?.failedReason || job.failedReason,
        restarted: job.restartInfo != null,
        restartedFromJobId: job.restartedFromJobId,
        restartJobId: job.restartJobId,
        routingContext: job.data?.routingContext,
        updatedOn: job.updatedAt?.getTime(),
        ...(live
          ? {
            queueState: live.queueState ?? null,
            queuePresent: live.queuePresent,
          }
          : {}),
      };
    });
  }

  private async progressUpdate(
    input: z.infer<typeof UpdateProgressSchema>,
    auth: Auth,
  ) {
    const mongoRoot = await getMongoResource(await getServerAuth());
    const { jobId, progress } = input;

    const jobDocs = await mongoRoot({
      action: "find",
      collection: "jobs",
      query: { _id: new ObjectId(jobId) },
      options: { limit: 1 },
    });

    const jobDoc = jobDocs[0];
    if (!jobDoc) {
      console.log(
        `[jobs] Job ${jobId} not found in MongoDB, cannot update progress`,
      );
      return { success: false, error: "Job not found" };
    }

    const jobType = jobDoc.type as string;

    // Check if this progress update is "newer" than what we have
    const currentProgress = jobDoc.progress;
    if (
      currentProgress && typeof currentProgress === "object" &&
      typeof progress === "object"
    ) {
      const currentVal = currentProgress.progress ?? currentProgress.iteration;
      const newVal = progress.progress ?? progress.iteration;

      if (
        typeof currentVal === "number" && typeof newVal === "number" &&
        newVal < currentVal
      ) {
        console.log(
          `[jobs] Ignoring stale progress update for ${jobId} (${newVal} < ${currentVal})`,
        );
        return { success: true, status: "stale" };
      }
    }

    await mongoRoot({
      action: "updateOne",
      collection: "jobs",
      query: { _id: new ObjectId(jobId) },
      update: {
        $set: {
          progress,
          updatedAt: new Date(),
        },
      },
    });

    const queue = getQueue(jobType);
    const job = await queue.getJob(jobId);

    if (job) {
      try {
        await job.updateProgress(progress);
      } catch (err) {
        console.log(
          `[jobs] Could not update BullMQ progress for job ${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await publishJobUpdate(jobId, jobType, "job.progress", {
      state: "active",
      progress,
      processedOn: jobDoc.startedAt?.getTime(),
    });

    return { success: true };
  }

  private async pauseWorker(
    input: z.infer<typeof PauseWorkerSchema>,
    auth: Auth,
  ) {
    const { workerType } = input;

    // Verify worker type exists
    const types = jobRegistry.getJobTypes();
    if (!types.includes(workerType)) {
      throw new Error(`Unknown worker type: ${workerType}`);
    }

    const wasPaused = await workerPauseManager.getEffectivePauseState(
      workerType,
    );
    if (!wasPaused) {
      await workerPauseManager.pauseWorker(workerType);
    }
    try {
      await this.persistWorkerConfig(workerType, { paused: true }, auth);
    } catch (error) {
      if (!wasPaused) await workerPauseManager.resumeWorker(workerType);
      throw error;
    }

    return { success: true, workerType, paused: true };
  }

  private async resumeWorker(
    input: z.infer<typeof ResumeWorkerSchema>,
    auth: Auth,
  ) {
    const { workerType } = input;

    // Verify worker type exists
    const types = jobRegistry.getJobTypes();
    if (!types.includes(workerType)) {
      throw new Error(`Unknown worker type: ${workerType}`);
    }

    const wasPaused = await workerPauseManager.getEffectivePauseState(
      workerType,
    );
    if (wasPaused) {
      await workerPauseManager.resumeWorker(workerType);
    }
    try {
      await this.persistWorkerConfig(workerType, { paused: false }, auth);
    } catch (error) {
      if (wasPaused) await workerPauseManager.pauseWorker(workerType);
      throw error;
    }

    return { success: true, workerType, paused: false };
  }

  private async pauseAll(auth: Auth) {
    const types = jobRegistry.getJobTypes();
    const before = Object.fromEntries(
      await Promise.all(types.map(async (workerType) =>
        [
          workerType,
          await workerPauseManager.getEffectivePauseState(workerType),
        ] as const
      )),
    );
    const workers = await workerPauseManager.setWorkersPaused(types, true);
    try {
      await this.persistWorkersConfig(types, { paused: true }, auth);
    } catch (error) {
      for (const workerType of types) {
        if (!before[workerType]) {
          await workerPauseManager.resumeWorker(workerType);
        }
      }
      throw error;
    }
    return { success: true, pausedWorkers: types, workers };
  }

  private async resumeAll(auth: Auth) {
    const types = jobRegistry.getJobTypes();
    const before = Object.fromEntries(
      await Promise.all(types.map(async (workerType) =>
        [
          workerType,
          await workerPauseManager.getEffectivePauseState(workerType),
        ] as const
      )),
    );
    const workers = await workerPauseManager.setWorkersPaused(types, false);
    try {
      await this.persistWorkersConfig(types, { paused: false }, auth);
    } catch (error) {
      for (const workerType of types) {
        if (before[workerType]) {
          await workerPauseManager.pauseWorker(workerType);
        }
      }
      throw error;
    }
    return { success: true, resumedWorkers: types, workers };
  }

  private async getWorkerStatus(auth: Auth) {
    const types = jobRegistry.getJobTypes();
    const configResource = await getConfigResource(auth);
    const config = await configResource({ action: "get" }) as any;
    const mongo = await getMongoResource(auth);
    const staleCutoff = new Date(Date.now() - STALE_JOB_AGE_MS);
    const liveCounts = await mongo({
      action: "aggregate",
      collection: "jobs",
      pipeline: [
        {
          $match: {
            type: { $in: types },
            state: { $in: ["active", "waiting", "delayed"] },
          },
        },
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
            staleActive: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$state", "active"] },
                      {
                        $lte: [
                          {
                            $ifNull: [
                              "$updatedAt",
                              { $ifNull: ["$startedAt", "$createdAt"] },
                            ],
                          },
                          staleCutoff,
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
        },
      ],
      options: { maxTimeMS: 3_000 },
    }) as any[];
    const liveByType = new Map(
      liveCounts.map((row: any) => [String(row._id), row]),
    );
    const staleJobs = await mongo({
      action: "find",
      collection: "jobs",
      query: {
        type: { $in: types },
        state: "active",
        $or: [
          { updatedAt: { $lte: staleCutoff } },
          {
            updatedAt: { $exists: false },
            startedAt: { $lte: staleCutoff },
          },
          {
            updatedAt: { $exists: false },
            startedAt: { $exists: false },
            createdAt: { $lte: staleCutoff },
          },
        ],
      },
      options: {
        limit: 100,
        projection: {
          type: 1,
          state: 1,
          createdAt: 1,
          startedAt: 1,
          updatedAt: 1,
          progress: 1,
        },
      },
    }) as any[];
    const staleClaims = await mongo({
      action: "count",
      collection: "objects",
      query: {
        "_summarizationClaim.startedAt": { $lte: staleCutoff.toISOString() },
      },
    }) as number;

    // One Redis round trip per worker; issue them together rather than paying
    // the wait once per worker down the loop.
    const pauseStates = new Map(
      await Promise.all(types.map(async (workerType) =>
        [
          workerType,
          await workerPauseManager.getEffectivePauseState(workerType),
        ] as const
      )),
    );

    const status: Record<string, any> = {};
    for (const workerType of types) {
      const counts = liveByType.get(workerType) ?? {};
      const workerStaleJobs = staleJobs.filter((job) =>
        job.type === workerType
      );
      const runtime = getWorkerRuntimeStatus(workerType);
      const defaultTriggerIntervalSeconds = jobRegistry.list().find((entry) =>
        entry.manifest.name === workerType
      )?.manifest.triggers?.interval;
      status[workerType] = {
        paused: pauseStates.get(workerType) ?? false,
        desiredConcurrency: config?.workers?.[workerType]?.concurrency ?? 1,
        effectiveConcurrency: runtime.effectiveConcurrency,
        minConcurrency: runtime.minConcurrency,
        maxConcurrency: runtime.maxConcurrency,
        // Scheduled-run cadence: capability default plus operator override.
        defaultTriggerIntervalSeconds,
        triggerIntervalSeconds:
          config?.workers?.[workerType]?.triggerIntervalSeconds ??
            defaultTriggerIntervalSeconds,
        running: runtime.running,
        active: Number(counts.active ?? 0),
        waiting: Number(counts.waiting ?? 0),
        delayed: Number(counts.delayed ?? 0),
        staleActive: Number(counts.staleActive ?? 0),
        staleClaims: workerType === "summarization" ? staleClaims : 0,
        staleJobs: workerStaleJobs.map((job) => ({
          id: job._id.toString(),
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          progress: job.progress,
        })),
      };
    }

    return { checkedAt: new Date().toISOString(), workers: status };
  }

  /**
   * Compact failure feed for error analysis on the Jobs page: every failed
   * job (including dismissed ones — analysis wants history) in the window,
   * with the failure reason truncated to what classification needs. The
   * frontend groups rows by error code/label and renders counts + timeline.
   */
  private async errorStats(
    input: z.infer<typeof ErrorStatsSchema>,
    auth: Auth,
  ) {
    const mongo = await getMongoResource(auth);
    const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000);

    const jobs = await mongo({
      action: "find",
      collection: "jobs",
      query: {
        state: "failed",
        createdAt: { $gte: since },
        ...(input.types?.length
          ? { type: { $in: input.types } }
          : { type: { $nin: [...DEFAULT_HIDDEN_JOB_TYPES] } }),
      },
      options: {
        sort: { createdAt: -1 },
        limit: 5000,
        projection: { type: 1, createdAt: 1, failedReason: 1, dismissedAt: 1 },
      },
    });

    return {
      sinceDays: input.sinceDays,
      truncated: jobs.length >= 5000,
      failures: jobs.map((job: any) => ({
        id: job._id.toString(),
        type: job.type,
        timestamp: job.createdAt?.getTime(),
        dismissed: job.dismissedAt != null,
        // 500 chars is enough for every classifier pattern while keeping the
        // payload small at the 5000-row cap.
        reason: String(job.failedReason ?? "").slice(0, 500),
      })),
    };
  }

  private async getJobsDashboard(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const registeredTypes = jobRegistry.getJobTypes();
    let pythonCapabilities: string[] | null = null;
    let pythonCapabilitiesError: string | null = null;
    try {
      const response = await fetch(`${env.PYTHON_WORKER_URL}/capabilities`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) {
        throw new Error(`Python capabilities returned HTTP ${response.status}`);
      }
      const payload = await response.json() as { jobs?: unknown };
      if (!Array.isArray(payload.jobs)) {
        throw new Error("Python capabilities did not return a jobs array");
      }
      pythonCapabilities = payload.jobs.filter((item): item is string =>
        typeof item === "string"
      );
    } catch (error) {
      pythonCapabilitiesError = error instanceof Error
        ? error.message
        : String(error);
    }
    let catalog = buildWorkerCatalog(registeredTypes, { pythonCapabilities });
    let catalogState: "ready" | "starting" | "stale" = registeredTypes.length
      ? pythonCapabilitiesError ? "stale" : "ready"
      : "starting";
    const existingCatalog = await readDashboardSnapshot<any[]>(
      mongo,
      WORKER_CATALOG_SNAPSHOT_ID,
    );
    let catalogAsOf = existingCatalog?.asOf;

    if (registeredTypes.length > 0 && !pythonCapabilitiesError) {
      const now = new Date();
      catalogAsOf = now;
      await mongo({
        action: "updateOne",
        collection: "jobs_dashboard_snapshots",
        query: { _id: WORKER_CATALOG_SNAPSHOT_ID },
        update: {
          $set: {
            schemaVersion: 1,
            state: "ready",
            data: catalog,
            asOf: now,
            lastSuccessfulAt: now,
            lastError: null,
          },
          $setOnInsert: { createdAt: now },
        },
        options: { upsert: true, touchUpdatedAt: false },
      });
    } else if (existingCatalog?.data?.length) {
      catalog = existingCatalog.data.map((entry: any) => ({
        ...entry,
        availability: entry.executionKind === "daemon"
          ? "daemon-managed"
          : entry.executionKind === "python-http" && pythonCapabilitiesError
          ? "degraded"
          : registeredTypes.length === 0
          ? "starting"
          : entry.availability,
      }));
      catalogState = "stale";
    }

    const [runHistory, exactBacklog, timelineIntegrity, runtime] = await Promise
      .all([
        readDashboardSnapshot(mongo, RUN_HISTORY_SNAPSHOT_ID),
        readDashboardSnapshot(mongo, EXACT_BACKLOG_SNAPSHOT_ID),
        readDashboardSnapshot(mongo, TIMELINE_INTEGRITY_SNAPSHOT_ID),
        this.getWorkerStatus(auth).catch((error) => {
          console.warn(
            "[jobs-dashboard] Live runtime status unavailable",
            error,
          );
          return {
            checkedAt: new Date().toISOString(),
            state: "stale",
            lastError: error instanceof Error ? error.message : String(error),
            workers: {},
          };
        }),
      ]);

    return {
      checkedAt: new Date().toISOString(),
      catalog: {
        state: catalogState,
        asOf: catalogAsOf ? new Date(catalogAsOf).toISOString() : undefined,
        workers: catalog,
        schemas: registeredTypes.length
          ? manualJobSchemas(jobRegistry.getJobSchemas())
          : {},
        ...(pythonCapabilitiesError
          ? { lastError: pythonCapabilitiesError }
          : {}),
      },
      runtime,
      snapshots: {
        runHistory: serializeDashboardSnapshot(runHistory),
        exactBacklog: serializeDashboardSnapshot(exactBacklog),
        timelineIntegrity: serializeDashboardSnapshot(timelineIntegrity),
      },
    };
  }

  private async refreshRunHistory(auth: Auth) {
    const operationId = new ObjectId().toString();
    const mongo = await getMongoResource(auth);
    const lease = await beginDashboardRefresh(
      mongo,
      RUN_HISTORY_SNAPSHOT_ID,
      operationId,
    );
    if (!lease) {
      const current = await readDashboardSnapshot(
        mongo,
        RUN_HISTORY_SNAPSHOT_ID,
      );
      return {
        accepted: false,
        operationId: current?.operationId,
        state: "refreshing",
      };
    }
    void refreshRunHistorySnapshot(mongo, operationId, lease).catch((error) => {
      console.error(
        `[jobs-dashboard] Run history ${operationId} failed`,
        error,
      );
    });
    return { accepted: true, operationId, state: "refreshing" };
  }

  private async stats(auth: Auth) {
    const mongo = await getMongoResource(auth);
    const snapshot = await readDashboardSnapshot<any>(
      mongo,
      RUN_HISTORY_SNAPSHOT_ID,
    );
    const history = snapshot?.data ?? {
      stats: [],
      totals: {
        active: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        cancelled: 0,
        total: 0,
      },
    };
    const live = await mongo({
      action: "aggregate",
      collection: "jobs",
      pipeline: [
        { $match: { state: { $in: ["active", "waiting", "delayed"] } } },
        {
          $group: {
            _id: { type: "$type", state: "$state" },
            count: { $sum: 1 },
          },
        },
      ],
      options: { maxTimeMS: 3_000 },
    }) as any[];
    const byType = new Map<string, Record<string, any>>(
      (history.stats ?? []).map((row: any) => [row.type, { ...row }]),
    );
    const totals = { ...history.totals };
    for (const row of live) {
      const type = row._id.type;
      const state = row._id.state as "active" | "waiting" | "delayed";
      const current = byType.get(type) ?? {
        type,
        totalRuns: 0,
        terminalRuns: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        emptyRuns: 0,
        idleAutoRuns: 0,
        successRate: 0,
        avgFrequency: "-",
        staleActive: 0,
        staleClaims: 0,
        active: 0,
        waiting: 0,
        delayed: 0,
      };
      current[state] = Number(row.count ?? 0);
      current.totalRuns += Number(row.count ?? 0);
      byType.set(type, current);
      totals[state] = Number(row.count ?? 0) + Number(totals[state] ?? 0);
      totals.total += Number(row.count ?? 0);
    }
    return {
      stats: [...byType.values()],
      totals,
      snapshot: serializeDashboardSnapshot(snapshot),
    };
  }

  private async persistWorkerConfig(
    workerType: string,
    config: { paused?: boolean; concurrency?: number },
    auth: Auth,
  ) {
    const configResource = await getConfigResource(auth);

    await configResource({
      action: "patch",
      path: `workers.${workerType}`,
      updates: config,
    });
  }

  private async persistWorkersConfig(
    workerTypes: string[],
    config: { paused?: boolean; concurrency?: number },
    auth: Auth,
  ) {
    const configResource = await getConfigResource(auth);
    await configResource({
      action: "patch",
      updates: {
        workers: Object.fromEntries(
          workerTypes.map((workerType) => [workerType, config]),
        ),
      },
    });
  }

  private async listWorkers(_auth: Auth) {
    const { workerDiscovery } = await import("@/lib/jobs/worker-discovery.ts");
    const workers = await workerDiscovery.getAllWorkers();

    return { workers };
  }

  private async getWorkerDefaults(
    input: z.infer<typeof GetWorkerDefaultsSchema>,
    _auth: Auth,
  ) {
    const { workerDiscovery } = await import("@/lib/jobs/worker-discovery.ts");
    const defaults = await workerDiscovery.getDefaultOverrides(
      input.workerType,
    );

    return {
      workerType: input.workerType,
      defaults: defaults || {},
    };
  }

  private async updateWorkerDefaults(
    input: z.infer<typeof UpdateWorkerDefaultsSchema>,
    _auth: Auth,
  ) {
    const { workerDiscovery } = await import("@/lib/jobs/worker-discovery.ts");

    // Verify worker type exists
    const types = jobRegistry.getJobTypes();
    if (!types.includes(input.workerType)) {
      throw new Error(`Unknown worker type: ${input.workerType}`);
    }

    await workerDiscovery.updateDefaultOverrides(
      input.workerType,
      input.defaults,
    );

    return {
      success: true,
      workerType: input.workerType,
      defaults: input.defaults,
    };
  }

  extractActions(input: WorkerProgressRequest): {
    path: ResourcePath;
    actions: string[];
  }[] {
    switch (input.action) {
      case "list":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "schemas":
        return [{ path: ["jobs"], actions: ["schemas"] }];
      case "cancel_all":
        return [{ path: ["jobs", "all"], actions: ["cancel"] }];
      case "clear_completed":
        return [{ path: ["jobs", "completed"], actions: ["delete"] }];
      case "clear_failed":
        return [{
          path: ["jobs", input.workerType, "failed"],
          actions: ["delete"],
        }];
      case "clear_queue":
        return [{ path: ["jobs", input.workerType], actions: ["cancel"] }];
      case "reset_worker":
        return [{
          path: ["jobs", input.workerType],
          actions: ["cancel", "pause", "resume", "enqueue"],
        }];
      case "cancel":
        return [{ path: ["jobs", input.id], actions: ["cancel"] }];
      case "dismiss_failed":
        return [{ path: ["jobs", input.id], actions: ["delete"] }];
      case "enqueue":
        return [{ path: ["jobs", input.data.type], actions: ["enqueue"] }];
      case "progressUpdate":
        return [{ path: ["jobs", input.jobId], actions: ["progressUpdate"] }];
      case "pause_worker":
        return [{ path: ["jobs", input.workerType], actions: ["pause"] }];
      case "resume_worker":
        return [{ path: ["jobs", input.workerType], actions: ["resume"] }];
      case "pause_all":
        return [{ path: ["jobs", "all"], actions: ["pause"] }];
      case "resume_all":
        return [{ path: ["jobs", "all"], actions: ["resume"] }];
      case "get_worker_status":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "set_worker_concurrency":
        return [{
          path: ["jobs", input.workerType],
          actions: ["configure"],
        }];
      case "restart_job":
        return [{
          path: ["jobs", input.id],
          actions: ["cancel", "enqueue"],
        }];
      case "force_start":
        return [{
          path: ["jobs", input.workerType],
          actions: ["enqueue"],
        }];
      case "list_workers":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "get_worker_defaults":
        return [{ path: ["jobs", input.workerType], actions: ["read"] }];
      case "update_worker_defaults":
        return [{ path: ["jobs", input.workerType], actions: ["configure"] }];
      case "stats":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "error_stats":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "pipeline_health":
      case "services_health":
      case "timeline_integrity_report":
        return [{ path: ["jobs"], actions: ["read"] }];
      case "timeline_bookkeeping_repair":
        return [{
          path: ["jobs", "timeline_recovery"],
          actions: input.apply ? ["read", "write"] : ["read"],
        }];
      case "start_timeline_rebuild":
        return [{
          path: ["jobs", "histRecalculation"],
          actions: ["enqueue"],
        }];
    }
    return [{ path: ["jobs"], actions: ["read", "write"] }];
  }
}

export async function getJobsResource(
  auth: Auth,
): Promise<(input: WorkerProgressRequest) => Promise<any>> {
  return auth.getResource("jobs");
}
