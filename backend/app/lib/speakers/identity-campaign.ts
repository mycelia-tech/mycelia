import { ObjectId } from "bson";

export type IdentityClassificationPolicy = "full" | "pilot";

export interface IdentityCalibrationSnapshot {
  calibrationId: string;
  profileId: string;
  profileRevision: number;
  embeddingSpaceId: string;
  classificationPolicy: IdentityClassificationPolicy;
  evidenceSnapshotHash: string;
}

export interface IdentityScope {
  mode: "all_compatible" | "range";
  start?: Date;
  end?: Date;
}

export interface IdentityPartition {
  runId: string;
  embeddingSpaceId: string;
  start: Date;
  end: Date;
  eligibleSegments: number;
  sourceSegments: number;
  /** Full partition count in the materialized source snapshot. */
  indexedSourceSegments?: number;
  /** Source-index identity used to reject stale preflight tokens. */
  sourceBuildId?: string;
  sourceRevision?: number;
  maxSegmentId?: string;
  generation?: number | null;
}

export interface IdentitySourceSnapshot {
  buildId: string;
  revision: number;
  membershipRevision: number;
  builtAt: Date;
  maxSegmentId?: string | null;
}

export function identityPartitionKey(
  partition: Pick<IdentityPartition, "runId" | "embeddingSpaceId">,
): string {
  return `${partition.runId}\u0000${partition.embeddingSpaceId}`;
}

/**
 * A completed campaign is a materialized baseline only when it really reached
 * zero remaining work. Older campaigns could report `completed` while still
 * carrying pending segments, so they must never suppress a new campaign.
 */
export function isCompleteIdentityCampaign(campaign: any): boolean {
  return campaign?.status === "completed" &&
    Number(campaign?.pendingSegments ?? -1) === 0 &&
    campaign?.sourceChanged !== true;
}

export function remainingIdentityPartitionSegments(
  sourceSegments: number,
  baselineSegments: number,
): number {
  return Math.max(
    Math.max(0, Math.trunc(sourceSegments)) -
      Math.max(0, Math.trunc(baselineSegments)),
    0,
  );
}

export function buildCurrentIdentityCondition(
  snapshot: IdentityCalibrationSnapshot,
): Record<string, unknown> {
  const profileId = ObjectId.isValid(snapshot.profileId)
    ? new ObjectId(snapshot.profileId)
    : snapshot.profileId;
  return {
    "speakerIdentity.calibrationId": snapshot.calibrationId,
    "speakerIdentity.profileRevision": snapshot.profileRevision,
    "speakerIdentity.embeddingSpaceId": snapshot.embeddingSpaceId,
    "speakerIdentity.source": "automatic",
    "speakerIdentity.validity": snapshot.classificationPolicy === "full"
      ? "verified"
      : "provisional",
    $or: [
      { "speakerIdentity.profileId": profileId },
      { "speakerIdentity.topCandidate.profileId": profileId },
    ],
  };
}

export function buildIdentitySourceMatch(
  snapshot: IdentityCalibrationSnapshot,
  scope: IdentityScope,
  snapshotCutoff: Date,
): Record<string, unknown> {
  const start: Record<string, Date> = { $lt: snapshotCutoff };
  if (scope.mode === "range") {
    if (!scope.start || !scope.end || scope.end <= scope.start) {
      throw new Error("A custom identity range requires start before end");
    }
    start.$gte = scope.start;
    if (scope.end < snapshotCutoff) start.$lt = scope.end;
  }
  return {
    lifecycleStatus: "active",
    embeddingSpaceId: snapshot.embeddingSpaceId,
    embedding: { $exists: true },
    start,
  };
}

export function buildIdentityEligibleMatch(
  snapshot: IdentityCalibrationSnapshot,
  scope: IdentityScope,
  snapshotCutoff: Date,
): Record<string, unknown> {
  return {
    ...buildIdentitySourceMatch(snapshot, scope, snapshotCutoff),
    $nor: [buildCurrentIdentityCondition(snapshot)],
  };
}

export function buildIdentityPartitionPipeline(
  snapshot: IdentityCalibrationSnapshot,
  scope: IdentityScope,
  snapshotCutoff: Date,
): Record<string, unknown>[] {
  return [
    { $match: buildIdentityEligibleMatch(snapshot, scope, snapshotCutoff) },
    {
      $group: {
        _id: {
          runId: "$runId",
          embeddingSpaceId: "$embeddingSpaceId",
        },
        eligibleSegments: { $sum: 1 },
        start: { $min: "$start" },
        end: { $max: "$end" },
      },
    },
    { $match: { eligibleSegments: { $gt: 0 } } },
    { $sort: { start: 1, "_id.runId": 1 } },
  ];
}

export function normalizeIdentityScope(input: {
  mode: "all_compatible" | "range";
  start?: Date | string;
  end?: Date | string;
}): IdentityScope {
  if (input.mode === "all_compatible") return { mode: "all_compatible" };
  const start = input.start ? new Date(input.start) : undefined;
  const end = input.end ? new Date(input.end) : undefined;
  if (!start || !end || end <= start) {
    throw new Error("A custom identity range requires start before end");
  }
  return { mode: "range", start, end };
}

export function buildIdentityPartitionQuery(
  partition: Pick<IdentityPartition, "runId" | "embeddingSpaceId">,
  snapshot: IdentityCalibrationSnapshot,
  scope: IdentityScope,
  snapshotCutoff: Date,
): Record<string, unknown> {
  return {
    ...buildIdentityEligibleMatch(snapshot, scope, snapshotCutoff),
    runId: partition.runId,
    embeddingSpaceId: partition.embeddingSpaceId,
  };
}

export function identityCampaignKey(input: {
  profileId: string;
  calibrationId: string;
  snapshotCutoff: Date;
  scope: IdentityScope;
}): string {
  const profile = ObjectId.isValid(input.profileId)
    ? input.profileId
    : String(input.profileId);
  return [
    profile,
    input.calibrationId,
    input.snapshotCutoff.toISOString(),
    input.scope.mode,
    input.scope.start?.toISOString() ?? "",
    input.scope.end?.toISOString() ?? "",
  ].join(":");
}
