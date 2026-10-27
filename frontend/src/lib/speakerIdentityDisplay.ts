import { normalizeObjectId } from "@/lib/diarization";

export type SpeakerProfileDisplay = {
  id: string;
  name: string;
  color?: string;
  archived?: boolean;
};

export type SpeakerIdentityCandidateDisplay = {
  profileId?: unknown;
  name?: string | null;
  score?: number | null;
};

export type SpeakerIdentityDisplayInput = {
  state?: string;
  identityState?: string;
  resolution?: string;
  selectedProfileState?: string;
  modelSetId?: string;
  source?: string;
  profileId?: unknown;
  evaluatedProfileId?: unknown;
  primaryScore?: number | null;
  topCandidate?: SpeakerIdentityCandidateDisplay | null;
  candidates?: SpeakerIdentityCandidateDisplay[];
};

export type LegacyMatchedSpeakerDisplayInput = {
  profile_id?: unknown;
  name?: string | null;
  similarity?: number | null;
};

export type ResolvedSpeakerCandidate = SpeakerProfileDisplay & {
  score: number | null;
};

export type ResolvedSpeakerIdentityDisplay = {
  resolution:
    | "identified"
    | "ambiguous"
    | "rejected"
    | "uncertain"
    | "unclassified";
  label: string;
  profile: SpeakerProfileDisplay | null;
  evaluatedProfile: SpeakerProfileDisplay | null;
  candidates: ResolvedSpeakerCandidate[];
  score: number | null;
  selectedResolution:
    | "identified"
    | "ambiguous"
    | "rejected"
    | "uncertain"
    | "unclassified";
};

export function buildSpeakerProfileDirectory(
  profiles: Array<{
    _id?: unknown;
    id?: unknown;
    name?: string | null;
    color?: string;
    lifecycleStatus?: string;
    archivedAt?: unknown;
  }>,
): Map<string, SpeakerProfileDisplay> {
  return new Map(profiles.flatMap((profile) => {
    const id = normalizeObjectId(profile.id ?? profile._id);
    if (!id || !profile.name) return [];
    return [
      [id, {
        id,
        name: profile.name,
        color: profile.color,
        archived: profile.lifecycleStatus === "archived" ||
          Boolean(profile.archivedAt),
      }] as const,
    ];
  }));
}

function fallbackProfile(
  id: string,
  name?: string | null,
): SpeakerProfileDisplay {
  return { id, name: name?.trim() || `Voice ${id.slice(0, 8)}` };
}

function resolveProfile(
  value: unknown,
  profiles: ReadonlyMap<string, SpeakerProfileDisplay>,
  fallbackName?: string | null,
): SpeakerProfileDisplay | null {
  const id = normalizeObjectId(value);
  if (!id) return null;
  return profiles.get(id) ?? fallbackProfile(id, fallbackName);
}

function finiteScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveCandidates(
  identity: SpeakerIdentityDisplayInput | undefined,
  profiles: ReadonlyMap<string, SpeakerProfileDisplay>,
): ResolvedSpeakerCandidate[] {
  const source = identity?.candidates?.length
    ? identity.candidates
    : identity?.topCandidate
    ? [identity.topCandidate]
    : [];
  const unique = new Map<string, ResolvedSpeakerCandidate>();
  for (const candidate of source) {
    const profile = resolveProfile(
      candidate.profileId,
      profiles,
      candidate.name,
    );
    if (!profile) continue;
    unique.set(profile.id, {
      ...profile,
      score: finiteScore(candidate.score),
    });
  }
  return [...unique.values()];
}

export function resolveSpeakerIdentityDisplay(input: {
  identity?: SpeakerIdentityDisplayInput;
  legacyMatchedSpeaker?: LegacyMatchedSpeakerDisplayInput;
  profiles: ReadonlyMap<string, SpeakerProfileDisplay>;
  selectedProfileId?: string | null;
}): ResolvedSpeakerIdentityDisplay {
  const { identity, legacyMatchedSpeaker, profiles } = input;
  const candidates = resolveCandidates(identity, profiles);
  const selectedProfile = resolveProfile(
    input.selectedProfileId,
    profiles,
  );
  const identityProfile = resolveProfile(identity?.profileId, profiles);
  const legacyProfile = resolveProfile(
    legacyMatchedSpeaker?.profile_id,
    profiles,
    legacyMatchedSpeaker?.name,
  );
  const hasCanonicalIdentity = Boolean(
    identity &&
      (identity.identityState || identity.resolution || identity.state ||
        identity.modelSetId),
  );
  const resolution = identity?.source === "manual_projection"
    ? identity?.state === "matched" || identity?.state === "identified"
      ? "identified"
      : identity?.state === "rejected" || identity?.state === "unknown"
      ? "rejected"
      : identity?.state === "uncertain"
      ? "uncertain"
      : "unclassified"
    : identity?.identityState === "ambiguous" ||
        identity?.resolution === "ambiguous" ||
        identity?.state === "ambiguous"
    ? "ambiguous"
    : identity?.identityState === "identified" ||
        identity?.resolution === "identified" ||
        identity?.state === "matched"
    ? "identified"
    : identity?.identityState === "unknown" ||
        identity?.resolution === "unknown" ||
        identity?.state === "rejected"
    ? "rejected"
    : identity?.identityState === "uncertain" ||
        identity?.resolution === "uncertain" ||
        identity?.state === "uncertain"
    ? "uncertain"
    : !hasCanonicalIdentity && legacyProfile
    ? "identified"
    : "unclassified";
  const evaluatedProfile = resolveProfile(
    identity?.evaluatedProfileId,
    profiles,
  ) ?? candidates.find((candidate) => candidate.id === selectedProfile?.id) ??
    (candidates.length === 1 ? candidates[0] : null) ??
    ((resolution === "rejected" || resolution === "uncertain")
      ? selectedProfile
      : null);

  // A canonical identity profile always wins over the compatibility projection.
  const profile = identityProfile ??
    (resolution === "identified" ? legacyProfile : null);
  const score = finiteScore(identity?.primaryScore) ??
    candidates.find((candidate) => candidate.id === profile?.id)?.score ??
    finiteScore(legacyMatchedSpeaker?.similarity);
  const selectedState = identity?.selectedProfileState;
  const selectedWasEvaluated = Boolean(
    selectedProfile &&
      normalizeObjectId(identity?.evaluatedProfileId) === selectedProfile.id,
  );
  const selectedResolution = !selectedProfile
    ? resolution
    : selectedState === "identified"
    ? "identified"
    : selectedState === "ambiguous"
    ? "ambiguous"
    : selectedState === "unknown" || selectedState === "rejected"
    ? "rejected"
    : selectedState === "uncertain"
    ? "uncertain"
    : selectedState === "unclassified"
    ? "unclassified"
    : identity?.source === "manual_projection"
    ? resolution === "identified" && identityProfile?.id === selectedProfile.id
      ? "identified"
      : resolution === "uncertain"
      ? "uncertain"
      : "rejected"
    : selectedWasEvaluated
    ? resolution === "identified"
      ? identityProfile?.id === selectedProfile.id ? "identified" : "rejected"
      : resolution === "ambiguous"
      ? candidates.some((candidate) => candidate.id === selectedProfile.id)
        ? "ambiguous"
        : "rejected"
      : resolution === "uncertain"
      ? candidates.some((candidate) => candidate.id === selectedProfile.id)
        ? "uncertain"
        : "rejected"
      : resolution === "rejected"
      ? "rejected"
      : "unclassified"
    : resolution === "identified" && identityProfile?.id === selectedProfile.id
    ? "identified"
    : "unclassified";

  if (resolution === "identified") {
    return {
      resolution,
      label: profile?.name ?? "Identified voice",
      profile,
      evaluatedProfile,
      candidates,
      score,
      selectedResolution,
    };
  }
  if (resolution === "ambiguous") {
    return {
      resolution,
      label: candidates.length > 0
        ? `Ambiguous: ${
          candidates.map((candidate) => candidate.name).join(" / ")
        }`
        : "Ambiguous voice",
      profile: null,
      evaluatedProfile,
      candidates,
      score,
      selectedResolution,
    };
  }
  if (resolution === "rejected") {
    return {
      resolution,
      label: evaluatedProfile
        ? `Not ${evaluatedProfile.name}`
        : "Not selected voice",
      profile: null,
      evaluatedProfile,
      candidates,
      score,
      selectedResolution,
    };
  }
  if (resolution === "uncertain") {
    return {
      resolution,
      label: evaluatedProfile
        ? `Uncertain: ${evaluatedProfile.name}`
        : "Uncertain voice",
      profile: null,
      evaluatedProfile,
      candidates,
      score,
      selectedResolution,
    };
  }
  return {
    resolution,
    label: "Unclassified",
    profile: null,
    evaluatedProfile,
    candidates,
    score,
    selectedResolution,
  };
}
