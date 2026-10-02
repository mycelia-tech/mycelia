import { ObjectId } from "bson";
import { getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { enqueueJob, getQueue } from "./queue.ts";
import { redlock } from "@/lib/redis.ts";
import {
  buildTimelineRebuildRangeBatches,
  deriveTimelineCampaignRecoveryStatus,
} from "./timeline-recovery.ts";

export const TIMELINE_REBUILD_CAMPAIGNS = "timeline_rebuild_campaigns";

type MongoCall = (input: any) => Promise<any>;

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function ensureTimelineCampaignDocument(
  mongo: MongoCall,
  campaignId: string,
) {
  const existing = await mongo({
    action: "findOne",
    collection: TIMELINE_REBUILD_CAMPAIGNS,
    query: { _id: campaignId },
  });
  if (existing) return existing;
  const first = await mongo({
    action: "findOne",
    collection: "jobs",
    query: {
      type: "histRecalculation",
      "data.timelineRebuildCampaignId": campaignId,
    },
    options: {
      sort: { "data.timelineRebuildBatchIndex": 1 },
      hint: "timeline_rebuild_campaign_jobs",
      maxTimeMS: 5_000,
    },
  });
  if (!first) return null;
  const now = new Date();
  const document = {
    _id: campaignId,
    status: "paused_legacy",
    autoRecover: false,
    legacy: true,
    plannedJobs: Number(first.data?.timelineRebuildBatchCount ?? 1),
    batchDays: Number(first.data?.timelineRebuildBatchDays ?? 31),
    start: validDate(first.data?.start),
    end: validDate(first.data?.timelineRebuildEnd ?? first.data?.end),
    createdAt: validDate(first.data?.timelineRebuildCreatedAt) ??
      validDate(first.createdAt) ?? now,
    lastActivityAt: validDate(first.finishedAt ?? first.updatedAt) ?? now,
    blockingReason:
      "Legacy campaign is paused until an operator explicitly resumes it.",
  };
  await mongo({
    action: "updateOne",
    collection: TIMELINE_REBUILD_CAMPAIGNS,
    query: { _id: campaignId },
    update: { $setOnInsert: document },
    options: { upsert: true, touchUpdatedAt: false },
  });
  return document;
}

async function campaignJobs(mongo: MongoCall, campaignId: string) {
  return await mongo({
    action: "find",
    collection: "jobs",
    query: {
      type: "histRecalculation",
      "data.timelineRebuildCampaignId": campaignId,
    },
    options: {
      sort: { "data.timelineRebuildBatchIndex": 1 },
      hint: "timeline_rebuild_campaign_jobs",
      maxTimeMS: 5_000,
      projection: {
        _id: 1,
        state: 1,
        data: 1,
        result: 1,
        progress: 1,
        failedReason: 1,
        createdAt: 1,
        updatedAt: 1,
        finishedAt: 1,
      },
    },
  }) as any[];
}

export async function syncTimelineCampaign(
  mongo: MongoCall,
  campaignId: string,
) {
  const campaign = await ensureTimelineCampaignDocument(mongo, campaignId);
  if (!campaign) return null;
  const jobs = await campaignJobs(mongo, campaignId);
  const plannedJobs = Number(
    campaign.plannedJobs ??
      jobs[0]?.data?.timelineRebuildBatchCount ?? jobs.length,
  );
  const byIndex = new Map<number, any>();
  for (const job of jobs) {
    byIndex.set(Number(job.data?.timelineRebuildBatchIndex ?? 0), job);
  }
  const counts = {
    active: 0,
    waiting: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const job of byIndex.values()) {
    if (job.state in counts) counts[job.state as keyof typeof counts]++;
  }
  const missingJobs = Math.max(0, plannedJobs - byIndex.size);
  const nextBatchIndex =
    Array.from({ length: plannedJobs }, (_, index) => index)
      .find((index) => !byIndex.has(index)) ?? null;
  const activeJob = [...byIndex.values()].find((job) =>
    ["active", "waiting", "delayed"].includes(job.state)
  );
  const last = [...byIndex.values()].at(-1);
  const lastCompleted = [...byIndex.values()].filter((job) =>
    job.state === "completed"
  ).at(-1);
  const status = deriveTimelineCampaignRecoveryStatus({
    storedStatus: campaign.status,
    ...counts,
    missingJobs,
  });
  const processedThrough = validDate(lastCompleted?.data?.end)?.toISOString() ??
    null;
  const lastActivityAt = validDate(
    last?.updatedAt ?? last?.finishedAt ?? campaign.lastActivityAt,
  ) ?? new Date();
  const blockingReason = status === "paused_legacy"
    ? campaign.blockingReason
    : status === "paused_error"
    ? last?.failedReason ?? "A batch exhausted its retry policy."
    : status === "verifying"
    ? "All batches finished; exact integrity verification is required."
    : null;
  const report = {
    campaignId,
    status,
    workerType: "histRecalculation",
    queue: "jobs-histRecalculation",
    plannedJobs,
    queuedJobs: byIndex.size,
    missingJobs,
    nextBatchIndex,
    processedThrough,
    activeJobId: activeJob?._id?.toString() ?? null,
    progress: activeJob?.progress ?? null,
    lastActivityAt: lastActivityAt.toISOString(),
    canResume: status.startsWith("paused") || status === "recovering",
    canPause: ["queued", "running", "recovering"].includes(status),
    blockingReason,
    ...counts,
  };
  await mongo({
    action: "updateOne",
    collection: TIMELINE_REBUILD_CAMPAIGNS,
    query: { _id: campaignId },
    update: { $set: { ...report, lastActivityAt } },
    options: { touchUpdatedAt: false },
  });
  return report;
}

export async function reconcileTimelineCampaign(
  campaignId: string,
  options: { manualResume?: boolean } = {},
) {
  return await redlock.using(
    [`mycelia:lock:timeline-rebuild:${campaignId}`],
    30_000,
    async () => {
      const auth = await getServerAuth();
      const mongo = await getMongoResource(auth);
      const campaign = await ensureTimelineCampaignDocument(mongo, campaignId);
      if (!campaign) {
        throw new Error(`Unknown timeline rebuild campaign ${campaignId}`);
      }
      if (options.manualResume) {
        await mongo({
          action: "updateOne",
          collection: TIMELINE_REBUILD_CAMPAIGNS,
          query: { _id: campaignId },
          update: {
            $set: {
              status: "recovering",
              autoRecover: true,
              resumedAt: new Date(),
              blockingReason: null,
            },
          },
          options: { touchUpdatedAt: false },
        });
      } else if (
        !campaign.autoRecover || String(campaign.status).startsWith("paused")
      ) {
        return await syncTimelineCampaign(mongo, campaignId);
      }

      const jobs = await campaignJobs(mongo, campaignId);
      const live = jobs.find((job) =>
        ["active", "waiting", "delayed"].includes(job.state)
      );
      if (live) return await syncTimelineCampaign(mongo, campaignId);

      const failed = jobs.find((job) =>
        ["failed", "cancelled"].includes(job.state)
      );
      if (failed) {
        if (!options.manualResume) {
          await mongo({
            action: "updateOne",
            collection: TIMELINE_REBUILD_CAMPAIGNS,
            query: { _id: campaignId },
            update: {
              $set: {
                status: "paused_error",
                autoRecover: false,
                blockingReason: failed.failedReason ?? failed.state,
              },
            },
            options: { touchUpdatedAt: false },
          });
          return await syncTimelineCampaign(mongo, campaignId);
        }
        const bullJob = await getQueue("histRecalculation").getJob(
          failed._id.toString(),
        );
        if (!bullJob) {
          throw new Error(`Failed batch ${failed._id} is no longer in BullMQ`);
        }
        await bullJob.retry();
        await mongo({
          action: "updateOne",
          collection: "jobs",
          query: { _id: failed._id },
          update: {
            $set: {
              state: "waiting",
              updatedAt: new Date(),
              retryRequestedAt: new Date(),
            },
          },
          options: { touchUpdatedAt: false },
        });
        await mongo({
          action: "updateOne",
          collection: TIMELINE_REBUILD_CAMPAIGNS,
          query: { _id: campaignId },
          update: {
            $set: {
              status: "queued",
              autoRecover: true,
              blockingReason: null,
              lastActivityAt: new Date(),
            },
          },
          options: { touchUpdatedAt: false },
        });
        return await syncTimelineCampaign(mongo, campaignId);
      }

      const plannedJobs = Number(
        campaign.plannedJobs ??
          jobs[0]?.data?.timelineRebuildBatchCount ?? 1,
      );
      const indexes = new Set(
        jobs.map((job) => Number(job.data?.timelineRebuildBatchIndex ?? 0)),
      );
      const nextBatchIndex = Array.from(
        { length: plannedJobs },
        (_, index) => index,
      )
        .find((index) => !indexes.has(index));
      if (nextBatchIndex == null) {
        return await syncTimelineCampaign(mongo, campaignId);
      }

      const previous = jobs.find((job) =>
        Number(job.data?.timelineRebuildBatchIndex ?? 0) === nextBatchIndex - 1
      );
      const campaignStart = validDate(campaign.start)!;
      const campaignEnd = validDate(campaign.end)!;
      const batchDays = Number(campaign.batchDays ?? 31);
      const selectedRanges = Array.isArray(campaign.ranges)
        ? campaign.ranges.flatMap((range: any) => {
          const start = validDate(range?.start);
          const end = validDate(range?.end);
          return start && end ? [{ start, end }] : [];
        })
        : [];
      const selectedBatches = selectedRanges.length > 0
        ? buildTimelineRebuildRangeBatches(selectedRanges, batchDays)
        : [];
      const selectedBatch = selectedBatches[nextBatchIndex];
      const start = selectedBatch?.start ??
        validDate(previous?.result?.nextStart) ?? new Date(
        campaignStart.getTime() + nextBatchIndex * batchDays * 86_400_000,
      );
      const end = selectedBatch?.end ?? validDate(previous?.result?.nextEnd) ??
        new Date(Math.min(
          start.getTime() + batchDays * 86_400_000,
          campaignEnd.getTime(),
        ));
      const job = await enqueueJob({
        type: "histRecalculation",
        start,
        end,
        staleOnly: false,
        markStale: false,
        timelineRebuildCampaignId: campaignId,
        timelineRebuildBatchIndex: nextBatchIndex,
        timelineRebuildBatchCount: plannedJobs,
        timelineRebuildCreatedAt: validDate(campaign.createdAt) ?? new Date(),
        timelineRebuildEnd: campaignEnd,
        timelineRebuildBatchDays: batchDays,
      }, {
        trigger: { type: "auto", reason: `timeline_recovery:${campaignId}` },
      }, auth);
      await mongo({
        action: "updateOne",
        collection: TIMELINE_REBUILD_CAMPAIGNS,
        query: { _id: campaignId },
        update: {
          $set: {
            status: "queued",
            activeJobId: job.id,
            lastActivityAt: new Date(),
            blockingReason: null,
          },
        },
        options: { touchUpdatedAt: false },
      });
      return await syncTimelineCampaign(mongo, campaignId);
    },
  );
}

export async function reconcileActiveTimelineCampaigns() {
  const auth = await getServerAuth();
  const mongo = await getMongoResource(auth);
  const campaigns = await mongo({
    action: "find",
    collection: TIMELINE_REBUILD_CAMPAIGNS,
    query: {
      autoRecover: true,
      status: { $in: ["queued", "running", "recovering"] },
    },
    options: { projection: { _id: 1 }, limit: 20 },
  }) as any[];
  for (const campaign of campaigns) {
    try {
      await reconcileTimelineCampaign(campaign._id.toString());
    } catch (error) {
      console.error(
        `[timeline-recovery] Failed to reconcile ${campaign._id}:`,
        error,
      );
    }
  }
}
