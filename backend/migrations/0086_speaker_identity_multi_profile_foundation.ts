import type { Db } from "mongodb";
import {
  ensureCollectionExists,
  ensureIndexExists,
} from "@/utils/migrations.ts";

export const IDENTITY_MODEL_SETS = "identity_model_sets";
export const IDENTITY_MODEL_SET_HEADS = "identity_model_set_heads";
export const SPEAKER_IDENTITY_EVALUATIONS = "speaker_identity_evaluations";
export const SPEAKER_IDENTITY_PROJECTIONS = "speaker_identity_projections";
export const SPEAKER_IDENTITY_SOURCE_INDEX = "speaker_identity_source_index";
export const SPEAKER_IDENTITY_SOURCE_PARTITIONS =
  "speaker_identity_source_partitions";
export const SPEAKER_IDENTITY_SOURCE_BATCHES =
  "speaker_identity_source_batches";

export async function up(db: Db): Promise<void> {
  for (
    const collection of [
      IDENTITY_MODEL_SETS,
      IDENTITY_MODEL_SET_HEADS,
      SPEAKER_IDENTITY_EVALUATIONS,
      SPEAKER_IDENTITY_PROJECTIONS,
      SPEAKER_IDENTITY_SOURCE_INDEX,
      SPEAKER_IDENTITY_SOURCE_PARTITIONS,
      SPEAKER_IDENTITY_SOURCE_BATCHES,
    ]
  ) {
    await ensureCollectionExists(db, collection);
  }

  await ensureIndexExists(db, IDENTITY_MODEL_SETS, { modelSetId: 1 }, {
    name: "identity_model_set_id",
    unique: true,
  });
  await ensureIndexExists(db, IDENTITY_MODEL_SETS, { fingerprint: 1 }, {
    name: "identity_model_set_fingerprint",
    unique: true,
    partialFilterExpression: { fingerprint: { $type: "string" } },
  });
  await ensureIndexExists(
    db,
    IDENTITY_MODEL_SETS,
    { "profiles.profileId": 1, status: 1, createdAt: -1 },
    { name: "identity_model_sets_profile_status" },
  );
  await ensureIndexExists(
    db,
    IDENTITY_MODEL_SET_HEADS,
    { embeddingSpaceId: 1 },
    { name: "identity_model_set_head_space", unique: true },
  );
  await ensureIndexExists(
    db,
    "speaker_identity_campaigns",
    { modelSetId: 1, active: 1 },
    {
      name: "speaker_identity_single_active_model_set",
      unique: true,
      partialFilterExpression: {
        modelSetId: { $type: "string" },
        active: true,
      },
    },
  );

  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_EVALUATIONS,
    {
      segmentId: 1,
      profileId: 1,
      profileRevision: 1,
      calibrationId: 1,
    },
    { name: "speaker_identity_evaluation_snapshot", unique: true },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_EVALUATIONS,
    { profileId: 1, calibrationId: 1, state: 1, evaluatedAt: -1 },
    { name: "speaker_identity_evaluation_profile_state" },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_PROJECTIONS,
    { modelSetId: 1, segmentId: 1 },
    { name: "speaker_identity_projection_segment", unique: true },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_PROJECTIONS,
    { modelSetId: 1, runId: 1, embeddingSpaceId: 1, segmentId: 1 },
    { name: "speaker_identity_projection_partition" },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_PROJECTIONS,
    { modelSetId: 1, resolution: 1, start: 1, end: 1 },
    { name: "speaker_identity_projection_timeline" },
  );

  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_SOURCE_PARTITIONS,
    { buildId: 1, runId: 1, embeddingSpaceId: 1 },
    { name: "speaker_identity_source_partition", unique: true },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_SOURCE_PARTITIONS,
    { buildId: 1, embeddingSpaceId: 1, start: 1 },
    { name: "speaker_identity_source_space_range" },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_SOURCE_PARTITIONS,
    { cleanupAt: 1 },
    { name: "speaker_identity_source_partition_ttl", expireAfterSeconds: 0 },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_SOURCE_BATCHES,
    { buildId: 1, batchKey: 1 },
    { name: "speaker_identity_source_batch", unique: true },
  );
  await ensureIndexExists(
    db,
    SPEAKER_IDENTITY_SOURCE_BATCHES,
    { cleanupAt: 1 },
    { name: "speaker_identity_source_batch_ttl", expireAfterSeconds: 0 },
  );
  await ensureIndexExists(
    db,
    "diarizations",
    { lifecycleStatus: 1, _id: 1 },
    {
      name: "speaker_identity_source_index_scan",
      partialFilterExpression: { embedding: { $exists: true } },
    },
  );

  // A campaign with pending work was never complete. Preserve its history while
  // preventing it from being treated as the baseline for automatic matching.
  await db.collection("speaker_identity_campaigns").updateMany(
    {
      status: "completed",
      pendingSegments: { $gt: 0 },
    },
    {
      $set: {
        status: "interrupted_legacy",
        active: false,
        interruptionReason:
          "Legacy campaign reported completed with pending segments",
        interruptedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

export async function down(_db: Db): Promise<void> {
  // The new collections contain derived state and may already be referenced by
  // jobs. Keep them intact on rollback; no canonical audio or labels live here.
}
