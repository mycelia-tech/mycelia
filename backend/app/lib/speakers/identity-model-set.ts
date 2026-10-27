export type IdentityEvaluationState = "matched" | "rejected" | "uncertain";

export type IdentityResolution =
  | "identified"
  | "ambiguous"
  | "uncertain"
  | "unknown"
  | "unclassified";

export interface IdentityProfileSnapshot {
  profileId: string;
  profileRevision: number;
  calibrationId: string;
  embeddingSpaceId: string;
  evidenceSnapshotHash?: string;
}

export interface IdentityModelSetSourceSnapshot {
  buildId: string;
  revision: number;
  membershipRevision: number;
  builtAt?: Date | string;
  maxSegmentId?: string | null;
}

export interface IdentityModelSetPartition {
  runId: string;
  embeddingSpaceId: string;
  sourceSegments: number;
  maxSegmentId: string;
  start?: Date | string;
  end?: Date | string;
}

export type IdentityModelSetStatus =
  | "building"
  | "ready"
  | "active"
  | "superseded"
  | "failed";

export interface IdentityModelSetCoverage {
  totalSegments: number;
  projectedSegments: number;
}

export interface SpeakerIdentityEvaluation {
  profileId: string;
  profileRevision: number;
  calibrationId: string;
  embeddingSpaceId: string;
  state: IdentityEvaluationState;
  score: number;
  positiveThreshold: number;
  negativeThreshold: number;
  matcherVersion?: string;
  scoringStrategy?: string;
}

export interface ManualIdentityOverride {
  profileId?: string | null;
  excludedProfileIds?: string[];
  disposition?: "speaker" | "noise_or_unclear";
}

export interface SpeakerIdentityCandidate {
  profileId: string;
  profileRevision: number;
  calibrationId: string;
  state: IdentityEvaluationState;
  score: number;
}

export interface SpeakerIdentityProjection {
  resolution: IdentityResolution;
  profileId: string | null;
  candidates: SpeakerIdentityCandidate[];
  source: "automatic" | "manual_projection";
  complete: boolean;
  evaluatedProfiles: number;
  expectedProfiles: number;
  topTwoMargin: number | null;
}

export function buildNextModelSetProfiles(
  activeProfiles: IdentityProfileSnapshot[],
  replacement: IdentityProfileSnapshot,
): IdentityProfileSnapshot[] {
  const next = activeProfiles.filter((profile) =>
    profile.profileId !== replacement.profileId
  );
  next.push(replacement);
  const spaces = new Set(next.map((profile) => profile.embeddingSpaceId));
  if (spaces.size !== 1) {
    throw new Error(
      "An identity model set requires one shared embedding space",
    );
  }
  return next;
}

export function modelSetCanActivate(
  status: IdentityModelSetStatus,
  coverage: IdentityModelSetCoverage,
): boolean {
  return status === "ready" && coverage.totalSegments > 0 &&
    coverage.projectedSegments === coverage.totalSegments;
}

export function identityModelSetActivationBlockers(modelSet: {
  status: IdentityModelSetStatus;
  coverage?: Partial<IdentityModelSetCoverage> | null;
  scope?: { mode?: string } | null;
}): string[] {
  const coverage = {
    totalSegments: Number(modelSet.coverage?.totalSegments ?? 0),
    projectedSegments: Number(modelSet.coverage?.projectedSegments ?? 0),
  };
  const blockers: string[] = [];
  if (modelSet.status !== "ready") blockers.push("model_set_not_ready");
  if (modelSet.scope?.mode !== "all_compatible") {
    blockers.push("model_set_not_full_history");
  }
  if (coverage.totalSegments <= 0) blockers.push("model_set_has_no_segments");
  if (coverage.projectedSegments !== coverage.totalSegments) {
    blockers.push("model_set_coverage_incomplete");
  }
  return blockers;
}

function canonicalDate(value: Date | string | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, current]) => current !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${
      entries.map(([key, current]) =>
        `${JSON.stringify(key)}:${canonicalJson(current)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable identity for a frozen model-set build. A later source append gets a
 * different build/revision while a membership replacement also changes the
 * membership revision. Sorting makes equivalent multi-profile selections
 * reuse the same derived set regardless of UI ordering.
 */
export async function identityModelSetFingerprint(input: {
  profiles: IdentityProfileSnapshot[];
  sourceSnapshot: IdentityModelSetSourceSnapshot;
  partitions: IdentityModelSetPartition[];
  scope: {
    mode: "all_compatible" | "range";
    start?: Date | string;
    end?: Date | string;
  };
  snapshotCutoff: Date | string;
}): Promise<string> {
  const payload = {
    profiles: [...input.profiles].sort((left, right) =>
      left.profileId.localeCompare(right.profileId)
    ).map((profile) => ({
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      calibrationId: profile.calibrationId,
      embeddingSpaceId: profile.embeddingSpaceId,
      evidenceSnapshotHash: profile.evidenceSnapshotHash ?? null,
    })),
    sourceSnapshot: {
      buildId: input.sourceSnapshot.buildId,
      revision: input.sourceSnapshot.revision,
      membershipRevision: input.sourceSnapshot.membershipRevision,
      maxSegmentId: input.sourceSnapshot.maxSegmentId ?? null,
    },
    partitions: [...input.partitions].sort((left, right) =>
      `${left.runId}\u0000${left.embeddingSpaceId}`.localeCompare(
        `${right.runId}\u0000${right.embeddingSpaceId}`,
      )
    ).map((partition) => ({
      runId: partition.runId,
      embeddingSpaceId: partition.embeddingSpaceId,
      sourceSegments: partition.sourceSegments,
      maxSegmentId: partition.maxSegmentId,
      start: canonicalDate(partition.start),
      end: canonicalDate(partition.end),
    })),
    scope: {
      mode: input.scope.mode,
      start: canonicalDate(input.scope.start),
      end: canonicalDate(input.scope.end),
    },
  };
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function evaluationMatchesSnapshot(
  evaluation: SpeakerIdentityEvaluation,
  snapshot: IdentityProfileSnapshot,
): boolean {
  return evaluation.profileId === snapshot.profileId &&
    evaluation.profileRevision === snapshot.profileRevision &&
    evaluation.calibrationId === snapshot.calibrationId &&
    evaluation.embeddingSpaceId === snapshot.embeddingSpaceId;
}

function candidateFromEvaluation(
  evaluation: SpeakerIdentityEvaluation,
): SpeakerIdentityCandidate {
  return {
    profileId: evaluation.profileId,
    profileRevision: evaluation.profileRevision,
    calibrationId: evaluation.calibrationId,
    state: evaluation.state,
    score: evaluation.score,
  };
}

/**
 * Resolve the identity visible for one segment in one immutable model set.
 *
 * A projection is automatic only after every frozen profile snapshot has an
 * evaluation. This prevents a partly-built model set from exposing a false
 * winner before the remaining profiles have been checked. Manual annotations
 * are authoritative, while automatic candidates are retained for audit.
 */
export function resolveIdentityProjection(input: {
  profileSnapshots: IdentityProfileSnapshot[];
  evaluations: SpeakerIdentityEvaluation[];
  manual?: ManualIdentityOverride | null;
}): SpeakerIdentityProjection {
  const snapshotsByProfile = new Map(
    input.profileSnapshots.map((snapshot) => [snapshot.profileId, snapshot]),
  );
  const excluded = new Set(input.manual?.excludedProfileIds ?? []);
  const current = input.evaluations
    .filter((evaluation) => {
      const snapshot = snapshotsByProfile.get(evaluation.profileId);
      return snapshot && evaluationMatchesSnapshot(evaluation, snapshot);
    })
    .map((evaluation) =>
      excluded.has(evaluation.profileId)
        ? { ...evaluation, state: "rejected" as const }
        : evaluation
    );

  const byProfile = new Map<string, SpeakerIdentityEvaluation>();
  for (const evaluation of current) {
    const previous = byProfile.get(evaluation.profileId);
    if (!previous || evaluation.score > previous.score) {
      byProfile.set(evaluation.profileId, evaluation);
    }
  }
  const evaluations = [...byProfile.values()];
  const allCandidates = evaluations
    .map(candidateFromEvaluation)
    .sort((left, right) => right.score - left.score);
  const topTwoMargin = allCandidates.length > 1
    ? allCandidates[0].score - allCandidates[1].score
    : null;

  if (
    input.manual?.disposition !== "noise_or_unclear" &&
    input.manual?.profileId
  ) {
    return {
      resolution: "identified",
      profileId: input.manual.profileId,
      candidates: allCandidates,
      source: "manual_projection",
      complete: true,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }

  if (input.manual?.disposition === "noise_or_unclear") {
    return {
      resolution: "unknown",
      profileId: null,
      candidates: allCandidates,
      source: "manual_projection",
      complete: true,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }

  const complete = input.profileSnapshots.length > 0 &&
    evaluations.length === input.profileSnapshots.length;
  if (!complete) {
    return {
      resolution: "unclassified",
      profileId: null,
      candidates: allCandidates,
      source: "automatic",
      complete: false,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }

  const matched = allCandidates.filter((candidate) =>
    candidate.state === "matched"
  );
  if (matched.length === 1) {
    return {
      resolution: "identified",
      profileId: matched[0].profileId,
      candidates: matched,
      source: "automatic",
      complete: true,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }
  if (matched.length > 1) {
    return {
      resolution: "ambiguous",
      profileId: null,
      candidates: matched,
      source: "automatic",
      complete: true,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }
  if (allCandidates.some((candidate) => candidate.state === "uncertain")) {
    return {
      resolution: "uncertain",
      profileId: null,
      candidates: allCandidates.filter((candidate) =>
        candidate.state === "uncertain"
      ),
      source: "automatic",
      complete: true,
      evaluatedProfiles: evaluations.length,
      expectedProfiles: input.profileSnapshots.length,
      topTwoMargin,
    };
  }
  return {
    resolution: "unknown",
    profileId: null,
    candidates: allCandidates,
    source: "automatic",
    complete: true,
    evaluatedProfiles: evaluations.length,
    expectedProfiles: input.profileSnapshots.length,
    topTwoMargin,
  };
}
