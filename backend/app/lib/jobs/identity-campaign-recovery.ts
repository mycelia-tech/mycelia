import { ObjectId } from "bson";
import { getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { enqueueJob } from "./queue.ts";
import type { JobData } from "./types.ts";

const STALE_RESERVATION_MS = 2 * 60_000;

type MongoOperation = (request: Record<string, unknown>) => Promise<any>;

export function buildIdentityCampaignRecoveryJob(
  campaign: Record<string, any>,
): JobData {
  const partitionIndex = Number(campaign.partitionIndex ?? 0);
  const partitions = Array.isArray(campaign.partitions)
    ? campaign.partitions
    : [];
  const partition = partitions[partitionIndex];
  if (!partition?.runId || !campaign.currentJobId) {
    throw new Error("Identity campaign reservation is incomplete");
  }
  const range = campaign.scope?.mode === "range"
    ? {
      start: campaign.scope.start,
      end: campaign.scope.end,
    }
    : campaign.snapshotCutoff
    ? { end: campaign.snapshotCutoff }
    : {};
  if (
    campaign.modelSetId &&
    (!campaign.sourceSnapshot || !Array.isArray(campaign.profileSnapshots) ||
      campaign.profileSnapshots.length === 0)
  ) {
    throw new Error("Identity model-set campaign snapshot is incomplete");
  }
  const identityContext = campaign.modelSetId
    ? {
      modelSetId: String(campaign.modelSetId),
      profileSnapshots: Array.isArray(campaign.profileSnapshots)
        ? campaign.profileSnapshots
        : [],
      sourceSnapshot: campaign.sourceSnapshot,
    }
    : {
      profileId: String(campaign.profileId),
      profileRevision: Number(campaign.profileRevision),
      calibrationId: String(campaign.calibrationId),
      evidenceSnapshotHash: String(campaign.evidenceSnapshotHash),
    };
  return {
    type: "speakerIdentity",
    runId: String(partition.runId),
    ...identityContext,
    ...range,
    ...(campaign.snapshotCutoff
      ? { snapshotCutoff: campaign.snapshotCutoff }
      : {}),
    ...(!campaign.modelSetId && campaign.sourceSnapshot
      ? { sourceSnapshot: campaign.sourceSnapshot }
      : {}),
    partitions,
    partitionIndex,
    ...(campaign.lastCursor ? { cursor: String(campaign.lastCursor) } : {}),
    campaignTotalSegments: Number(campaign.totalSegments ?? 0),
    campaignMode: campaign.mode === "classify_automatic"
      ? "classify_automatic"
      : "classify_existing",
    campaignId: String(campaign.campaignId),
    limit: 1_000,
  };
}

export async function reconcileIdentityCampaignReservations(
  dependencies: {
    mongo?: MongoOperation;
    enqueue?: typeof enqueueJob;
    now?: Date;
  } = {},
): Promise<{ recovered: number; retained: number; retriedLater: number }> {
  const mongo = dependencies.mongo ?? await getMongoResource(
    await getServerAuth(),
  );
  const enqueue = dependencies.enqueue ?? enqueueJob;
  const now = dependencies.now ?? new Date();
  const cutoff = new Date(now.getTime() - STALE_RESERVATION_MS);
  const campaigns = await mongo({
    action: "find",
    collection: "speaker_identity_campaigns",
    query: {
      active: true,
      status: "queued",
      currentJobId: { $type: "string" },
      updatedAt: { $lte: cutoff },
    },
    options: { sort: { updatedAt: 1 }, limit: 25 },
  }) as Array<Record<string, any>>;
  let recovered = 0;
  let retained = 0;
  let retriedLater = 0;

  for (const campaign of campaigns) {
    const jobId = String(campaign.currentJobId ?? "");
    if (!ObjectId.isValid(jobId)) continue;
    const existing = await mongo({
      action: "findOne",
      collection: "jobs",
      query: { _id: new ObjectId(jobId) },
      options: { projection: { _id: 1, state: 1 } },
    });
    if (existing && ["waiting", "active"].includes(existing.state)) {
      retained += 1;
      continue;
    }
    if (existing) {
      await mongo({
        action: "updateOne",
        collection: "speaker_identity_campaigns",
        query: {
          _id: campaign._id,
          active: true,
          status: "queued",
          currentJobId: jobId,
        },
        update: {
          $set: {
            active: false,
            status: "interrupted",
            failureReason: `Reserved job is already ${existing.state}`,
            finishedAt: now,
            updatedAt: now,
          },
        },
      });
      continue;
    }

    const claimed = await mongo({
      action: "updateOne",
      collection: "speaker_identity_campaigns",
      query: {
        _id: campaign._id,
        active: true,
        status: "queued",
        currentJobId: jobId,
        $or: [
          { reservationRecoveryClaimedAt: { $exists: false } },
          { reservationRecoveryClaimedAt: { $lte: cutoff } },
        ],
      },
      update: {
        $set: { reservationRecoveryClaimedAt: now, updatedAt: now },
      },
    }) as any;
    if (claimed?.matchedCount !== 1) continue;

    try {
      await enqueue(buildIdentityCampaignRecoveryJob(campaign), {
        jobId,
        priority: 3,
        trigger: {
          type: "auto",
          reason: "identity campaign reservation recovery",
        },
      });
      await mongo({
        action: "updateOne",
        collection: "speaker_identity_campaigns",
        query: { _id: campaign._id, active: true, currentJobId: jobId },
        update: {
          $set: { reservationRecoveredAt: now, updatedAt: now },
          $unset: {
            reservationRecoveryClaimedAt: "",
            reservationRecoveryError: "",
          },
        },
      });
      recovered += 1;
    } catch (error) {
      // An ambiguous queue response may still have persisted the stable job.
      const raced = await mongo({
        action: "findOne",
        collection: "jobs",
        query: { _id: new ObjectId(jobId) },
        options: { projection: { _id: 1, state: 1 } },
      });
      await mongo({
        action: "updateOne",
        collection: "speaker_identity_campaigns",
        query: { _id: campaign._id, active: true, currentJobId: jobId },
        update: {
          $set: {
            ...(raced ? { reservationRecoveredAt: now } : {}),
            ...(!raced
              ? {
                reservationRecoveryError: error instanceof Error
                  ? error.message
                  : String(error),
              }
              : {}),
            updatedAt: now,
          },
          $unset: { reservationRecoveryClaimedAt: "" },
        },
      });
      if (raced) recovered += 1;
      else retriedLater += 1;
    }
  }

  return { recovered, retained, retriedLater };
}
