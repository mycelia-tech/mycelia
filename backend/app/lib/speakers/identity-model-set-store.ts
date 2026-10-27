import { ObjectId } from "bson";
import {
  identityModelSetActivationBlockers,
  identityModelSetFingerprint,
  type IdentityModelSetPartition,
  type IdentityModelSetSourceSnapshot,
  type IdentityProfileSnapshot,
} from "./identity-model-set.ts";

type MongoOperation = (request: any) => Promise<any>;

function mongoId(value: string): string | ObjectId {
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
}

async function currentProfileSnapshotBlockers(
  mongo: MongoOperation,
  snapshots: IdentityProfileSnapshot[],
): Promise<string[]> {
  const blockers: string[] = [];
  for (const snapshot of snapshots) {
    const [profile, calibration] = await Promise.all([
      mongo({
        action: "findOne",
        collection: "speaker_profiles",
        query: { _id: mongoId(snapshot.profileId) },
        options: {
          projection: {
            revision: 1,
            embeddingSpaceId: 1,
            lifecycleStatus: 1,
            activeCalibrationIds: 1,
            activeCalibrationId: 1,
            calibrationHeadsInitialized: 1,
            calibrationEvidenceRevision: 1,
          },
        },
      }),
      mongo({
        action: "findOne",
        collection: "speaker_calibrations",
        query: { calibrationId: snapshot.calibrationId },
        options: {
          projection: {
            calibrationId: 1,
            profileId: 1,
            profileRevision: 1,
            embeddingSpaceId: 1,
            evidenceSnapshotHash: 1,
            evidenceRevision: 1,
            status: 1,
            lifecycleStatus: 1,
          },
        },
      }),
    ]) as [Record<string, any> | null, Record<string, any> | null];
    const prefix = `profile ${snapshot.profileId}`;
    if (!profile || profile.lifecycleStatus === "archived") {
      blockers.push(`${prefix} is missing or archived`);
      continue;
    }
    if (Number(profile.revision ?? 1) !== snapshot.profileRevision) {
      blockers.push(`${prefix} revision changed`);
    }
    if (String(profile.embeddingSpaceId ?? "") !== snapshot.embeddingSpaceId) {
      blockers.push(`${prefix} embedding space changed`);
    }
    const activeFullCalibrationId = profile.activeCalibrationIds?.full ??
      profile.activeCalibrationId;
    if (String(activeFullCalibrationId ?? "") !== snapshot.calibrationId) {
      blockers.push(`${prefix} active calibration changed`);
    }
    if (
      !calibration || calibration.status !== "validated" ||
      calibration.lifecycleStatus !== "active" ||
      String(calibration.profileId ?? "") !== snapshot.profileId ||
      Number(calibration.profileRevision ?? 0) !== snapshot.profileRevision ||
      String(calibration.embeddingSpaceId ?? "") !==
        snapshot.embeddingSpaceId ||
      String(calibration.evidenceSnapshotHash ?? "") !==
        String(snapshot.evidenceSnapshotHash ?? "") ||
      Number(calibration.evidenceRevision ?? 0) !==
        Number(profile.calibrationEvidenceRevision ?? 0)
    ) {
      blockers.push(`${prefix} calibration evidence changed`);
    }
  }
  return blockers;
}

export type PrepareIdentityModelSetInput = {
  profiles: IdentityProfileSnapshot[];
  sourceSnapshot: IdentityModelSetSourceSnapshot;
  partitions: IdentityModelSetPartition[];
  scope: {
    mode: "all_compatible" | "range";
    start?: Date | string;
    end?: Date | string;
  };
  snapshotCutoff: Date | string;
  createdBy?: unknown;
};

function normalizeProfiles(
  profiles: IdentityProfileSnapshot[],
): IdentityProfileSnapshot[] {
  const result = [...profiles].sort((left, right) =>
    left.profileId.localeCompare(right.profileId)
  );
  if (result.length === 0) {
    throw new Error("An identity model set requires at least one profile");
  }
  if (
    new Set(result.map((profile) => profile.profileId)).size !== result.length
  ) {
    throw new Error("An identity model set cannot repeat a profile");
  }
  if (new Set(result.map((profile) => profile.embeddingSpaceId)).size !== 1) {
    throw new Error("An identity model set requires one embedding space");
  }
  return result;
}

function normalizePartitions(
  partitions: IdentityModelSetPartition[],
  embeddingSpaceId: string,
): IdentityModelSetPartition[] {
  const result = [...partitions].filter((partition) =>
    partition.embeddingSpaceId === embeddingSpaceId &&
    Number(partition.sourceSegments) > 0 &&
    Boolean(partition.maxSegmentId)
  ).sort((left, right) =>
    `${left.runId}\u0000${left.embeddingSpaceId}`.localeCompare(
      `${right.runId}\u0000${right.embeddingSpaceId}`,
    )
  );
  if (result.length === 0) {
    throw new Error("An identity model set requires frozen source partitions");
  }
  return result;
}

export async function prepareIdentityModelSet(
  mongo: MongoOperation,
  input: PrepareIdentityModelSetInput,
): Promise<{ modelSet: Record<string, any>; reused: boolean }> {
  const profiles = normalizeProfiles(input.profiles);
  const embeddingSpaceId = profiles[0].embeddingSpaceId;
  const partitions = normalizePartitions(input.partitions, embeddingSpaceId);
  const fingerprint = await identityModelSetFingerprint({
    profiles,
    sourceSnapshot: input.sourceSnapshot,
    partitions,
    scope: input.scope,
    snapshotCutoff: input.snapshotCutoff,
  });
  const existing = await mongo({
    action: "findOne",
    collection: "identity_model_sets",
    query: { fingerprint },
  }) as Record<string, any> | null;
  if (existing) {
    if (existing.status === "failed") {
      const now = new Date();
      await mongo({
        action: "updateOne",
        collection: "identity_model_sets",
        query: { _id: existing._id, fingerprint, status: "failed" },
        update: {
          $set: { status: "building", resumedAt: now, updatedAt: now },
          $unset: { failureReason: "", failedAt: "" },
        },
      });
      return {
        modelSet: { ...existing, status: "building", updatedAt: now },
        reused: true,
      };
    }
    return { modelSet: existing, reused: true };
  }

  const now = new Date();
  const totalSegments = partitions.reduce(
    (total, partition) => total + Number(partition.sourceSegments),
    0,
  );
  const modelSet = {
    modelSetId: `identity-model-set-${new ObjectId()}`,
    fingerprint,
    embeddingSpaceId,
    profileIds: profiles.map((profile) => profile.profileId),
    profiles,
    sourceSnapshot: input.sourceSnapshot,
    partitions,
    scope: input.scope,
    snapshotCutoff: new Date(input.snapshotCutoff),
    status: "building",
    coverage: { totalSegments, projectedSegments: 0 },
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await mongo({
      action: "insertOne",
      collection: "identity_model_sets",
      doc: modelSet,
    });
    return { modelSet, reused: false };
  } catch (error) {
    const concurrent = await mongo({
      action: "findOne",
      collection: "identity_model_sets",
      query: { fingerprint },
    }) as Record<string, any> | null;
    if (concurrent) return { modelSet: concurrent, reused: true };
    throw error;
  }
}

export async function activateIdentityModelSet(
  mongo: MongoOperation,
  modelSetId: string,
  activatedBy?: unknown,
): Promise<Record<string, unknown>> {
  const modelSet = await mongo({
    action: "findOne",
    collection: "identity_model_sets",
    query: { modelSetId },
  }) as Record<string, any> | null;
  if (!modelSet) throw new Error("Identity model set not found");

  const sourceIndex = await mongo({
    action: "findOne",
    collection: "speaker_identity_source_index",
    query: { _id: "active" },
  }) as Record<string, any> | null;
  if (sourceIndex?.status !== "ready") {
    throw new Error(
      "Identity model set cannot activate: source_index_not_ready",
    );
  }
  if (
    Number(sourceIndex.membershipRevision ?? -1) !==
      Number(modelSet.sourceSnapshot?.membershipRevision ?? -2)
  ) {
    throw new Error(
      "Identity model set cannot activate: source_membership_changed",
    );
  }

  const head = await mongo({
    action: "findOne",
    collection: "identity_model_set_heads",
    query: { embeddingSpaceId: modelSet.embeddingSpaceId },
  }) as Record<string, any> | null;
  if (
    modelSet.status === "active" && head?.activeModelSetId === modelSetId
  ) {
    if (
      head.previousModelSetId && head.previousModelSetId !== modelSetId
    ) {
      await mongo({
        action: "updateOne",
        collection: "identity_model_sets",
        query: { modelSetId: head.previousModelSetId, status: "active" },
        update: {
          $set: {
            status: "superseded",
            supersededBy: modelSetId,
            supersededAt: new Date(),
            updatedAt: new Date(),
          },
        },
      });
    }
    return { modelSetId, status: "active", reused: true, head };
  }

  const resumableActive = modelSet.status === "active" &&
    modelSet.scope?.mode === "all_compatible" &&
    Number(modelSet.coverage?.totalSegments ?? 0) > 0 &&
    Number(modelSet.coverage?.projectedSegments ?? 0) ===
      Number(modelSet.coverage?.totalSegments ?? 0);
  const blockers = resumableActive
    ? []
    : identityModelSetActivationBlockers(modelSet as any);
  if (blockers.length > 0) {
    throw new Error(
      `Identity model set cannot activate: ${blockers.join(", ")}`,
    );
  }

  const profileBlockers = await currentProfileSnapshotBlockers(
    mongo,
    Array.isArray(modelSet.profiles) ? modelSet.profiles : [],
  );
  if (profileBlockers.length > 0 || !modelSet.profiles?.length) {
    const now = new Date();
    const failureReason = profileBlockers.length > 0
      ? profileBlockers.join("; ")
      : "model set has no frozen profile snapshots";
    await mongo({
      action: "updateOne",
      collection: "identity_model_sets",
      query: {
        modelSetId,
        status: { $in: ["building", "ready", "active"] },
      },
      update: {
        $set: {
          status: "failed",
          failureReason: `profile_snapshot_changed: ${failureReason}`,
          failedAt: now,
          updatedAt: now,
        },
      },
    });
    throw new Error(
      `Identity model set cannot activate: profile_snapshot_changed: ${failureReason}`,
    );
  }

  const now = new Date();
  const activated = await mongo({
    action: "updateOne",
    collection: "identity_model_sets",
    query: {
      _id: modelSet._id,
      modelSetId,
      status: { $in: ["ready", "active"] },
      "coverage.totalSegments": Number(modelSet.coverage.totalSegments),
      "coverage.projectedSegments": Number(modelSet.coverage.totalSegments),
    },
    update: {
      $set: {
        status: "active",
        activatedAt: modelSet.activatedAt ?? now,
        activatedBy: modelSet.activatedBy ?? activatedBy ?? null,
        updatedAt: now,
      },
    },
  }) as Record<string, any>;
  if (Number(activated?.matchedCount ?? 0) !== 1) {
    throw new Error("Identity model set changed before activation; retry");
  }

  // The previous set remains active and visible until this single head switch.
  await mongo({
    action: "updateOne",
    collection: "identity_model_set_heads",
    query: { embeddingSpaceId: modelSet.embeddingSpaceId },
    update: {
      $set: {
        embeddingSpaceId: modelSet.embeddingSpaceId,
        activeModelSetId: modelSetId,
        previousModelSetId: head?.activeModelSetId ?? null,
        profileIds: modelSet.profileIds,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    options: { upsert: true },
  });
  if (head?.activeModelSetId && head.activeModelSetId !== modelSetId) {
    await mongo({
      action: "updateOne",
      collection: "identity_model_sets",
      query: { modelSetId: head.activeModelSetId, status: "active" },
      update: {
        $set: {
          status: "superseded",
          supersededBy: modelSetId,
          supersededAt: now,
          updatedAt: now,
        },
      },
    });
  }
  return {
    modelSetId,
    status: "active",
    reused: false,
    previousModelSetId: head?.activeModelSetId ?? null,
  };
}
