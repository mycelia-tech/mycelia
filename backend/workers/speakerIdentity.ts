import { z } from "zod";
import { ObjectId } from "bson";
import { zDateOrString } from "@myceliasdk/zod-json-schema.ts";
import { NetworkJobCapability } from "./python.ts";
import { findUsableFullCalibration } from "@/lib/speakers/calibration-contract.ts";
import {
  identityPartitionKey,
  remainingIdentityPartitionSegments,
} from "@/lib/speakers/identity-campaign.ts";
import type { IdentityProfileSnapshot } from "@/lib/speakers/identity-model-set.ts";
import {
  identityPublishedSourceSnapshotMatches,
  identitySourceIndexSnapshot,
  SPEAKER_IDENTITY_SOURCE_INDEX,
  SPEAKER_IDENTITY_SOURCE_INDEX_ID,
  SPEAKER_IDENTITY_SOURCE_PARTITIONS,
} from "@/lib/speakers/identity-source-index.ts";
import { getTriggerTiming } from "@/lib/jobs/trigger-config.ts";

export const schema = z.object({
  type: z.literal("speakerIdentity"),
  runId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  profileRevision: z.number().int().positive().optional(),
  calibrationId: z.string().min(1).optional(),
  evidenceSnapshotHash: z.string().min(1).optional(),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  limit: z.number().int().min(1).max(10000).default(1000),
  cursor: z.string().optional(),
  campaignId: z.string().min(1).optional(),
  snapshotCutoff: zDateOrString().optional(),
  sourceSnapshot: z.object({
    buildId: z.string().min(1),
    revision: z.number().int().positive(),
    membershipRevision: z.number().int().nonnegative(),
    builtAt: zDateOrString(),
    maxSegmentId: z.string().nullable().optional(),
  }).optional(),
  modelSetId: z.string().min(1).optional(),
  profileSnapshots: z.array(z.object({
    profileId: z.string().min(1),
    profileRevision: z.number().int().positive(),
    calibrationId: z.string().min(1),
    embeddingSpaceId: z.string().min(1),
    evidenceSnapshotHash: z.string().min(1),
  })).max(100).optional(),
  partitions: z.array(z.object({
    runId: z.string().min(1),
    embeddingSpaceId: z.string().min(1),
    start: zDateOrString(),
    end: zDateOrString(),
    eligibleSegments: z.number().int().nonnegative(),
    sourceSegments: z.number().int().nonnegative(),
    indexedSourceSegments: z.number().int().nonnegative().optional(),
    sourceBuildId: z.string().min(1).optional(),
    sourceRevision: z.number().int().nonnegative().optional(),
    maxSegmentId: z.string().optional(),
    afterSegmentId: z.string().optional(),
    generation: z.number().int().nonnegative().nullable().optional(),
  })).max(2_000).default([]),
  partitionIndex: z.number().int().nonnegative().default(0),
  campaignTotalSegments: z.number().int().nonnegative().optional(),
  campaignMode: z.enum(["classify_existing", "classify_automatic"]).optional(),
}).superRefine((value, context) => {
  if (value.modelSetId) {
    if (!value.sourceSnapshot) {
      context.addIssue({
        code: "custom",
        path: ["sourceSnapshot"],
        message: "A model-set job requires a frozen source snapshot",
      });
    }
    if (!value.profileSnapshots?.length) {
      context.addIssue({
        code: "custom",
        path: ["profileSnapshots"],
        message: "A model-set job requires at least one profile snapshot",
      });
    }
    if (!value.partitions.length) {
      context.addIssue({
        code: "custom",
        path: ["partitions"],
        message: "A model-set job requires frozen source partitions",
      });
    }
    return;
  }
  for (
    const [field, current] of [
      ["profileId", value.profileId],
      ["profileRevision", value.profileRevision],
      ["calibrationId", value.calibrationId],
      ["evidenceSnapshotHash", value.evidenceSnapshotHash],
    ] as const
  ) {
    if (current === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `Legacy identity jobs require ${field}`,
      });
    }
  }
});

const PYTHON_WORKER_URL = Deno.env.get("PYTHON_WORKER_URL") ||
  "http://localhost:8000";

type MongoResource = (request: Record<string, unknown>) => Promise<any>;

type AutomaticIdentityContext = {
  modelSet: any;
  profiles: Array<{ snapshot: IdentityProfileSnapshot; profile: any }>;
  baseline: any;
  embeddingSpaceId: string;
};

function profileReference(profileId: string): string | ObjectId {
  return ObjectId.isValid(profileId) ? new ObjectId(profileId) : profileId;
}

async function frozenProfileIsCurrent(
  mongo: MongoResource,
  snapshot: IdentityProfileSnapshot,
): Promise<any | null> {
  const profile = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { _id: profileReference(snapshot.profileId) },
    options: {
      projection: {
        name: 1,
        revision: 1,
        embeddingSpaceId: 1,
        embedding: 1,
        enrollmentStatus: 1,
        lifecycleStatus: 1,
        activeCalibrationIds: 1,
        activeCalibrationId: 1,
        calibrationHeadsInitialized: 1,
        calibrationEvidenceRevision: 1,
      },
    },
  });
  if (
    !profile || profile.lifecycleStatus === "archived" ||
    profile.enrollmentStatus === "pending_rebuild" ||
    Number(profile.revision ?? 1) !== snapshot.profileRevision ||
    String(profile.embeddingSpaceId ?? "") !== snapshot.embeddingSpaceId ||
    !Array.isArray(profile.embedding) || profile.embedding.length === 0
  ) return null;

  const calibration = await mongo({
    action: "findOne",
    collection: "speaker_calibrations",
    query: {
      calibrationId: snapshot.calibrationId,
      profileId: snapshot.profileId,
    },
  });
  const usable = findUsableFullCalibration(calibration ? [calibration] : [], {
    profileId: snapshot.profileId,
    profileRevision: snapshot.profileRevision,
    embeddingSpaceId: snapshot.embeddingSpaceId,
  });
  if (
    !usable ||
    String(usable.evidenceSnapshotHash ?? "") !==
      String(snapshot.evidenceSnapshotHash ?? "") ||
    Number(usable.evidenceRevision ?? 0) !==
      Number(profile.calibrationEvidenceRevision ?? 0)
  ) return null;

  const activeIds = profile.activeCalibrationIds;
  const fullHead = activeIds && typeof activeIds === "object"
    ? activeIds.full
    : null;
  const authoritativeHead = fullHead ?? profile.activeCalibrationId;
  if (
    authoritativeHead
      ? String(authoritativeHead) !== snapshot.calibrationId
      : profile.calibrationHeadsInitialized === true || Boolean(activeIds)
  ) return null;
  return profile;
}

/**
 * Automatic classification extends the active model set without changing its
 * frozen profiles. If a profile or calibration has moved, an operator must
 * build and activate a replacement set first.
 */
async function resolveAutomaticIdentityContext(
  mongo: MongoResource,
): Promise<AutomaticIdentityContext | null> {
  const heads = await mongo({
    action: "find",
    collection: "identity_model_set_heads",
    query: { activeModelSetId: { $type: "string" } },
    options: { sort: { updatedAt: -1 }, limit: 25 },
  }) as any[];
  for (const head of heads ?? []) {
    const modelSetId = String(head.activeModelSetId ?? "");
    const embeddingSpaceId = String(head.embeddingSpaceId ?? "");
    if (!modelSetId || !embeddingSpaceId) continue;
    const modelSet = await mongo({
      action: "findOne",
      collection: "identity_model_sets",
      query: { modelSetId, status: "active", embeddingSpaceId },
    });
    const snapshots = Array.isArray(modelSet?.profiles)
      ? modelSet.profiles as IdentityProfileSnapshot[]
      : [];
    const total = Number(modelSet?.coverage?.totalSegments ?? 0);
    if (
      !modelSet || snapshots.length === 0 || total <= 0 ||
      Number(modelSet.coverage?.projectedSegments ?? -1) !== total ||
      snapshots.some((snapshot) =>
        !snapshot.profileId || !snapshot.calibrationId ||
        snapshot.embeddingSpaceId !== embeddingSpaceId
      )
    ) continue;

    const profiles: AutomaticIdentityContext["profiles"] = [];
    let snapshotsCurrent = true;
    for (const snapshot of snapshots) {
      const profile = await frozenProfileIsCurrent(mongo, snapshot);
      if (!profile) {
        snapshotsCurrent = false;
        break;
      }
      profiles.push({ snapshot, profile });
    }
    if (!snapshotsCurrent) continue;

    const baseline = await mongo({
      action: "findOne",
      collection: "speaker_identity_campaigns",
      query: {
        modelSetId,
        "scope.mode": "all_compatible",
        status: "completed",
        pendingSegments: 0,
        sourceChanged: { $ne: true },
      },
      options: {
        sort: { finishedAt: -1, updatedAt: -1 },
        projection: {
          _id: 1,
          campaignId: 1,
          finishedAt: 1,
          partitions: 1,
          sourceSnapshot: 1,
          totalSegments: 1,
        },
      },
    });
    if (!baseline || !Array.isArray(baseline.partitions)) continue;
    return { modelSet, profiles, baseline, embeddingSpaceId };
  }
  return null;
}

async function hasOpenIdentityCampaign(
  mongo: MongoResource,
  modelSetId: string,
): Promise<boolean> {
  const campaign = await mongo({
    action: "findOne",
    collection: "speaker_identity_campaigns",
    query: {
      modelSetId,
      active: true,
      status: { $in: ["queued", "counting", "running"] },
    },
    options: {
      projection: {
        _id: 1,
        mode: 1,
        status: 1,
        currentJobId: 1,
        updatedAt: 1,
      },
    },
  });
  if (
    campaign?.mode === "classify_automatic" && campaign.status === "queued" &&
    campaign.updatedAt &&
    new Date(campaign.updatedAt).getTime() < Date.now() - 5 * 60_000
  ) {
    const currentJobId = typeof campaign.currentJobId === "string"
      ? campaign.currentJobId
      : null;
    const persistedJob = currentJobId && ObjectId.isValid(currentJobId)
      ? await mongo({
        action: "findOne",
        collection: "jobs",
        query: { _id: new ObjectId(currentJobId) },
        options: { projection: { _id: 1, state: 1 } },
      })
      : null;
    if (persistedJob && ["waiting", "active"].includes(persistedJob.state)) {
      return true;
    }
    const interrupted = await mongo({
      action: "updateOne",
      collection: "speaker_identity_campaigns",
      query: {
        _id: campaign._id,
        active: true,
        currentJobId: currentJobId ?? null,
      },
      update: {
        $set: {
          active: false,
          status: "interrupted",
          failureReason: "Automatic enqueue was not completed",
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    }) as any;
    return interrupted?.matchedCount !== 1;
  }
  return Boolean(campaign);
}

async function loadReadyIdentitySource(
  mongo: MongoResource,
  embeddingSpaceId: string,
): Promise<
  {
    snapshot: NonNullable<ReturnType<typeof identitySourceIndexSnapshot>>;
    rows: any[];
  } | null
> {
  const state = await mongo({
    action: "findOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
  });
  const snapshot = identitySourceIndexSnapshot(state);
  if (!snapshot) return null;
  const rows = await mongo({
    action: "find",
    collection: SPEAKER_IDENTITY_SOURCE_PARTITIONS,
    query: {
      buildId: snapshot.buildId,
      status: "ready",
      embeddingSpaceId,
    },
    options: { sort: { start: 1, runId: 1 }, limit: 2_000 },
  }) as any[];
  const latestState = await mongo({
    action: "findOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
  });
  return identityPublishedSourceSnapshotMatches(snapshot, latestState)
    ? { snapshot, rows }
    : null;
}

function automaticIdentityPartitions(
  rows: any[],
  baseline: any,
  sourceSnapshot: NonNullable<ReturnType<typeof identitySourceIndexSnapshot>>,
): {
  partitions: Array<Record<string, unknown>>;
  totalSegments: number;
  pendingSegments: number;
  processedSegments: number;
  firstPendingIndex: number;
} | null {
  if (
    Number(baseline?.sourceSnapshot?.membershipRevision ?? -1) !==
      sourceSnapshot.membershipRevision
  ) return null;
  const baselineByKey = new Map<string, any>();
  for (const partition of baseline?.partitions ?? []) {
    baselineByKey.set(identityPartitionKey(partition), partition);
  }
  const currentKeys = new Set(rows.map((row) =>
    identityPartitionKey({
      runId: String(row.runId ?? ""),
      embeddingSpaceId: String(row.embeddingSpaceId ?? ""),
    })
  ));
  if ([...baselineByKey.keys()].some((key) => !currentKeys.has(key))) {
    return null;
  }

  const partitions: Array<Record<string, unknown>> = [];
  let totalSegments = 0;
  let pendingSegments = 0;
  for (const row of rows) {
    const runId = String(row.runId ?? "");
    const embeddingSpaceId = String(row.embeddingSpaceId ?? "");
    const sourceSegments = Number(row.sourceSegments ?? 0);
    const maxSegmentId = String(row.maxSegmentId ?? "");
    if (!runId || !embeddingSpaceId || sourceSegments <= 0 || !maxSegmentId) {
      continue;
    }
    const previous = baselineByKey.get(
      identityPartitionKey({ runId, embeddingSpaceId }),
    );
    const previousSegments = Number(previous?.sourceSegments ?? 0);
    const previousMaxSegmentId = String(previous?.maxSegmentId ?? "");
    // A same-membership source revision is append-only. Equal/shrinking counts
    // with another ceiling indicate replacement data and must wait for a new
    // model set instead of being treated as an append.
    if (
      previous &&
      (sourceSegments < previousSegments ||
        (sourceSegments === previousSegments &&
          maxSegmentId !== previousMaxSegmentId) ||
        (sourceSegments > previousSegments &&
          maxSegmentId === previousMaxSegmentId))
    ) return null;
    const eligibleSegments = remainingIdentityPartitionSegments(
      sourceSegments,
      previousSegments,
    );
    totalSegments += sourceSegments;
    pendingSegments += eligibleSegments;
    partitions.push({
      runId,
      embeddingSpaceId,
      start: new Date(row.start),
      end: new Date(row.end),
      eligibleSegments,
      sourceSegments,
      indexedSourceSegments: sourceSegments,
      sourceBuildId: sourceSnapshot.buildId,
      sourceRevision: sourceSnapshot.revision,
      maxSegmentId,
      ...(previousMaxSegmentId ? { afterSegmentId: previousMaxSegmentId } : {}),
      generation: null,
    });
  }
  const firstPendingIndex = partitions.findIndex((partition) =>
    Number(partition.eligibleSegments ?? 0) > 0
  );
  return {
    partitions,
    totalSegments,
    pendingSegments,
    processedSegments: Math.max(totalSegments - pendingSegments, 0),
    firstPendingIndex,
  };
}

export default new NetworkJobCapability({
  name: "speakerIdentity",
  schema,
  url: `${PYTHON_WORKER_URL}/jobs/speakerIdentity`,
  policies: [
    { resource: "db/speaker_profiles", action: "read", effect: "allow" },
    { resource: "db/speaker_calibrations", action: "read", effect: "allow" },
    { resource: "db/speaker_annotations", action: "read", effect: "allow" },
    { resource: "db/speaker_identity_campaigns", action: "*", effect: "allow" },
    { resource: "db/identity_model_sets", action: "*", effect: "allow" },
    {
      resource: "db/speaker_identity_source_index",
      action: "read",
      effect: "allow",
    },
    {
      resource: "db/speaker_identity_source_partitions",
      action: "read",
      effect: "allow",
    },
    {
      resource: "db/speaker_identity_evaluations",
      action: "*",
      effect: "allow",
    },
    {
      resource: "db/speaker_identity_projections",
      action: "*",
      effect: "allow",
    },
    { resource: "db/diarizations", action: "*", effect: "allow" },
  ],
  hasPendingWork: async ({ mongo }) => {
    const context = await resolveAutomaticIdentityContext(mongo);
    if (
      !context ||
      await hasOpenIdentityCampaign(mongo, context.modelSet.modelSetId)
    ) {
      return false;
    }
    const source = await loadReadyIdentitySource(
      mongo,
      context.embeddingSpaceId,
    );
    if (!source) return false;
    const plan = automaticIdentityPartitions(
      source.rows,
      context.baseline,
      source.snapshot,
    );
    // Cap trigger fan-out at one campaign even if runtime concurrency is raised.
    return plan && plan.pendingSegments > 0 ? 1 : 0;
  },
  getTriggerJobData: async (_payload, _reason, { mongo }) => {
    const context = await resolveAutomaticIdentityContext(mongo);
    if (
      !context ||
      await hasOpenIdentityCampaign(mongo, context.modelSet.modelSetId)
    ) {
      throw new Error(
        "Automatic speaker identity is not ready or already running",
      );
    }
    const source = await loadReadyIdentitySource(
      mongo,
      context.embeddingSpaceId,
    );
    if (!source) {
      throw new Error("Speaker identity source is still being prepared");
    }
    const snapshotCutoff = new Date();
    const scope = { mode: "all_compatible" as const };
    const plan = automaticIdentityPartitions(
      source.rows,
      context.baseline,
      source.snapshot,
    );
    if (!plan || plan.pendingSegments === 0 || plan.firstPendingIndex < 0) {
      throw new Error("No new compatible speaker segments remain");
    }
    const { partitions } = plan;
    const firstPartition = partitions[plan.firstPendingIndex];
    const profileSnapshots = context.profiles.map(({ snapshot }) => snapshot);
    const primary = context.profiles[0];
    const campaignId = `speaker-identity-auto-${crypto.randomUUID()}`;
    const now = new Date();
    await mongo({
      action: "insertOne",
      collection: "speaker_identity_campaigns",
      doc: {
        campaignId,
        mode: "classify_automatic",
        active: true,
        status: "queued",
        modelSetId: context.modelSet.modelSetId,
        profileId: primary.snapshot.profileId,
        profileIds: profileSnapshots.map((snapshot) => snapshot.profileId),
        profileSnapshots,
        profileName: primary.profile.name,
        profileRevision: primary.snapshot.profileRevision,
        calibrationId: primary.snapshot.calibrationId,
        evidenceSnapshotHash: primary.snapshot.evidenceSnapshotHash,
        classificationPolicy: "full",
        decisionValidity: "verified",
        embeddingSpaceId: context.embeddingSpaceId,
        scope,
        range: { start: null, end: snapshotCutoff },
        snapshotCutoff,
        sourceSnapshot: source.snapshot,
        partitions,
        partitionIndex: plan.firstPendingIndex,
        totalSegments: plan.totalSegments,
        pendingSegments: plan.pendingSegments,
        processedSegments: plan.processedSegments,
        matched: 0,
        rejected: 0,
        identified: 0,
        ambiguous: 0,
        unknown: 0,
        uncertain: 0,
        incompatibleSkipped: 0,
        estimatedBatches: Math.ceil(plan.pendingSegments / 1_000),
        createdAt: now,
        updatedAt: now,
      },
    });
    return {
      type: "speakerIdentity",
      runId: firstPartition.runId,
      modelSetId: context.modelSet.modelSetId,
      profileSnapshots,
      end: snapshotCutoff,
      snapshotCutoff,
      sourceSnapshot: source.snapshot,
      partitions,
      partitionIndex: plan.firstPendingIndex,
      campaignTotalSegments: plan.totalSegments,
      campaignMode: "classify_automatic",
      campaignId,
      limit: 1_000,
    };
  },
  triggers: {
    sources: [{
      channel: "mycelia:mongo:speaker_identity_source_index",
      name: "speaker_identity_source_ready",
      filter: {
        event: "mongo.change",
        "data.document.status": "ready",
      },
    }],
    ...getTriggerTiming("speakerIdentity"),
  },
});
