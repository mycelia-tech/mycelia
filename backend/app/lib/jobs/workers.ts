import type { Worker } from "bullmq";
import { ObjectId } from "bson";
import {
  createWorker,
  drainWaitingDiarizatorJobs,
  enqueueJob,
  getQueue,
  getQueueEvents,
  requestDiarizatorAdmissionDrain,
} from "./queue.ts";
import { cancelRunningJob, processJob } from "./processor.ts";
import { discoverJobWorkers, jobRegistry } from "./job-registry.ts";
import { publishJobUpdate } from "@/lib/events/publisher.ts";
import { getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { workerPauseManager } from "./worker-pause-manager.ts";
import { env } from "#/env.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import {
  getContinuationJobData,
  getContinuationPriority,
  shouldScheduleGenericContinuation,
} from "./job-chain.ts";
import {
  getWorkerConcurrencyRange,
  normalizeWorkerConcurrency,
} from "./worker-concurrency.ts";
import {
  getJobServiceDependencies,
  invalidateExternalServicesHealthCache,
} from "./service-health.ts";
import { isCancelledJobRecord } from "./job-state.ts";
import { isDiarizatorRoutedJobType } from "./diarizator-admission.ts";
import { releaseTranscriptionSequenceClaimsForJob } from "./transcription-claim-reaper.ts";
import {
  reconcileActiveTimelineCampaigns,
  syncTimelineCampaign,
} from "./timeline-campaign-recovery.ts";
import { triggerManager } from "./trigger-manager.ts";
import { reconcileAutomaticTimelineDensity } from "./timeline-density-maintenance.ts";

const workers = new Map<string, Worker>();
let timelineRecoveryInterval: ReturnType<typeof setInterval> | null = null;
const pendingDiarizatorRefillReasons = new Set<string>();
let diarizatorRefillScheduled = false;
let diarizatorRefillRunning = false;

const PROVIDER_FAILURE_PATTERN =
  /LLM API error|Failed to call resource llm|LLM_EMPTY_RESPONSE|LLM_INVALID_RESPONSE|No healthy (LLM|STT|provider)|error sending request|Connection refused|ECONNREFUSED|fetch failed/i;

function requestDiarizatorPoolRefill(reason: string): void {
  pendingDiarizatorRefillReasons.add(reason);
  if (diarizatorRefillScheduled || diarizatorRefillRunning) return;
  diarizatorRefillScheduled = true;
  queueMicrotask(() => void flushDiarizatorPoolRefill());
}

async function flushDiarizatorPoolRefill(): Promise<void> {
  diarizatorRefillScheduled = false;
  diarizatorRefillRunning = true;
  const reason = [...pendingDiarizatorRefillReasons].sort().join(",") ||
    "unspecified";
  pendingDiarizatorRefillReasons.clear();
  try {
    // Preserve global admission priority first. If a sensitive pinned job
    // cannot use the free route, synthesize ordinary historical work for the
    // remaining provider capacity immediately instead of waiting 10 seconds.
    await drainWaitingDiarizatorJobs({
      reason: `slot_release:${reason}`,
    });
    await triggerManager.triggerNow(
      "diarization",
      `slot_release:${reason}`,
    );
  } catch (error) {
    console.warn(
      `[DIARIZATION_ADMISSION] Pool refill failed (${reason}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    requestDiarizatorAdmissionDrain(`slot_release.retry:${reason}`);
  } finally {
    diarizatorRefillRunning = false;
    if (pendingDiarizatorRefillReasons.size > 0) {
      requestDiarizatorPoolRefill("coalesced");
    }
  }
}

export async function startWorkers() {
  console.log("Starting job workers...");

  // Discover and register all job workers
  await discoverJobWorkers();

  // Sync discovered workers with database
  const { workerDiscovery } = await import("./worker-discovery.ts");
  await workerDiscovery.syncDiscoveredWorkers();

  const jobTypes = jobRegistry.getJobTypes();
  const config = await getServerConfig();

  for (const jobType of jobTypes) {
    const concurrency = normalizeWorkerConcurrency(
      jobType,
      config?.workers?.[jobType]?.concurrency,
    );
    if (jobType === "histRecalculation") {
      // Manual campaigns and automatic day updates also serialize across
      // backend processes, not only within this process's Worker instance.
      await getQueue(jobType).setGlobalConcurrency(1);
    }
    const worker = createWorker(jobType, processJob, concurrency);

    // Global events listener to ensure MongoDB is in sync with BullMQ
    // This catches events even from other worker instances (like Python workers)
    const events = getQueueEvents(jobType);

    events.on("active", async ({ jobId, prev }) => {
      console.log(`[${jobType}] Job ${jobId} is now active (prev: ${prev})`);
      const auth = await getServerAuth();
      const mongo = await getMongoResource(auth);
      const startedAt = new Date();
      const existingJobs = await mongo({
        action: "find",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        options: { limit: 1 },
      });
      const existingJob = existingJobs[0];
      if (isCancelledJobRecord(existingJob)) {
        console.warn(
          `[${jobType}] Ignoring stale active event for cancelled job ${jobId}`,
        );
        return;
      }
      const isRestart = (existingJob?.attempts ?? 0) > 0 ||
        existingJob?.finishedAt != null;

      if (isRestart) {
        console.warn(
          `[${jobType}] Job ${jobId} restarted: clearing stale terminal data ` +
            `(previous state=${existingJob?.state ?? "unknown"}, ` +
            `attempts=${existingJob?.attempts ?? 0})`,
        );
      }

      await mongo({
        action: "updateOne",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        update: {
          $set: {
            state: "active",
            startedAt,
            updatedAt: new Date(),
            ...(isRestart
              ? {
                restartInfo: {
                  detectedAt: startedAt,
                  previousState: existingJob?.state,
                  previousStartedAt: existingJob?.startedAt,
                  previousFinishedAt: existingJob?.finishedAt,
                  attempt: (existingJob?.attempts ?? 0) + 1,
                },
              }
              : {}),
          },
          $inc: { attempts: 1 },
          $unset: {
            finishedAt: "",
            failedReason: "",
            result: "",
            cancelReason: "",
          },
        },
      });

      await publishJobUpdate(jobId, jobType, "job.active", {
        state: "active",
        processedOn: startedAt.getTime(),
        restarted: isRestart,
      });
    });

    events.on("completed", async ({ jobId, returnvalue }) => {
      console.log(`[${jobType}] Job ${jobId} completed globally`);
      const auth = await getServerAuth();
      const mongo = await getMongoResource(auth);
      const finishedAt = new Date();
      await mongo({
        action: "updateOne",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        update: {
          $set: {
            state: "completed",
            finishedAt,
            result: returnvalue,
            updatedAt: new Date(),
          },
        },
      });

      await publishJobUpdate(jobId, jobType, "job.completed", {
        state: "completed",
        finishedOn: finishedAt.getTime(),
        result: returnvalue,
      });
      if (jobType === "histRecalculation") {
        await reconcileAutomaticTimelineDensity();
      }
    });

    events.on("failed", async ({ jobId, failedReason }) => {
      console.error(`[${jobType}] Job ${jobId} failed globally:`, failedReason);
      // A provider-shaped failure means the cached "healthy" verdict is
      // stale: drop it so the next enqueue re-probes and blocks instead of
      // starting more jobs doomed to fail the same way.
      if (
        getJobServiceDependencies(jobType).length > 0 &&
        PROVIDER_FAILURE_PATTERN.test(failedReason ?? "")
      ) {
        invalidateExternalServicesHealthCache();
      }
      const auth = await getServerAuth();
      const mongo = await getMongoResource(auth);
      const existingJobs = await mongo({
        action: "find",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        options: { limit: 1 },
      });
      if (existingJobs[0]?.state === "cancelled") {
        console.log(
          `[${jobType}] Job ${jobId} was cancelled; preserving cancelled state after worker exit`,
        );
        return;
      }
      if (jobType === "transcription") {
        const released = await releaseTranscriptionSequenceClaimsForJob(
          mongo,
          jobId,
        );
        if (released > 0) {
          console.warn(
            `[SELF-HEAL] Released ${released} transcription sequence claim(s) from failed job ${jobId}.`,
          );
        }
      }
      const finishedAt = new Date();
      let partialResult: Record<string, unknown> | undefined;

      if (jobType === "summarization") {
        const savedSummaryStats = await mongo({
          action: "aggregate",
          collection: "objects",
          pipeline: [
            { $match: { "summaries.jobId": jobId } },
            { $unwind: "$summaries" },
            { $match: { "summaries.jobId": jobId } },
            {
              $group: {
                _id: null,
                summariesSaved: { $sum: 1 },
                lastSummaryAt: { $max: "$summaries.date" },
              },
            },
            { $project: { _id: 0 } },
          ],
        });
        if ((savedSummaryStats[0]?.summariesSaved ?? 0) > 0) {
          partialResult = {
            ...savedSummaryStats[0],
            reason: "summaries_saved_before_job_failure",
          };
          console.warn(
            `[${jobType}] Job ${jobId} failed after saving ` +
              `${savedSummaryStats[0].summariesSaved} summary result(s)`,
          );
        }
      }

      await mongo({
        action: "updateOne",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        update: {
          $set: {
            state: "failed",
            finishedAt,
            failedReason: failedReason,
            updatedAt: new Date(),
            ...(partialResult ? { partialResult } : {}),
          },
        },
      });

      await publishJobUpdate(jobId, jobType, "job.failed", {
        state: "failed",
        finishedOn: finishedAt.getTime(),
        failedReason: failedReason,
      });
    });

    events.on("removed", ({ jobId, prev }) => {
      if (!isDiarizatorRoutedJobType(jobType)) return;
      console.info(
        `[${jobType}] Job ${jobId} was removed from queue (prev: ${prev})`,
      );
      requestDiarizatorPoolRefill(`queue.removed:${jobType}`);
    });

    worker.on("active", (job) => {
      console.log(`[${jobType}] Local worker started job ${job.id}`);
    });

    worker.on("completed", async (job) => {
      console.log(`[${jobType}] Local worker completed job ${job.id}`);
      console.log(
        `[${jobType}] Job ${job.id} result:`,
        JSON.stringify(job.returnvalue),
      );

      if (shouldScheduleGenericContinuation(job.data, job.returnvalue)) {
        console.log(
          `[${jobType}] Scheduling another job for ${job.data.type} because hasMore is true`,
        );
        try {
          const continuationData = getContinuationJobData(
            job.data,
            job.returnvalue,
          ) as typeof job.data;
          let continuationJobId: string | undefined;
          let continuationMongo:
            | Awaited<ReturnType<typeof getMongoResource>>
            | undefined;
          if (
            job.data.type === "speakerIdentity" &&
            typeof job.data.campaignId === "string"
          ) {
            continuationJobId = new ObjectId().toString();
            const auth = await getServerAuth();
            continuationMongo = await getMongoResource(auth);
            const reserved = await continuationMongo({
              action: "updateOne",
              collection: "speaker_identity_campaigns",
              query: {
                campaignId: job.data.campaignId,
                active: true,
                currentJobId: String(job.id),
              },
              update: {
                $set: {
                  status: "queued",
                  currentJobId: continuationJobId,
                  updatedAt: new Date(),
                },
              },
            }) as any;
            if (reserved?.matchedCount !== 1) {
              throw new Error(
                "Speaker identity continuation lost campaign ownership",
              );
            }
          }
          const continuation = await enqueueJob(
            continuationData,
            {
              ...(continuationJobId ? { jobId: continuationJobId } : {}),
              priority: getContinuationPriority(job.data),
              trigger: { type: "auto", reason: "hasMore" },
              reuseHealthyRoute: job.data.type === "diarization",
            },
          );
          try {
            const mongo = continuationMongo ?? await getMongoResource(
              await getServerAuth(),
            );
            await mongo({
              action: "updateOne",
              collection: "jobs",
              query: { _id: new ObjectId(job.id!) },
              update: {
                $set: {
                  continuation: {
                    status: "queued",
                    attemptedAt: new Date(),
                    jobId: continuation.id,
                  },
                },
              },
            });
            if (
              job.data.type === "histRecalculation" &&
              typeof job.data.timelineRebuildCampaignId === "string"
            ) {
              await syncTimelineCampaign(
                mongo,
                job.data.timelineRebuildCampaignId,
              );
            }
          } catch (persistError) {
            // The next job already owns the durable campaign reservation.
            // A telemetry-link failure must not invalidate queued work.
            console.warn(
              `[${jobType}] Continuation queued but telemetry link failed`,
              persistError,
            );
          }
        } catch (error) {
          try {
            const auth = await getServerAuth();
            const mongo = await getMongoResource(auth);
            await mongo({
              action: "updateOne",
              collection: "jobs",
              query: { _id: new ObjectId(job.id!) },
              update: {
                $set: {
                  continuation: {
                    status: "failed",
                    attemptedAt: new Date(),
                    error: error instanceof Error
                      ? error.message
                      : String(error),
                  },
                },
              },
            });
          } catch (persistError) {
            console.error(
              `[${jobType}] Could not persist continuation failure`,
              persistError,
            );
          }
          if (
            job.data.type === "speakerIdentity" &&
            typeof job.data.campaignId === "string"
          ) {
            try {
              const auth = await getServerAuth();
              const mongo = await getMongoResource(auth);
              await mongo({
                action: "updateOne",
                collection: "speaker_identity_campaigns",
                query: { campaignId: job.data.campaignId, active: true },
                update: {
                  $set: {
                    status: "queued",
                    reservationRecoveryError: error instanceof Error
                      ? error.message
                      : String(error),
                    updatedAt: new Date(),
                  },
                },
              });
            } catch (campaignError) {
              console.error(
                "[speakerIdentity] Could not retain continuation reservation",
                campaignError,
              );
            }
          }
          console.warn(
            `[${jobType}] Deferred hasMore continuation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else if (job.returnvalue?.hasMore === true) {
        console.warn(
          `[${jobType}] Not scheduling another ${job.data.type} job because the previous run made no measurable progress`,
        );
      }
      if (isDiarizatorRoutedJobType(jobType)) {
        requestDiarizatorPoolRefill(`continuation.checked:${jobType}`);
      }
      if (jobType === "diarization") {
        void triggerManager.triggerNow(
          "speakerIdentity",
          `diarization.completed:${job.id}`,
        );
      }
    });

    worker.on("failed", async (job, err) => {
      console.error(
        `[${jobType}] Local worker failed job ${job?.id}:`,
        err.message,
      );
      if (
        jobType === "speakerIdentity" &&
        typeof job?.data?.campaignId === "string"
      ) {
        try {
          const auth = await getServerAuth();
          const mongo = await getMongoResource(auth);
          await mongo({
            action: "updateOne",
            collection: "speaker_identity_campaigns",
            query: { campaignId: job.data.campaignId, active: true },
            update: {
              $set: {
                status: "failed",
                active: false,
                failureReason: err.message,
                finishedAt: new Date(),
                updatedAt: new Date(),
              },
            },
          });
        } catch (campaignError) {
          console.warn(
            `[speakerIdentity] Could not close failed campaign ${job.data.campaignId}: ${
              campaignError instanceof Error
                ? campaignError.message
                : String(campaignError)
            }`,
          );
        }
      }
      if (isDiarizatorRoutedJobType(jobType)) {
        requestDiarizatorPoolRefill(`worker.failed:${jobType}`);
      }
    });

    worker.on("progress", async (job, progress) => {
      const auth = await getServerAuth();
      const mongo = await getMongoResource(auth);
      await mongo({
        action: "updateOne",
        collection: "jobs",
        query: { _id: new ObjectId(job.id) },
        update: {
          $set: {
            progress,
            updatedAt: new Date(),
          },
        },
      });

      await publishJobUpdate(job.id!, jobType, "job.progress", {
        state: "active",
        progress,
        processedOn: job.processedOn,
      });
    });

    worker.on("error", (err) => {
      console.error(`[${jobType}] Worker error:`, err);
    });

    workers.set(jobType, worker);
  }

  console.log(
    `Started ${workers.size} worker(s) for ${jobTypes.length} job types`,
  );
  console.log(`Python worker expected at: ${env.PYTHON_WORKER_URL}`);

  // Restore paused workers from config
  await restorePausedWorkers();
  await reconcileActiveTimelineCampaigns();
  await reconcileAutomaticTimelineDensity();
  if (!timelineRecoveryInterval) {
    timelineRecoveryInterval = setInterval(() => {
      void reconcileActiveTimelineCampaigns().then(() =>
        reconcileAutomaticTimelineDensity()
      );
    }, 30_000);
  }
}

async function restorePausedWorkers() {
  try {
    const config = await getServerConfig();

    if (config?.workers) {
      await workerPauseManager.initFromConfig(config.workers);
    }
  } catch (err) {
    console.error(
      "[workers] Failed to restore paused workers from config:",
      err,
    );
  }
}

export async function stopWorkers() {
  console.log("Stopping job workers...");

  if (timelineRecoveryInterval) {
    clearInterval(timelineRecoveryInterval);
    timelineRecoveryInterval = null;
  }

  await Promise.all([...workers.values()].map((worker) => worker.close()));
  workers.clear();

  console.log("All workers stopped");
}

export function getWorkerRuntimeStatus(workerType: string) {
  const worker = workers.get(workerType);
  const range = getWorkerConcurrencyRange(workerType);
  return {
    running: worker != null,
    effectiveConcurrency: worker?.concurrency ?? 0,
    minConcurrency: range.min,
    maxConcurrency: range.max,
  };
}

export function setWorkerRuntimeConcurrency(
  workerType: string,
  concurrency: number,
): number {
  const worker = workers.get(workerType);
  if (!worker) throw new Error(`Worker ${workerType} is not running`);
  worker.concurrency = concurrency;
  return worker.concurrency;
}

export function cancelActiveWorkerJob(
  workerType: string,
  jobId: string,
): { bullmqCancelled: boolean; processTerminated: boolean } {
  const worker = workers.get(workerType);
  return {
    bullmqCancelled: worker?.cancelJob(jobId, "targeted_restart") ?? false,
    processTerminated: cancelRunningJob(jobId),
  };
}
