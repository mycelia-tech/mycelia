import { ObjectId } from "bson";
import { z } from "zod";
import { type Auth } from "@/lib/auth/core.server.ts";
import { type Resource } from "@/lib/auth/resources.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { zDateOrString } from "@myceliasdk/zod-json-schema.ts";
import {
  applyManualIdentityProjection,
  getObservedRunStatus,
  projectAnnotationState,
} from "./run-lifecycle.ts";
import {
  assertProfileArchiveSnapshotCurrent,
  buildProfileArchiveUpdate,
  buildProfileRestoreUpdate,
} from "./profile-lifecycle.ts";
import { computeSpeakerProfileArchivePreview } from "./profile-lifecycle-resource.ts";
import {
  assertRunPurgeSnapshotCurrent,
  buildRunPurgeQueries,
  buildRunPurgeSnapshot,
  type RunPurgeSnapshot,
} from "./run-purge.ts";
import {
  applyReviewDecisionRevision,
  attachReviewDecisionSummaries,
  groupReviewSegments,
  latestReviewAnnotationsBySegment,
  prepareReviewCandidates,
  restoreReviewDecision,
} from "./review-sessions.ts";
import {
  applyHeldOutNegativeSafety,
  applyPositiveThresholdOverride,
  chooseCalibrationThresholds,
  classifyCalibrationScore,
  cosineSimilarity,
  evaluateCalibration,
  isolateEnrollmentSourceRecordings,
  scoreProfileEmbedding,
  selectProfileScoringStrategy,
  splitCalibrationRecordings,
} from "./calibration.ts";
import {
  calibrationEvidenceFingerprint,
  calibrationFingerprint,
  describeCalibrations,
  findUsableCalibration,
  findUsableFullCalibration,
  findUsablePilotCalibration,
  normalizeCalibrationPolicy,
  normalizeNegativeDecisionMode,
  normalizePositiveThresholdProvenance,
  SPEAKER_CALIBRATION_COMPUTED_BY,
  SPEAKER_CALIBRATION_CONTRACT_VERSION,
  SPEAKER_CALIBRATION_MIN_CHECK_AUTO_MATCHES,
  SPEAKER_CALIBRATION_MIN_CHECK_AUTO_REJECTIONS,
  SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS,
  SPEAKER_CALIBRATION_PILOT_MAX_RANGE_HOURS,
  SPEAKER_CALIBRATION_PILOT_MIN_PRECISION,
  SPEAKER_CALIBRATION_TARGET_PRECISION,
  SPEAKER_IDENTITY_SNAPSHOT_INDEX,
} from "./calibration-contract.ts";
import {
  buildDiarizationCoveragePipeline,
  buildIdentityClassificationSummaryPipeline,
  buildManualOnlyIdentitySummary,
  buildSpeakerTimelinePipeline,
  buildTimelineAnnotationOverlapProjectionPipeline,
  mergeSpeakerTimelineRows,
  TIMELINE_SPEAKER_SEGMENT_PROJECTION,
} from "./timeline-queries.ts";
import {
  buildCurrentIdentityCondition,
  type IdentityCalibrationSnapshot,
  type IdentityPartition,
  identityPartitionKey,
  isCompleteIdentityCampaign,
  normalizeIdentityScope,
  remainingIdentityPartitionSegments,
} from "./identity-campaign.ts";
import {
  identitySourceIndexSnapshot,
  identitySourceIndexView,
  identitySourcePartitionMatches,
  identitySourceSnapshotMatches,
  markIdentitySourceIndexCounting,
  reconcileIdentitySourceIndexReservations,
  SPEAKER_IDENTITY_SOURCE_INDEX,
  SPEAKER_IDENTITY_SOURCE_INDEX_ID,
  SPEAKER_IDENTITY_SOURCE_PARTITIONS,
} from "./identity-source-index.ts";
import {
  activateIdentityModelSet,
  prepareIdentityModelSet,
} from "./identity-model-set-store.ts";
import {
  identityModelSetFingerprint,
  type IdentityProfileSnapshot,
} from "./identity-model-set.ts";
import {
  activeModelSetsByEmbeddingSpace,
  activeProjectionIdentity,
} from "./identity-projection-read.ts";
import {
  assertActivationPreviewSafe,
  buildEmptyActivationRepairPlan,
  collectReplacementRunIds,
  previewActivationSafety,
  previewEmptyActivationRepair,
  selectDiarizationLifecycleIndex,
} from "./activation-repair.ts";
import { redlock } from "@/lib/redis.ts";

type ActivationLockSignal = AbortSignal & { error?: unknown };

function assertActivationLock(
  signal: ActivationLockSignal,
  phase: string,
): void {
  if (!signal.aborted) return;
  throw new Error(
    `Diarization activation lock was lost before ${phase}; preview and retry`,
    { cause: signal.error ?? signal.reason },
  );
}

const objectId = z.string().refine(ObjectId.isValid, "Invalid ObjectId");
const range = { start: zDateOrString(), end: zDateOrString() };
const profileName = z.string().trim().min(1).max(120);
const SPEAKER_REVIEW_SOURCE_INDEX = "speaker_review_source_scan";
const SPEAKER_REVIEW_RANGE_INDEX = "speaker_review_range_scan";
const uniqueReviewStrings = (maximum: number) =>
  z.array(z.string().trim().min(1).max(256)).max(maximum).transform((
    values,
  ) => [...new Set(values)]);
const uniqueReviewObjectIds = (maximum: number) =>
  z.array(objectId).max(maximum).transform((values) => [...new Set(values)]);
const reviewSourceShape = {
  targetProfileIds: z.array(objectId).length(1),
  sourceMode: z.enum([
    "all_matching",
    "selected_recordings",
    "timeline_range",
    "diarization_generation",
  ]).default("all_matching"),
  embeddingSpaceIds: uniqueReviewStrings(1).default([]),
  runIds: uniqueReviewStrings(1).default([]),
  recordingIds: uniqueReviewObjectIds(500).default([]),
  rangeMode: z.enum(["fixed", "all_before"]).default("fixed"),
  candidateMode: z.enum(["reviewable", "auto_matched"]).default(
    "reviewable",
  ),
  quality: z.object({
    minDurationSeconds: z.number().min(0).max(10).default(1),
    deduplicateOverlaps: z.boolean().default(true),
  }).default({ minDurationSeconds: 1, deduplicateOverlaps: true }),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
};

function validateReviewSource(
  value: {
    sourceMode:
      | "all_matching"
      | "selected_recordings"
      | "timeline_range"
      | "diarization_generation";
    rangeMode: "fixed" | "all_before";
    start?: Date | string;
    end?: Date | string;
    runIds: string[];
    recordingIds: string[];
  },
  context: z.RefinementCtx,
  options: { allowEmptySelectedRecordings: boolean },
) {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if (value.rangeMode === "fixed" && !(value.start && value.end)) {
    issue("rangeMode", "A fixed review source requires start and end");
  }
  if (value.sourceMode === "diarization_generation") {
    if (value.runIds.length !== 1) {
      issue("runIds", "Choose exactly one diarization generation");
    }
    if (value.recordingIds.length > 0) {
      issue(
        "recordingIds",
        "A diarization generation cannot also select recordings",
      );
    }
    return;
  }
  if (value.runIds.length > 0) {
    issue("runIds", "Only a diarization-generation source may select a run");
  }
  if (value.sourceMode === "selected_recordings") {
    if (
      !options.allowEmptySelectedRecordings && value.recordingIds.length === 0
    ) {
      issue("recordingIds", "Select at least one recording");
    }
    return;
  }
  if (value.recordingIds.length > 0) {
    issue(
      "recordingIds",
      "Only a selected-recordings source may include recording IDs",
    );
  }
  if (
    value.sourceMode === "timeline_range" && value.rangeMode !== "fixed"
  ) {
    issue("rangeMode", "A Timeline source requires a fixed range");
  }
}
const PROFILE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];

function isValidReviewAssignment(value: {
  profileId?: string;
  excludedProfileIds: string[];
}): boolean {
  return Boolean(value.profileId || value.excludedProfileIds.length > 0) &&
    (!value.profileId || !value.excludedProfileIds.includes(value.profileId));
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function sameIdentityProfileSnapshots(
  left: IdentityProfileSnapshot[],
  right: IdentityProfileSnapshot[],
): boolean {
  const canonical = (values: IdentityProfileSnapshot[]) =>
    [...values]
      .sort((a, b) => a.profileId.localeCompare(b.profileId))
      .map((value) =>
        JSON.stringify({
          profileId: value.profileId,
          profileRevision: value.profileRevision,
          calibrationId: value.calibrationId,
          embeddingSpaceId: value.embeddingSpaceId,
          evidenceSnapshotHash: value.evidenceSnapshotHash ?? null,
        })
      );
  const normalizedLeft = canonical(left);
  const normalizedRight = canonical(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function frozenIdentitySourceCeiling(
  maxSegmentId: unknown,
): Record<string, unknown> {
  const value = String(maxSegmentId ?? "");
  return ObjectId.isValid(value) ? { _id: { $lte: new ObjectId(value) } } : {};
}

export const speakerSegmentsRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("coverage"),
    ...range,
    bucketMs: z.number().int().min(1_000).max(86_400_000),
  }),
  z.object({
    action: z.literal("list"),
    ...range,
    profileId: objectId.optional(),
    selectedProfileId: objectId.optional(),
    segmentId: objectId.optional(),
    state: z.enum(["matched", "rejected", "uncertain"]).optional(),
    view: z.enum(["full", "timeline"]).default("full"),
    limit: z.number().int().min(1).max(5000).default(1000),
  }),
  z.object({
    action: z.literal("annotate"),
    originalId: objectId,
    segmentId: objectId.optional(),
    runId: z.string().optional(),
    ...range,
    profileId: objectId.optional(),
    excludedProfileIds: z.array(objectId).default([]),
  }).refine(
    (v) => Boolean(v.profileId) !== (v.excludedProfileIds.length > 0),
    "Choose a profile or excluded profiles",
  ),
  z.object({
    action: z.literal("assign"),
    segmentId: objectId,
    scope: z.enum(["segment", "speaker"]),
    profileId: objectId.optional(),
  }),
  z.object({
    action: z.literal("create-profile"),
    name: profileName,
  }),
  z.object({
    action: z.literal("create-profile-from-segments"),
    name: profileName,
    segmentIds: z.array(objectId).min(1).max(100),
  }),
  z.object({
    action: z.literal("profile-archive-preview"),
    profileId: objectId,
    replacementPrimaryProfileId: objectId.optional(),
  }),
  z.object({
    action: z.literal("archive-profile"),
    profileId: objectId,
    replacementPrimaryProfileId: objectId.optional(),
    snapshotFingerprint: z.string().min(1),
    confirmation: z.string().min(1),
  }),
  z.object({ action: z.literal("restore-profile"), profileId: objectId }),
  z.object({
    action: z.literal("invalidate-profile-identity-evidence"),
    profileId: objectId,
    profileRevision: z.number().int().positive(),
    reason: z.literal("profile_reenrollment"),
  }),
  z.object({ action: z.literal("delete-annotation"), id: objectId }),
  z.object({
    action: z.literal("preview-review-session"),
    ...reviewSourceShape,
    previewLimit: z.number().int().min(1).max(10).default(5),
  }).superRefine((value, context) =>
    validateReviewSource(value, context, {
      allowEmptySelectedRecordings: true,
    })
  ),
  z.object({
    action: z.literal("create-review-session"),
    name: z.string().max(120).optional(),
    ...reviewSourceShape,
    limit: z.number().int().min(1).max(100).default(10),
    preferences: z.object({
      autoPlay: z.boolean().default(true),
      autoAdvanceWindow: z.boolean().default(true),
      groupMode: z.boolean().default(true),
      compactMode: z.boolean().default(true),
    }).default({
      autoPlay: true,
      autoAdvanceWindow: true,
      groupMode: true,
      compactMode: true,
    }),
  }).superRefine((value, context) =>
    validateReviewSource(value, context, {
      allowEmptySelectedRecordings: false,
    })
  ),
  z.object({
    action: z.literal("list-review-sessions"),
    profileId: objectId.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({ action: z.literal("get-review-session"), sessionId: objectId }),
  z.object({
    action: z.literal("load-next-review-window"),
    sessionId: objectId,
    revision: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("update-review-position"),
    sessionId: objectId,
    revision: z.number().int().positive(),
    activeSegmentId: objectId.nullable().optional(),
    skipSegmentId: objectId.optional(),
    preferences: z.object({
      autoPlay: z.boolean().optional(),
      autoAdvanceWindow: z.boolean().optional(),
      groupMode: z.boolean().optional(),
      compactMode: z.boolean().optional(),
    }).optional(),
  }),
  z.object({
    action: z.literal("commit-review-decision"),
    sessionId: objectId,
    revision: z.number().int().positive(),
    clientRequestId: z.string().min(1).max(120),
    segmentIds: z.array(objectId).min(1).max(100),
    profileId: objectId.optional(),
    excludedProfileIds: z.array(objectId).default([]),
    calibrationUse: z.enum(["eligible", "timeline_only"]).default("eligible"),
  }).refine(
    isValidReviewAssignment,
    "Choose an assigned or excluded profile without contradicting the assignment",
  ),
  z.object({
    action: z.literal("revise-review-decision"),
    sessionId: objectId,
    revision: z.number().int().positive(),
    clientRequestId: z.string().min(1).max(120),
    segmentIds: z.array(objectId).min(1).max(100),
    replacesDecisionId: objectId,
    profileId: objectId.optional(),
    excludedProfileIds: z.array(objectId).default([]),
    calibrationUse: z.enum(["eligible", "timeline_only"]).default("eligible"),
  }).refine(
    isValidReviewAssignment,
    "Choose an assigned or excluded profile without contradicting the assignment",
  ),
  z.object({
    action: z.literal("commit-review-skip"),
    sessionId: objectId,
    revision: z.number().int().positive(),
    clientRequestId: z.string().min(1).max(120),
    segmentIds: z.array(objectId).min(1).max(100),
    replacesDecisionId: objectId.optional(),
    skipReason: z.literal("noise_or_unclear").default("noise_or_unclear"),
  }),
  z.object({
    action: z.literal("list-review-history"),
    profileId: objectId,
    limit: z.number().int().min(1).max(500).default(100),
  }),
  z.object({
    action: z.literal("revise-review-history"),
    profileId: objectId,
    segmentId: objectId,
    replacesDecisionId: objectId,
    clientRequestId: z.string().min(1).max(120),
    outcome: z.enum(["assigned", "skipped"]),
    assignedProfileId: objectId.optional(),
    excludedProfileIds: z.array(objectId).default([]),
    calibrationUse: z.enum(["eligible", "timeline_only"]).default("eligible"),
    skipReason: z.literal("noise_or_unclear").optional(),
  }).refine(
    (value) =>
      value.outcome === "skipped" || isValidReviewAssignment({
        profileId: value.assignedProfileId,
        excludedProfileIds: value.excludedProfileIds,
      }),
    "An assigned correction needs a profile or an excluded target",
  ),
  z.object({
    action: z.literal("undo-review-decision"),
    sessionId: objectId,
    revision: z.number().int().positive(),
    decisionId: objectId,
  }),
  z.object({
    action: z.literal("complete-review-session"),
    sessionId: objectId,
  }),
  z.object({
    action: z.literal("review-queue"),
    ...range,
    state: z.enum(["matched", "rejected", "uncertain", "reviewable"]).default(
      "reviewable",
    ),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  z.object({
    action: z.literal("similar"),
    segmentId: objectId,
    topN: z.number().int().min(1).max(100).default(20),
    candidateLimit: z.number().int().min(1).max(10000).default(5000),
  }),
  z.object({
    action: z.literal("list-calibrations"),
    profileId: objectId.optional(),
  }),
  z.object({
    action: z.literal("calibration-preview"),
    profileId: objectId,
    calibrationRecordingIds: z.array(z.string()).default([]),
    validationRecordingIds: z.array(z.string()).default([]),
    targetPrecision: z.number().min(SPEAKER_CALIBRATION_PILOT_MIN_PRECISION)
      .max(1).default(SPEAKER_CALIBRATION_TARGET_PRECISION),
    positiveThresholdOverride: z.number().finite().min(-1).max(1).optional(),
  }).superRefine((value, context) => {
    if (
      value.positiveThresholdOverride !== undefined &&
      value.targetPrecision >= SPEAKER_CALIBRATION_TARGET_PRECISION
    ) {
      context.addIssue({
        code: "custom",
        path: ["positiveThresholdOverride"],
        message:
          "Positive threshold override is available only for provisional pilots",
      });
    }
  }),
  z.object({
    action: z.literal("identity-status"),
    profileId: objectId,
  }),
  z.object({
    action: z.literal("identity-classification"),
    profileId: objectId,
  }),
  z.object({
    action: z.literal("identity-preflight"),
    profileId: objectId,
    profileIds: z.array(objectId).min(1).max(20).transform((
      values,
    ) => [...new Set(values)]).optional(),
    scope: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("all_compatible") }),
      z.object({ mode: z.literal("range"), ...range }),
    ]),
  }),
  z.object({
    action: z.literal("start-identity-campaign"),
    profileId: objectId,
    preflightToken: z.string().min(1).max(120),
    profileIds: z.array(objectId).min(1).max(20).transform((
      values,
    ) => [...new Set(values)]).optional(),
  }),
  z.object({
    action: z.literal("prepare-identity-model-set"),
    preflightToken: z.string().min(1).max(120),
    profileIds: z.array(objectId).min(1).max(20).transform((
      values,
    ) => [...new Set(values)]),
  }),
  z.object({
    action: z.literal("list-identity-model-sets"),
    profileId: objectId.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal("identity-model-set-head"),
    profileId: objectId.optional(),
    embeddingSpaceId: z.string().trim().min(1).max(256).optional(),
  }),
  z.object({
    action: z.literal("activate-identity-model-set"),
    modelSetId: z.string().trim().min(1).max(160),
  }),
  z.object({
    action: z.literal("speaker-timeline-summary"),
    ...range,
    profileId: objectId.optional(),
    detail: z.enum(["intervals", "buckets"]),
    bucketMs: z.number().int().min(1_000).max(86_400_000).optional(),
    filters: z.object({
      states: z.array(
        z.enum([
          "identified",
          "ambiguous",
          "unknown",
          "matched",
          "rejected",
          "uncertain",
          "unclassified",
        ]),
      )
        .max(7).optional(),
      validities: z.array(z.enum(["verified", "provisional", "manual"]))
        .max(3).optional(),
      inclusion: z.enum(["selected_only", "includes_candidate"]).optional(),
      sources: z.array(z.enum(["manual", "automatic"])).max(2).optional(),
    }).default({}),
  }).superRefine((value, context) => {
    if (value.detail === "buckets" && !value.bucketMs) {
      context.addIssue({
        code: "custom",
        path: ["bucketMs"],
        message: "Far Timeline summary requires bucketMs",
      });
    }
  }),
  z.object({
    action: z.literal("list-identity-campaigns"),
    profileId: objectId.optional(),
    runId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal("save-calibration"),
    profileId: objectId,
    calibrationRecordingIds: z.array(z.string()).min(1),
    validationRecordingIds: z.array(z.string()).min(1),
    targetPrecision: z.number().min(SPEAKER_CALIBRATION_PILOT_MIN_PRECISION)
      .max(1).default(SPEAKER_CALIBRATION_TARGET_PRECISION),
    positiveThresholdOverride: z.number().finite().min(-1).max(1).optional(),
    acceptLowerPrecisionRisk: z.boolean().default(false),
  }).strict().superRefine((value, context) => {
    if (
      value.targetPrecision < SPEAKER_CALIBRATION_TARGET_PRECISION &&
      value.acceptLowerPrecisionRisk !== true
    ) {
      context.addIssue({
        code: "custom",
        path: ["acceptLowerPrecisionRisk"],
        message:
          "Explicitly accept lower-precision pilot risk before saving this calibration",
      });
    }
    if (
      value.positiveThresholdOverride !== undefined &&
      value.targetPrecision >= SPEAKER_CALIBRATION_TARGET_PRECISION
    ) {
      context.addIssue({
        code: "custom",
        path: ["positiveThresholdOverride"],
        message:
          "Positive threshold override is available only for provisional pilots",
      });
    }
  }),
  z.object({ action: z.literal("list-runs") }),
  z.object({
    action: z.literal("list-campaigns"),
    runId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal("create-run"),
    runId: z.string().min(1),
    mode: z.enum(["missing", "rediarize"]),
    ...range,
    generation: z.number().int().min(1),
    replacesRunId: z.string().optional(),
    diarizationFingerprint: z.record(z.string(), z.any()),
    embeddingSpaceId: z.string().min(1),
    sourceJobId: z.string().optional(),
  }),
  z.object({
    action: z.literal("mark-run-ready"),
    runId: z.string().min(1),
    coverage: z.record(z.string(), z.any()).default({}),
    errors: z.array(z.any()).default([]),
  }),
  z.object({ action: z.literal("compare-run"), runId: z.string().min(1) }),
  z.object({ action: z.literal("mark-run-failed"), runId: z.string().min(1) }),
  z.object({
    action: z.literal("activation-preview"),
    runId: z.string().min(1),
  }),
  z.object({ action: z.literal("activate-run"), runId: z.string().min(1) }),
  z.object({
    action: z.literal("repair-empty-activation-preview"),
    runId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("repair-empty-activation"),
    runId: z.string().min(1),
    confirmation: z.string().min(1),
  }),
  z.object({ action: z.literal("preview-purge"), runId: z.string().min(1) }),
  z.object({
    action: z.literal("purge-superseded"),
    runId: z.string().min(1),
    snapshotFingerprint: z.string().min(1),
    confirmation: z.string().min(1),
  }),
]);

type SpeakerSegmentsRequest = z.input<typeof speakerSegmentsRequestSchema>;

function normalizedEmbedding(values: unknown): number[] | null {
  if (
    !Array.isArray(values) || values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    return null;
  }
  const norm = Math.sqrt(
    values.reduce((sum: number, value: number) => sum + value * value, 0),
  );
  if (!Number.isFinite(norm) || norm === 0) return null;
  return values.map((value: number) => value / norm);
}

function centroidEmbedding(embeddings: unknown[]): number[] {
  const normalized = embeddings.map(normalizedEmbedding);
  if (normalized.some((embedding) => embedding === null)) {
    throw new Error("Every selected segment must have a valid voice embedding");
  }
  const vectors = normalized as number[][];
  const dimension = vectors[0].length;
  if (vectors.some((embedding) => embedding.length !== dimension)) {
    throw new Error("Selected segment embeddings have different dimensions");
  }
  const centroid = Array.from(
    { length: dimension },
    (_, index) =>
      vectors.reduce((sum, embedding) => sum + embedding[index], 0) /
      vectors.length,
  );
  const result = normalizedEmbedding(centroid);
  if (!result) {
    throw new Error("Selected segment embeddings cancel each other out");
  }
  return result;
}

async function nextProfileColor(mongo: any): Promise<string> {
  const profiles = await mongo({
    action: "find",
    collection: "speaker_profiles",
    query: {},
    options: { projection: { _id: 1 }, limit: 5_000 },
  }) as any[];
  return PROFILE_COLORS[profiles.length % PROFILE_COLORS.length];
}

async function assertProfileNameAvailable(mongo: any, name: string) {
  const existing = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { name },
    options: { projection: { _id: 1 } },
  });
  if (existing) {
    throw new Error(`A voice profile named "${name}" already exists`);
  }
}

type ReviewAutomaticIdentityContext = {
  calibrationId: string;
  profileRevision: number;
  embeddingSpaceId: string;
  evidenceSnapshotHash: string;
  decisionValidity: "verified" | "provisional";
};

type ResolvedReviewCandidateContext = {
  embeddingSpaceIds: string[];
  automaticIdentity: ReviewAutomaticIdentityContext | null;
};

export async function resolveReviewCandidateContext(
  mongo: any,
  targetProfileId: string,
  requested: string[],
  options: {
    sourceMode:
      | "all_matching"
      | "selected_recordings"
      | "timeline_range"
      | "diarization_generation";
    runIds: string[];
    candidateMode: "reviewable" | "auto_matched";
  },
): Promise<ResolvedReviewCandidateContext> {
  const profile = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { _id: new ObjectId(targetProfileId) },
    options: {
      projection: {
        name: 1,
        revision: 1,
        embeddingSpaceId: 1,
        activeCalibrationIds: 1,
        activeCalibrationId: 1,
        calibrationHeadsInitialized: 1,
        calibrationEvidenceRevision: 1,
      },
    },
  }) as any;
  if (!profile) throw new Error("Review target profile not found");
  const profileSpace = String(profile.embeddingSpaceId ?? "").trim();
  if (!profileSpace || ["unknown", "legacy-unknown"].includes(profileSpace)) {
    throw new Error(
      (profile.name ?? "Voice profile") +
        " must be re-enrolled before scoped review",
    );
  }
  if (requested.length > 0 && !requested.includes(profileSpace)) {
    throw new Error(
      "Review embedding space does not match " +
        (profile.name ?? "the target profile"),
    );
  }
  if (options.runIds.length > 0) {
    const run = await mongo({
      action: "findOne",
      collection: "diarization_runs",
      query: { runId: options.runIds[0] },
      options: {
        projection: { runId: 1, status: 1, embeddingSpaceId: 1 },
      },
    }) as any;
    if (!run || run.status !== "active") {
      throw new Error("The selected diarization generation is not active");
    }
    if (run.embeddingSpaceId !== profileSpace) {
      throw new Error(
        "The selected diarization generation uses a different embedding space",
      );
    }
  }
  let automaticIdentity: ReviewAutomaticIdentityContext | null = null;
  if (options.candidateMode === "auto_matched") {
    const head = await mongo({
      action: "findOne",
      collection: "identity_model_set_heads",
      query: { embeddingSpaceId: profileSpace },
      options: { projection: { activeModelSetId: 1 } },
    }) as any;
    const activeModelSet = head?.activeModelSetId
      ? await mongo({
        action: "findOne",
        collection: "identity_model_sets",
        query: { modelSetId: head.activeModelSetId, status: "active" },
        options: { projection: { profileIds: 1, staleProfileIds: 1 } },
      }) as any
      : null;
    const usesActiveProjection = Boolean(
      activeModelSet?.profileIds?.map(String).includes(targetProfileId) &&
        !activeModelSet?.staleProfileIds?.map(String).includes(targetProfileId),
    );
    if (!usesActiveProjection) {
      const calibrations = await mongo({
        action: "find",
        collection: "speaker_calibrations",
        query: { profileId: targetProfileId },
        options: { sort: { createdAt: -1 }, limit: 20 },
      }) as any[];
      const profileRevision = Number(profile.revision ?? 1);
      const headedCalibrations = calibrationsAtProfileHead(
        profile,
        calibrations,
      ).filter((calibration) =>
        calibrationEvidenceMatchesProfile(profile, calibration)
      );
      const calibration = findUsableCalibration(headedCalibrations, {
        profileId: targetProfileId,
        profileRevision,
        embeddingSpaceId: profileSpace,
      });
      if (!calibration) {
        throw new Error(
          "Audit automatic matches requires an active model-set projection or current server-validated calibration",
        );
      }
      const policy = normalizeCalibrationPolicy(calibration);
      if (!policy) {
        throw new Error(
          "Audit automatic matches requires a current calibration policy",
        );
      }
      automaticIdentity = {
        calibrationId: String(calibration.calibrationId),
        profileRevision,
        embeddingSpaceId: profileSpace,
        evidenceSnapshotHash: String(calibration.evidenceSnapshotHash),
        decisionValidity: policy.classificationPolicy === "full"
          ? "verified"
          : "provisional",
      };
    }
  }
  return { embeddingSpaceIds: [profileSpace], automaticIdentity };
}

type ReviewCandidateScope = {
  embeddingSpaceIds?: string[];
  runIds?: string[];
  recordingIds?: string[];
};

function safeObjectIdValues(ids: string[]): Array<string | ObjectId> {
  return [...new Set(ids)].filter(ObjectId.isValid).flatMap((id) => [
    id,
    new ObjectId(id),
  ]);
}

export function reviewCandidateMatchesIdentity(
  segment: any,
  candidateMode: "reviewable" | "auto_matched",
  targetProfileId?: string,
  automaticIdentity?: ReviewAutomaticIdentityContext | null,
): boolean {
  const identity = segment?.speakerIdentity;
  const target = String(targetProfileId ?? "");
  if (candidateMode === "auto_matched") {
    if (!target) {
      throw new Error(
        "Audit automatic matches requires a target voice profile",
      );
    }
    if (identity?.modelSetId) {
      return identity.source === "automatic" &&
        identity.validity === "verified" &&
        identity.selectedProfileState === "identified";
    }
    if (!automaticIdentity) {
      throw new Error(
        "Audit automatic matches requires a current identity calibration",
      );
    }
    const candidateProfileIds = [
      identity?.profileId,
      identity?.topCandidate?.profileId,
    ].map(String);
    return identity?.state === "matched" &&
      identity?.calibrationId === automaticIdentity.calibrationId &&
      Number(identity?.profileRevision) === automaticIdentity.profileRevision &&
      identity?.embeddingSpaceId === automaticIdentity.embeddingSpaceId &&
      String(
          identity?.thresholds?.evidenceSnapshotHash ??
            identity?.evidenceSnapshotHash ?? "",
        ) === automaticIdentity.evidenceSnapshotHash &&
      identity?.source === "automatic" &&
      identity?.validity === automaticIdentity.decisionValidity &&
      candidateProfileIds.includes(target);
  }
  if (!identity) return true;
  const selectedState = identity.selectedProfileState ?? identity.identityState;
  return ["ambiguous", "uncertain", "unclassified"].includes(
    String(selectedState ?? ""),
  ) || (selectedState == null && identity.state === "uncertain");
}

export function annotationResolvesReviewForProfile(
  annotation: any,
  targetProfileId?: string,
): boolean {
  if (annotation?.profileId) return true;
  if (!targetProfileId) return true;
  return (annotation?.excludedProfileIds ?? []).map(String).includes(
    targetProfileId,
  );
}

function buildStoredReviewScopeQuery(
  scope: ReviewCandidateScope,
): Record<string, unknown> {
  const query: Record<string, unknown> = { lifecycleStatus: "active" };
  if (scope.embeddingSpaceIds?.length) {
    query.embeddingSpaceId = { $in: scope.embeddingSpaceIds };
  }
  if (scope.runIds?.length) query.runId = { $in: scope.runIds };
  if (scope.recordingIds?.length) {
    const recordingValues = safeObjectIdValues(scope.recordingIds);
    if (recordingValues.length === 0) return { _id: { $exists: false } };
    query.$or = [
      { original_id: { $in: recordingValues } },
      { original: { $in: recordingValues } },
    ];
  }
  return query;
}

export function buildReviewCandidateQuery(
  start: Date,
  end: Date,
  candidateMode: "reviewable" | "auto_matched" = "reviewable",
  targetProfileId?: string,
  cursor?: { start: Date | string; segmentId: string } | null,
  scope: ReviewCandidateScope = {},
  automaticIdentity?: ReviewAutomaticIdentityContext | null,
): Record<string, unknown> {
  // Identity is filtered after active-head projections are hydrated. Keeping
  // legacy speakerIdentity predicates here would hide current model-set rows.
  if (candidateMode === "auto_matched" && !targetProfileId) {
    throw new Error(
      "Audit automatic matches requires a current identity calibration",
    );
  }
  const cursorFilter = cursor
    ? {
      $or: [
        { start: { $gt: new Date(cursor.start) } },
        {
          start: new Date(cursor.start),
          _id: { $gt: new ObjectId(cursor.segmentId) },
        },
      ],
    }
    : null;
  const scopedConditions: Record<string, unknown>[] = [];
  if (cursorFilter) scopedConditions.push(cursorFilter);
  if (scope.embeddingSpaceIds?.length) {
    scopedConditions.push({
      embeddingSpaceId: { $in: scope.embeddingSpaceIds },
    });
  }
  if (scope.runIds?.length) {
    scopedConditions.push({ runId: { $in: scope.runIds } });
  }
  if (scope.recordingIds?.length) {
    const recordingValues = safeObjectIdValues(scope.recordingIds);
    if (recordingValues.length === 0) {
      scopedConditions.push({ _id: { $exists: false } });
    } else {
      scopedConditions.push({
        $or: [
          { original_id: { $in: recordingValues } },
          { original: { $in: recordingValues } },
        ],
      });
    }
  }
  return {
    lifecycleStatus: "active",
    start: { $lt: end },
    end: { $gt: start },
    ...(scopedConditions.length > 0 ? { $and: scopedConditions } : {}),
  };
}

async function findReviewCandidates(
  mongo: any,
  start: Date,
  end: Date,
  limit: number,
  candidateMode: "reviewable" | "auto_matched" = "reviewable",
  targetProfileId?: string,
  cursor?: { start: Date | string; segmentId: string } | null,
  scope: ReviewCandidateScope = {},
  automaticIdentity?: ReviewAutomaticIdentityContext | null,
): Promise<ReviewCandidateScan> {
  const scanLimit = Math.min(Math.max(limit, 1), 5_000);
  const scanHint = scope.runIds?.length
    ? "speaker_identity_campaign_scan"
    : scope.recordingIds?.length
    ? undefined
    : start.getTime() > 0
    ? SPEAKER_REVIEW_RANGE_INDEX
    : SPEAKER_REVIEW_SOURCE_INDEX;
  const rawCandidates = await mongo({
    action: "find",
    collection: "diarizations",
    query: buildReviewCandidateQuery(
      start,
      end,
      candidateMode,
      targetProfileId,
      cursor,
      scope,
      automaticIdentity,
    ),
    options: {
      sort: { start: 1, _id: 1 },
      limit: scanLimit,
      projection: { embedding: 0 },
      ...(scanHint ? { hint: scanHint } : {}),
      maxTimeMS: 15_000,
    },
  }) as any[];
  const scan = buildReviewScanMetadata(rawCandidates, scanLimit);
  const activeModelSetSegments = await hydrateActiveIdentityModelSetProjections(
    mongo,
    rawCandidates,
    targetProfileId,
  );
  await suppressStaleAutomaticIdentities(
    mongo,
    rawCandidates.filter((segment) =>
      !activeModelSetSegments.has(String(segment._id))
    ),
  );
  const identityCandidates = rawCandidates.filter((segment) =>
    reviewCandidateMatchesIdentity(
      segment,
      candidateMode,
      targetProfileId,
      automaticIdentity,
    )
  );
  const candidateIds = identityCandidates.map((segment) => segment._id);
  if (candidateIds.length === 0) return { ...scan, candidates: [] };
  const [annotations, skippedDecisions] = await Promise.all([
    mongo({
      action: "find",
      collection: "speaker_annotations",
      query: { segmentId: { $in: candidateIds } },
      options: {
        projection: { segmentId: 1, profileId: 1, excludedProfileIds: 1 },
        limit: candidateIds.length * 5,
        maxTimeMS: 10_000,
      },
    }),
    targetProfileId
      ? mongo({
        action: "find",
        collection: "speaker_review_decisions",
        query: {
          status: "committed",
          outcome: "skipped",
          targetProfileIds: new ObjectId(targetProfileId),
          segmentIds: { $in: candidateIds },
        },
        options: {
          projection: { segmentIds: 1 },
          limit: candidateIds.length,
          maxTimeMS: 10_000,
        },
      })
      : Promise.resolve([]),
  ]) as [any[], any[]];
  const excluded = new Set([
    ...annotations.filter((annotation) =>
      annotationResolvesReviewForProfile(annotation, targetProfileId)
    ).map((item) => String(item.segmentId)),
    ...skippedDecisions.flatMap((decision) =>
      (decision.segmentIds ?? []).map(String)
    ),
  ]);
  return {
    ...scan,
    candidates: identityCandidates.filter((segment) =>
      !excluded.has(String(segment._id))
    ),
  };
}

type ReviewCandidateScan = {
  candidates: any[];
  rawScannedCount: number;
  capped: boolean;
  nextCursor: { start: Date | string; segmentId: string } | null;
};

export function buildReviewScanMetadata(
  rawCandidates: any[],
  scanLimit: number,
): Omit<ReviewCandidateScan, "candidates"> {
  const last = rawCandidates.at(-1);
  return {
    rawScannedCount: rawCandidates.length,
    capped: rawCandidates.length >= scanLimit,
    nextCursor: last
      ? { start: last.start, segmentId: String(last._id) }
      : null,
  };
}

export function stratifyReviewCandidates(
  candidates: any[],
  limit: number,
): { selected: any[]; remaining: any[] } {
  const groups = new Map<string, any[]>();
  for (const candidate of candidates) {
    const recordingId = String(
      candidate.original_id ?? candidate.original ?? "unknown",
    );
    const group = groups.get(recordingId) ?? [];
    group.push(candidate);
    groups.set(recordingId, group);
  }
  const queues = [...groups.values()];
  const selected: any[] = [];
  while (selected.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const candidate = queue.shift();
      if (candidate) selected.push(candidate);
      if (selected.length >= limit) break;
    }
  }
  const selectedIds = new Set(
    selected.map((candidate) => String(candidate._id)),
  );
  return {
    selected,
    remaining: candidates.filter((candidate) =>
      !selectedIds.has(String(candidate._id))
    ),
  };
}

async function loadBufferedReviewCandidates(
  mongo: any,
  ids: unknown[],
  targetProfileId?: string,
  scope: ReviewCandidateScope = {},
  candidateMode: "reviewable" | "auto_matched" = "reviewable",
  automaticIdentity?: ReviewAutomaticIdentityContext | null,
): Promise<any[]> {
  const objectIds = ids.map(String).filter(ObjectId.isValid).map((id) =>
    new ObjectId(id)
  );
  if (objectIds.length === 0) return [];
  const candidates = await mongo({
    action: "find",
    collection: "diarizations",
    query: {
      _id: { $in: objectIds },
      ...buildStoredReviewScopeQuery(scope),
    },
    options: { projection: { embedding: 0 }, limit: objectIds.length },
  }) as any[];
  const activeModelSetSegments = await hydrateActiveIdentityModelSetProjections(
    mongo,
    candidates,
    targetProfileId,
  );
  await suppressStaleAutomaticIdentities(
    mongo,
    candidates.filter((segment) =>
      !activeModelSetSegments.has(String(segment._id))
    ),
  );
  const identityCandidates = candidates.filter((segment) =>
    reviewCandidateMatchesIdentity(
      segment,
      candidateMode,
      targetProfileId,
      automaticIdentity,
    )
  );
  const [annotations, skippedDecisions] = await Promise.all([
    mongo({
      action: "find",
      collection: "speaker_annotations",
      query: { segmentId: { $in: objectIds } },
      options: {
        projection: { segmentId: 1, profileId: 1, excludedProfileIds: 1 },
        limit: objectIds.length * 5,
      },
    }),
    targetProfileId
      ? mongo({
        action: "find",
        collection: "speaker_review_decisions",
        query: {
          status: "committed",
          outcome: "skipped",
          targetProfileIds: new ObjectId(targetProfileId),
          segmentIds: { $in: objectIds },
        },
        options: { projection: { segmentIds: 1 }, limit: objectIds.length },
      })
      : Promise.resolve([]),
  ]) as [any[], any[]];
  const excluded = new Set([
    ...annotations.filter((annotation) =>
      annotationResolvesReviewForProfile(annotation, targetProfileId)
    ).map((item) => String(item.segmentId)),
    ...skippedDecisions.flatMap((decision) =>
      (decision.segmentIds ?? []).map(String)
    ),
  ]);
  const byId = new Map(
    identityCandidates.map((item) => [String(item._id), item]),
  );
  return objectIds.map((id) => byId.get(String(id))).filter((item) =>
    item && !excluded.has(String(item._id))
  );
}

async function suppressStaleAutomaticIdentities(
  mongo: any,
  segments: any[],
): Promise<void> {
  const automatic = segments.filter((segment) =>
    segment.speakerIdentity?.source !== "manual_projection" &&
    segment.speakerIdentity?.calibrationId
  );
  const calibrationIds = [
    ...new Set(
      automatic.map((segment) => String(segment.speakerIdentity.calibrationId)),
    ),
  ];
  if (calibrationIds.length === 0) return;
  const calibrations = await mongo({
    action: "find",
    collection: "speaker_calibrations",
    query: { calibrationId: { $in: calibrationIds } },
    options: { limit: calibrationIds.length },
  }) as any[];
  const profileIds = [
    ...new Set(
      calibrations.map((calibration) => String(calibration.profileId ?? ""))
        .filter(ObjectId.isValid),
    ),
  ];
  const profiles = profileIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_profiles",
    query: { _id: { $in: profileIds.map((id) => new ObjectId(id)) } },
    options: {
      projection: {
        revision: 1,
        embeddingSpaceId: 1,
        activeCalibrationIds: 1,
        activeCalibrationId: 1,
        calibrationHeadsInitialized: 1,
        calibrationEvidenceRevision: 1,
      },
      limit: profileIds.length,
    },
  }) as any[];
  const profileById = new Map(
    profiles.map((profile) => [String(profile._id), profile]),
  );
  const usablePolicies = new Map<string, {
    classificationPolicy: "full" | "pilot";
    evidenceSnapshotHash: string;
    profileRevision: number;
    embeddingSpaceId: string;
  }>();
  for (const calibration of calibrations) {
    const profileId = String(calibration.profileId ?? "");
    const profile = profileById.get(profileId);
    const atProfileHead = profile &&
      calibrationsAtProfileHead(profile, [calibration]).length > 0;
    const usable = atProfileHead &&
        calibrationEvidenceMatchesProfile(profile, calibration)
      ? findUsableCalibration([calibration], {
        profileId,
        profileRevision: Number(profile.revision ?? 1),
        embeddingSpaceId: profile.embeddingSpaceId,
      })
      : null;
    const policy = usable ? normalizeCalibrationPolicy(calibration) : null;
    if (policy) {
      usablePolicies.set(
        String(calibration.calibrationId),
        {
          classificationPolicy: policy.classificationPolicy,
          evidenceSnapshotHash: String(calibration.evidenceSnapshotHash),
          profileRevision: Number(profile.revision ?? 1),
          embeddingSpaceId: String(profile.embeddingSpaceId),
        },
      );
    }
  }
  for (const segment of automatic) {
    const identity = segment.speakerIdentity;
    const current = usablePolicies.get(String(identity.calibrationId));
    const identityEvidenceSnapshotHash = String(
      identity.thresholds?.evidenceSnapshotHash ??
        identity.evidenceSnapshotHash ?? "",
    );
    if (
      current &&
      Number(identity.profileRevision) === current.profileRevision &&
      String(identity.embeddingSpaceId ?? "") === current.embeddingSpaceId &&
      identityEvidenceSnapshotHash === current.evidenceSnapshotHash
    ) {
      identity.validity = current.classificationPolicy === "full"
        ? "verified"
        : "provisional";
      identity.classificationPolicy = current.classificationPolicy;
      continue;
    }
    identity.validity = "stale";
    identity.staleState = identity.state;
    delete identity.state;
    identity.identityState = "unclassified";
  }
}

async function hydrateActiveIdentityModelSetProjections(
  mongo: any,
  segments: any[],
  selectedProfileId?: string,
): Promise<Set<string>> {
  const embeddingSpaceIds = [
    ...new Set(
      segments.map((segment) => String(segment.embeddingSpaceId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (embeddingSpaceIds.length === 0 || segments.length === 0) {
    return new Set();
  }
  const heads = await mongo({
    action: "find",
    collection: "identity_model_set_heads",
    query: { embeddingSpaceId: { $in: embeddingSpaceIds } },
    options: {
      projection: { embeddingSpaceId: 1, activeModelSetId: 1 },
      limit: embeddingSpaceIds.length,
    },
  }) as any[];
  const activeModelSetIds = [
    ...new Set(
      heads.map((head) => String(head.activeModelSetId ?? "")).filter(Boolean),
    ),
  ];
  if (activeModelSetIds.length === 0) return new Set();
  const modelSets = await mongo({
    action: "find",
    collection: "identity_model_sets",
    query: {
      modelSetId: { $in: activeModelSetIds },
      status: "active",
    },
    options: {
      projection: {
        modelSetId: 1,
        embeddingSpaceId: 1,
        profileIds: 1,
        profiles: 1,
        staleProfileIds: 1,
        status: 1,
      },
      limit: activeModelSetIds.length,
    },
  }) as any[];
  const modelSetBySpace = activeModelSetsByEmbeddingSpace({
    heads,
    modelSets,
  });
  if (modelSetBySpace.size === 0) return new Set();

  const segmentIds = segments.map((segment) => segment._id).filter(Boolean);
  const usableModelSetIds = [
    ...new Set(
      [...modelSetBySpace.values()].map((modelSet) => modelSet.modelSetId),
    ),
  ];
  const projections = segmentIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_identity_projections",
    query: {
      modelSetId: { $in: usableModelSetIds },
      segmentId: { $in: segmentIds },
    },
    options: {
      projection: {
        modelSetId: 1,
        segmentId: 1,
        resolution: 1,
        profileId: 1,
        candidates: 1,
        complete: 1,
        source: 1,
        topTwoMargin: 1,
        projectedAt: 1,
      },
      limit: segmentIds.length,
    },
  }) as any[];
  const projectionByModelSetAndSegment = new Map(
    projections.map((projection) => [
      `${String(projection.modelSetId)}:${String(projection.segmentId)}`,
      projection,
    ]),
  );
  const activeSegmentIds = new Set<string>();
  for (const segment of segments) {
    const modelSet = modelSetBySpace.get(
      String(segment.embeddingSpaceId ?? ""),
    );
    if (!modelSet) continue;
    const segmentId = String(segment._id);
    const projection = projectionByModelSetAndSegment.get(
      `${modelSet.modelSetId}:${segmentId}`,
    );
    // Even before this particular segment has been projected, the active set
    // is authoritative for its embedding space. Mark it unclassified rather
    // than leaking an embedded decision from a superseded calibration/set.
    segment.speakerIdentity = activeProjectionIdentity({
      modelSet,
      projection,
      selectedProfileId,
    });
    activeSegmentIds.add(segmentId);
  }
  return activeSegmentIds;
}

async function hydrateReviewSession(
  mongo: any,
  session: any,
): Promise<any> {
  const { candidateBufferIds: _candidateBufferIds, ...publicSession } = session;
  const window = session?.window ?? [];
  const ids = window.map((item: any) => String(item.segmentId)).filter(
    ObjectId.isValid,
  ).map((id: string) => new ObjectId(id));
  const segments = ids.length === 0 ? [] : await mongo({
    action: "find",
    collection: "diarizations",
    query: { _id: { $in: ids }, lifecycleStatus: "active" },
    options: { projection: { embedding: 0 }, limit: ids.length },
  }) as any[];
  const byId = new Map(
    segments.map((segment) => [String(segment._id), segment]),
  );
  const decisionIds = [
    ...new Set(
      window.map((item: any) => String(item.decisionId ?? "")).filter(
        ObjectId.isValid,
      ),
    ),
  ].map((id) => new ObjectId(String(id)));
  const decisions = decisionIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_review_decisions",
    query: { _id: { $in: decisionIds }, status: "committed" },
    options: {
      projection: {
        outcome: 1,
        profileId: 1,
        excludedProfileIds: 1,
        calibrationUse: 1,
        skipReason: 1,
        source: 1,
        updatedAt: 1,
      },
      limit: decisionIds.length,
    },
  }) as any[];
  const profileIds = [
    ...new Set(
      decisions.flatMap((decision) => [
        String(decision.profileId ?? ""),
        ...(decision.excludedProfileIds ?? []).map(String),
      ]).filter(ObjectId.isValid),
    ),
  ].map((id) => new ObjectId(String(id)));
  const profiles = profileIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_profiles",
    query: { _id: { $in: profileIds } },
    options: { projection: { name: 1 }, limit: profileIds.length },
  }) as any[];
  return {
    ...publicSession,
    window: attachReviewDecisionSummaries(window, decisions, profiles),
    segments: window.map((item: any) => byId.get(String(item.segmentId)))
      .filter(Boolean),
  };
}

async function loadReviewHistory(
  mongo: any,
  author: string,
  profileId: string,
  limit: number,
): Promise<any> {
  const profileObjectId = new ObjectId(profileId);
  const scanLimit = Math.min(Math.max(limit * 10, 500), 5_000);
  const decisions = await mongo({
    action: "find",
    collection: "speaker_review_decisions",
    query: {
      author,
      status: "committed",
      targetProfileIds: profileObjectId,
    },
    options: {
      sort: { updatedAt: -1, createdAt: -1 },
      limit: scanLimit,
      projection: {
        sessionId: 1,
        segmentIds: 1,
        targetProfileIds: 1,
        outcome: 1,
        profileId: 1,
        excludedProfileIds: 1,
        calibrationUse: 1,
        skipReason: 1,
        source: 1,
        updatedAt: 1,
        createdAt: 1,
      },
    },
  }) as any[];
  const latestBySegment = new Map<string, any>();
  for (const decision of decisions) {
    for (const segmentId of decision.segmentIds ?? []) {
      const id = String(segmentId);
      if (!latestBySegment.has(id)) latestBySegment.set(id, decision);
    }
  }
  const selected = [...latestBySegment.entries()].slice(0, limit);
  const segmentIds = selected.map(([id]) => id).filter(ObjectId.isValid).map(
    (id) => new ObjectId(id),
  );
  const segments = segmentIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "diarizations",
    query: { _id: { $in: segmentIds } },
    options: { projection: { embedding: 0 }, limit: segmentIds.length },
  }) as any[];
  const segmentById = new Map(
    segments.map((segment) => [String(segment._id), segment]),
  );
  const sessionIds = [
    ...new Set(
      selected.map(([, decision]) => String(decision.sessionId ?? "")).filter(
        ObjectId.isValid,
      ),
    ),
  ].map((id) => new ObjectId(id));
  const sessions = sessionIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_review_sessions",
    query: { _id: { $in: sessionIds }, owner: author },
    options: {
      projection: { name: 1, status: 1 },
      limit: sessionIds.length,
    },
  }) as any[];
  const sessionById = new Map(
    sessions.map((session) => [String(session._id), session]),
  );
  const profileIds = [
    ...new Set(
      selected.flatMap(([, decision]) => [
        String(decision.profileId ?? ""),
        ...(decision.excludedProfileIds ?? []).map(String),
      ]).filter(ObjectId.isValid),
    ),
  ].map((id) => new ObjectId(id));
  const profiles = profileIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "speaker_profiles",
    query: { _id: { $in: profileIds } },
    options: { projection: { name: 1 }, limit: profileIds.length },
  }) as any[];
  const profileNames = new Map(
    profiles.map((profile) => [
      String(profile._id),
      String(profile.name ?? "Deleted profile"),
    ]),
  );
  return {
    items: selected.map(([segmentId, decision]) => {
      const segment = segmentById.get(segmentId) ?? null;
      const assignedProfileId = decision.profileId
        ? String(decision.profileId)
        : null;
      const excludedProfileIds = (decision.excludedProfileIds ?? []).map(
        String,
      );
      const session = sessionById.get(String(decision.sessionId ?? ""));
      return {
        decisionId: String(decision._id),
        outcome: decision.outcome === "skipped" ? "skipped" : "assigned",
        calibrationUse: decision.calibrationUse ?? "eligible",
        skipReason: decision.skipReason ?? null,
        assignedProfileId,
        assignedProfileName: assignedProfileId
          ? profileNames.get(assignedProfileId) ?? "Deleted profile"
          : null,
        excludedProfileIds,
        excludedProfileNames: excludedProfileIds.map((id: string) =>
          profileNames.get(id) ?? "Deleted profile"
        ),
        updatedAt: decision.updatedAt ?? decision.createdAt ?? null,
        sessionId: decision.sessionId ? String(decision.sessionId) : null,
        sessionName: session?.name ?? "Older review",
        sessionStatus: session?.status ?? null,
        segment,
      };
    }).filter((item) => item.segment),
    scannedDecisions: decisions.length,
    hasMore: decisions.length >= scanLimit ||
      latestBySegment.size > selected.length,
  };
}

export function eligibleReviewDecisionProfileIds(decision: any): unknown[] {
  if (
    decision?.outcome !== "assigned" ||
    (decision?.calibrationUse ?? "eligible") !== "eligible"
  ) {
    return [];
  }
  return [
    ...(decision.targetProfileIds ?? []),
    decision.profileId,
    ...(decision.excludedProfileIds ?? []),
  ];
}

export function buildReviewHistoryRevisionScope(input: {
  segmentId: ObjectId;
  profileId: ObjectId;
  decisionId: ObjectId;
  author: string;
}) {
  return {
    currentDecision: {
      segmentIds: input.segmentId,
      targetProfileIds: input.profileId,
      author: input.author,
      status: "committed",
    },
    replacedAnnotation: {
      segmentId: input.segmentId,
      decisionId: input.decisionId,
      source: "manual",
      author: input.author,
    },
  };
}

export async function commitReviewDecisionArtifacts(
  mongo: any,
  decision: any,
  segments: any[],
): Promise<void> {
  const now = new Date();
  for (const segment of segments) {
    await mongo({
      action: "updateOne",
      collection: "speaker_annotations",
      query: { decisionId: decision._id, segmentId: segment._id },
      update: {
        $setOnInsert: {
          decisionId: decision._id,
          sessionId: decision.sessionId,
          originalId: segment.original_id ?? segment.original,
          segmentId: segment._id,
          runId: segment.runId ?? null,
          start: segment.start,
          end: segment.end,
          profileId: decision.profileId ?? null,
          excludedProfileIds: decision.excludedProfileIds ?? [],
          calibrationUse: decision.calibrationUse ?? "eligible",
          source: "manual",
          author: decision.author,
          createdAt: decision.createdAt ?? now,
        },
        $set: { updatedAt: now },
      },
      options: { upsert: true },
    });
  }
  const supersededDecision = decision.supersedesDecisionId
    ? await mongo({
      action: "findOne",
      collection: "speaker_review_decisions",
      query: { _id: decision.supersedesDecisionId },
    }) as any
    : null;
  const affectedProfileIds = [
    ...eligibleReviewDecisionProfileIds(decision),
    ...eligibleReviewDecisionProfileIds(supersededDecision),
  ];
  if (affectedProfileIds.length > 0) {
    await invalidateCalibrationsForProfiles(
      mongo,
      affectedProfileIds,
      decision.supersedesDecisionId
        ? "review label revised"
        : "voice labels changed",
      now,
    );
  }
  await mongo({
    action: "updateOne",
    collection: "speaker_review_decisions",
    query: { _id: decision._id, status: "building" },
    update: {
      $set: {
        status: "committed",
        annotationCount: segments.length,
        committedAt: now,
        updatedAt: now,
      },
    },
  });
}

export async function invalidateCalibrationsForProfiles(
  mongo: any,
  rawProfileIds: unknown[],
  reason: string,
  now = new Date(),
  idempotencyKey?: string,
): Promise<void> {
  const profileIds = [
    ...new Set(
      rawProfileIds.map(String).filter((id) => ObjectId.isValid(id)),
    ),
  ];
  if (profileIds.length === 0) return;
  await Promise.all([
    mongo({
      action: "updateMany",
      collection: "speaker_calibrations",
      query: {
        profileId: { $in: profileIds },
        status: "validated",
        lifecycleStatus: { $ne: "superseded" },
      },
      update: {
        $set: {
          lifecycleStatus: "stale",
          staleAt: now,
          staleReason: reason,
          updatedAt: now,
        },
      },
    }),
    mongo({
      action: "updateMany",
      collection: "speaker_profiles",
      query: {
        _id: { $in: profileIds.map((id) => new ObjectId(id)) },
        ...(idempotencyKey
          ? { lastIdentityEvidenceInvalidationKey: { $ne: idempotencyKey } }
          : {}),
      },
      update: {
        $unset: { activeCalibrationIds: "", activeCalibrationId: "" },
        $set: {
          calibrationHeadsInitialized: true,
          calibrationInvalidatedAt: now,
          ...(idempotencyKey
            ? { lastIdentityEvidenceInvalidationKey: idempotencyKey }
            : {}),
          updatedAt: now,
        },
        $inc: { calibrationEvidenceRevision: 1 },
      },
    }),
    mongo({
      action: "updateMany",
      collection: "speaker_identity_evaluations",
      query: {
        profileId: {
          $in: [
            ...profileIds,
            ...profileIds.map((id) => new ObjectId(id)),
          ],
        },
        lifecycleStatus: { $ne: "stale" },
      },
      update: {
        $set: {
          lifecycleStatus: "stale",
          staleAt: now,
          staleReason: reason,
          updatedAt: now,
        },
      },
    }),
    mongo({
      action: "updateMany",
      collection: "identity_model_sets",
      query: {
        $or: [
          { profileIds: { $in: profileIds } },
          { "profiles.profileId": { $in: profileIds } },
        ],
        status: { $in: ["building", "ready"] },
      },
      update: {
        $set: {
          status: "failed",
          failureReason: `profile_evidence_changed: ${reason}`,
          failedAt: now,
          updatedAt: now,
        },
      },
    }),
    mongo({
      action: "updateMany",
      collection: "identity_model_sets",
      query: {
        $or: [
          { profileIds: { $in: profileIds } },
          { "profiles.profileId": { $in: profileIds } },
        ],
        status: "active",
      },
      update: {
        $addToSet: {
          staleProfileIds: { $each: profileIds },
          staleProfileReasons: reason,
        },
        $set: {
          profileEvidenceStaleAt: now,
          updatedAt: now,
        },
      },
    }),
  ]);
}

function nextPendingSegmentId(
  window: any[],
  afterSegmentId?: string,
): string | null {
  const after = afterSegmentId
    ? window.findIndex((item) => String(item.segmentId) === afterSegmentId)
    : -1;
  for (let offset = 1; offset <= window.length; offset++) {
    const item = window[(after + offset) % window.length];
    if (item?.status === "pending") return String(item.segmentId);
  }
  return null;
}

async function computeCalibrationPreview(
  mongo: any,
  profileId: string,
  requestedCalibrationIds: string[],
  requestedValidationIds: string[],
  targetPrecision: number,
  positiveThresholdOverride?: number,
): Promise<any> {
  const profileObjectId = new ObjectId(profileId);
  const profile = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { _id: profileObjectId },
  }) as any;
  if (!profile?.embedding?.length || !profile.embeddingSpaceId) {
    throw new Error("Re-enroll this profile before calibration");
  }
  const savedEnrollmentSamples = (await mongo({
    action: "find",
    collection: "voice_samples.files",
    query: { "metadata.profile_id": profileId },
    options: {
      projection: {
        "metadata.source": 1,
        "metadata.source_original_id": 1,
        "metadata.source_start": 1,
        "metadata.source_end": 1,
        "metadata.provenance": 1,
      },
      sort: { uploadDate: 1 },
      limit: 500,
    },
  }) as any[]) ?? [];
  const annotations = await mongo({
    action: "find",
    collection: "speaker_annotations",
    query: {
      calibrationUse: { $ne: "timeline_only" },
      $or: [
        { profileId: profileObjectId },
        { excludedProfileIds: profileObjectId },
      ],
    },
    options: {
      sort: { updatedAt: -1, createdAt: -1 },
      limit: 20_000,
      projection: {
        decisionId: 1,
        sessionId: 1,
        segmentId: 1,
        originalId: 1,
        profileId: 1,
        excludedProfileIds: 1,
        calibrationUse: 1,
        updatedAt: 1,
        createdAt: 1,
      },
    },
  }) as any[];
  const latestBySegment = new Map<string, any>();
  for (const annotation of annotations) {
    const segmentId = String(annotation.segmentId ?? "");
    if (ObjectId.isValid(segmentId) && !latestBySegment.has(segmentId)) {
      latestBySegment.set(segmentId, annotation);
    }
  }
  const segmentIds = [...latestBySegment.keys()].map((id) => new ObjectId(id));
  const segments = segmentIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "diarizations",
    query: { _id: { $in: segmentIds }, embedding: { $exists: true } },
    options: {
      projection: {
        embedding: 1,
        embeddingSpaceId: 1,
        original_id: 1,
        original: 1,
        runId: 1,
        speaker: 1,
        start: 1,
        end: 1,
      },
      limit: segmentIds.length,
    },
  }) as any[];
  const segmentById = new Map(
    segments.map((segment) => [String(segment._id), segment]),
  );
  const labeledExamples: Array<{
    segmentId: string;
    recordingId: string;
    label: "positive" | "negative";
    score: number;
    start: Date;
    end: Date;
    decisionId: string | null;
    sessionId: string | null;
    assignedProfileId: string | null;
    excludedProfileIds: string[];
    updatedAt: Date | null;
    segment: Record<string, unknown>;
  }> = [];
  let incompatible = 0;
  for (const [segmentId, annotation] of latestBySegment) {
    const segment = segmentById.get(segmentId);
    if (
      !segment?.embedding ||
      segment.embeddingSpaceId !== profile.embeddingSpaceId
    ) {
      incompatible += 1;
      continue;
    }
    const isPositive = String(annotation.profileId ?? "") === profileId;
    const isNegative = (annotation.excludedProfileIds ?? []).some((
      id: unknown,
    ) => String(id) === profileId);
    if (!isPositive && !isNegative) continue;
    const { embedding: _embedding, ...publicSegment } = segment;
    labeledExamples.push({
      segmentId,
      recordingId: String(
        annotation.originalId ?? segment.original_id ?? segment.original,
      ),
      label: isPositive ? "positive" : "negative",
      score: cosineSimilarity(profile.embedding, segment.embedding),
      start: new Date(segment.start),
      end: new Date(segment.end),
      decisionId: ObjectId.isValid(String(annotation.decisionId ?? ""))
        ? String(annotation.decisionId)
        : null,
      sessionId: ObjectId.isValid(String(annotation.sessionId ?? ""))
        ? String(annotation.sessionId)
        : null,
      assignedProfileId: ObjectId.isValid(String(annotation.profileId ?? ""))
        ? String(annotation.profileId)
        : null,
      excludedProfileIds: (annotation.excludedProfileIds ?? []).map(String),
      updatedAt: annotation.updatedAt ?? annotation.createdAt ?? null,
      segment: publicSegment,
    });
  }
  const prototypeDocuments = Array.isArray(profile.embeddingPrototypes)
    ? profile.embeddingPrototypes
    : [];
  const prototypeSampleIds = new Set(
    prototypeDocuments.map((item: any) => String(item?.sampleId ?? ""))
      .filter(Boolean),
  );
  const enrollmentSourceDocuments = [
    ...prototypeDocuments,
    ...savedEnrollmentSamples.filter((sample) =>
      !prototypeSampleIds.has(String(sample?._id ?? ""))
    ).map((sample) => {
      const metadata = sample?.metadata ?? {};
      return {
        sampleId: sample?._id,
        embedding: [0],
        source: metadata.source,
        provenance: metadata.provenance ?? {
          source: metadata.source,
          originalId: metadata.source_original_id,
          interval: {
            start: metadata.source_start,
            end: metadata.source_end,
          },
        },
      };
    }),
  ];
  const enrollmentIsolation = isolateEnrollmentSourceRecordings(
    labeledExamples,
    enrollmentSourceDocuments,
  );
  const examples = enrollmentIsolation.examples;
  const recordingMap = new Map<string, any>();
  for (const example of examples) {
    const row = recordingMap.get(example.recordingId) ?? {
      id: example.recordingId,
      positive: 0,
      negative: 0,
      total: 0,
      start: example.start,
      end: example.end,
    };
    row[example.label] += 1;
    row.total += 1;
    if (example.start < row.start) row.start = example.start;
    if (example.end > row.end) row.end = example.end;
    recordingMap.set(example.recordingId, row);
  }
  const recordings = [...recordingMap.values()].sort((a, b) =>
    b.total - a.total || a.id.localeCompare(b.id)
  );
  const automaticSplit = requestedCalibrationIds.length === 0 &&
    requestedValidationIds.length === 0;
  const split = automaticSplit ? splitCalibrationRecordings(recordings) : {
    calibrationRecordingIds: requestedCalibrationIds,
    validationRecordingIds: requestedValidationIds,
  };
  const calibrationSet = new Set(split.calibrationRecordingIds);
  const validationSet = new Set(split.validationRecordingIds);
  const overlap = split.validationRecordingIds.filter((id: string) =>
    calibrationSet.has(id)
  );
  const prototypes = prototypeDocuments.map((item: any) =>
    Array.isArray(item?.embedding) ? item.embedding : null
  ).filter((embedding: unknown): embedding is number[] =>
    Array.isArray(embedding) && embedding.length > 0
  );
  const learnExamples = examples.filter((item) =>
    calibrationSet.has(item.recordingId)
  );
  // Strategy selection sees Learn recordings only. Check remains held out and
  // is scored exactly once with the frozen winning strategy.
  const strategySelection = selectProfileScoringStrategy(
    learnExamples.map((item) => ({
      label: item.label,
      embedding: segmentById.get(item.segmentId)?.embedding ?? [],
      value: item,
    })),
    profile.embedding,
    prototypes,
    targetPrecision,
  );
  const scoringStrategy = strategySelection?.strategy ?? "centroid";
  const scoredExamples = examples.map((item) => ({
    ...item,
    score: scoreProfileEmbedding(
      segmentById.get(item.segmentId)?.embedding ?? [],
      profile.embedding,
      prototypes,
      scoringStrategy,
    ),
  }));
  const calibrationExamples = scoredExamples.filter((item) =>
    calibrationSet.has(item.recordingId)
  );
  const validationExamples = scoredExamples.filter((item) =>
    validationSet.has(item.recordingId)
  );
  const recommendedThresholds = strategySelection?.thresholds ??
    chooseCalibrationThresholds(calibrationExamples, targetPrecision);
  const thresholdSelection = applyPositiveThresholdOverride(
    recommendedThresholds,
    positiveThresholdOverride,
    targetPrecision < SPEAKER_CALIBRATION_TARGET_PRECISION,
  );
  let thresholds = thresholdSelection.thresholds;
  let calibrationMetrics = thresholds
    ? evaluateCalibration(
      calibrationExamples,
      thresholds.positiveThreshold,
      thresholds.negativeThreshold,
      thresholds.negativeDecisionMode,
    )
    : null;
  let validationMetrics = thresholds
    ? evaluateCalibration(
      validationExamples,
      thresholds.positiveThreshold,
      thresholds.negativeThreshold,
      thresholds.negativeDecisionMode,
    )
    : null;
  if (thresholds) {
    const safeThresholds = applyHeldOutNegativeSafety(
      thresholds,
      validationMetrics,
      targetPrecision,
      SPEAKER_CALIBRATION_MIN_CHECK_AUTO_REJECTIONS,
    );
    if (
      safeThresholds.negativeDecisionMode !== thresholds.negativeDecisionMode
    ) {
      thresholds = safeThresholds;
      calibrationMetrics = evaluateCalibration(
        calibrationExamples,
        thresholds.positiveThreshold,
        thresholds.negativeThreshold,
        thresholds.negativeDecisionMode,
      );
      validationMetrics = evaluateCalibration(
        validationExamples,
        thresholds.positiveThreshold,
        thresholds.negativeThreshold,
        thresholds.negativeDecisionMode,
      );
    }
  }
  const validationIssues = thresholds
    ? {
      falsePositive: validationExamples.filter((example) =>
        example.label === "negative" &&
        classifyCalibrationScore(
            example.score,
            thresholds.positiveThreshold,
            thresholds.negativeThreshold,
            thresholds.negativeDecisionMode,
          ) === "identified"
      ).sort((a, b) => b.score - a.score).slice(0, 200).map((example) => ({
        kind: "false_positive",
        ...example,
        decision: "identified",
      })),
      missedPositive: validationExamples.filter((example) =>
        example.label === "positive" &&
        classifyCalibrationScore(
            example.score,
            thresholds.positiveThreshold,
            thresholds.negativeThreshold,
            thresholds.negativeDecisionMode,
          ) !== "identified"
      ).sort((a, b) => b.score - a.score).slice(0, 200).map((example) => ({
        kind: "missed_positive",
        ...example,
        decision: classifyCalibrationScore(
          example.score,
          thresholds.positiveThreshold,
          thresholds.negativeThreshold,
          thresholds.negativeDecisionMode,
        ),
      })),
    }
    : { falsePositive: [], missedPositive: [] };
  const positive = examples.filter((item) => item.label === "positive").length;
  const negative = examples.length - positive;
  const blockers: string[] = [];
  if (enrollmentIsolation.unknownTimelinePrototypeCount > 0) {
    blockers.push(
      `${enrollmentIsolation.unknownTimelinePrototypeCount} Timeline-derived enrollment sample(s) have unknown source recording or interval; remove and re-add those samples before calibration`,
    );
  }
  const explicitlySelectedEnrollmentSources = [
    ...requestedCalibrationIds,
    ...requestedValidationIds,
  ].filter((id) => enrollmentIsolation.enrollmentRecordingIds.includes(id));
  if (explicitlySelectedEnrollmentSources.length > 0) {
    blockers.push(
      `${
        new Set(explicitlySelectedEnrollmentSources).size
      } selected Learn/Check recording(s) are profile enrollment sources and cannot be used for independent validation`,
    );
  }
  if (positive < 40) {
    blockers.push(`${40 - positive} more compatible target labels needed`);
  }
  if (negative < 40) {
    blockers.push(`${40 - negative} more compatible not-target labels needed`);
  }
  if (examples.length < 100) {
    blockers.push(
      `${100 - examples.length} more compatible labels needed in total`,
    );
  }
  if (recordings.length < 2) {
    blockers.push("Label at least two different source recordings");
  }
  if (overlap.length > 0) {
    blockers.push("Calibration and validation recordings overlap");
  }
  if (
    calibrationExamples.every((item) => item.label !== "positive") ||
    calibrationExamples.every((item) => item.label !== "negative")
  ) {
    blockers.push("Calibration set needs both target and not-target examples");
  }
  if (
    validationExamples.every((item) => item.label !== "positive") ||
    validationExamples.every((item) => item.label !== "negative")
  ) {
    blockers.push("Validation set needs both target and not-target examples");
  }
  const validationPositiveCount =
    validationExamples.filter((item) => item.label === "positive").length;
  const validationNegativeCount = validationExamples.length -
    validationPositiveCount;
  if (validationPositiveCount < SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS) {
    blockers.push(
      `Check needs ${
        SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS - validationPositiveCount
      } more target labels`,
    );
  }
  if (validationNegativeCount < SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS) {
    blockers.push(
      `Check needs ${
        SPEAKER_CALIBRATION_MIN_CHECK_PER_CLASS - validationNegativeCount
      } more not-target labels`,
    );
  }
  if (!thresholds) {
    blockers.push(
      "No auto-Sky threshold reaches the target precision on calibration audio",
    );
  }
  if (
    thresholds && (!validationMetrics || validationMetrics.identified === 0 ||
      validationMetrics.positivePrecision < targetPrecision)
  ) {
    blockers.push(
      `Validation auto-match precision is below ${
        Math.round(targetPrecision * 100)
      }%`,
    );
  }
  if (
    thresholds && validationMetrics &&
    validationMetrics.identified < SPEAKER_CALIBRATION_MIN_CHECK_AUTO_MATCHES
  ) {
    blockers.push(
      `Check needs at least ${SPEAKER_CALIBRATION_MIN_CHECK_AUTO_MATCHES} automatic target matches`,
    );
  }
  const evidenceSnapshotHash = await calibrationEvidenceFingerprint(
    [
      ...examples.map((example) => {
        const segment = segmentById.get(example.segmentId);
        return {
          segmentId: example.segmentId,
          decisionId: example.decisionId,
          label: example.label,
          recordingId: example.recordingId,
          runId: String(segment?.runId ?? ""),
          embeddingSpaceId: String(segment?.embeddingSpaceId ?? ""),
          updatedAt: example.updatedAt
            ? new Date(example.updatedAt).toISOString()
            : null,
        };
      }),
      {
        segmentId: "__enrollment_provenance__",
        enrollmentRecordingIds: enrollmentIsolation.enrollmentRecordingIds,
        unknownTimelinePrototypeCount:
          enrollmentIsolation.unknownTimelinePrototypeCount,
      },
    ],
  );
  return {
    profile: {
      id: profileId,
      name: profile.name,
      revision: profile.revision ?? 1,
      embeddingSpaceId: profile.embeddingSpaceId,
    },
    counts: {
      positive,
      negative,
      total: examples.length,
      recordings: recordings.length,
      incompatible,
    },
    recordings,
    ...split,
    automaticSplit,
    targetPrecision,
    thresholds,
    recommendedPositiveThreshold:
      thresholdSelection.recommendedPositiveThreshold,
    positiveThresholdSource: thresholdSelection.positiveThresholdSource,
    scoringStrategy,
    scoringStrategiesEvaluated: prototypes.length > 0
      ? ["centroid", "max_prototype", "top2_prototype_mean"]
      : ["centroid"],
    enrollmentIsolation: {
      enrollmentRecordingIds: enrollmentIsolation.enrollmentRecordingIds,
      excludedRecordingIds: enrollmentIsolation.excludedRecordingIds,
      excludedExampleCount: enrollmentIsolation.excludedExampleCount,
      unknownTimelinePrototypeCount:
        enrollmentIsolation.unknownTimelinePrototypeCount,
    },
    evidenceSnapshotHash,
    evidenceRevision: Number(profile.calibrationEvidenceRevision ?? 0),
    calibrationMetrics,
    validationMetrics,
    validationIssues,
    scoreDistribution: {
      calibrationPositive: calibrationExamples.filter((item) =>
        item.label === "positive"
      ).map((item) => item.score),
      calibrationNegative: calibrationExamples.filter((item) =>
        item.label === "negative"
      ).map((item) => item.score),
      validationPositive: validationExamples.filter((item) =>
        item.label === "positive"
      ).map((item) => item.score),
      validationNegative: validationExamples.filter((item) =>
        item.label === "negative"
      ).map((item) => item.score),
    },
    blockers: [...new Set(blockers)],
    canValidate: blockers.length === 0,
  };
}

async function verifyCalibrationEvidence(
  mongo: any,
  profileId: string,
  calibration: any,
): Promise<{ valid: boolean; blocker: string | null }> {
  try {
    const currentEvidence = await computeCalibrationPreview(
      mongo,
      profileId,
      calibration.calibrationRecordingIds ?? [],
      calibration.validationRecordingIds ?? [],
      Number(calibration.targetPrecision),
      calibration.positiveThresholdSource === "operator_stricter"
        ? Number(calibration.positiveThreshold)
        : undefined,
    );
    if (
      currentEvidence.evidenceSnapshotHash !==
        calibration.evidenceSnapshotHash
    ) {
      return {
        valid: false,
        blocker:
          "Voice labels changed after calibration; recalculate and save again",
      };
    }
    return { valid: true, blocker: null };
  } catch (error) {
    return {
      valid: false,
      blocker: `Calibration evidence cannot be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function calibrationEvidenceMatchesProfile(
  profile: any,
  calibration: any,
): boolean {
  return Boolean(String(calibration?.evidenceSnapshotHash ?? "").trim()) &&
    Number(calibration?.evidenceRevision ?? 0) ===
      Number(profile?.calibrationEvidenceRevision ?? 0);
}

function calibrationsAtProfileHead(profile: any, calibrations: any[]): any[] {
  const hasPolicyHeads = profile?.activeCalibrationIds !== undefined &&
    profile?.activeCalibrationIds !== null;
  const headIds = new Set(
    (hasPolicyHeads
      ? [
        profile?.activeCalibrationIds?.full,
        profile?.activeCalibrationIds?.pilot,
      ]
      : [profile?.activeCalibrationId]).filter(Boolean).map(String),
  );
  return hasPolicyHeads || headIds.size > 0 ||
      profile?.calibrationHeadsInitialized === true
    ? calibrations.filter((candidate) =>
      headIds.has(String(candidate.calibrationId))
    )
    : calibrations;
}

async function resolveIdentityClassificationContext(
  mongo: any,
  profileId: string,
): Promise<{
  profile: any;
  calibration: any | null;
  snapshot: IdentityCalibrationSnapshot | null;
  blockers: string[];
}> {
  const profileObjectId = new ObjectId(profileId);
  const [profile, calibrations] = await Promise.all([
    mongo({
      action: "findOne",
      collection: "speaker_profiles",
      query: { _id: profileObjectId },
    }),
    mongo({
      action: "find",
      collection: "speaker_calibrations",
      query: { profileId },
      options: { sort: { createdAt: -1 }, limit: 50 },
    }),
  ]) as [any, any[]];
  const blockers: string[] = [];
  if (!profile) blockers.push("Voice profile no longer exists");
  if (!Array.isArray(profile?.embedding) || profile.embedding.length === 0) {
    blockers.push("Build the voice profile before classification");
  }
  if (profile?.enrollmentStatus === "pending_rebuild") {
    blockers.push("Rebuild the profile after adding clean samples");
  }
  if (!profile?.embeddingSpaceId) {
    blockers.push("The profile has no voice-model provenance");
  }
  const calibrationContext = profile
    ? {
      profileId,
      profileRevision: Number(profile.revision ?? 1),
      embeddingSpaceId: profile.embeddingSpaceId,
    }
    : null;
  const headedCalibrations = calibrationsAtProfileHead(profile, calibrations);
  const candidateCalibrations = calibrationContext
    ? [
      findUsableFullCalibration(headedCalibrations, calibrationContext),
      findUsablePilotCalibration(headedCalibrations, calibrationContext),
    ].filter((candidate, index, values) =>
      candidate && values.findIndex((value) =>
          value?.calibrationId === candidate.calibrationId
        ) === index
    )
    : [];
  let calibration: any | null = null;
  let evidenceFailure: string | null = null;
  for (const candidate of candidateCalibrations) {
    const evidence = await verifyCalibrationEvidence(
      mongo,
      profileId,
      candidate,
    );
    if (evidence.valid) {
      calibration = candidate;
      break;
    }
    evidenceFailure = evidence.blocker;
  }
  if (!calibration) {
    if (evidenceFailure) blockers.push(evidenceFailure);
    if (
      (profile?.activeCalibrationIds || profile?.activeCalibrationId) &&
      headedCalibrations.length === 0
    ) {
      blockers.push(
        "Saved calibration activation is incomplete; save calibration again",
      );
    }
    blockers.push(
      "Save a server-validated calibration for this profile revision",
    );
  }
  const policy = calibration ? normalizeCalibrationPolicy(calibration) : null;
  const snapshot = profile && calibration
    ? {
      calibrationId: String(calibration.calibrationId),
      profileId,
      profileRevision: Number(profile.revision ?? 1),
      embeddingSpaceId: String(profile.embeddingSpaceId),
      classificationPolicy: policy?.classificationPolicy ?? "full",
      evidenceSnapshotHash: String(calibration.evidenceSnapshotHash),
    }
    : null;
  return { profile, calibration, snapshot, blockers };
}

async function resolveIdentityModelSetProfiles(
  mongo: any,
  profileIds: string[],
): Promise<IdentityProfileSnapshot[]> {
  const snapshots: IdentityProfileSnapshot[] = [];
  for (const profileId of [...new Set(profileIds)]) {
    const context = await resolveIdentityClassificationContext(
      mongo,
      profileId,
    );
    if (context.blockers.length > 0 || !context.snapshot) {
      throw new Error(
        `${context.profile?.name ?? profileId}: ${
          context.blockers.join("; ") || "classification is not ready"
        }`,
      );
    }
    if (context.snapshot.classificationPolicy !== "full") {
      throw new Error(
        `${
          context.profile?.name ?? profileId
        } needs a full calibration before joining a model set`,
      );
    }
    snapshots.push({
      profileId,
      profileRevision: context.snapshot.profileRevision,
      calibrationId: context.snapshot.calibrationId,
      embeddingSpaceId: context.snapshot.embeddingSpaceId,
      evidenceSnapshotHash: context.snapshot.evidenceSnapshotHash,
    });
  }
  if (
    new Set(snapshots.map((snapshot) => snapshot.embeddingSpaceId)).size !== 1
  ) {
    throw new Error(
      "Every profile in a model set must use the same voice model",
    );
  }
  return snapshots;
}

async function resolveDefaultIdentityModelSetProfileIds(
  mongo: any,
  selectedProfileId: string,
): Promise<string[]> {
  const selected = await mongo({
    action: "findOne",
    collection: "speaker_profiles",
    query: { _id: new ObjectId(selectedProfileId) },
    options: { projection: { embeddingSpaceId: 1 } },
  }) as any;
  if (!selected?.embeddingSpaceId) return [selectedProfileId];
  const head = await mongo({
    action: "findOne",
    collection: "identity_model_set_heads",
    query: { embeddingSpaceId: selected.embeddingSpaceId },
  }) as any;
  const activeSet = head?.activeModelSetId
    ? await mongo({
      action: "findOne",
      collection: "identity_model_sets",
      query: { modelSetId: head.activeModelSetId, status: "active" },
      options: { projection: { profileIds: 1 } },
    }) as any
    : null;
  return [
    ...new Set([
      ...(activeSet?.profileIds ?? []).map(String),
      selectedProfileId,
    ]),
  ];
}

async function prepareIdentityModelSetFromPreflight(
  mongo: any,
  preflight: any,
  profileIds: string[],
  principal: unknown,
) {
  if (
    !preflight?.canStart || !preflight?.sourceSnapshot ||
    !Array.isArray(preflight.partitions) || preflight.partitions.length === 0
  ) {
    throw new Error("Classification preview has no frozen source to build");
  }
  const profiles = await resolveIdentityModelSetProfiles(mongo, profileIds);
  const frozenProfiles = preflight.resolved?.profileSnapshots;
  if (
    !Array.isArray(frozenProfiles) ||
    !sameIdentityProfileSnapshots(profiles, frozenProfiles)
  ) {
    throw new Error(
      "A selected profile or calibration changed after preview; check the source again",
    );
  }
  const embeddingSpaceId = profiles[0].embeddingSpaceId;
  if (
    preflight.partitions.some((partition: any) =>
      String(partition.embeddingSpaceId) !== embeddingSpaceId
    )
  ) {
    throw new Error(
      "Classification source does not match the selected profiles",
    );
  }
  return await prepareIdentityModelSet(mongo, {
    profiles,
    sourceSnapshot: preflight.sourceSnapshot,
    partitions: preflight.partitions,
    scope: preflight.scope,
    snapshotCutoff: preflight.snapshotCutoff,
    createdBy: principal,
  });
}

async function ensureIdentitySourceIndexQueued(
  mongo: any,
  currentState: any,
): Promise<any> {
  let state = currentState;
  if (!state) {
    await markIdentitySourceIndexCounting(
      mongo,
      "identity_preflight_requested",
    );
    state = await mongo({
      action: "findOne",
      collection: SPEAKER_IDENTITY_SOURCE_INDEX,
      query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
    });
  }
  if (state?.status === "ready" || state?.status === "blocked") return state;
  state = await reconcileIdentitySourceIndexReservations(mongo, state);
  if (state?.currentJobId) return state;
  const staleQueuedAt = new Date(Date.now() - 2 * 60_000);
  if (
    state?.queuedJobId && state?.queuedAt &&
    new Date(state.queuedAt) > staleQueuedAt
  ) {
    return state;
  }
  const reservedJobId = new ObjectId().toString();
  const queuedAt = new Date();
  const claimed = await mongo({
    action: "updateOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: {
      _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
      status: "counting",
      currentJobId: { $exists: false },
      $or: [
        { queuedJobId: { $exists: false } },
        { queuedAt: { $lte: staleQueuedAt } },
      ],
    },
    update: {
      $set: { queuedJobId: reservedJobId, queuedAt, updatedAt: queuedAt },
    },
  }) as any;
  if (Number(claimed?.matchedCount ?? 0) !== 1) {
    return await mongo({
      action: "findOne",
      collection: SPEAKER_IDENTITY_SOURCE_INDEX,
      query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
    });
  }
  try {
    const { enqueueJob } = await import("@/lib/jobs/queue.ts");
    await enqueueJob({ type: "speakerIdentitySourceIndex" }, {
      jobId: reservedJobId,
      priority: 4,
      trigger: {
        type: "auto",
        reason: "prepare speaker identity source",
      },
    });
  } catch (error) {
    await mongo({
      action: "updateOne",
      collection: SPEAKER_IDENTITY_SOURCE_INDEX,
      query: {
        _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
        queuedJobId: reservedJobId,
      },
      update: {
        $unset: { queuedJobId: "", queuedAt: "" },
        $set: {
          queueError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        },
      },
    });
  }
  return await mongo({
    action: "findOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
  });
}

async function computeIdentityPreflight(
  mongo: any,
  profileId: string,
  rawScope: {
    mode: "all_compatible" | "range";
    start?: Date | string;
    end?: Date | string;
  },
  snapshotCutoff: Date,
  requestedProfileIds: string[] = [profileId],
): Promise<any> {
  const scope = normalizeIdentityScope(rawScope);
  const context = await resolveIdentityClassificationContext(mongo, profileId);
  const blockers = [...context.blockers];
  if (!context.snapshot) {
    return {
      canStart: false,
      status: "blocked",
      blockers,
      scope,
      snapshotCutoff,
      partitions: [],
      totals: {
        eligibleSegments: 0,
        alreadyCurrent: 0,
        incompatibleSegments: 0,
        estimatedBatches: 0,
      },
      resolved: {
        profileId,
        profileRevision: Number(context.profile?.revision ?? 0),
        profileName: context.profile?.name ?? null,
        calibrationId: null,
        embeddingSpaceId: context.profile?.embeddingSpaceId ?? null,
        classificationPolicy: null,
      },
      sourceIndex: identitySourceIndexView(null),
    };
  }
  const snapshot = context.snapshot;
  const usesModelSet = snapshot.classificationPolicy === "full";
  let modelSetProfiles: IdentityProfileSnapshot[] = [{
    profileId,
    profileRevision: snapshot.profileRevision,
    calibrationId: snapshot.calibrationId,
    embeddingSpaceId: snapshot.embeddingSpaceId,
    evidenceSnapshotHash: snapshot.evidenceSnapshotHash,
  }];
  if (usesModelSet) {
    if (!requestedProfileIds.includes(profileId)) {
      blockers.push(
        "The model set must include the profile used to preview the source",
      );
    } else {
      try {
        modelSetProfiles = await resolveIdentityModelSetProfiles(
          mongo,
          requestedProfileIds,
        );
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const calibrationPolicy = normalizeCalibrationPolicy(context.calibration);
  if (snapshot.classificationPolicy === "pilot") {
    if (scope.mode !== "range") {
      blockers.push("A provisional calibration requires a bounded period");
    } else {
      const rangeHours = (scope.end!.getTime() - scope.start!.getTime()) /
        3_600_000;
      if (
        rangeHours <= 0 || rangeHours >
          (calibrationPolicy?.maxRangeHours ??
            SPEAKER_CALIBRATION_PILOT_MAX_RANGE_HOURS)
      ) {
        blockers.push(
          `A provisional calibration is limited to ${
            calibrationPolicy?.maxRangeHours ??
              SPEAKER_CALIBRATION_PILOT_MAX_RANGE_HOURS
          } hours`,
        );
      }
    }
  }
  let sourceIndexState = await mongo({
    action: "findOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
  }) as any;
  if (sourceIndexState?.status === "ready") {
    const newer = await mongo({
      action: "find",
      collection: "diarizations",
      query: {
        lifecycleStatus: "active",
        embedding: { $exists: true },
        ...(sourceIndexState.publishedMaxSegmentId
          ? { _id: { $gt: sourceIndexState.publishedMaxSegmentId } }
          : {}),
      },
      options: {
        projection: { _id: 1 },
        sort: { _id: 1 },
        limit: 1,
        hint: "speaker_identity_source_index_scan",
      },
    }) as any[];
    if (newer.length > 0) {
      await markIdentitySourceIndexCounting(
        mongo,
        "preflight_detected_new_active_segment",
      );
      sourceIndexState = await mongo({
        action: "findOne",
        collection: SPEAKER_IDENTITY_SOURCE_INDEX,
        query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
      });
    }
  }
  let sourceIndex = identitySourceIndexView(sourceIndexState);
  const sourceSnapshot = identitySourceIndexSnapshot(sourceIndexState);
  if (!sourceSnapshot) {
    sourceIndexState = await ensureIdentitySourceIndexQueued(
      mongo,
      sourceIndexState,
    );
    sourceIndex = identitySourceIndexView(sourceIndexState);
    if (sourceIndex.status === "blocked") {
      blockers.push(
        sourceIndex.error
          ? `Voice source index is blocked: ${sourceIndex.error}`
          : "Voice source index is blocked; retry its job",
      );
    }
    return {
      canStart: false,
      status: sourceIndex.status,
      blockers,
      scope,
      snapshotCutoff,
      partitions: [],
      totals: {
        eligibleSegments: 0,
        alreadyCurrent: 0,
        incompatibleSegments: 0,
        estimatedBatches: 0,
      },
      resolved: {
        profileId,
        profileName: context.profile?.name ?? null,
        profileRevision: snapshot.profileRevision,
        calibrationId: snapshot.calibrationId,
        embeddingSpaceId: snapshot.embeddingSpaceId,
        classificationPolicy: snapshot.classificationPolicy,
        targetPrecision: Number(context.calibration?.targetPrecision ?? 0),
        evidenceSnapshotHash: snapshot.evidenceSnapshotHash,
      },
      sourceIndex,
      sourceSnapshot: null,
      runningCampaign: null,
      coverageRepair: null,
    };
  }

  const [sourceRows, running, baseline] = await Promise.all([
    mongo({
      action: "find",
      collection: SPEAKER_IDENTITY_SOURCE_PARTITIONS,
      query: { buildId: sourceSnapshot.buildId, status: "ready" },
      options: { sort: { start: 1, runId: 1 }, limit: 2_000 },
    }),
    mongo({
      action: "findOne",
      collection: "speaker_identity_campaigns",
      query: {
        $or: [
          { profileId: { $in: requestedProfileIds } },
          { profileIds: { $in: requestedProfileIds } },
        ],
        active: true,
        status: { $in: ["queued", "counting", "running"] },
      },
      options: { sort: { updatedAt: -1, createdAt: -1 } },
    }),
    mongo({
      action: "findOne",
      collection: "speaker_identity_campaigns",
      query: {
        profileId,
        profileRevision: snapshot.profileRevision,
        calibrationId: snapshot.calibrationId,
        embeddingSpaceId: snapshot.embeddingSpaceId,
        "scope.mode": "all_compatible",
        status: "completed",
        pendingSegments: 0,
        sourceChanged: { $ne: true },
      },
      options: {
        sort: { finishedAt: -1, updatedAt: -1 },
        projection: {
          status: 1,
          pendingSegments: 1,
          sourceChanged: 1,
          partitions: 1,
          sourceSnapshot: 1,
        },
      },
    }),
  ]) as [any[], any, any];
  if (
    Number(sourceIndexState?.partitionCount ?? sourceRows.length) !==
      sourceRows.length
  ) {
    blockers.push(
      "Voice source index is incomplete; rebuild it before classification",
    );
  }
  if (running) {
    blockers.push("An identity campaign is already running for this profile");
  }

  const effectiveStart = scope.mode === "range" ? scope.start! : new Date(0);
  const effectiveEnd = scope.mode === "range"
    ? new Date(Math.min(scope.end!.getTime(), snapshotCutoff.getTime()))
    : snapshotCutoff;
  const rowsInScope = sourceRows.filter((row) => {
    const start = new Date(row.start);
    const end = new Date(row.end);
    return start < effectiveEnd && end > effectiveStart;
  });
  const compatibleRows = rowsInScope.filter((row) =>
    String(row.embeddingSpaceId) === snapshot.embeddingSpaceId
  );
  const incompatibleRows = rowsInScope.filter((row) =>
    String(row.embeddingSpaceId) !== snapshot.embeddingSpaceId
  );
  const baselineByKey = new Map<string, IdentityPartition>();
  if (
    isCompleteIdentityCampaign(baseline) &&
    Number(baseline?.sourceSnapshot?.membershipRevision ?? 0) ===
      sourceSnapshot.membershipRevision
  ) {
    for (const partition of baseline.partitions ?? []) {
      baselineByKey.set(identityPartitionKey(partition), partition);
    }
  }
  const currentIdentity = buildCurrentIdentityCondition(snapshot);
  const runIds = [...new Set(compatibleRows.map((row) => String(row.runId)))];
  const runs = runIds.length === 0 ? [] : await mongo({
    action: "find",
    collection: "diarization_runs",
    query: { runId: { $in: runIds } },
    options: {
      projection: { runId: 1, generation: 1, status: 1 },
      limit: runIds.length,
    },
  }) as any[];
  const runById = new Map(runs.map((run) => [String(run.runId), run]));
  let alreadyCurrent = 0;
  const partitions: IdentityPartition[] = [];
  for (const row of compatibleRows) {
    const runId = String(row.runId);
    const embeddingSpaceId = String(row.embeddingSpaceId);
    let sourceSegments = Number(row.sourceSegments ?? 0);
    let currentSegments = 0;
    if (scope.mode === "range") {
      const sourceQuery = {
        lifecycleStatus: "active",
        embedding: { $exists: true },
        runId,
        embeddingSpaceId,
        start: { $gte: effectiveStart, $lt: effectiveEnd },
        ...frozenIdentitySourceCeiling(row.maxSegmentId),
      };
      sourceSegments = Number(
        await mongo({
          action: "count",
          collection: "diarizations",
          query: sourceQuery,
          options: {
            maxTimeMS: 10_000,
            hint: "speaker_identity_preflight_source",
          },
        }),
      );
      if (!usesModelSet) {
        currentSegments = Number(
          await mongo({
            action: "count",
            collection: "diarizations",
            query: { ...sourceQuery, ...currentIdentity },
            options: { maxTimeMS: 10_000 },
          }),
        );
      }
    } else if (!usesModelSet) {
      const baselinePartition = baselineByKey.get(
        identityPartitionKey({ runId, embeddingSpaceId }),
      );
      currentSegments = Math.min(
        sourceSegments,
        Number(baselinePartition?.sourceSegments ?? 0),
      );
    }
    alreadyCurrent += currentSegments;
    const eligibleSegments = remainingIdentityPartitionSegments(
      sourceSegments,
      currentSegments,
    );
    if (eligibleSegments <= 0) continue;
    partitions.push({
      runId,
      embeddingSpaceId,
      start: scope.mode === "range" ? effectiveStart : new Date(row.start),
      end: scope.mode === "range" ? effectiveEnd : new Date(row.end),
      eligibleSegments,
      sourceSegments,
      indexedSourceSegments: Number(row.sourceSegments ?? 0),
      sourceBuildId: sourceSnapshot.buildId,
      sourceRevision: sourceSnapshot.revision,
      maxSegmentId: String(row.maxSegmentId ?? ""),
      generation: runById.get(runId)?.generation ?? null,
    });
  }
  let incompatible = incompatibleRows.reduce(
    (total, row) => total + Number(row.sourceSegments ?? 0),
    0,
  );
  if (scope.mode === "range") {
    incompatible = 0;
    for (const row of incompatibleRows) {
      incompatible += Number(
        await mongo({
          action: "count",
          collection: "diarizations",
          query: {
            lifecycleStatus: "active",
            embedding: { $exists: true },
            runId: String(row.runId),
            embeddingSpaceId: String(row.embeddingSpaceId),
            start: { $gte: effectiveStart, $lt: effectiveEnd },
            ...frozenIdentitySourceCeiling(row.maxSegmentId),
          },
          options: {
            maxTimeMS: 10_000,
            hint: "speaker_identity_preflight_source",
          },
        }),
      );
    }
  }
  const activeRuns = await mongo({
    action: "find",
    collection: "diarization_runs",
    query: { status: "active" },
    options: {
      projection: {
        runId: 1,
        status: 1,
        range: 1,
        activatedAt: 1,
        replacesRunId: 1,
      },
      limit: 100,
    },
  }) as any[];
  const effectiveRange = { start: effectiveStart, end: effectiveEnd };
  let coverageRepair: any | null = null;
  const indexedRunIds = new Set(rowsInScope.map((row) => String(row.runId)));
  for (const activeRun of activeRuns) {
    if (!activeRun.range || !rangesOverlap(activeRun.range, effectiveRange)) {
      continue;
    }
    if (indexedRunIds.has(String(activeRun.runId))) continue;
    coverageRepair = {
      runId: String(activeRun.runId),
      status: "preview_required",
      repairable: null,
      summary: "Active run has no indexed speaker segments",
    };
    blockers.push(
      `Check empty diarization activation ${activeRun.runId} before classification`,
    );
    break;
  }
  let eligibleSegments = partitions.reduce(
    (total, partition) => total + partition.eligibleSegments,
    0,
  );
  let modelSetPreview: any | null = null;
  if (usesModelSet && eligibleSegments > 0) {
    const fingerprint = await identityModelSetFingerprint({
      profiles: modelSetProfiles,
      sourceSnapshot,
      partitions: partitions.map((partition) => ({
        ...partition,
        maxSegmentId: String(partition.maxSegmentId),
      })),
      scope,
      snapshotCutoff,
    });
    const existingModelSet = await mongo({
      action: "findOne",
      collection: "identity_model_sets",
      query: { fingerprint },
      options: { projection: { partitions: 0 } },
    }) as any;
    if (existingModelSet) {
      const total = partitions.reduce(
        (sum, partition) => sum + Number(partition.sourceSegments),
        0,
      );
      const projected = Math.min(
        total,
        Number(existingModelSet.coverage?.projectedSegments ?? 0),
      );
      alreadyCurrent = projected;
      eligibleSegments = Math.max(total - projected, 0);
      modelSetPreview = {
        modelSetId: existingModelSet.modelSetId,
        status: existingModelSet.status,
        coverage: existingModelSet.coverage,
        activationRequired: existingModelSet.status === "ready" &&
          eligibleSegments === 0,
      };
    }
  }
  return {
    canStart: blockers.length === 0 && eligibleSegments > 0,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers: eligibleSegments === 0 && blockers.length === 0
      ? ["No compatible segments need this calibration"]
      : blockers,
    scope,
    snapshotCutoff,
    partitions,
    totals: {
      eligibleSegments,
      alreadyCurrent: Number(alreadyCurrent ?? 0),
      incompatibleSegments: Number(incompatible ?? 0),
      estimatedBatches: Math.ceil(eligibleSegments / 1_000),
      estimated: scope.mode === "all_compatible",
    },
    resolved: {
      profileId,
      profileName: context.profile?.name ?? null,
      profileRevision: snapshot.profileRevision,
      calibrationId: snapshot.calibrationId,
      embeddingSpaceId: snapshot.embeddingSpaceId,
      classificationPolicy: snapshot.classificationPolicy,
      targetPrecision: Number(context.calibration?.targetPrecision ?? 0),
      maxRangeHours: calibrationPolicy?.maxRangeHours ?? null,
      evidenceSnapshotHash: String(
        context.calibration?.evidenceSnapshotHash ?? "",
      ),
      identityContract: usesModelSet ? "model_set_v1" : "legacy_single_profile",
      profileIds: modelSetProfiles.map((profile) => profile.profileId),
      profileSnapshots: modelSetProfiles,
    },
    runningCampaign: running ?? null,
    coverageRepair,
    sourceIndex,
    sourceSnapshot,
    modelSet: modelSetPreview,
  };
}

function exactLifecycleReader(mongo: any) {
  return {
    countSegments: async (query: Record<string, unknown>) => {
      const hint = selectDiarizationLifecycleIndex(query);
      return Number(
        await mongo({
          action: "count",
          collection: "diarizations",
          query,
          options: { maxTimeMS: 20_000, ...(hint ? { hint } : {}) },
        }),
      );
    },
    distinctSegmentRunIds: async (query: Record<string, unknown>) => {
      const hint = selectDiarizationLifecycleIndex(query);
      return ((await mongo({
        action: "aggregate",
        collection: "diarizations",
        pipeline: [
          { $match: query },
          { $group: { _id: "$runId" } },
        ],
        options: { maxTimeMS: 20_000, ...(hint ? { hint } : {}) },
      })) as any[]).map((row) => String(row._id)).filter(Boolean);
    },
    countRuns: async (query: Record<string, unknown>) =>
      Number(
        await mongo({
          action: "count",
          collection: "diarization_runs",
          query,
          options: { maxTimeMS: 10_000 },
        }),
      ),
  };
}

function rangesOverlap(
  left: { start?: unknown; end?: unknown },
  right: { start: Date; end: Date },
): boolean {
  const leftStart = left.start ? new Date(left.start as string) : new Date(0);
  const leftEnd = left.end
    ? new Date(left.end as string)
    : new Date(8640000000000000);
  return leftStart < right.end && leftEnd > right.start;
}

async function computeActivationPreview(mongo: any, runId: string) {
  const run = await mongo({
    action: "findOne",
    collection: "diarization_runs",
    query: { runId },
  }) as any;
  if (!run) throw new Error("Run not found");
  const preview = await previewActivationSafety(
    run,
    exactLifecycleReader(mongo),
  );
  const campaigns = await mongo({
    action: "find",
    collection: "speaker_identity_campaigns",
    query: { status: { $in: ["queued", "counting", "running"] } },
    options: {
      projection: { campaignId: 1, profileId: 1, range: 1, status: 1 },
      sort: { updatedAt: -1 },
      limit: 100,
    },
  }) as any[];
  const overlappingIdentityCampaigns = campaigns.filter((campaign) =>
    rangesOverlap(campaign.range ?? {}, preview.range)
  );
  const generationHasErrors = Array.isArray(run.errors) &&
    run.errors.length > 0;
  const blockers = [
    ...preview.blockers,
    ...(generationHasErrors ? ["generation_has_errors" as const] : []),
    ...(overlappingIdentityCampaigns.length > 0
      ? ["identity_campaign_running" as const]
      : []),
  ];
  const replacementRunIds = [
    ...new Set([
      ...preview.replacementRunIds,
      ...(run.activationProvenance?.replacementRunIds ?? []).map(String),
    ]),
  ];
  return {
    ...preview,
    allowed: preview.allowed && !generationHasErrors &&
      overlappingIdentityCampaigns.length === 0,
    blockers,
    replacementRunIds,
    overlappingIdentityCampaigns,
    summary: generationHasErrors
      ? "Activation is blocked until generation errors are resolved or explicitly marked failed."
      : overlappingIdentityCampaigns.length > 0
      ? "Activation is blocked while speaker classification is using this time range."
      : preview.summary,
  };
}

async function computeEmptyActivationRepairPreview(
  mongo: any,
  runId: string,
) {
  const run = await mongo({
    action: "findOne",
    collection: "diarization_runs",
    query: { runId },
  }) as any;
  if (!run) throw new Error("Run not found");
  const relatedRuns = await mongo({
    action: "find",
    collection: "diarization_runs",
    query: {
      $or: [
        { runId: run.replacesRunId ?? "__none__" },
        { supersededBy: runId },
        { "partialSupersessions.runId": runId },
      ],
    },
    options: {
      projection: { runId: 1, supersededBy: 1, partialSupersessions: 1 },
      limit: 100,
    },
  }) as any[];
  const replacementRunIds = [
    ...new Set([
      ...(run.activationProvenance?.replacementRunIds ?? []).map(String),
      ...collectReplacementRunIds(run, relatedRuns),
    ]),
  ].filter((candidate) => candidate && candidate !== runId).sort();
  const preview = await previewEmptyActivationRepair(
    run,
    replacementRunIds,
    exactLifecycleReader(mongo),
  );
  return {
    ...preview,
    confirmation: preview.repairable
      ? `REPAIR ${runId} ${preview.counts.recoverableSupersededSegments}`
      : null,
    preserves: ["raw audio", "transcripts", "embeddings", "segment documents"],
  };
}

async function computeRunPurgePreview(
  mongo: any,
  runId: string,
): Promise<RunPurgeSnapshot> {
  const run = await mongo({
    action: "findOne",
    collection: "diarization_runs",
    query: { runId },
    options: { projection: { runId: 1, status: 1, purgedAt: 1 } },
  }) as any;
  if (!run) throw new Error("Run not found");

  const queries = buildRunPurgeQueries(runId);
  const [documents, embeddings, activeSegments] = await Promise.all([
    mongo({
      action: "count",
      collection: "diarizations",
      query: queries.deletable,
    }),
    mongo({
      action: "count",
      collection: "diarizations",
      query: queries.embeddings,
    }),
    mongo({
      action: "count",
      collection: "diarizations",
      query: queries.active,
    }),
  ]);

  return buildRunPurgeSnapshot({
    runId,
    status: String(run.status ?? ""),
    documents: Number(documents ?? 0),
    embeddings: Number(embeddings ?? 0),
    activeSegments: Number(activeSegments ?? 0),
    purgedAt: run.purgedAt,
  });
}

export class SpeakerSegmentsResource
  implements Resource<SpeakerSegmentsRequest, unknown> {
  code = "speaker-segments";
  description =
    "Versioned speaker segments, manual identity annotations, similarity and diarization run lifecycle";
  schemas = { request: speakerSegmentsRequestSchema, response: z.any() };

  extractActions(input: SpeakerSegmentsRequest) {
    return [{ path: ["speaker-segments"], actions: [input.action] }];
  }

  async use(rawInput: SpeakerSegmentsRequest, auth: Auth): Promise<unknown> {
    const input = speakerSegmentsRequestSchema.parse(rawInput);
    const mongo = await getMongoResource(auth);

    switch (input.action) {
      case "profile-archive-preview":
        return await redlock.using(
          ["mycelia:lock:speaker-profile-lifecycle"],
          30_000,
          async (signal) => {
            assertActivationLock(signal, "profile archive preview");
            const preview = await computeSpeakerProfileArchivePreview(
              mongo,
              input.profileId,
              input.replacementPrimaryProfileId,
            );
            assertActivationLock(signal, "profile archive preview completion");
            return preview;
          },
        );
      case "archive-profile":
        return await redlock.using(
          ["mycelia:lock:speaker-profile-lifecycle"],
          30_000,
          async (signal) => {
            assertActivationLock(signal, "profile archive validation");
            const preview = await computeSpeakerProfileArchivePreview(
              mongo,
              input.profileId,
              input.replacementPrimaryProfileId,
            );
            assertProfileArchiveSnapshotCurrent(
              {
                snapshotFingerprint: input.snapshotFingerprint,
                confirmation: input.confirmation,
              },
              preview,
              input.confirmation,
            );

            const profileId = new ObjectId(input.profileId);
            const replacementPrimaryProfileId =
              preview.isPrimary && input.replacementPrimaryProfileId
                ? new ObjectId(input.replacementPrimaryProfileId)
                : null;
            let promotedReplacement = false;
            try {
              if (replacementPrimaryProfileId) {
                assertActivationLock(signal, "primary profile replacement");
                const promoted = await mongo({
                  action: "updateOne",
                  collection: "speaker_profiles",
                  query: {
                    _id: replacementPrimaryProfileId,
                    lifecycleStatus: { $ne: "archived" },
                  },
                  update: {
                    $set: { is_primary: true, updated_at: new Date() },
                  },
                }) as any;
                if (Number(promoted?.matchedCount ?? 0) !== 1) {
                  throw new Error(
                    "Replacement primary profile changed; preview archive again",
                  );
                }
                promotedReplacement = true;
              }

              assertActivationLock(signal, "profile archive write");
              const archivedAt = new Date();
              const archived = await mongo({
                action: "updateOne",
                collection: "speaker_profiles",
                query: {
                  _id: profileId,
                  lifecycleStatus: { $ne: "archived" },
                },
                update: buildProfileArchiveUpdate({
                  archivedAt,
                  archivedBy: auth.principal,
                  snapshotFingerprint: preview.snapshotFingerprint,
                }),
              }) as any;
              if (Number(archived?.matchedCount ?? 0) !== 1) {
                throw new Error(
                  "Speaker profile changed before archive; preview archive again",
                );
              }
              assertActivationLock(signal, "profile archive completion");
              return {
                archived: true,
                profileId: input.profileId,
                replacementPrimaryProfileId:
                  input.replacementPrimaryProfileId ?? null,
                retainedReferences: preview.retainedReferences,
                snapshotFingerprint: preview.snapshotFingerprint,
              };
            } catch (error) {
              // If promotion succeeded but archiving did not, restore the old
              // primary invariant. If the archive write did succeed and only
              // the response failed, leave the replacement primary intact.
              if (promotedReplacement && replacementPrimaryProfileId) {
                const archivedProfile = await mongo({
                  action: "findOne",
                  collection: "speaker_profiles",
                  query: { _id: profileId },
                  options: { projection: { lifecycleStatus: 1 } },
                }) as any;
                if (archivedProfile?.lifecycleStatus !== "archived") {
                  await mongo({
                    action: "updateOne",
                    collection: "speaker_profiles",
                    query: { _id: replacementPrimaryProfileId },
                    update: {
                      $set: { is_primary: false, updated_at: new Date() },
                    },
                  });
                }
              }
              throw error;
            }
          },
        );
      case "restore-profile":
        return await redlock.using(
          ["mycelia:lock:speaker-profile-lifecycle"],
          30_000,
          async (signal) => {
            assertActivationLock(signal, "profile restore");
            const restored = await mongo({
              action: "updateOne",
              collection: "speaker_profiles",
              query: {
                _id: new ObjectId(input.profileId),
                lifecycleStatus: "archived",
              },
              update: buildProfileRestoreUpdate({
                restoredAt: new Date(),
                restoredBy: auth.principal,
              }),
            }) as any;
            if (Number(restored?.matchedCount ?? 0) !== 1) {
              throw new Error("Archived speaker profile not found");
            }
            assertActivationLock(signal, "profile restore completion");
            return { restored: true, profileId: input.profileId };
          },
        );
      case "invalidate-profile-identity-evidence": {
        const profile = await mongo({
          action: "findOne",
          collection: "speaker_profiles",
          query: { _id: new ObjectId(input.profileId) },
          options: { projection: { revision: 1 } },
        }) as any;
        if (
          !profile || Number(profile.revision ?? 0) !== input.profileRevision
        ) {
          throw new Error(
            "Voice profile changed before identity evidence invalidation",
          );
        }
        await invalidateCalibrationsForProfiles(
          mongo,
          [input.profileId],
          "voice profile re-enrolled",
          new Date(),
          `profile-reenrollment:${input.profileId}:${input.profileRevision}`,
        );
        return {
          invalidated: true,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        };
      }
      case "create-profile": {
        await assertProfileNameAvailable(mongo, input.name);
        const now = new Date();
        const doc = {
          name: input.name,
          sample_count: 0,
          total_duration: 0,
          is_primary: false,
          color: await nextProfileColor(mongo),
          source: "manual_profile",
          enrollmentStatus: "needs_samples",
          lifecycleStatus: "active",
          revision: 1,
          created_at: now,
          updated_at: now,
          createdBy: auth.principal,
        };
        const result = await mongo({
          action: "insertOne",
          collection: "speaker_profiles",
          doc,
        }) as any;
        return { ...doc, _id: result.insertedId };
      }
      case "create-profile-from-segments": {
        await assertProfileNameAvailable(mongo, input.name);
        const segmentIds = [...new Set(input.segmentIds)].map((id) =>
          new ObjectId(id)
        );
        const segments = await mongo({
          action: "find",
          collection: "diarizations",
          query: { _id: { $in: segmentIds }, lifecycleStatus: "active" },
          options: { limit: segmentIds.length },
        }) as any[];
        if (segments.length !== segmentIds.length) {
          throw new Error(
            "Every selected review segment must still be active and available",
          );
        }
        const embeddingSpaceIds = new Set(
          segments.map((segment) =>
            String(segment.embeddingSpaceId ?? "legacy-unknown")
          ),
        );
        if (embeddingSpaceIds.size !== 1) {
          throw new Error(
            "Selected segments use different embedding spaces and cannot seed one profile",
          );
        }
        const embeddingSpaceId = [...embeddingSpaceIds][0];
        const embedding = centroidEmbedding(
          segments.map((segment) => segment.embedding),
        );
        const duration = segments.reduce((total, segment) => {
          const start = new Date(segment.start).getTime();
          const end = new Date(segment.end).getTime();
          return total +
            (Number.isFinite(start) && Number.isFinite(end)
              ? Math.max(0, (end - start) / 1_000)
              : 0);
        }, 0);
        const now = new Date();
        const doc = {
          name: input.name,
          embedding,
          embeddingSpaceId,
          sample_count: 0,
          total_duration: 0,
          seed_segment_count: segments.length,
          seed_duration: duration,
          is_primary: false,
          color: await nextProfileColor(mongo),
          source: "review_segments",
          enrollmentStatus: "seeded_from_review",
          lifecycleStatus: "active",
          revision: 1,
          enrollmentProvenance: {
            source: "review_segments",
            embeddingSpaceId,
            segmentIds: segments.map((segment) => segment._id),
            segmentCount: segments.length,
            duration,
          },
          created_at: now,
          updated_at: now,
          createdBy: auth.principal,
        };
        const result = await mongo({
          action: "insertOne",
          collection: "speaker_profiles",
          doc,
        }) as any;
        return { ...doc, _id: result.insertedId };
      }
      case "coverage": {
        const [rows, buildingRuns] = await Promise.all([
          mongo({
            action: "aggregate",
            collection: "audio_chunks",
            pipeline: buildDiarizationCoveragePipeline(
              input.start,
              input.end,
              input.bucketMs,
            ),
            options: {
              hint: "audio_chunks_diarization_coverage_v1",
              maxTimeMS: 8_000,
            },
          }),
          mongo({
            action: "find",
            collection: "diarization_runs",
            query: {
              status: "building",
              "range.start": { $lt: input.end },
              "range.end": { $gt: input.start },
            },
            options: { projection: { runId: 1, range: 1, generation: 1 } },
          }),
        ]) as [any[], any[]];
        const buckets = new Map<number, Record<string, number>>();
        for (const row of rows) {
          const time = Number(row._id.bucket);
          const counts = buckets.get(time) ?? {};
          counts[String(row._id.state)] = Number(row.count);
          buckets.set(time, counts);
        }
        return {
          bucketMs: input.bucketMs,
          buckets: [...buckets.entries()].map(([start, counts]) => ({
            start,
            end: start + input.bucketMs,
            counts,
          })),
          buildingRuns,
        };
      }
      case "list": {
        const query: Record<string, unknown> = {
          lifecycleStatus: "active",
          start: { $lt: input.end },
          end: { $gt: input.start },
          ...(input.segmentId ? { _id: new ObjectId(input.segmentId) } : {}),
        };
        const segments = await mongo({
          action: "find",
          collection: "diarizations",
          query,
          options: {
            sort: { start: 1 },
            limit: input.state || input.profileId ? 5000 : input.limit,
            ...(input.view === "timeline"
              ? { projection: TIMELINE_SPEAKER_SEGMENT_PROJECTION }
              : {}),
          },
        }) as any[];
        const activeModelSetSegments =
          await hydrateActiveIdentityModelSetProjections(
            mongo,
            segments,
            input.selectedProfileId,
          );
        await suppressStaleAutomaticIdentities(
          mongo,
          segments.filter((segment) =>
            !activeModelSetSegments.has(String(segment._id))
          ),
        );
        const originalIds = [
          ...new Set(
            segments.map((s) => String(s.original_id ?? s.original)).filter(
              ObjectId.isValid,
            ),
          ),
        ].map((id) => new ObjectId(id));
        const annotations = originalIds.length === 0 ? [] : await mongo({
          action: "find",
          collection: "speaker_annotations",
          query: {
            originalId: { $in: originalIds },
            start: { $lt: input.end },
            end: { $gt: input.start },
          },
          options: { sort: { createdAt: 1 } },
        }) as any[];
        for (const segment of segments) {
          const original = String(segment.original_id ?? segment.original);
          const applicable = annotations.filter((a) =>
            String(a.originalId) === original
          );
          for (const annotation of applicable) {
            const excludedProfileIds = (annotation.excludedProfileIds ?? [])
              .map(String);
            // A negative manual label is evidence only against the profiles it
            // names. In a selected-profile view it must not turn an unrelated
            // profile into a global rejection.
            if (
              input.selectedProfileId && !annotation.profileId &&
              !excludedProfileIds.includes(input.selectedProfileId)
            ) continue;
            const projected = projectAnnotationState({
              segmentStart: new Date(segment.start),
              segmentEnd: new Date(segment.end),
              annotationStart: new Date(annotation.start),
              annotationEnd: new Date(annotation.end),
              profileId: annotation.profileId
                ? String(annotation.profileId)
                : undefined,
              excludedProfileIds,
            });
            if (projected) {
              segment.speakerIdentity = {
                ...applyManualIdentityProjection(
                  segment.speakerIdentity,
                  projected,
                ),
                annotationId: annotation._id,
                validity: "manual",
                excludedProfileIds,
                ...(input.selectedProfileId
                  ? {
                    evaluatedProfileId: input.selectedProfileId,
                    selectedProfileState: projected.state === "matched" &&
                        String(projected.profileId) === input.selectedProfileId
                      ? "identified"
                      : "unknown",
                  }
                  : {}),
              };
            }
          }
        }
        const filtered = segments.filter((segment) =>
          (!input.state || segment.speakerIdentity?.state === input.state) &&
          (!input.profileId ||
            String(segment.speakerIdentity?.profileId ?? "") ===
              input.profileId)
        ).slice(0, input.limit);
        return { segments: filtered, annotations };
      }
      case "annotate": {
        const now = new Date();
        const doc = {
          originalId: new ObjectId(input.originalId),
          segmentId: input.segmentId ? new ObjectId(input.segmentId) : null,
          runId: input.runId ?? null,
          start: input.start,
          end: input.end,
          profileId: input.profileId ? new ObjectId(input.profileId) : null,
          excludedProfileIds: input.excludedProfileIds.map((id) =>
            new ObjectId(id)
          ),
          source: "manual",
          author: auth.principal,
          createdAt: now,
          updatedAt: now,
        };
        const result = await mongo({
          action: "insertOne",
          collection: "speaker_annotations",
          doc,
        });
        await invalidateCalibrationsForProfiles(
          mongo,
          [input.profileId, ...input.excludedProfileIds],
          "manual speaker annotation changed",
          now,
        );
        return { ...doc, _id: (result as any).insertedId };
      }
      case "assign": {
        const source = await mongo({
          action: "findOne",
          collection: "diarizations",
          query: { _id: new ObjectId(input.segmentId) },
        }) as any;
        if (!source) throw new Error("Diarization segment not found");
        const targetQuery = input.scope === "speaker"
          ? {
            lifecycleStatus: "active",
            original_id: source.original_id ?? source.original,
            speaker: source.speaker,
          }
          : { _id: source._id };
        const targets = await mongo({
          action: "find",
          collection: "diarizations",
          query: targetQuery,
          options: { limit: 5000 },
        }) as any[];
        const targetIds = targets.map((target) => target._id);
        const existingAnnotations = targetIds.length === 0 ? [] : await mongo({
          action: "find",
          collection: "speaker_annotations",
          query: { segmentId: { $in: targetIds } },
          options: {
            projection: { profileId: 1, excludedProfileIds: 1 },
            limit: targetIds.length * 5,
          },
        }) as any[];
        await mongo({
          action: "deleteMany",
          collection: "speaker_annotations",
          query: { segmentId: { $in: targetIds } },
        });
        const affectedProfileIds = existingAnnotations.flatMap((annotation) => [
          annotation.profileId,
          ...(annotation.excludedProfileIds ?? []),
        ]);
        if (!input.profileId) {
          await invalidateCalibrationsForProfiles(
            mongo,
            affectedProfileIds,
            "manual speaker assignment changed",
          );
          return { assigned: 0, cleared: targetIds.length };
        }
        const now = new Date();
        const docs = targets.map((target) => ({
          originalId: target.original_id ?? target.original,
          segmentId: target._id,
          runId: target.runId ?? null,
          start: target.start,
          end: target.end,
          profileId: new ObjectId(input.profileId!),
          excludedProfileIds: [],
          source: "manual",
          author: auth.principal,
          createdAt: now,
          updatedAt: now,
        }));
        if (docs.length) {
          await mongo({
            action: "insertMany",
            collection: "speaker_annotations",
            docs,
          });
        }
        await invalidateCalibrationsForProfiles(
          mongo,
          [...affectedProfileIds, input.profileId],
          "manual speaker assignment changed",
          now,
        );
        return { assigned: docs.length, cleared: targetIds.length };
      }
      case "delete-annotation": {
        const annotation = await mongo({
          action: "findOne",
          collection: "speaker_annotations",
          query: { _id: new ObjectId(input.id) },
        }) as any;
        const result = await mongo({
          action: "deleteOne",
          collection: "speaker_annotations",
          query: { _id: new ObjectId(input.id) },
        });
        if (annotation) {
          await invalidateCalibrationsForProfiles(
            mongo,
            [annotation.profileId, ...(annotation.excludedProfileIds ?? [])],
            "manual speaker annotation deleted",
          );
        }
        return result;
      }
      case "preview-review-session": {
        const now = new Date();
        const snapshotStart = input.rangeMode === "all_before"
          ? new Date(0)
          : new Date(input.start!);
        const requestedEnd = input.rangeMode === "all_before"
          ? now
          : new Date(input.end!);
        const snapshotEnd = requestedEnd > now ? now : requestedEnd;
        if (!(snapshotStart < snapshotEnd)) {
          throw new Error("Review range must end after it starts");
        }
        const resolvedContext = await resolveReviewCandidateContext(
          mongo,
          input.targetProfileIds[0],
          input.embeddingSpaceIds,
          {
            sourceMode: input.sourceMode,
            runIds: input.runIds,
            candidateMode: input.candidateMode,
          },
        );
        const embeddingSpaceIds = resolvedContext.embeddingSpaceIds;
        const scope = {
          embeddingSpaceIds,
          runIds: input.runIds,
          recordingIds: input.recordingIds,
        };
        const candidateScan = await findReviewCandidates(
          mongo,
          snapshotStart,
          snapshotEnd,
          5_000,
          input.candidateMode,
          input.targetProfileIds[0],
          null,
          scope,
          resolvedContext.automaticIdentity,
        );
        const prepared = prepareReviewCandidates(
          candidateScan.candidates,
          input.quality,
        );
        const { selected: sampleSegments } = stratifyReviewCandidates(
          prepared.candidates,
          input.previewLimit,
        );
        const recordingMap = new Map<string, {
          id: string;
          eligibleSegments: number;
          start: Date;
          end: Date;
        }>();
        for (const segment of prepared.candidates) {
          const id = String(segment.original_id ?? segment.original ?? "");
          if (!ObjectId.isValid(id)) continue;
          const segmentStart = new Date(segment.start);
          const segmentEnd = new Date(segment.end);
          const current = recordingMap.get(id);
          recordingMap.set(
            id,
            current
              ? {
                ...current,
                eligibleSegments: current.eligibleSegments + 1,
                start: segmentStart < current.start
                  ? segmentStart
                  : current.start,
                end: segmentEnd > current.end ? segmentEnd : current.end,
              }
              : {
                id,
                eligibleSegments: 1,
                start: segmentStart,
                end: segmentEnd,
              },
          );
        }
        const recordingIds = [...recordingMap.keys()];
        const sourceFiles = recordingIds.length === 0 ? [] : await mongo({
          action: "find",
          collection: "source_files",
          query: {
            _id: {
              $in: recordingIds.map((id) => new ObjectId(id)),
            },
          },
          options: {
            projection: {
              path: 1,
              filename: 1,
              name: 1,
              start: 1,
              updatedAt: 1,
            },
            limit: recordingIds.length,
            maxTimeMS: 10_000,
          },
        }) as any[];
        const sourceById = new Map(
          sourceFiles.map((source) => [String(source._id), source]),
        );
        const recordings = [...recordingMap.values()].map((recording) => {
          const source = sourceById.get(recording.id);
          return {
            ...recording,
            name: source?.name ?? source?.filename ?? source?.path ?? null,
            path: source?.path ?? null,
          };
        }).sort((a, b) =>
          b.eligibleSegments - a.eligibleSegments ||
          a.start.getTime() - b.start.getTime()
        );
        return {
          sourceMode: input.sourceMode,
          range: { start: snapshotStart, end: snapshotEnd },
          embeddingSpaceIds,
          runIds: input.runIds,
          recordingIds: input.recordingIds,
          scope: {
            sourceMode: input.sourceMode,
            targetProfileIds: input.targetProfileIds,
            embeddingSpaceIds,
            runIds: input.runIds,
            recordingIds: input.recordingIds,
            rangeMode: "fixed",
            candidateMode: input.candidateMode,
            quality: input.quality,
            start: snapshotStart,
            end: snapshotEnd,
          },
          counts: {
            eligibleSegments: prepared.candidates.length,
            recordings: recordings.length,
            scannedSegments: candidateScan.rawScannedCount,
            capped: candidateScan.capped,
          },
          qualityStats: prepared.stats,
          recordings,
          sampleSegments,
        };
      }
      case "create-review-session": {
        const now = new Date();
        const snapshotStart = input.rangeMode === "all_before"
          ? new Date(0)
          : new Date(input.start!);
        const requestedEnd = input.rangeMode === "all_before"
          ? now
          : new Date(input.end!);
        const snapshotEnd = requestedEnd > now ? now : requestedEnd;
        if (!(snapshotStart < snapshotEnd)) {
          throw new Error("Review range must end after it starts");
        }
        const resolvedContext = await resolveReviewCandidateContext(
          mongo,
          input.targetProfileIds[0],
          input.embeddingSpaceIds,
          {
            sourceMode: input.sourceMode,
            runIds: input.runIds,
            candidateMode: input.candidateMode,
          },
        );
        const embeddingSpaceIds = resolvedContext.embeddingSpaceIds;
        const candidateScan = await findReviewCandidates(
          mongo,
          snapshotStart,
          snapshotEnd,
          5_000,
          input.candidateMode,
          input.targetProfileIds[0],
          null,
          {
            embeddingSpaceIds,
            runIds: input.runIds,
            recordingIds: input.recordingIds,
          },
          resolvedContext.automaticIdentity,
        );
        const prepared = prepareReviewCandidates(
          candidateScan.candidates,
          input.quality,
        );
        const { selected: candidates, remaining } = stratifyReviewCandidates(
          prepared.candidates,
          input.limit,
        );
        const groups = groupReviewSegments(candidates);
        const groupBySegment = new Map(
          groups.flatMap((group) =>
            group.segmentIds.map((segmentId) => [segmentId, group.groupId])
          ),
        );
        const sessionId = new ObjectId();
        const doc = {
          _id: sessionId,
          owner: auth.principal,
          name: input.name ??
            `Review ${snapshotEnd.toISOString().slice(0, 10)}`,
          status: "active",
          targetProfileIds: input.targetProfileIds.map((id) =>
            new ObjectId(id)
          ),
          embeddingSpaceIds,
          runIds: input.runIds,
          recordingIds: input.recordingIds.map((id) => new ObjectId(id)),
          querySnapshot: {
            sourceMode: input.sourceMode,
            identityState: input.candidateMode,
            candidateMode: input.candidateMode,
            rangeMode: input.rangeMode,
            start: snapshotStart,
            end: snapshotEnd,
            snapshotEnd,
            sort: { start: 1, _id: 1 },
            quality: input.quality,
            embeddingSpaceIds,
            runIds: input.runIds,
            recordingIds: input.recordingIds.map((id) => new ObjectId(id)),
            automaticIdentity: resolvedContext.automaticIdentity,
          },
          window: candidates.map((segment) => ({
            segmentId: segment._id,
            groupId: groupBySegment.get(String(segment._id)),
            status: "pending",
            ...(segment.reviewQuality
              ? { quality: segment.reviewQuality }
              : {}),
          })),
          candidateBufferIds: remaining.map((segment) => segment._id),
          groups,
          windowNumber: 1,
          windowSize: input.limit,
          loadedCount: candidates.length,
          sessionLoadedCount: candidates.length,
          reviewedCount: 0,
          skippedCount: 0,
          windowReviewedCount: 0,
          windowSkippedCount: 0,
          backlogEstimate: prepared.candidates.length,
          backlogEstimateCapped: candidateScan.capped,
          qualityStats: prepared.stats,
          hasMore: remaining.length > 0 || candidateScan.capped,
          hasMoreBeyondCursor: candidateScan.capped,
          nextCursor: candidateScan.nextCursor,
          activeSegmentId: candidates[0]?._id ?? null,
          grouping: {
            version: "nearby-speaker-v1",
            maxGapSeconds: 2,
            maxDurationSeconds: 30,
            maxSegments: 20,
          },
          preferences: input.preferences,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          lastOpenedAt: now,
        };
        await mongo({
          action: "insertOne",
          collection: "speaker_review_sessions",
          doc,
        });
        const { candidateBufferIds: _candidateBufferIds, ...publicDoc } = doc;
        return { ...publicDoc, segments: candidates };
      }
      case "list-review-sessions":
        return await mongo({
          action: "find",
          collection: "speaker_review_sessions",
          query: {
            owner: auth.principal,
            status: { $ne: "abandoned" },
            ...(input.profileId
              ? { targetProfileIds: new ObjectId(input.profileId) }
              : {}),
          },
          options: {
            sort: { lastOpenedAt: -1, updatedAt: -1 },
            limit: input.limit,
            projection: { window: 0, groups: 0, candidateBufferIds: 0 },
          },
        });
      case "list-review-history":
        return await loadReviewHistory(
          mongo,
          auth.principal,
          input.profileId,
          input.limit,
        );
      case "revise-review-history": {
        const segmentId = new ObjectId(input.segmentId);
        const revisionScope = buildReviewHistoryRevisionScope({
          segmentId,
          profileId: new ObjectId(input.profileId),
          decisionId: new ObjectId(input.replacesDecisionId),
          author: auth.principal,
        });
        const current = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: revisionScope.currentDecision,
          options: { sort: { updatedAt: -1, createdAt: -1 } },
        }) as any;
        if (!current || String(current._id) !== input.replacesDecisionId) {
          throw new Error(
            "This history item changed elsewhere; refresh before editing",
          );
        }
        const existing = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: {
            author: auth.principal,
            clientRequestId: input.clientRequestId,
          },
        }) as any;
        if (existing?.status === "committed") {
          return await loadReviewHistory(
            mongo,
            auth.principal,
            input.profileId,
            100,
          );
        }
        const segment = await mongo({
          action: "findOne",
          collection: "diarizations",
          query: { _id: segmentId, lifecycleStatus: "active" },
          options: { projection: { embedding: 0 } },
        }) as any;
        if (!segment) {
          throw new Error("The diarization segment is no longer active");
        }
        const now = new Date();
        const decisionId = existing?._id ?? new ObjectId();
        const targetProfileIds = (current.targetProfileIds ?? []).length > 0
          ? current.targetProfileIds
          : [new ObjectId(input.profileId)];
        const assignedProfileId = input.outcome === "assigned" &&
            input.assignedProfileId
          ? new ObjectId(input.assignedProfileId)
          : null;
        const excludedProfileIds = input.outcome === "assigned"
          ? input.excludedProfileIds.map((id) => new ObjectId(id))
          : [];
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: {
            author: auth.principal,
            clientRequestId: input.clientRequestId,
          },
          update: {
            $setOnInsert: {
              _id: decisionId,
              sessionId: current.sessionId ?? null,
              clientRequestId: input.clientRequestId,
              author: auth.principal,
              segmentIds: [segmentId],
              targetProfileIds,
              outcome: input.outcome,
              profileId: assignedProfileId,
              excludedProfileIds,
              calibrationUse: input.calibrationUse,
              skipReason: input.outcome === "skipped"
                ? input.skipReason ?? "noise_or_unclear"
                : null,
              supersedesDecisionId: current._id,
              source: "review_history_revision",
              status: "building",
              createdAt: now,
            },
            $set: { updatedAt: now },
          },
          options: { upsert: true },
        });
        await mongo({
          action: "deleteMany",
          collection: "speaker_annotations",
          query: revisionScope.replacedAnnotation,
        });
        if (input.outcome === "assigned") {
          await mongo({
            action: "insertOne",
            collection: "speaker_annotations",
            doc: {
              decisionId,
              sessionId: current.sessionId ?? null,
              originalId: segment.original_id ?? segment.original,
              segmentId,
              runId: segment.runId ?? null,
              start: segment.start,
              end: segment.end,
              profileId: assignedProfileId,
              excludedProfileIds,
              calibrationUse: input.calibrationUse,
              source: "manual",
              author: auth.principal,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        if (
          (current.calibrationUse ?? "eligible") === "eligible" ||
          input.calibrationUse === "eligible"
        ) {
          await invalidateCalibrationsForProfiles(
            mongo,
            [
              ...(current.targetProfileIds ?? []),
              current.profileId,
              ...(current.excludedProfileIds ?? []),
              ...targetProfileIds,
              assignedProfileId,
              ...excludedProfileIds,
            ],
            "review label revised",
            now,
          );
        }
        const affectedSessions = await mongo({
          action: "find",
          collection: "speaker_review_sessions",
          query: { owner: auth.principal, "window.segmentId": segmentId },
          options: { limit: 50 },
        }) as any[];
        for (const session of affectedSessions) {
          const previousWindow = session.window ?? [];
          const previous = previousWindow.find((item: any) =>
            String(item.segmentId) === input.segmentId
          );
          if (!previous) continue;
          const nextStatus = input.outcome === "skipped"
            ? "skipped"
            : "reviewed";
          const window = previousWindow.map((item: any) =>
            String(item.segmentId) === input.segmentId
              ? { ...item, status: nextStatus, decisionId }
              : item
          );
          const reviewedDelta = (nextStatus === "reviewed" ? 1 : 0) -
            (previous.status === "reviewed" ? 1 : 0);
          const skippedDelta = (nextStatus === "skipped" ? 1 : 0) -
            (previous.status === "skipped" ? 1 : 0);
          await mongo({
            action: "updateOne",
            collection: "speaker_review_sessions",
            query: { _id: session._id },
            update: {
              $set: {
                window,
                reviewedCount: Math.max(
                  0,
                  Number(session.reviewedCount ?? 0) + reviewedDelta,
                ),
                skippedCount: Math.max(
                  0,
                  Number(session.skippedCount ?? 0) + skippedDelta,
                ),
                windowReviewedCount: window.filter((item: any) =>
                  item.status === "reviewed"
                )
                  .length,
                windowSkippedCount: window.filter((item: any) =>
                  item.status === "skipped"
                )
                  .length,
                updatedAt: now,
              },
              $inc: { revision: 1 },
            },
          });
        }
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { _id: decisionId, status: "building" },
          update: {
            $set: {
              status: "committed",
              annotationCount: input.outcome === "assigned" ? 1 : 0,
              committedAt: new Date(),
              updatedAt: new Date(),
            },
          },
        });
        return await loadReviewHistory(
          mongo,
          auth.principal,
          input.profileId,
          100,
        );
      }
      case "get-review-session": {
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: new ObjectId(input.sessionId), owner: auth.principal },
        }) as any;
        if (!session) throw new Error("Review session not found");
        return await hydrateReviewSession(mongo, session);
      }
      case "load-next-review-window": {
        const sessionId = new ObjectId(input.sessionId);
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: sessionId,
            owner: auth.principal,
            status: "active",
            revision: input.revision,
          },
        }) as any;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        if (
          (session.window ?? []).some((item: any) => item.status === "pending")
        ) {
          throw new Error("Review or skip every item in this window first");
        }
        const snapshot = session.querySnapshot;
        const targetProfileId = String(session.targetProfileIds?.[0] ?? "");
        const candidateMode = snapshot.candidateMode ?? "reviewable";
        const scope = {
          embeddingSpaceIds: snapshot.embeddingSpaceIds ??
            session.embeddingSpaceIds ?? [],
          runIds: snapshot.runIds ?? session.runIds ?? [],
          recordingIds: (
            snapshot.recordingIds ?? session.recordingIds ?? []
          ).map(String),
        };
        const sourceMode = snapshot.sourceMode ??
          (scope.runIds.length > 0
            ? "diarization_generation"
            : scope.recordingIds.length > 0
            ? "selected_recordings"
            : "all_matching");
        const resolvedContext = await resolveReviewCandidateContext(
          mongo,
          targetProfileId,
          scope.embeddingSpaceIds.map(String),
          {
            sourceMode,
            runIds: scope.runIds.map(String),
            candidateMode,
          },
        );
        scope.embeddingSpaceIds = resolvedContext.embeddingSpaceIds;
        const frozenAutomaticIdentity = snapshot.automaticIdentity as
          | ReviewAutomaticIdentityContext
          | null
          | undefined;
        if (
          frozenAutomaticIdentity &&
          JSON.stringify(frozenAutomaticIdentity) !==
            JSON.stringify(resolvedContext.automaticIdentity)
        ) {
          throw new Error(
            "This automatic-match review session is stale; create a new session",
          );
        }
        const buffered = await loadBufferedReviewCandidates(
          mongo,
          session.candidateBufferIds ?? [],
          targetProfileId,
          scope,
          candidateMode,
          resolvedContext.automaticIdentity,
        );
        const fetchedScan = buffered.length === 0 &&
            Boolean(session.hasMoreBeyondCursor ?? session.hasMore)
          ? await findReviewCandidates(
            mongo,
            new Date(snapshot.start),
            new Date(snapshot.snapshotEnd ?? snapshot.end),
            5_000,
            candidateMode,
            targetProfileId,
            session.nextCursor,
            scope,
            resolvedContext.automaticIdentity,
          )
          : null;
        const prepared = buffered.length > 0
          ? {
            candidates: buffered,
            stats: {
              input: 0,
              accepted: 0,
              shortExcluded: 0,
              duplicateExcluded: 0,
            },
          }
          : prepareReviewCandidates(
            fetchedScan?.candidates ?? [],
            snapshot.quality ?? {
              minDurationSeconds: 0,
              deduplicateOverlaps: false,
            },
          );
        const candidatePool = prepared.candidates;
        const { selected: candidates, remaining } = stratifyReviewCandidates(
          candidatePool,
          Number(session.windowSize ?? 100),
        );
        const groups = groupReviewSegments(candidates, session.grouping);
        const groupBySegment = new Map(
          groups.flatMap((group) =>
            group.segmentIds.map((segmentId) => [segmentId, group.groupId])
          ),
        );
        const window = candidates.map((segment) => ({
          segmentId: segment._id,
          groupId: groupBySegment.get(String(segment._id)),
          status: "pending",
          ...(segment.reviewQuality ? { quality: segment.reviewQuality } : {}),
        }));
        const hasMoreBeyondCursor = buffered.length > 0
          ? Boolean(session.hasMoreBeyondCursor ?? session.hasMore)
          : Boolean(fetchedScan?.capped);
        const completed = candidates.length === 0 && !hasMoreBeyondCursor;
        const result = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId, revision: input.revision },
          update: {
            $set: {
              window,
              groups,
              candidateBufferIds: remaining.map((segment) => segment._id),
              activeSegmentId: candidates[0]?._id ?? null,
              loadedCount: candidates.length,
              sessionLoadedCount:
                Number(session.sessionLoadedCount ?? session.loadedCount ?? 0) +
                candidates.length,
              windowReviewedCount: 0,
              windowSkippedCount: 0,
              qualityStats: {
                input: Number(session.qualityStats?.input ?? 0) +
                  prepared.stats.input,
                accepted: Number(session.qualityStats?.accepted ?? 0) +
                  prepared.stats.accepted,
                shortExcluded:
                  Number(session.qualityStats?.shortExcluded ?? 0) +
                  prepared.stats.shortExcluded,
                duplicateExcluded:
                  Number(session.qualityStats?.duplicateExcluded ?? 0) +
                  prepared.stats.duplicateExcluded,
              },
              hasMore: remaining.length > 0 || hasMoreBeyondCursor,
              hasMoreBeyondCursor,
              nextCursor: fetchedScan?.nextCursor ?? session.nextCursor,
              status: completed ? "completed" : "active",
              ...(completed ? { completedAt: new Date() } : {}),
              updatedAt: new Date(),
              lastOpenedAt: new Date(),
            },
            $inc: { revision: 1, windowNumber: 1 },
          },
        }) as any;
        if (result.matchedCount !== 1) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const updated = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId },
        }) as any;
        return await hydrateReviewSession(mongo, updated);
      }
      case "update-review-position": {
        const sessionId = new ObjectId(input.sessionId);
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: sessionId,
            owner: auth.principal,
            status: "active",
            revision: input.revision,
          },
        }) as any;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const window = [...(session.window ?? [])];
        let skippedDelta = 0;
        if (input.skipSegmentId) {
          const item = window.find((entry: any) =>
            String(entry.segmentId) === input.skipSegmentId
          );
          if (!item) {
            throw new Error("Skipped segment is not in this review window");
          }
          if (item.status === "reviewed") {
            throw new Error(
              "Undo the saved decision before skipping this segment",
            );
          }
          if (item.status !== "skipped") skippedDelta = 1;
          item.status = "skipped";
        }
        const validActive = input.activeSegmentId == null || window.some(
          (item: any) => String(item.segmentId) === input.activeSegmentId,
        );
        if (!validActive) {
          throw new Error("Active segment is not in this review window");
        }
        const preferences = {
          ...(session.preferences ?? {}),
          ...(input.preferences ?? {}),
        };
        const windowSkippedCount =
          window.filter((item: any) => item.status === "skipped").length;
        const skippedCount = Number(session.skippedCount ?? 0) + skippedDelta;
        const result = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId, revision: input.revision },
          update: {
            $set: {
              window,
              preferences,
              skippedCount,
              windowSkippedCount,
              ...(input.activeSegmentId !== undefined
                ? {
                  activeSegmentId: input.activeSegmentId
                    ? new ObjectId(input.activeSegmentId)
                    : null,
                }
                : {}),
              updatedAt: new Date(),
              lastOpenedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (result.matchedCount !== 1) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const updated = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId },
        }) as any;
        return await hydrateReviewSession(mongo, updated);
      }
      case "commit-review-decision": {
        const sessionId = new ObjectId(input.sessionId);
        const existing = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
        }) as any;
        if (existing?.status === "committed") {
          const session = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal },
          }) as any;
          return {
            decision: existing,
            session: await hydrateReviewSession(mongo, session),
          };
        }
        if (existing?.status === "building") {
          const recoverySession = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal, status: "active" },
          }) as any;
          const claimed = (existing.segmentIds ?? []).every(
            (segmentId: unknown) =>
              (recoverySession?.window ?? []).some((item: any) =>
                String(item.segmentId) === String(segmentId) &&
                String(item.decisionId) === String(existing._id)
              ),
          );
          if (claimed) {
            const recoverySegments = await mongo({
              action: "find",
              collection: "diarizations",
              query: {
                _id: { $in: existing.segmentIds ?? [] },
                lifecycleStatus: "active",
              },
              options: {
                projection: { embedding: 0 },
                limit: (existing.segmentIds ?? []).length,
              },
            }) as any[];
            await commitReviewDecisionArtifacts(
              mongo,
              existing,
              recoverySegments,
            );
            return {
              decision: { ...existing, status: "committed" },
              session: await hydrateReviewSession(mongo, recoverySession),
            };
          }
        }
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: sessionId,
            owner: auth.principal,
            status: { $in: ["active", "completed"] },
            revision: input.revision,
          },
        }) as any;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const segmentIds = [...new Set(input.segmentIds)];
        const allowed = new Set(
          (session.window ?? []).map((item: any) => String(item.segmentId)),
        );
        if (segmentIds.some((id) => !allowed.has(id))) {
          throw new Error(
            "Every selected segment must belong to this review window",
          );
        }
        if (
          session.status === "completed" &&
          (session.window ?? []).some((item: any) =>
            segmentIds.includes(String(item.segmentId)) &&
            item.status === "pending"
          )
        ) {
          throw new Error(
            "Completed sessions only allow corrections to saved answers",
          );
        }
        const objectIds = segmentIds.map((id) => new ObjectId(id));
        const segments = await mongo({
          action: "find",
          collection: "diarizations",
          query: { _id: { $in: objectIds }, lifecycleStatus: "active" },
          options: { projection: { embedding: 0 }, limit: objectIds.length },
        }) as any[];
        if (segments.length !== objectIds.length) {
          throw new Error("One or more selected segments are no longer active");
        }
        const now = new Date();
        const decisionId = existing?._id ?? new ObjectId();
        const decision = {
          _id: decisionId,
          sessionId,
          clientRequestId: input.clientRequestId,
          author: auth.principal,
          segmentIds: objectIds,
          targetProfileIds: session.targetProfileIds ?? [],
          originalGroups: session.groups,
          outcome: "assigned",
          profileId: input.profileId ? new ObjectId(input.profileId) : null,
          excludedProfileIds: input.excludedProfileIds.map((id) =>
            new ObjectId(id)
          ),
          calibrationUse: input.calibrationUse,
          source: segmentIds.length > 1 ? "review_batch" : "review_single",
          status: "building",
          createdAt: now,
        };
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
          update: {
            $setOnInsert: decision,
            $set: { updatedAt: now },
          },
          options: { upsert: true },
        });
        await commitReviewDecisionArtifacts(mongo, decision, segments);
        const selected = new Set(segmentIds);
        const selectedItems = (session.window ?? []).filter((item: any) =>
          selected.has(String(item.segmentId))
        );
        const reviewedDelta =
          selectedItems.filter((item: any) => item.status !== "reviewed")
            .length;
        const skippedToReviewed =
          selectedItems.filter((item: any) => item.status === "skipped").length;
        const window = (session.window ?? []).map((item: any) =>
          selected.has(String(item.segmentId))
            ? { ...item, status: "reviewed", decisionId }
            : item
        );
        const windowReviewedCount =
          window.filter((item: any) => item.status === "reviewed").length;
        const windowSkippedCount =
          window.filter((item: any) => item.status === "skipped").length;
        const reviewedCount = Number(session.reviewedCount ?? 0) +
          reviewedDelta;
        const skippedCount = Math.max(
          0,
          Number(session.skippedCount ?? 0) - skippedToReviewed,
        );
        const activeSegmentId = nextPendingSegmentId(window, segmentIds.at(-1));
        const updated = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId, revision: input.revision },
          update: {
            $set: {
              window,
              reviewedCount,
              skippedCount,
              windowReviewedCount,
              windowSkippedCount,
              activeSegmentId: activeSegmentId
                ? new ObjectId(activeSegmentId)
                : null,
              updatedAt: new Date(),
              lastOpenedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (updated.matchedCount !== 1) {
          throw new Error(
            "Decision was saved; reload the session to refresh its position",
          );
        }
        const latestSession = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId },
        }) as any;
        return {
          decision: {
            _id: decisionId,
            status: "committed",
            segmentIds: objectIds,
          },
          session: await hydrateReviewSession(mongo, latestSession),
        };
      }
      case "commit-review-skip": {
        const sessionId = new ObjectId(input.sessionId);
        const existing = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
        }) as any;
        if (existing?.status === "committed") {
          const current = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal },
          }) as any;
          return {
            decision: existing,
            session: await hydrateReviewSession(mongo, current),
          };
        }
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: sessionId,
            owner: auth.principal,
            status: { $in: ["active", "completed"] },
            revision: input.revision,
          },
        }) as any;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const segmentIds = [...new Set(input.segmentIds)];
        const selected = new Set(segmentIds);
        const selectedItems = (session.window ?? []).filter((item: any) =>
          selected.has(String(item.segmentId))
        );
        if (selectedItems.length !== segmentIds.length) {
          throw new Error(
            "Every skipped segment must belong to this review window",
          );
        }
        if (
          selectedItems.some((item: any) => item.status === "reviewed") &&
          (!input.replacesDecisionId ||
            selectedItems.some((item: any) =>
              String(item.decisionId ?? "") !== input.replacesDecisionId
            ))
        ) {
          throw new Error(
            "The reviewed answer changed; reopen Edit before skipping it",
          );
        }
        const objectIds = segmentIds.map((id) => new ObjectId(id));
        const now = new Date();
        const decisionId = existing?._id ?? new ObjectId();
        const supersededDecision = input.replacesDecisionId
          ? await mongo({
            action: "findOne",
            collection: "speaker_review_decisions",
            query: {
              _id: new ObjectId(input.replacesDecisionId),
              sessionId,
              status: "committed",
            },
          }) as any
          : null;
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
          update: {
            $setOnInsert: {
              _id: decisionId,
              sessionId,
              clientRequestId: input.clientRequestId,
              author: auth.principal,
              segmentIds: objectIds,
              targetProfileIds: session.targetProfileIds ?? [],
              outcome: "skipped",
              profileId: null,
              excludedProfileIds: [],
              skipReason: input.skipReason,
              ...(input.replacesDecisionId
                ? {
                  supersedesDecisionId: new ObjectId(
                    input.replacesDecisionId,
                  ),
                }
                : {}),
              source: segmentIds.length > 1
                ? "review_batch_skip"
                : "review_single_skip",
              status: "building",
              createdAt: now,
            },
            $set: { updatedAt: now },
          },
          options: { upsert: true },
        });
        const window = (session.window ?? []).map((item: any) =>
          selected.has(String(item.segmentId))
            ? { ...item, status: "skipped", decisionId }
            : item
        );
        const reviewedRemoved =
          selectedItems.filter((item: any) => item.status === "reviewed")
            .length;
        const skippedAdded =
          selectedItems.filter((item: any) => item.status !== "skipped").length;
        const activeSegmentId = selected.has(String(session.activeSegmentId))
          ? nextPendingSegmentId(window, segmentIds.at(-1))
          : String(session.activeSegmentId ?? "") || null;
        const updated = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId, revision: input.revision },
          update: {
            $set: {
              window,
              reviewedCount: Math.max(
                0,
                Number(session.reviewedCount ?? 0) - reviewedRemoved,
              ),
              skippedCount: Number(session.skippedCount ?? 0) + skippedAdded,
              windowReviewedCount: window.filter((item: any) =>
                item.status === "reviewed"
              ).length,
              windowSkippedCount:
                window.filter((item: any) => item.status === "skipped").length,
              activeSegmentId: activeSegmentId
                ? new ObjectId(activeSegmentId)
                : null,
              updatedAt: now,
              lastOpenedAt: now,
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (updated.matchedCount !== 1) {
          await mongo({
            action: "updateOne",
            collection: "speaker_review_decisions",
            query: { _id: decisionId, status: "building" },
            update: { $set: { status: "conflicted", updatedAt: new Date() } },
          });
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        await mongo({
          action: "deleteMany",
          collection: "speaker_annotations",
          query: { segmentId: { $in: objectIds }, source: "manual" },
        });
        const removedEligibleProfileIds = eligibleReviewDecisionProfileIds(
          supersededDecision,
        );
        if (reviewedRemoved > 0 && removedEligibleProfileIds.length > 0) {
          await invalidateCalibrationsForProfiles(
            mongo,
            removedEligibleProfileIds,
            "review label changed to noise or unclear",
            now,
          );
        }
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { _id: decisionId, status: "building" },
          update: {
            $set: {
              status: "committed",
              annotationCount: 0,
              committedAt: new Date(),
              updatedAt: new Date(),
            },
          },
        });
        const latestSession = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId },
        }) as any;
        return {
          decision: { _id: decisionId, status: "committed", segmentIds },
          session: await hydrateReviewSession(mongo, latestSession),
        };
      }
      case "revise-review-decision": {
        const sessionId = new ObjectId(input.sessionId);
        const existing = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
        }) as any;
        if (existing?.status === "committed") {
          const session = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal },
          }) as any;
          return {
            decision: existing,
            session: await hydrateReviewSession(mongo, session),
          };
        }
        if (existing?.status === "building") {
          const recoverySession = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal, status: "active" },
          }) as any;
          const claimed = (existing.segmentIds ?? []).every(
            (segmentId: unknown) =>
              (recoverySession?.window ?? []).some((item: any) =>
                String(item.segmentId) === String(segmentId) &&
                String(item.decisionId) === String(existing._id)
              ),
          );
          if (claimed) {
            const recoverySegments = await mongo({
              action: "find",
              collection: "diarizations",
              query: {
                _id: { $in: existing.segmentIds ?? [] },
                lifecycleStatus: "active",
              },
              options: {
                projection: { embedding: 0 },
                limit: (existing.segmentIds ?? []).length,
              },
            }) as any[];
            if (
              recoverySegments.length !== (existing.segmentIds ?? []).length
            ) {
              throw new Error(
                "One or more selected segments are no longer active",
              );
            }
            await commitReviewDecisionArtifacts(
              mongo,
              existing,
              recoverySegments,
            );
            return {
              decision: { ...existing, status: "committed" },
              session: await hydrateReviewSession(mongo, recoverySession),
            };
          }
        }
        const session = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: sessionId,
            owner: auth.principal,
            status: { $in: ["active", "completed"] },
            revision: input.revision,
          },
        }) as any;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const segmentIds = [...new Set(input.segmentIds)];
        const previousWindow = session.window ?? [];
        let decisionId = existing?._id ?? new ObjectId();
        let window = applyReviewDecisionRevision(previousWindow, {
          segmentIds,
          replacesDecisionId: input.replacesDecisionId,
          decisionId,
        });
        const objectIds = segmentIds.map((id) => new ObjectId(id));
        const segments = await mongo({
          action: "find",
          collection: "diarizations",
          query: { _id: { $in: objectIds }, lifecycleStatus: "active" },
          options: { projection: { embedding: 0 }, limit: objectIds.length },
        }) as any[];
        if (segments.length !== objectIds.length) {
          throw new Error("One or more selected segments are no longer active");
        }
        const now = new Date();
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
          update: {
            $setOnInsert: {
              _id: decisionId,
              sessionId,
              clientRequestId: input.clientRequestId,
              author: auth.principal,
              segmentIds: objectIds,
              targetProfileIds: session.targetProfileIds ?? [],
              originalGroups: session.groups,
              outcome: "assigned",
              profileId: input.profileId ? new ObjectId(input.profileId) : null,
              excludedProfileIds: input.excludedProfileIds.map((id) =>
                new ObjectId(id)
              ),
              calibrationUse: input.calibrationUse,
              supersedesDecisionId: new ObjectId(input.replacesDecisionId),
              source: segmentIds.length > 1
                ? "review_batch_revision"
                : "review_single_revision",
              status: "building",
              createdAt: now,
            },
            $set: { updatedAt: now },
          },
          options: { upsert: true },
        });
        const persistedDecision = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: { sessionId, clientRequestId: input.clientRequestId },
        }) as any;
        if (
          !persistedDecision?._id || persistedDecision.status !== "building"
        ) {
          throw new Error("Review decision could not be claimed");
        }
        decisionId = persistedDecision._id;
        window = applyReviewDecisionRevision(previousWindow, {
          segmentIds,
          replacesDecisionId: input.replacesDecisionId,
          decisionId,
        });
        const updated = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId, revision: input.revision },
          update: {
            $set: {
              window,
              reviewedCount: Number(session.reviewedCount ?? 0) +
                window.filter((item: any) => item.status === "reviewed")
                  .length -
                previousWindow.filter((item: any) => item.status === "reviewed")
                  .length,
              skippedCount: Number(session.skippedCount ?? 0) +
                window.filter((item: any) => item.status === "skipped").length -
                previousWindow.filter((item: any) => item.status === "skipped")
                  .length,
              windowReviewedCount: window.filter((item: any) =>
                item.status === "reviewed"
              ).length,
              windowSkippedCount:
                window.filter((item: any) => item.status === "skipped").length,
              updatedAt: new Date(),
              lastOpenedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (updated.matchedCount !== 1) {
          const latest = await mongo({
            action: "findOne",
            collection: "speaker_review_sessions",
            query: { _id: sessionId, owner: auth.principal },
          }) as any;
          const claimed = segmentIds.every((segmentId) =>
            (latest?.window ?? []).some((item: any) =>
              String(item.segmentId) === segmentId &&
              String(item.decisionId) === String(decisionId)
            )
          );
          if (!claimed) {
            await mongo({
              action: "updateOne",
              collection: "speaker_review_decisions",
              query: { _id: decisionId, status: "building" },
              update: { $set: { status: "conflicted", updatedAt: new Date() } },
            });
            throw new Error(
              "Review session changed elsewhere; reload to continue",
            );
          }
        }
        await mongo({
          action: "deleteMany",
          collection: "speaker_annotations",
          query: { segmentId: { $in: objectIds }, source: "manual" },
        });
        await commitReviewDecisionArtifacts(mongo, persistedDecision, segments);
        const latestSession = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: sessionId },
        }) as any;
        return {
          decision: {
            _id: decisionId,
            status: "committed",
            segmentIds: objectIds,
            supersedesDecisionId: new ObjectId(input.replacesDecisionId),
          },
          session: await hydrateReviewSession(mongo, latestSession),
        };
      }
      case "undo-review-decision": {
        const decisionId = new ObjectId(input.decisionId);
        const decision = await mongo({
          action: "findOne",
          collection: "speaker_review_decisions",
          query: {
            _id: decisionId,
            author: auth.principal,
            status: { $in: ["committed", "rolling_back"] },
          },
        }) as any;
        if (!decision) throw new Error("Review decision cannot be undone");
        if (String(decision.sessionId) !== input.sessionId) {
          throw new Error("Review decision does not belong to this session");
        }
        const currentSession = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: {
            _id: new ObjectId(input.sessionId),
            owner: auth.principal,
            status: "active",
          },
        }) as any;
        if (!currentSession) throw new Error("Review session not found");
        const decisionStillCurrent = (decision.segmentIds ?? []).some(
          (segmentId: unknown) =>
            (currentSession.window ?? []).some((item: any) =>
              String(item.segmentId) === String(segmentId) &&
              String(item.decisionId) === input.decisionId
            ),
        );
        if (!decisionStillCurrent) {
          await mongo({
            action: "deleteMany",
            collection: "speaker_annotations",
            query: { decisionId },
          });
          await mongo({
            action: "updateOne",
            collection: "speaker_review_decisions",
            query: { _id: decisionId, status: { $ne: "rolled_back" } },
            update: {
              $set: {
                status: "rolled_back",
                rolledBackAt: new Date(),
                updatedAt: new Date(),
              },
            },
          });
          if ((decision.calibrationUse ?? "eligible") === "eligible") {
            await invalidateCalibrationsForProfiles(
              mongo,
              [
                ...(decision.targetProfileIds ?? []),
                decision.profileId,
                ...(decision.excludedProfileIds ?? []),
              ],
              "review label undone",
            );
          }
          return await hydrateReviewSession(mongo, currentSession);
        }
        const session = Number(currentSession.revision) === input.revision
          ? currentSession
          : null;
        if (!session) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        const restored = restoreReviewDecision(session.window ?? [], {
          segmentIds: decision.segmentIds ?? [],
          decisionId: input.decisionId,
        });
        const restoredIds = new Set(
          (decision.segmentIds ?? []).map((segmentId: unknown) =>
            String(segmentId)
          ),
        );
        const restoredReviewedCount = (session.window ?? []).filter((
          item: any,
        ) =>
          restoredIds.has(String(item.segmentId)) &&
          String(item.decisionId ?? "") === input.decisionId &&
          item.status === "reviewed"
        ).length;
        const restoredSkippedCount = (session.window ?? []).filter((
          item: any,
        ) =>
          restoredIds.has(String(item.segmentId)) &&
          String(item.decisionId ?? "") === input.decisionId &&
          item.status === "skipped"
        ).length;
        const window = restored.window;
        const windowReviewedCount =
          window.filter((item: any) => item.status === "reviewed").length;
        const windowSkippedCount =
          window.filter((item: any) => item.status === "skipped").length;
        const updated = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: { _id: session._id, revision: input.revision },
          update: {
            $set: {
              window,
              reviewedCount: Math.max(
                0,
                Number(session.reviewedCount ?? 0) -
                  restoredReviewedCount,
              ),
              skippedCount: Math.max(
                0,
                Number(session.skippedCount ?? 0) - restoredSkippedCount,
              ),
              windowReviewedCount,
              windowSkippedCount,
              activeSegmentId: restored.firstRestored,
              updatedAt: new Date(),
              lastOpenedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (updated.matchedCount !== 1) {
          throw new Error(
            "Review session changed elsewhere; reload to continue",
          );
        }
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { _id: decisionId, status: "committed" },
          update: { $set: { status: "rolling_back", updatedAt: new Date() } },
        });
        await mongo({
          action: "deleteMany",
          collection: "speaker_annotations",
          query: { decisionId },
        });
        if ((decision.calibrationUse ?? "eligible") === "eligible") {
          await invalidateCalibrationsForProfiles(
            mongo,
            [
              ...(decision.targetProfileIds ?? []),
              decision.profileId,
              ...(decision.excludedProfileIds ?? []),
            ],
            "review label undone",
          );
        }
        await mongo({
          action: "updateOne",
          collection: "speaker_review_decisions",
          query: { _id: decisionId, status: "rolling_back" },
          update: {
            $set: {
              status: "rolled_back",
              rolledBackAt: new Date(),
              updatedAt: new Date(),
            },
          },
        });
        const latestSession = await mongo({
          action: "findOne",
          collection: "speaker_review_sessions",
          query: { _id: session._id },
        }) as any;
        return await hydrateReviewSession(mongo, latestSession);
      }
      case "complete-review-session": {
        const result = await mongo({
          action: "updateOne",
          collection: "speaker_review_sessions",
          query: {
            _id: new ObjectId(input.sessionId),
            owner: auth.principal,
            status: "active",
          },
          update: {
            $set: {
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            },
            $inc: { revision: 1 },
          },
        }) as any;
        if (result.matchedCount !== 1) {
          throw new Error("Active review session not found");
        }
        return { success: true, sessionId: input.sessionId };
      }
      case "review-queue": {
        const candidates = await mongo({
          action: "find",
          collection: "diarizations",
          query: {
            lifecycleStatus: "active",
            start: { $lt: input.end },
            end: { $gt: input.start },
            ...(input.state === "reviewable"
              ? {
                $or: [
                  { "speakerIdentity.state": "uncertain" },
                  { speakerIdentity: { $exists: false } },
                  { "speakerIdentity.identityState": { $exists: false } },
                ],
              }
              : { "speakerIdentity.state": input.state }),
          },
          options: {
            sort: input.state === "reviewable"
              ? { start: -1 }
              : { "speakerIdentity.primaryScore": 1 },
            limit: Math.min(input.limit * 3, 3000),
            projection: {
              embedding: 0,
            },
          },
        }) as any[];
        const candidateIds = candidates.map((segment) => segment._id);
        const annotations = candidateIds.length === 0 ? [] : await mongo({
          action: "find",
          collection: "speaker_annotations",
          query: { segmentId: { $in: candidateIds } },
          options: { projection: { segmentId: 1 }, limit: candidateIds.length },
        }) as any[];
        const annotated = new Set(
          annotations.map((item) => String(item.segmentId)),
        );
        return candidates.filter((segment) =>
          !annotated.has(String(segment._id))
        )
          .slice(0, input.limit);
      }
      case "similar": {
        const source = await mongo({
          action: "findOne",
          collection: "diarizations",
          query: { _id: new ObjectId(input.segmentId) },
        }) as any;
        if (!source?.embedding) {
          throw new Error("Source segment has no embedding");
        }
        if (!source.embeddingSpaceId) {
          throw new Error("Source segment has no embeddingSpaceId");
        }
        const candidates = await mongo({
          action: "find",
          collection: "diarizations",
          query: {
            lifecycleStatus: "active",
            embeddingSpaceId: source.embeddingSpaceId,
            embedding: { $exists: true },
            _id: { $ne: source._id },
          },
          options: { limit: input.candidateLimit },
        }) as any[];
        return candidates.map((segment) => ({
          segment,
          score: cosineSimilarity(source.embedding, segment.embedding),
        })).sort((a, b) => b.score - a.score).slice(0, input.topN);
      }
      case "list-calibrations":
        return await mongo({
          action: "find",
          collection: "speaker_calibrations",
          query: input.profileId ? { profileId: input.profileId } : {},
          options: { sort: { createdAt: -1 } },
        });
      case "calibration-preview":
        return await computeCalibrationPreview(
          mongo,
          input.profileId,
          input.calibrationRecordingIds,
          input.validationRecordingIds,
          input.targetPrecision,
          input.positiveThresholdOverride,
        );
      case "identity-status": {
        const profileId = new ObjectId(input.profileId);
        const [
          profile,
          annotations,
          calibrations,
          latestJobs,
          latestCampaigns,
          savedSamples,
        ] = await Promise.all([
          mongo({
            action: "findOne",
            collection: "speaker_profiles",
            query: { _id: profileId },
            options: {
              projection: {
                name: 1,
                is_primary: 1,
                revision: 1,
                embeddingSpaceId: 1,
                sample_count: 1,
                total_duration: 1,
                enrollmentStatus: 1,
                enrollmentProvenance: 1,
                embedding: 1,
                activeCalibrationIds: 1,
                activeCalibrationId: 1,
                calibrationHeadsInitialized: 1,
                calibrationEvidenceRevision: 1,
              },
            },
          }),
          mongo({
            action: "find",
            collection: "speaker_annotations",
            query: {
              $or: [
                { profileId },
                { excludedProfileIds: profileId },
              ],
            },
            options: {
              projection: {
                segmentId: 1,
                originalId: 1,
                profileId: 1,
                excludedProfileIds: 1,
                calibrationUse: 1,
                createdAt: 1,
                updatedAt: 1,
              },
              sort: { updatedAt: -1, createdAt: -1 },
              limit: 10_000,
            },
          }),
          mongo({
            action: "find",
            collection: "speaker_calibrations",
            query: { profileId: input.profileId },
            options: { sort: { createdAt: -1 }, limit: 10 },
          }),
          mongo({
            action: "find",
            collection: "jobs",
            query: {
              type: "speakerIdentity",
              $or: [
                { "data.profileId": input.profileId },
                { "data.profileSnapshots.profileId": input.profileId },
              ],
            },
            options: {
              sort: { updatedAt: -1, createdAt: -1 },
              projection: {
                state: 1,
                progress: 1,
                result: 1,
                createdAt: 1,
                updatedAt: 1,
                failedReason: 1,
              },
              limit: 1,
            },
          }),
          mongo({
            action: "find",
            collection: "speaker_identity_campaigns",
            query: {
              $or: [
                { profileId: input.profileId },
                { profileIds: input.profileId },
              ],
            },
            options: { sort: { updatedAt: -1 }, limit: 1 },
          }),
          mongo({
            action: "find",
            collection: "voice_samples.files",
            query: { "metadata.profile_id": input.profileId },
            options: {
              projection: { uploadDate: 1, "metadata.duration": 1 },
              sort: { uploadDate: 1 },
              limit: 500,
            },
          }),
        ]) as [any, any[], any[], any[], any[], any[]];
        const profileRevision = Number(profile?.revision ?? 1);
        const profileEmbeddingSpaceId = profile?.embeddingSpaceId;
        const rebuiltSampleIds = new Set(
          (profile?.enrollmentProvenance?.sampleIds ?? []).map(String),
        );
        const samplesWaitingForRebuild =
          savedSamples.filter((sample) =>
            !rebuiltSampleIds.has(String(sample._id))
          ).length;
        const calibrationContext = {
          profileId: input.profileId,
          profileRevision,
          embeddingSpaceId: profileEmbeddingSpaceId,
        };
        const describedCalibrations = describeCalibrations(
          calibrations,
          calibrationContext,
        );
        const headedCalibrations = calibrationsAtProfileHead(
          profile,
          calibrations,
        );
        const rawFullCalibration = findUsableFullCalibration(
          headedCalibrations,
          calibrationContext,
        );
        const rawPilotCalibration = findUsablePilotCalibration(
          headedCalibrations,
          calibrationContext,
        );
        const currentEvidenceRevision = Number(
          profile?.calibrationEvidenceRevision ?? 0,
        );
        const evidenceStatus = (calibration: any | null) =>
          calibration
            ? {
              valid: Boolean(calibration.evidenceSnapshotHash) &&
                Number(calibration.evidenceRevision ?? 0) ===
                  currentEvidenceRevision,
              blocker:
                "Voice labels changed after calibration; recalculate and save again",
            }
            : null;
        const fullEvidence = evidenceStatus(rawFullCalibration);
        const pilotEvidence = evidenceStatus(rawPilotCalibration);
        const usableFullCalibration = fullEvidence?.valid
          ? rawFullCalibration
          : null;
        const usablePilotCalibrationRecord = pilotEvidence?.valid
          ? rawPilotCalibration
          : null;
        // Launchers should never be moved from a verified/full calibration to a
        // newer bounded pilot. Keep the pilot visible separately for audit and
        // explicitly scoped pilot runs.
        const usableCalibrationRecord = usableFullCalibration ??
          usablePilotCalibrationRecord;
        const usableCalibrationPolicy = usableCalibrationRecord
          ? normalizeCalibrationPolicy(usableCalibrationRecord)
          : null;
        const usableCalibration = usableCalibrationRecord &&
            usableCalibrationPolicy
          ? {
            ...usableCalibrationRecord,
            ...usableCalibrationPolicy,
            negativeDecisionMode: normalizeNegativeDecisionMode(
              usableCalibrationRecord,
            ),
            recommendedPositiveThreshold: normalizePositiveThresholdProvenance(
              usableCalibrationRecord,
            )
              ?.recommendedPositiveThreshold,
            positiveThresholdSource: normalizePositiveThresholdProvenance(
              usableCalibrationRecord,
            )
              ?.positiveThresholdSource,
          }
          : null;
        const usablePilotCalibrationPolicy = usablePilotCalibrationRecord
          ? normalizeCalibrationPolicy(usablePilotCalibrationRecord)
          : null;
        const usablePilotCalibration = usablePilotCalibrationRecord &&
            usablePilotCalibrationPolicy
          ? {
            ...usablePilotCalibrationRecord,
            ...usablePilotCalibrationPolicy,
            negativeDecisionMode: normalizeNegativeDecisionMode(
              usablePilotCalibrationRecord,
            ),
            recommendedPositiveThreshold: normalizePositiveThresholdProvenance(
              usablePilotCalibrationRecord,
            )
              ?.recommendedPositiveThreshold,
            positiveThresholdSource: normalizePositiveThresholdProvenance(
              usablePilotCalibrationRecord,
            )
              ?.positiveThresholdSource,
          }
          : null;
        const blockers: string[] = [];
        if (!profile) blockers.push("Profile no longer exists");
        if (
          !Array.isArray(profile?.embedding) || profile.embedding.length === 0
        ) {
          blockers.push("Profile has no enrolled embedding");
        }
        if (profile?.enrollmentStatus === "pending_rebuild") {
          blockers.push("Profile embedding rebuild is pending");
        }
        if (!profileEmbeddingSpaceId) {
          blockers.push("Profile has no embedding provenance");
        }
        if (profile && !usableCalibration) {
          const staleReasons = describedCalibrations.flatMap((calibration) =>
            calibration.staleReasons ?? []
          );
          const evidenceReasons = [
            fullEvidence?.blocker,
            pilotEvidence?.blocker,
          ].filter(Boolean) as string[];
          blockers.push(
            evidenceReasons.length > 0
              ? [...new Set(evidenceReasons)].join("; ")
              : staleReasons.length > 0
              ? `Saved calibration is stale: ${
                [...new Set(staleReasons)].join("; ")
              }`
              : "No server-validated calibration exists for the current profile",
          );
        }
        const recordings = new Map<
          string,
          { id: string; sky: number; notSky: number }
        >();
        let sky = 0;
        let notSky = 0;
        let timelineOnly = 0;
        for (
          const annotation of latestReviewAnnotationsBySegment(annotations)
        ) {
          const recordingId = annotation.originalId
            ? String(annotation.originalId)
            : null;
          const isSky = String(annotation.profileId ?? "") === input.profileId;
          const isNotSky = (annotation.excludedProfileIds ?? []).some(
            (id: unknown) => String(id) === input.profileId,
          );
          if (annotation.calibrationUse === "timeline_only") {
            if (isSky) timelineOnly += 1;
            continue;
          }
          if (isSky) sky += 1;
          if (isNotSky) notSky += 1;
          if (recordingId) {
            const row = recordings.get(recordingId) ?? {
              id: recordingId,
              sky: 0,
              notSky: 0,
            };
            if (isSky) row.sky += 1;
            if (isNotSky) row.notSky += 1;
            recordings.set(recordingId, row);
          }
        }
        return {
          profile: profile
            ? {
              id: input.profileId,
              name: profile.name,
              isPrimary: profile.is_primary === true,
              revision: profileRevision,
              embeddingSpaceId: profileEmbeddingSpaceId ?? null,
              sampleCount: Number(profile.sample_count ?? 0),
              totalDuration: Number(profile.total_duration ?? 0),
              sampleVolumeSufficient: Number(profile.sample_count ?? 0) >= 3 &&
                Number(profile.total_duration ?? 0) >= 60,
              samplesWaitingForRebuild,
              enrollmentStatus: profile.enrollmentStatus ?? null,
            }
            : null,
          labels: {
            sky,
            notSky,
            total: sky + notSky,
            timelineOnly,
            recordings: recordings.size,
            byRecording: [...recordings.values()].map((row) => ({
              ...row,
              total: row.sky + row.notSky,
            })).sort((a, b) => b.total - a.total),
          },
          calibrations: describedCalibrations,
          usableCalibration,
          usablePilotCalibration,
          canClassify: blockers.length === 0,
          canRunFullClassification: blockers.length === 0 &&
            Boolean(usableFullCalibration),
          blockers,
          latestJob: latestJobs[0] ?? null,
          latestCampaign: latestCampaigns[0] ?? null,
        };
      }
      case "prepare-identity-model-set": {
        const preflight = await mongo({
          action: "findOne",
          collection: "speaker_identity_preflights",
          query: {
            preflightToken: input.preflightToken,
            owner: auth.principal,
          },
        }) as any;
        if (!preflight || new Date(preflight.expiresAt) <= new Date()) {
          throw new Error(
            "Classification preview expired; check the source again",
          );
        }
        if (!input.profileIds.includes(String(preflight.profileId))) {
          throw new Error(
            "The model set must include the profile used to preview the source",
          );
        }
        if (
          !sameStringSet(
            input.profileIds,
            preflight.resolved?.profileIds ?? [String(preflight.profileId)],
          )
        ) {
          throw new Error(
            "The selected profiles changed after preview; check the source again",
          );
        }
        const prepared = await prepareIdentityModelSetFromPreflight(
          mongo,
          preflight,
          input.profileIds,
          auth.principal,
        );
        return {
          ...prepared,
          modelSet: {
            ...prepared.modelSet,
            partitions: undefined,
          },
        };
      }
      case "list-identity-model-sets":
        return await mongo({
          action: "find",
          collection: "identity_model_sets",
          query: input.profileId ? { profileIds: input.profileId } : {},
          options: {
            projection: { partitions: 0 },
            sort: { createdAt: -1 },
            limit: input.limit,
          },
        });
      case "identity-model-set-head": {
        let embeddingSpaceId = input.embeddingSpaceId ?? null;
        if (!embeddingSpaceId && input.profileId) {
          const profile = await mongo({
            action: "findOne",
            collection: "speaker_profiles",
            query: { _id: new ObjectId(input.profileId) },
            options: { projection: { embeddingSpaceId: 1 } },
          }) as any;
          embeddingSpaceId = profile?.embeddingSpaceId ?? null;
        }
        if (!embeddingSpaceId) {
          return {
            heads: await mongo({
              action: "find",
              collection: "identity_model_set_heads",
              query: {},
              options: { sort: { updatedAt: -1 }, limit: 100 },
            }),
          };
        }
        const head = await mongo({
          action: "findOne",
          collection: "identity_model_set_heads",
          query: { embeddingSpaceId },
        }) as any;
        const modelSet = head?.activeModelSetId
          ? await mongo({
            action: "findOne",
            collection: "identity_model_sets",
            query: {
              modelSetId: head.activeModelSetId,
              status: "active",
            },
            options: { projection: { partitions: 0 } },
          })
          : null;
        return {
          embeddingSpaceId,
          head,
          modelSet,
          status: modelSet ? "active" : "no_active_model_set",
        };
      }
      case "activate-identity-model-set":
        return await redlock.using(
          ["mycelia:lock:speaker-identity-model-set-activation"],
          60_000,
          async (signal) => {
            assertActivationLock(signal, "identity model-set activation");
            const result = await activateIdentityModelSet(
              mongo,
              input.modelSetId,
              auth.principal,
            );
            assertActivationLock(signal, "identity model-set completion");
            return result;
          },
        );
      case "identity-preflight": {
        const snapshotCutoff = new Date();
        const profileIds = input.profileIds ??
          await resolveDefaultIdentityModelSetProfileIds(
            mongo,
            input.profileId,
          );
        const preflight = await computeIdentityPreflight(
          mongo,
          input.profileId,
          input.scope,
          snapshotCutoff,
          profileIds,
        );
        if (!preflight.canStart || preflight.status !== "ready") {
          return { ...preflight, preflightToken: null };
        }
        const preflightToken = crypto.randomUUID();
        await mongo({
          action: "insertOne",
          collection: "speaker_identity_preflights",
          doc: {
            preflightToken,
            owner: auth.principal,
            profileId: input.profileId,
            ...preflight,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 10 * 60_000),
          },
        });
        return { ...preflight, preflightToken };
      }
      case "start-identity-campaign": {
        const preflight = await mongo({
          action: "findOne",
          collection: "speaker_identity_preflights",
          query: {
            preflightToken: input.preflightToken,
            owner: auth.principal,
            profileId: input.profileId,
          },
        }) as any;
        if (!preflight || new Date(preflight.expiresAt) <= new Date()) {
          throw new Error(
            "Classification preview expired; check the source again",
          );
        }
        const requestedProfileIds = input.profileIds ??
          preflight.resolved?.profileIds ?? [input.profileId];
        if (!requestedProfileIds.includes(input.profileId)) {
          throw new Error(
            "The model set must include the profile used to preview the source",
          );
        }
        if (
          !sameStringSet(
            requestedProfileIds,
            preflight.resolved?.profileIds ?? [input.profileId],
          )
        ) {
          throw new Error(
            "The selected profiles changed after preview; check the source again",
          );
        }
        if (preflight.campaignId) {
          const existingCampaign = await mongo({
            action: "findOne",
            collection: "speaker_identity_campaigns",
            query: { campaignId: preflight.campaignId },
          });
          if (existingCampaign) {
            return {
              campaignId: preflight.campaignId,
              jobId: existingCampaign.currentJobId ?? null,
              status: existingCampaign.status,
              reused: true,
            };
          }
        }
        if (!preflight.canStart || !preflight.partitions?.length) {
          throw new Error(
            `Classification cannot start: ${
              (preflight.blockers ?? ["no compatible segments"]).join("; ")
            }`,
          );
        }
        const context = await resolveIdentityClassificationContext(
          mongo,
          input.profileId,
        );
        if (
          !context.snapshot ||
          context.snapshot.calibrationId !==
            preflight.resolved?.calibrationId ||
          context.snapshot.profileRevision !==
            preflight.resolved?.profileRevision ||
          context.snapshot.embeddingSpaceId !==
            preflight.resolved?.embeddingSpaceId ||
          context.snapshot.evidenceSnapshotHash !==
            preflight.resolved?.evidenceSnapshotHash
        ) {
          throw new Error(
            "The profile or calibration changed after preview; check the source again",
          );
        }
        const snapshotCutoff = new Date(preflight.snapshotCutoff);
        const sourceIndexState = await mongo({
          action: "findOne",
          collection: SPEAKER_IDENTITY_SOURCE_INDEX,
          query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
        });
        if (
          !preflight.sourceSnapshot ||
          !identitySourceSnapshotMatches(
            preflight.sourceSnapshot,
            sourceIndexState,
          )
        ) {
          throw new Error(
            "Active diarization coverage changed after preview; check the source again",
          );
        }
        const actualPartitions = await mongo({
          action: "find",
          collection: SPEAKER_IDENTITY_SOURCE_PARTITIONS,
          query: { buildId: preflight.sourceSnapshot.buildId, status: "ready" },
          options: { limit: 2_000 },
        }) as any[];
        const actualByKey = new Map(actualPartitions.map((partition) => [
          identityPartitionKey(partition),
          partition,
        ]));
        for (const partition of preflight.partitions as IdentityPartition[]) {
          const actual = actualByKey.get(identityPartitionKey(partition));
          if (!actual || !identitySourcePartitionMatches(partition, actual)) {
            throw new Error(
              "Active diarization coverage changed after preview; check the source again",
            );
          }
        }
        const preparedModelSet = preflight.resolved?.identityContract ===
            "model_set_v1"
          ? await prepareIdentityModelSetFromPreflight(
            mongo,
            preflight,
            requestedProfileIds,
            auth.principal,
          )
          : null;
        const modelSet = preparedModelSet?.modelSet ?? null;
        if (modelSet?.status === "superseded") {
          throw new Error(
            "This model-set source was already superseded; preview the current source again",
          );
        }
        const modelSetTotal = modelSet
          ? Number(modelSet.coverage?.totalSegments ?? 0)
          : Number(preflight.totals.eligibleSegments ?? 0);
        const modelSetProjected = modelSet
          ? Number(modelSet.coverage?.projectedSegments ?? 0)
          : 0;
        const campaignPending = Math.max(
          0,
          modelSetTotal - modelSetProjected,
        );
        if (modelSet && campaignPending === 0) {
          return {
            campaignId: null,
            jobId: null,
            modelSetId: modelSet.modelSetId,
            status: modelSet.status,
            reused: true,
            activationRequired: modelSet.status === "ready",
          };
        }
        const campaignId = `speaker-identity-${new ObjectId()}`;
        const claimed = await mongo({
          action: "updateOne",
          collection: "speaker_identity_preflights",
          query: {
            _id: preflight._id,
            campaignId: { $exists: false },
            expiresAt: { $gt: new Date() },
          },
          update: {
            $set: { campaignId, consumedAt: new Date(), updatedAt: new Date() },
          },
        }) as any;
        if (claimed.matchedCount !== 1) {
          const concurrent = await mongo({
            action: "findOne",
            collection: "speaker_identity_preflights",
            query: { _id: preflight._id },
          }) as any;
          if (concurrent?.campaignId) {
            const existingCampaign = await mongo({
              action: "findOne",
              collection: "speaker_identity_campaigns",
              query: { campaignId: concurrent.campaignId },
            }) as any;
            if (existingCampaign) {
              return {
                campaignId: concurrent.campaignId,
                jobId: existingCampaign.currentJobId ?? null,
                status: existingCampaign.status,
                reused: true,
              };
            }
            // A process can stop after claiming the short-lived preflight but
            // before inserting the durable campaign. Clear only that orphaned
            // claim; the operator can safely press Start again with the same
            // preview token.
            await mongo({
              action: "updateOne",
              collection: "speaker_identity_preflights",
              query: {
                _id: preflight._id,
                campaignId: concurrent.campaignId,
              },
              update: {
                $unset: { campaignId: "", consumedAt: "" },
                $set: { recoveredAt: new Date(), updatedAt: new Date() },
              },
            });
            throw new Error(
              "A previous start was interrupted before queueing; press Start again",
            );
          }
          throw new Error("Classification preview was already consumed");
        }
        const firstPartition = preflight.partitions[0] as IdentityPartition;
        // Reserve the canonical job id before the campaign becomes visible.
        // The queue uses the same id, so a successful enqueue never produces
        // an ownerless job even if this request stops before returning.
        const reservedJobId = new ObjectId().toString();
        const now = new Date();
        const campaign = {
          campaignId,
          mode: preflight.scope.mode === "all_compatible"
            ? "classify_all_compatible"
            : "classify_range",
          profileId: input.profileId,
          profileIds: modelSet?.profileIds ?? [input.profileId],
          ...(modelSet
            ? {
              modelSetId: modelSet.modelSetId,
              profileSnapshots: modelSet.profiles,
            }
            : {}),
          profileName: preflight.resolved.profileName,
          profileRevision: preflight.resolved.profileRevision,
          calibrationId: preflight.resolved.calibrationId,
          classificationPolicy: preflight.resolved.classificationPolicy,
          decisionValidity: preflight.resolved.classificationPolicy === "pilot"
            ? "provisional"
            : "verified",
          targetPrecision: preflight.resolved.targetPrecision,
          embeddingSpaceId: preflight.resolved.embeddingSpaceId,
          evidenceSnapshotHash: preflight.resolved.evidenceSnapshotHash,
          scope: preflight.scope,
          range: preflight.scope.mode === "range"
            ? { start: preflight.scope.start, end: preflight.scope.end }
            : { start: null, end: snapshotCutoff },
          snapshotCutoff,
          sourceSnapshot: preflight.sourceSnapshot,
          partitions: preflight.partitions,
          partitionIndex: 0,
          status: "queued",
          active: true,
          totalSegments: modelSetTotal,
          pendingSegments: campaignPending,
          processedSegments: modelSetProjected,
          matched: 0,
          rejected: 0,
          identified: 0,
          ambiguous: 0,
          unknown: 0,
          uncertain: 0,
          incompatibleSkipped: 0,
          estimatedBatches: Math.ceil(campaignPending / 1_000),
          firstJobId: reservedJobId,
          currentJobId: reservedJobId,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await mongo({
            action: "insertOne",
            collection: "speaker_identity_campaigns",
            doc: campaign,
          });
        } catch (error) {
          const concurrent = await mongo({
            action: "findOne",
            collection: "speaker_identity_campaigns",
            query: {
              active: true,
              $or: [
                { profileId: { $in: requestedProfileIds } },
                { profileIds: { $in: requestedProfileIds } },
              ],
            },
            options: { sort: { updatedAt: -1, createdAt: -1 } },
          }) as any;
          if (!concurrent) throw error;
          await mongo({
            action: "updateOne",
            collection: "speaker_identity_preflights",
            query: { _id: preflight._id, campaignId },
            update: {
              $set: {
                campaignId: concurrent.campaignId,
                reusedAt: new Date(),
                updatedAt: new Date(),
              },
            },
          });
          return {
            campaignId: concurrent.campaignId,
            jobId: concurrent.currentJobId ?? null,
            status: concurrent.status,
            reused: true,
          };
        }
        try {
          const { enqueueJob } = await import("@/lib/jobs/queue.ts");
          const job = await enqueueJob({
            type: "speakerIdentity",
            runId: firstPartition.runId,
            profileId: input.profileId,
            ...(modelSet
              ? {
                modelSetId: modelSet.modelSetId,
                profileSnapshots: modelSet.profiles,
              }
              : {
                profileRevision: preflight.resolved.profileRevision,
                calibrationId: preflight.resolved.calibrationId,
                evidenceSnapshotHash: preflight.resolved.evidenceSnapshotHash,
              }),
            ...(preflight.scope.mode === "range"
              ? {
                start: preflight.scope.start,
                end: preflight.scope.end,
              }
              : { end: snapshotCutoff }),
            snapshotCutoff,
            sourceSnapshot: preflight.sourceSnapshot,
            partitions: preflight.partitions,
            partitionIndex: 0,
            limit: 1_000,
            campaignId,
          }, {
            jobId: reservedJobId,
            priority: 3,
            trigger: {
              type: "manual",
              reason: "Classify all compatible voice history",
              principal: String(auth.principal),
            },
          });
          return {
            campaignId,
            jobId: String(job.id ?? reservedJobId),
            status: "queued",
            reused: false,
          };
        } catch (error) {
          await mongo({
            action: "updateOne",
            collection: "speaker_identity_campaigns",
            query: { campaignId, active: true, currentJobId: reservedJobId },
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
          throw error;
        }
      }
      case "speaker-timeline-summary": {
        const profile = input.profileId
          ? await mongo({
            action: "findOne",
            collection: "speaker_profiles",
            query: { _id: new ObjectId(input.profileId) },
          }) as any
          : await mongo({
            action: "findOne",
            collection: "speaker_profiles",
            query: { is_primary: true },
          }) as any;
        if (!profile) {
          return {
            mode: input.detail,
            status: "no_data",
            reason: input.profileId
              ? "The selected voice profile does not exist"
              : "No primary voice profile exists",
            intervals: [],
            buckets: [],
            totals: {
              segments: 0,
              matched: 0,
              identified: 0,
              ambiguous: 0,
              unknown: 0,
              rejected: 0,
              uncertain: 0,
              unclassified: 0,
            },
          };
        }
        const profileId = String(profile._id);
        const [head, annotationOverlapRows] = await Promise.all([
          profile.embeddingSpaceId
            ? mongo({
              action: "findOne",
              collection: "identity_model_set_heads",
              query: { embeddingSpaceId: profile.embeddingSpaceId },
            })
            : Promise.resolve(null),
          mongo({
            action: "aggregate",
            collection: "speaker_annotations",
            pipeline: buildTimelineAnnotationOverlapProjectionPipeline({
              start: input.start,
              end: input.end,
              targetProfileId: new ObjectId(profileId),
            }),
            options: { maxTimeMS: 5_000 },
          }),
        ]) as [any, any[]];
        const annotationOverlapSelectedSegmentIds = annotationOverlapRows
          .filter((row) => String(row.profileId ?? "") === profileId)
          .map((row) => row._id);
        const annotationOverlapOtherSegmentIds = annotationOverlapRows
          .filter((row) => String(row.profileId ?? "") !== profileId)
          .map((row) => row._id);
        const activeModelSet = head?.activeModelSetId
          ? await mongo({
            action: "findOne",
            collection: "identity_model_sets",
            query: {
              modelSetId: head.activeModelSetId,
              status: "active",
            },
            options: { projection: { partitions: 0 } },
          }) as any
          : null;
        const selectedProfileSnapshot = activeModelSet?.profiles?.find(
          (snapshot: any) => String(snapshot.profileId) === profileId,
        ) ?? null;
        const selectedProfileStale = Boolean(
          activeModelSet?.staleProfileIds?.map(String).includes(profileId),
        );
        const automaticReason = !activeModelSet
          ? "Manual identity is shown; build and activate an identity model set for automatic results"
          : !selectedProfileSnapshot
          ? "The selected voice is not included in the active identity model set"
          : selectedProfileStale
          ? "The selected voice changed after this identity model set was built; automatic results are hidden until a replacement activates"
          : null;
        const timelinePipelineInput = {
          start: input.start,
          end: input.end,
          detail: input.detail,
          bucketMs: input.bucketMs,
          targetProfileId: profileId,
          modelSetId: activeModelSet?.modelSetId ?? null,
          targetProfileIncluded: Boolean(
            selectedProfileSnapshot && !selectedProfileStale,
          ),
          annotationOverlapSelectedSegmentIds,
          annotationOverlapOtherSegmentIds,
          states: input.filters.states,
          validities: input.filters.validities,
          inclusion: input.filters.inclusion,
          sources: input.filters.sources,
        } as const;
        const [startsInRange, overlapsStart] = await Promise.all([
          mongo({
            action: "aggregate",
            collection: "diarizations",
            pipeline: buildSpeakerTimelinePipeline({
              ...timelinePipelineInput,
              rangeBranch: "starts_in_range",
            }),
            options: {
              hint: "speaker_timeline_active_range",
              maxTimeMS: 10_000,
            },
          }),
          mongo({
            action: "aggregate",
            collection: "diarizations",
            pipeline: buildSpeakerTimelinePipeline({
              ...timelinePipelineInput,
              rangeBranch: "overlaps_start",
            }),
            options: {
              hint: "speaker_timeline_active_end",
              maxTimeMS: 10_000,
            },
          }),
        ]) as [any[], any[]];
        const rows = mergeSpeakerTimelineRows(input.detail, [
          startsInRange,
          overlapsStart,
        ]);
        if (input.detail === "intervals") {
          const truncated = rows.length > 10_000;
          const intervals = rows.slice(0, 10_000).map((row) => ({
            segmentId: String(row._id),
            originalId: row.originalId ? String(row.originalId) : null,
            start: row.start,
            end: row.end,
            state: row.state,
            validity: row.validity,
            profileId: row.profileId ? String(row.profileId) : null,
            score: row.score ?? null,
            source: row.source ?? null,
            candidates: row.candidates ?? [],
            includesSelectedCandidate: row.includesSelectedCandidate === true,
            modelSetId: row.modelSetId ?? null,
          }));
          const totals = intervals.reduce((result, row) => {
            result.segments += 1;
            const state = row.state as
              | "identified"
              | "ambiguous"
              | "unknown"
              | "uncertain"
              | "unclassified";
            result[state] += 1;
            return result;
          }, {
            segments: 0,
            matched: 0,
            identified: 0,
            ambiguous: 0,
            unknown: 0,
            rejected: 0,
            uncertain: 0,
            unclassified: 0,
          });
          totals.matched = totals.identified;
          totals.rejected = totals.unknown;
          return {
            mode: "intervals",
            status: intervals.length ? "ready" : "no_data",
            profile: {
              id: profileId,
              name: profile.name,
              color: profile.color ?? null,
            },
            calibration: selectedProfileSnapshot
              ? { id: selectedProfileSnapshot.calibrationId, status: "full" }
              : null,
            modelSet: activeModelSet
              ? {
                id: activeModelSet.modelSetId,
                status: activeModelSet.status,
                profileIds: activeModelSet.profileIds ?? [],
              }
              : null,
            reason: automaticReason,
            intervals,
            totals,
            truncated,
          };
        }
        const buckets = rows.map((row) => ({
          start: new Date(Number(row._id)),
          end: new Date(Number(row._id) + Number(input.bucketMs)),
          counts: {
            identified: Number(row.identified ?? 0),
            ambiguous: Number(row.ambiguous ?? 0),
            unknown: Number(row.unknown ?? 0),
            // Compatibility aliases for older Timeline clients.
            matched: Number(row.identified ?? 0),
            rejected: Number(row.unknown ?? 0),
            uncertain: Number(row.uncertain ?? 0),
            unclassified: Number(row.unclassified ?? 0),
          },
          durationMs: {
            identified: Number(row.identifiedMs ?? 0),
            ambiguous: Number(row.ambiguousMs ?? 0),
            uncertain: Number(row.uncertainMs ?? 0),
            unclassified: Number(row.unclassifiedMs ?? 0),
          },
          validityCounts: {
            verified: Number(row.verified ?? 0),
            provisional: Number(row.provisional ?? 0),
            manual: Number(row.manual ?? 0),
          },
          segments: Number(row.segments ?? 0),
        }));
        const totals = buckets.reduce((result, bucket) => {
          result.segments += bucket.segments;
          result.identified += bucket.counts.identified;
          result.ambiguous += bucket.counts.ambiguous;
          result.unknown += bucket.counts.unknown;
          result.matched += bucket.counts.matched;
          result.rejected += bucket.counts.rejected;
          result.uncertain += bucket.counts.uncertain;
          result.unclassified += bucket.counts.unclassified;
          return result;
        }, {
          segments: 0,
          matched: 0,
          identified: 0,
          ambiguous: 0,
          unknown: 0,
          rejected: 0,
          uncertain: 0,
          unclassified: 0,
        });
        return {
          mode: "buckets",
          status: buckets.length ? "ready" : "no_data",
          profile: {
            id: profileId,
            name: profile.name,
            color: profile.color ?? null,
          },
          calibration: selectedProfileSnapshot
            ? { id: selectedProfileSnapshot.calibrationId, status: "full" }
            : null,
          modelSet: activeModelSet
            ? {
              id: activeModelSet.modelSetId,
              status: activeModelSet.status,
              profileIds: activeModelSet.profileIds ?? [],
            }
            : null,
          reason: automaticReason,
          buckets,
          totals,
        };
      }
      case "identity-classification": {
        const profileObjectId = new ObjectId(input.profileId);
        const profile = await mongo({
          action: "findOne",
          collection: "speaker_profiles",
          query: { _id: profileObjectId },
          options: { projection: { revision: 1, embeddingSpaceId: 1 } },
        }) as any;
        const profileRevision = Number(profile?.revision ?? 1);
        const embeddingSpaceId = profile?.embeddingSpaceId ?? null;
        const classificationContext = profile
          ? await resolveIdentityClassificationContext(mongo, input.profileId)
          : null;
        const usableCalibration = classificationContext?.calibration ?? null;
        const usablePolicy = usableCalibration
          ? normalizeCalibrationPolicy(usableCalibration)
          : null;
        const usableFullCalibration = usablePolicy?.classificationPolicy ===
            "full"
          ? usableCalibration
          : null;
        const usablePilotCalibration = usablePolicy?.classificationPolicy ===
            "pilot"
          ? usableCalibration
          : null;
        const head = embeddingSpaceId
          ? await mongo({
            action: "findOne",
            collection: "identity_model_set_heads",
            query: { embeddingSpaceId },
          }) as any
          : null;
        const activeModelSet = head?.activeModelSetId
          ? await mongo({
            action: "findOne",
            collection: "identity_model_sets",
            query: {
              modelSetId: head.activeModelSetId,
              status: "active",
            },
            options: {
              projection: {
                modelSetId: 1,
                profileIds: 1,
                staleProfileIds: 1,
              },
            },
          }) as any
          : null;
        const targetProfileIncluded = Boolean(
          activeModelSet?.profileIds?.map(String).includes(input.profileId) &&
            !activeModelSet?.staleProfileIds?.map(String).includes(
              input.profileId,
            ),
        );
        const asOf = new Date();
        const annotationOverlapRows = await mongo({
          action: "aggregate",
          collection: "speaker_annotations",
          pipeline: buildTimelineAnnotationOverlapProjectionPipeline({
            start: new Date(0),
            end: asOf,
            targetProfileId: profileObjectId,
          }),
          options: { maxTimeMS: 5_000 },
        }) as any[];
        const annotationOverlapSelectedSegmentIds = annotationOverlapRows
          .filter((row) => String(row.profileId ?? "") === input.profileId)
          .map((row) => row._id);
        const annotationOverlapOtherSegmentIds = annotationOverlapRows
          .filter((row) => String(row.profileId ?? "") !== input.profileId)
          .map((row) => row._id);
        const summaryPromise = activeModelSet && targetProfileIncluded
          ? mongo({
            action: "aggregate",
            collection: "diarizations",
            pipeline: buildIdentityClassificationSummaryPipeline({
              asOf,
              targetProfileId: input.profileId,
              modelSetId: activeModelSet.modelSetId,
              targetProfileIncluded: true,
              annotationOverlapSelectedSegmentIds,
              annotationOverlapOtherSegmentIds,
            }),
            options: {
              maxTimeMS: 20_000,
              hint: "speaker_timeline_active_range",
            },
          }) as Promise<any[]>
          : (async () => {
            const totalSegments = Number(
              await mongo({
                action: "count",
                collection: "diarizations",
                query: {
                  lifecycleStatus: "active",
                  start: { $gte: new Date(0), $lt: asOf },
                },
                options: {
                  maxTimeMS: 10_000,
                  hint: "speaker_timeline_active_range",
                },
              }),
            );
            return [buildManualOnlyIdentitySummary(
              totalSegments,
              annotationOverlapSelectedSegmentIds,
              annotationOverlapOtherSegmentIds,
            )];
          })();
        const [summaryRows, provisionalCounts] = await Promise.all([
          summaryPromise,
          usablePilotCalibration && !activeModelSet
            ? await mongo({
              action: "aggregate",
              collection: "diarizations",
              pipeline: [
                {
                  $match: {
                    lifecycleStatus: "active",
                    "speakerIdentity.calibrationId":
                      usablePilotCalibration.calibrationId,
                    "speakerIdentity.profileRevision": profileRevision,
                    "speakerIdentity.embeddingSpaceId": embeddingSpaceId,
                    "speakerIdentity.source": "automatic",
                    "speakerIdentity.validity": "provisional",
                  },
                },
                {
                  $group: {
                    _id: "$speakerIdentity.identityState",
                    count: { $sum: 1 },
                  },
                },
              ],
              options: {
                maxTimeMS: 10_000,
                hint: SPEAKER_IDENTITY_SNAPSHOT_INDEX,
              },
            }) as any[]
            : Promise.resolve([]),
        ]) as [any[], any[]];
        const summary = summaryRows[0] ?? {};
        const provisional = Object.fromEntries(
          provisionalCounts.map((row) => [row._id, row.count]),
        );
        return {
          asOf,
          classification: {
            identified: summary.identified ?? 0,
            unknown: summary.unknown ?? 0,
            uncertain: summary.uncertain ?? 0,
            provisional: {
              identified: provisional.identified ?? 0,
              unknown: provisional.unknown ?? 0,
              uncertain: provisional.uncertain ?? 0,
            },
            // Embedded pre-model-set decisions are intentionally ignored.
            // Stale active snapshot metadata remains visible on the model set,
            // while these counts describe only the active head plus manual
            // annotations.
            stale: 0,
            unclassified: summary.unclassified ?? 0,
          },
          calibrationId: usableCalibration?.calibrationId ?? null,
          classificationPolicy: usablePolicy?.classificationPolicy ?? null,
          maxRangeHours: usablePolicy?.maxRangeHours ?? null,
          canRunFullClassification: Boolean(usableFullCalibration),
        };
      }
      case "list-identity-campaigns": {
        const query: Record<string, unknown> = {};
        if (input.profileId) {
          query.$or = [
            { profileId: input.profileId },
            { profileIds: input.profileId },
          ];
        }
        if (input.runId) query.runId = input.runId;
        return await mongo({
          action: "find",
          collection: "speaker_identity_campaigns",
          query,
          options: { sort: { updatedAt: -1 }, limit: input.limit },
        });
      }
      case "save-calibration": {
        const calibrationIds = new Set(input.calibrationRecordingIds);
        if (input.validationRecordingIds.some((id) => calibrationIds.has(id))) {
          throw new Error(
            "Calibration and validation must use different recordings",
          );
        }
        const preview = await computeCalibrationPreview(
          mongo,
          input.profileId,
          input.calibrationRecordingIds,
          input.validationRecordingIds,
          input.targetPrecision,
          input.positiveThresholdOverride,
        );
        if (!preview.thresholds) {
          throw new Error(
            "Calibration data does not produce a safe auto-Sky threshold",
          );
        }
        if (!preview.canValidate) {
          throw new Error(
            `Calibration is blocked: ${preview.blockers.join("; ")}`,
          );
        }
        if (preview.profile.embeddingSpaceId === "legacy-unknown") {
          throw new Error(
            "Legacy embeddings require an explicit compatibility validation before calibration",
          );
        }
        const now = new Date();
        const classificationPolicy = preview.targetPrecision <
            SPEAKER_CALIBRATION_TARGET_PRECISION
          ? "pilot"
          : "full";
        const saveToken = crypto.randomUUID();
        const saveLock = await mongo({
          action: "updateOne",
          collection: "speaker_profiles",
          query: {
            _id: new ObjectId(input.profileId),
            $or: [
              { calibrationSaveLock: { $exists: false } },
              { "calibrationSaveLock.expiresAt": { $lte: now } },
            ],
          },
          update: {
            $set: {
              calibrationHeadsInitialized: true,
              calibrationSaveLock: {
                token: saveToken,
                startedAt: now,
                expiresAt: new Date(now.getTime() + 5 * 60_000),
              },
            },
          },
        }) as any;
        if (Number(saveLock.matchedCount ?? 0) !== 1) {
          throw new Error(
            "Calibration save is already in progress; wait for it to finish",
          );
        }
        try {
          const calibrationId =
            `voice-r${preview.profile.revision}-${Date.now()}-${
              crypto.randomUUID().slice(0, 8)
            }`;
          const record: any = {
            calibrationId,
            profileId: input.profileId,
            profileRevision: preview.profile.revision,
            embeddingSpaceId: preview.profile.embeddingSpaceId,
            positiveThreshold: preview.thresholds.positiveThreshold,
            recommendedPositiveThreshold: preview.recommendedPositiveThreshold,
            positiveThresholdSource: preview.positiveThresholdSource,
            negativeThreshold: preview.thresholds.negativeThreshold,
            negativeDecisionMode: preview.thresholds.negativeDecisionMode,
            scoringStrategy: preview.scoringStrategy ?? "centroid",
            metrics: {
              precision: preview.validationMetrics.positivePrecision,
              recall: preview.validationMetrics.positiveRecall,
              sky: preview.counts.positive,
              notSky: preview.counts.negative,
              borderline: preview.calibrationMetrics.uncertain +
                preview.validationMetrics.uncertain,
            },
            calibrationMetrics: preview.calibrationMetrics,
            validationMetrics: preview.validationMetrics,
            targetPrecision: preview.targetPrecision,
            classificationPolicy,
            operatorAcceptedLowerPrecision: classificationPolicy === "pilot" &&
              input.acceptLowerPrecisionRisk === true,
            maxRangeHours: classificationPolicy === "pilot"
              ? SPEAKER_CALIBRATION_PILOT_MAX_RANGE_HOURS
              : null,
            serverComputed: true,
            contractVersion: SPEAKER_CALIBRATION_CONTRACT_VERSION,
            computedBy: SPEAKER_CALIBRATION_COMPUTED_BY,
            computedAt: now,
            calibrationAlgorithmVersion: "prototype-thresholds-v3",
            matcherVersion: "profile-prototypes-v3",
            calibrationRecordingIds: input.calibrationRecordingIds,
            validationRecordingIds: input.validationRecordingIds,
            allowLegacyCompatibility: false,
            status: "validated",
            lifecycleStatus: "pending",
            evidence: {
              compatibleLabels: preview.counts.total,
              positiveLabels: preview.counts.positive,
              negativeLabels: preview.counts.negative,
              recordings: preview.counts.recordings,
            },
            evidenceSnapshotHash: preview.evidenceSnapshotHash,
            evidenceRevision: preview.evidenceRevision,
            createdAt: now,
            updatedAt: now,
          };
          const fingerprint = await calibrationFingerprint(record);
          const samePolicyQuery = classificationPolicy === "full"
            ? {
              $or: [
                { classificationPolicy: "full" },
                {
                  classificationPolicy: { $exists: false },
                  targetPrecision: {
                    $gte: SPEAKER_CALIBRATION_TARGET_PRECISION,
                  },
                },
              ],
            }
            : {
              $or: [
                { classificationPolicy: "pilot" },
                {
                  classificationPolicy: { $exists: false },
                  targetPrecision: {
                    $lt: SPEAKER_CALIBRATION_TARGET_PRECISION,
                  },
                },
              ],
            };
          const evidenceRevisionQuery = preview.evidenceRevision === 0
            ? {
              $or: [
                { calibrationEvidenceRevision: 0 },
                { calibrationEvidenceRevision: { $exists: false } },
              ],
            }
            : { calibrationEvidenceRevision: preview.evidenceRevision };
          const prior = await mongo({
            action: "find",
            collection: "speaker_calibrations",
            query: {
              profileId: input.profileId,
              profileRevision: preview.profile.revision,
              status: "validated",
            },
            options: { sort: { createdAt: -1 }, limit: 100 },
          }) as any[];
          let equivalent: any | null = null;
          for (const calibration of prior) {
            const candidateFingerprint = calibration.calibrationFingerprint ??
              await calibrationFingerprint(calibration);
            if (candidateFingerprint === fingerprint) {
              equivalent = calibration;
              break;
            }
          }
          if (equivalent) {
            const activatedCalibration = await mongo({
              action: "updateOne",
              collection: "speaker_calibrations",
              query: {
                _id: equivalent._id,
                calibrationFingerprint: fingerprint,
              },
              update: {
                $set: {
                  lifecycleStatus: "active",
                  calibrationFingerprint: fingerprint,
                  evidenceRevision: preview.evidenceRevision,
                  activatedAt: now,
                  updatedAt: now,
                },
                $unset: {
                  supersededAt: "",
                  supersededBy: "",
                  staleAt: "",
                  staleReason: "",
                },
              },
            }) as any;
            if (Number(activatedCalibration.matchedCount ?? 0) !== 1) {
              throw new Error(
                "Equivalent calibration changed while it was being activated",
              );
            }
            const activatedHead = await mongo({
              action: "updateOne",
              collection: "speaker_profiles",
              query: {
                _id: new ObjectId(input.profileId),
                "calibrationSaveLock.token": saveToken,
                ...evidenceRevisionQuery,
              },
              update: {
                $set: {
                  [`activeCalibrationIds.${classificationPolicy}`]:
                    equivalent.calibrationId,
                  updatedAt: now,
                },
              },
            }) as any;
            if (Number(activatedHead.matchedCount ?? 0) !== 1) {
              throw new Error(
                "Voice labels changed while calibration was saving; recalculate and save again",
              );
            }
            await mongo({
              action: "updateMany",
              collection: "speaker_calibrations",
              query: {
                profileId: input.profileId,
                _id: { $ne: equivalent._id },
                status: "validated",
                lifecycleStatus: { $ne: "superseded" },
                ...samePolicyQuery,
              },
              update: {
                $set: {
                  lifecycleStatus: "superseded",
                  supersededAt: now,
                  supersededBy: equivalent.calibrationId,
                  updatedAt: now,
                },
              },
            });
            return {
              ...equivalent,
              lifecycleStatus: "active",
              calibrationFingerprint: fingerprint,
              reused: true,
            };
          }
          record._id = new ObjectId();
          record.calibrationFingerprint = fingerprint;
          record.activatedAt = now;
          try {
            await mongo({
              action: "insertOne",
              collection: "speaker_calibrations",
              doc: record,
            });
          } catch (error) {
            // A concurrent identical Save is idempotent too. Never supersede the
            // current calibration before proving that its replacement exists.
            const concurrent = await mongo({
              action: "findOne",
              collection: "speaker_calibrations",
              query: {
                profileId: input.profileId,
                calibrationFingerprint: fingerprint,
              },
            }) as any;
            if (!concurrent) throw error;
            equivalent = concurrent;
          }
          const activeCalibrationId = equivalent?.calibrationId ??
            calibrationId;
          const activeCalibrationObjectId = equivalent?._id ?? record._id;
          const activatedCalibration = await mongo({
            action: "updateOne",
            collection: "speaker_calibrations",
            query: {
              _id: activeCalibrationObjectId,
              lifecycleStatus: equivalent ? { $ne: "stale" } : "pending",
            },
            update: {
              $set: {
                lifecycleStatus: "active",
                evidenceRevision: preview.evidenceRevision,
                activatedAt: now,
                updatedAt: now,
              },
              $unset: {
                supersededAt: "",
                supersededBy: "",
                staleAt: "",
                staleReason: "",
              },
            },
          }) as any;
          if (Number(activatedCalibration.matchedCount ?? 0) !== 1) {
            throw new Error(
              "Voice labels changed while calibration was saving; recalculate and save again",
            );
          }
          const activatedHead = await mongo({
            action: "updateOne",
            collection: "speaker_profiles",
            query: {
              _id: new ObjectId(input.profileId),
              "calibrationSaveLock.token": saveToken,
              ...evidenceRevisionQuery,
            },
            update: {
              $set: {
                [`activeCalibrationIds.${classificationPolicy}`]:
                  activeCalibrationId,
                updatedAt: now,
              },
            },
          }) as any;
          if (Number(activatedHead.matchedCount ?? 0) !== 1) {
            throw new Error(
              "Voice labels changed while calibration was saving; recalculate and save again",
            );
          }
          await mongo({
            action: "updateMany",
            collection: "speaker_calibrations",
            query: {
              profileId: input.profileId,
              _id: { $ne: activeCalibrationObjectId },
              status: "validated",
              lifecycleStatus: { $ne: "superseded" },
              ...samePolicyQuery,
            },
            update: {
              $set: {
                lifecycleStatus: "superseded",
                supersededAt: now,
                supersededBy: activeCalibrationId,
                updatedAt: now,
              },
            },
          });
          return equivalent
            ? { ...equivalent, lifecycleStatus: "active", reused: true }
            : { ...record, lifecycleStatus: "active" };
        } finally {
          await mongo({
            action: "updateOne",
            collection: "speaker_profiles",
            query: {
              _id: new ObjectId(input.profileId),
              "calibrationSaveLock.token": saveToken,
            },
            update: { $unset: { calibrationSaveLock: "" } },
          });
        }
      }
      case "list-runs": {
        const [runs, campaigns] = await Promise.all([
          mongo({
            action: "find",
            collection: "diarization_runs",
            query: {},
            options: { sort: { createdAt: -1 } },
          }),
          mongo({
            action: "find",
            collection: "diarization_campaigns",
            query: {},
            options: { sort: { updatedAt: -1 }, limit: 100 },
          }),
        ]) as [any[], any[]];
        return runs.map((run) => ({
          ...run,
          status: getObservedRunStatus(run, campaigns),
          campaign: campaigns.find((campaign) => campaign.runId === run.runId),
        }));
      }
      case "list-campaigns":
        return await mongo({
          action: "find",
          collection: "diarization_campaigns",
          query: input.runId ? { runId: input.runId } : {},
          options: { sort: { updatedAt: -1 }, limit: input.limit },
        });
      case "create-run": {
        const existing = await mongo({
          action: "findOne",
          collection: "diarization_runs",
          query: { runId: input.runId },
        });
        if (existing) return existing;
        const doc = {
          ...input,
          action: undefined,
          status: "building",
          range: { start: input.start, end: input.end },
          errors: [],
          createdAt: new Date(),
        };
        const { action: _action, start: _start, end: _end, ...stored } = doc;
        await mongo({
          action: "insertOne",
          collection: "diarization_runs",
          doc: stored,
        });
        return stored;
      }
      case "mark-run-ready": {
        const result = await mongo({
          action: "updateOne",
          collection: "diarization_runs",
          query: { runId: input.runId, status: "building" },
          update: {
            $set: {
              status: "ready",
              coverage: input.coverage,
              errors: input.errors,
              readyAt: new Date(),
            },
          },
        });
        if ((result as any).matchedCount !== 1) {
          throw new Error("Only a building run can become ready");
        }
        return result;
      }
      case "compare-run": {
        const run = await mongo({
          action: "findOne",
          collection: "diarization_runs",
          query: { runId: input.runId },
        }) as any;
        if (!run) throw new Error("Run not found");
        const [stats] = await mongo({
          action: "aggregate",
          collection: "diarizations",
          pipeline: [
            { $match: { runId: input.runId } },
            {
              $group: {
                _id: "$speakerIdentity.state",
                segments: { $sum: 1 },
                durationMs: { $sum: { $subtract: ["$end", "$start"] } },
              },
            },
          ],
        }) as any[];
        const distribution = await mongo({
          action: "aggregate",
          collection: "diarizations",
          pipeline: [{ $match: { runId: input.runId } }, {
            $group: { _id: "$speakerIdentity.state", count: { $sum: 1 } },
          }],
        });
        return {
          run,
          stats: stats ?? null,
          identityDistribution: distribution,
        };
      }
      case "mark-run-failed": {
        const result = await mongo({
          action: "updateOne",
          collection: "diarization_runs",
          query: { runId: input.runId, status: "building" },
          update: {
            $set: {
              status: "failed",
              failedAt: new Date(),
              failureReason: "Marked failed by operator after interruption",
            },
          },
        });
        if ((result as any).matchedCount !== 1) {
          throw new Error(
            "Only a building/interrupted run can be marked failed",
          );
        }
        return { success: true, runId: input.runId };
      }
      case "activation-preview":
        return await computeActivationPreview(mongo, input.runId);
      case "activate-run": {
        // All activation previews and writes are serialized. Two different
        // ready runs may overlap the same active predecessor; a per-run claim
        // cannot prevent both from becoming active concurrently.
        return await redlock.using(
          ["mycelia:lock:diarization-activation"],
          120_000,
          async (signal) => {
            assertActivationLock(signal, "activation preview");
            const preview = await computeActivationPreview(mongo, input.runId);
            assertActivationPreviewSafe(preview as any);
            assertActivationLock(signal, "activation claim");
            const run = await mongo({
              action: "findOne",
              collection: "diarization_runs",
              query: { runId: input.runId },
            }) as any;
            if (!run) throw new Error("Run not found");
            const now = new Date();
            const activationId = run.activationProvenance?.activationId ??
              `activate:${input.runId}:${now.toISOString()}`;
            assertActivationLock(signal, "activation claim write");
            const activationClaim = await mongo({
              action: "updateOne",
              collection: "diarization_runs",
              query: {
                runId: input.runId,
                status: { $in: ["ready", "active", "superseded"] },
              },
              update: {
                $set: {
                  activationProvenance: {
                    activationId,
                    state: "activating",
                    replacementRunIds: preview.replacementRunIds,
                    previewCounts: preview.counts,
                    startedAt: run.activationProvenance?.startedAt ?? now,
                  },
                  updatedAt: now,
                },
              },
            }) as any;
            if (Number(activationClaim.matchedCount ?? 0) !== 1) {
              throw new Error(
                "Activation source changed before it could be claimed; preview again",
              );
            }
            let sourceMembershipMutated = false;
            try {
              // Activate the replacement first. A short overlap is safer than a
              // Timeline gap and makes the operation resume-safe after interruption.
              assertActivationLock(signal, "replacement activation");
              const activated = await mongo({
                action: "updateMany",
                collection: "diarizations",
                query: {
                  runId: input.runId,
                  start: { $lt: preview.range.end },
                  end: { $gt: preview.range.start },
                },
                update: { $set: { lifecycleStatus: "active" } },
              }) as any;
              sourceMembershipMutated = true;
              if (
                Number(activated.matchedCount ?? 0) !==
                  preview.counts.targetSegmentsInRange
              ) {
                throw new Error(
                  "Activation stopped before superseding old coverage because the target segment count changed",
                );
              }
              assertActivationLock(signal, "predecessor supersession");
              if (preview.replacementRunIds.length > 0) {
                await mongo({
                  action: "updateMany",
                  collection: "diarizations",
                  query: {
                    runId: { $in: preview.replacementRunIds },
                    lifecycleStatus: "active",
                    start: { $lt: preview.range.end },
                    end: { $gt: preview.range.start },
                  },
                  update: { $set: { lifecycleStatus: "superseded" } },
                });
              }
              for (const oldRunId of preview.replacementRunIds) {
                assertActivationLock(signal, `run ${oldRunId} supersession`);
                const remainingActive = Number(
                  await mongo({
                    action: "count",
                    collection: "diarizations",
                    query: { runId: oldRunId, lifecycleStatus: "active" },
                  }),
                );
                await mongo({
                  action: "updateOne",
                  collection: "diarization_runs",
                  query: { runId: oldRunId },
                  update: remainingActive === 0
                    ? {
                      $set: {
                        status: "superseded",
                        supersededAt: now,
                        supersededBy: input.runId,
                        updatedAt: now,
                      },
                    }
                    : {
                      $set: { status: "active", updatedAt: now },
                      $push: {
                        partialSupersessions: {
                          runId: input.runId,
                          start: preview.range.start,
                          end: preview.range.end,
                          activatedAt: now,
                        },
                      },
                    },
                });
              }
              assertActivationLock(signal, "activation completion");
              await mongo({
                action: "updateOne",
                collection: "diarization_runs",
                query: {
                  runId: input.runId,
                  "activationProvenance.activationId": activationId,
                },
                update: {
                  $set: {
                    status: "active",
                    activatedAt: run.activatedAt ?? now,
                    "activationProvenance.state": "completed",
                    "activationProvenance.completedAt": now,
                    "activationProvenance.activatedSegments": Number(
                      activated.modifiedCount ?? activated.matchedCount ?? 0,
                    ),
                    updatedAt: now,
                  },
                },
              });
              return {
                success: true,
                runId: input.runId,
                activationId,
                counts: preview.counts,
                replacementRunIds: preview.replacementRunIds,
              };
            } finally {
              if (sourceMembershipMutated) {
                await markIdentitySourceIndexCounting(
                  mongo,
                  `diarization_activation:${input.runId}`,
                  { membershipChanged: true },
                );
              }
            }
          },
        );
      }
      case "repair-empty-activation-preview": {
        if (input.runId) {
          return await computeEmptyActivationRepairPreview(mongo, input.runId);
        }
        const activeRuns = await mongo({
          action: "find",
          collection: "diarization_runs",
          query: { status: "active" },
          options: { sort: { activatedAt: -1 }, limit: 100 },
        }) as any[];
        const previews = [];
        for (const activeRun of activeRuns) {
          const preview = await computeEmptyActivationRepairPreview(
            mongo,
            activeRun.runId,
          );
          if (preview.counts.targetSegments === 0) previews.push(preview);
        }
        return {
          repairs: previews,
          repairable: previews.filter((preview) => preview.repairable).length,
        };
      }
      case "repair-empty-activation": {
        return await redlock.using(
          ["mycelia:lock:diarization-activation"],
          120_000,
          async (signal) => {
            assertActivationLock(signal, "empty-activation repair preview");
            const preview = await computeEmptyActivationRepairPreview(
              mongo,
              input.runId,
            );
            if (!preview.repairable || !preview.confirmation) {
              throw new Error(preview.summary);
            }
            if (input.confirmation !== preview.confirmation) {
              throw new Error(
                "Confirmation does not match the latest repair preview",
              );
            }
            const plan = buildEmptyActivationRepairPlan(preview);
            const results: Array<
              { key: string; matched: number; modified: number }
            > = [];
            let sourceMembershipMutated = false;
            try {
              for (const operation of plan.operations) {
                assertActivationLock(signal, `repair step ${operation.key}`);
                const result = await mongo({
                  action: operation.action,
                  collection: operation.collection,
                  query: operation.query,
                  update: operation.update,
                }) as any;
                const matched = Number(result.matchedCount ?? 0);
                const modified = Number(result.modifiedCount ?? 0);
                if (operation.collection === "diarizations") {
                  sourceMembershipMutated = true;
                }
                if (matched !== operation.expectedMatches) {
                  throw new Error(
                    `Repair stopped at ${operation.key}: expected ${operation.expectedMatches} records, matched ${matched}. Preview again before retrying.`,
                  );
                }
                results.push({ key: operation.key, matched, modified });
              }
              assertActivationLock(signal, "repair completion");
              return {
                success: true,
                repairId: plan.repairId,
                runId: input.runId,
                restoredSegments: preview.counts.recoverableSupersededSegments,
                replacementRunIds: preview.replacementRunIds,
                results,
                deleted: 0,
              };
            } finally {
              if (sourceMembershipMutated) {
                await markIdentitySourceIndexCounting(
                  mongo,
                  `diarization_activation_repair:${input.runId}`,
                  { membershipChanged: true },
                );
              }
            }
          },
        );
      }
      case "preview-purge": {
        return await redlock.using(
          ["mycelia:lock:diarization-activation"],
          120_000,
          async (signal) => {
            assertActivationLock(signal, "diarization purge preview");
            const preview = await computeRunPurgePreview(mongo, input.runId);
            assertActivationLock(
              signal,
              "diarization purge preview completion",
            );
            return {
              ...preview,
              preserves: ["raw audio", "transcripts", "manual annotations"],
            };
          },
        );
      }
      case "purge-superseded": {
        return await redlock.using(
          ["mycelia:lock:diarization-activation"],
          120_000,
          async (signal) => {
            assertActivationLock(signal, "diarization purge validation");
            const current = await computeRunPurgePreview(mongo, input.runId);
            assertRunPurgeSnapshotCurrent(
              {
                ...current,
                snapshotFingerprint: input.snapshotFingerprint,
                confirmation: input.confirmation,
              },
              current,
              input.confirmation,
            );

            const queries = buildRunPurgeQueries(input.runId);
            assertActivationLock(signal, "diarization purge write");
            const deleted = await mongo({
              action: "deleteMany",
              collection: "diarizations",
              query: queries.deletable,
            }) as any;
            const deletedCount = Number(deleted?.deletedCount ?? 0);
            if (deletedCount !== current.documents) {
              throw new Error(
                `Diarization purge removed ${deletedCount} of ${current.documents} previewed documents; preview the remaining data again`,
              );
            }
            // The identity source index contains active diarizations only.
            // Purge deletes only non-active documents, so it must not advance
            // membershipRevision or make the active source index dirty.
            assertActivationLock(signal, "diarization purge metadata");
            const marked = await mongo({
              action: "updateOne",
              collection: "diarization_runs",
              query: {
                runId: input.runId,
                status: current.status,
                purgedAt: { $in: [null] },
              },
              update: {
                $set: {
                  purgedAt: new Date(),
                  purgedDocuments: deletedCount,
                  purgedEmbeddings: current.embeddings,
                  purgeSnapshotFingerprint: current.snapshotFingerprint,
                  purgePreserved: [
                    "raw audio",
                    "transcripts",
                    "manual annotations",
                  ],
                },
              },
            }) as any;
            if (Number(marked?.matchedCount ?? 0) !== 1) {
              throw new Error(
                "Diarization run changed while purge completed; inspect the run before retrying",
              );
            }
            assertActivationLock(signal, "diarization purge completion");
            return {
              runId: input.runId,
              deletedCount,
              embeddings: current.embeddings,
              preserved: [
                "raw audio",
                "transcripts",
                "manual annotations",
              ],
            };
          },
        );
      }
    }
  }
}
