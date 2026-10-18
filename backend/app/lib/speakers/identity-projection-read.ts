export type ActiveIdentityModelSet = {
  modelSetId: string;
  embeddingSpaceId: string;
  profileIds: string[];
  staleProfileIds: string[];
};

export type StoredIdentityProjection = {
  modelSetId?: string;
  segmentId?: unknown;
  resolution?: string;
  profileId?: unknown;
  candidates?: Array<{
    profileId?: unknown;
    profileRevision?: number;
    calibrationId?: string;
    state?: string;
    score?: number;
  }>;
  complete?: boolean;
  source?: string;
  topTwoMargin?: number | null;
  projectedAt?: Date | string;
};

function stringId(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function normalizedResolution(value: unknown):
  | "identified"
  | "ambiguous"
  | "unknown"
  | "uncertain"
  | "unclassified" {
  return [
      "identified",
      "ambiguous",
      "unknown",
      "uncertain",
      "unclassified",
    ].includes(String(value))
    ? value as
      | "identified"
      | "ambiguous"
      | "unknown"
      | "uncertain"
      | "unclassified"
    : "unclassified";
}

function legacyState(
  resolution: ReturnType<typeof normalizedResolution>,
): "matched" | "rejected" | "uncertain" {
  if (resolution === "identified") return "matched";
  if (resolution === "unknown") return "rejected";
  return "uncertain";
}

export function selectedProfileProjectionState(input: {
  resolution?: unknown;
  profileId?: unknown;
  candidates?: Array<{ profileId?: unknown; state?: string }>;
  selectedProfileId?: string | null;
  selectedProfileEvaluated: boolean;
}):
  | "identified"
  | "ambiguous"
  | "unknown"
  | "uncertain"
  | "unclassified"
  | null {
  const selectedProfileId = input.selectedProfileId ?? null;
  if (!selectedProfileId || !input.selectedProfileEvaluated) return null;
  const resolution = normalizedResolution(input.resolution);
  if (resolution === "unclassified") return "unclassified";
  if (resolution === "identified") {
    return stringId(input.profileId) === selectedProfileId
      ? "identified"
      : "unknown";
  }
  if (resolution === "ambiguous") {
    return input.candidates?.some((candidate) =>
        candidate.state === "matched" &&
        stringId(candidate.profileId) === selectedProfileId
      )
      ? "ambiguous"
      : "unknown";
  }
  if (resolution === "uncertain") {
    return input.candidates?.some((candidate) =>
        candidate.state === "uncertain" &&
        stringId(candidate.profileId) === selectedProfileId
      )
      ? "uncertain"
      : "unknown";
  }
  return "unknown";
}

/**
 * Convert the immutable projection of the active model set to the compatibility
 * shape consumed by Transcript and detail pages. A missing projection inside
 * an active set is deliberately unclassified; it must never fall through to
 * an older embedded decision.
 */
export function activeProjectionIdentity(input: {
  modelSet: ActiveIdentityModelSet;
  projection?: StoredIdentityProjection | null;
  selectedProfileId?: string | null;
}): Record<string, unknown> {
  const projection = input.projection ?? null;
  const resolution = projection?.complete === false
    ? "unclassified"
    : normalizedResolution(projection?.resolution);
  const candidates = projection?.candidates ?? [];
  const selectedProfilePresent = Boolean(
    input.selectedProfileId &&
      input.modelSet.profileIds.includes(input.selectedProfileId),
  );
  const selectedProfileStale = Boolean(
    input.selectedProfileId &&
      input.modelSet.staleProfileIds.includes(input.selectedProfileId),
  );
  const selectedProfileEvaluated = Boolean(
    selectedProfilePresent && !selectedProfileStale,
  );
  const selectedProfileState = selectedProfileStale
    ? "unclassified"
    : selectedProfileProjectionState({
      resolution,
      profileId: projection?.profileId,
      candidates,
      selectedProfileId: input.selectedProfileId,
      selectedProfileEvaluated,
    });
  return {
    state: legacyState(resolution),
    identityState: resolution,
    resolution,
    profileId: resolution === "identified"
      ? projection?.profileId ?? null
      : null,
    candidates,
    complete: projection?.complete === true,
    modelSetId: input.modelSet.modelSetId,
    embeddingSpaceId: input.modelSet.embeddingSpaceId,
    source: projection?.source === "manual_projection"
      ? "manual_projection"
      : "automatic",
    validity: selectedProfileStale ? "stale" : "verified",
    topTwoMargin: projection?.topTwoMargin ?? null,
    evaluatedAt: projection?.projectedAt ?? null,
    ...(selectedProfilePresent
      ? {
        evaluatedProfileId: input.selectedProfileId,
        selectedProfileState,
      }
      : {}),
  };
}

export function activeModelSetsByEmbeddingSpace(input: {
  heads: Array<{ embeddingSpaceId?: unknown; activeModelSetId?: unknown }>;
  modelSets: Array<{
    modelSetId?: unknown;
    embeddingSpaceId?: unknown;
    profileIds?: unknown[];
    profiles?: Array<{ profileId?: unknown }>;
    staleProfileIds?: unknown[];
    status?: unknown;
  }>;
}): Map<string, ActiveIdentityModelSet> {
  const activeSets = new Map(
    input.modelSets
      .filter((modelSet) => modelSet.status === "active")
      .map((modelSet) => [stringId(modelSet.modelSetId), modelSet] as const),
  );
  const result = new Map<string, ActiveIdentityModelSet>();
  for (const head of input.heads) {
    const embeddingSpaceId = stringId(head.embeddingSpaceId);
    const modelSetId = stringId(head.activeModelSetId);
    const modelSet = activeSets.get(modelSetId);
    if (
      !embeddingSpaceId || !modelSetId || !modelSet ||
      stringId(modelSet.embeddingSpaceId) !== embeddingSpaceId
    ) continue;
    const profileIds = (modelSet.profileIds?.length
      ? modelSet.profileIds
      : modelSet.profiles?.map((profile) =>
        profile.profileId
      ) ?? [])
      .map(stringId)
      .filter(Boolean);
    result.set(embeddingSpaceId, {
      modelSetId,
      embeddingSpaceId,
      profileIds: [...new Set(profileIds)],
      staleProfileIds: [
        ...new Set(
          (modelSet.staleProfileIds ?? []).map(stringId).filter(Boolean),
        ),
      ],
    });
  }
  return result;
}
