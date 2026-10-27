export const SELECTED_VOICE_PROFILE_STORAGE_KEY =
  "voice-identity-selected-profile";

export function withVoiceProfile(
  destination: string,
  profileId: string | null | undefined,
): string {
  if (!profileId) return destination;

  const hashIndex = destination.indexOf("#");
  const hash = hashIndex >= 0 ? destination.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0
    ? destination.slice(0, hashIndex)
    : destination;
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(search);
  params.set("profileId", profileId);
  return `${path}?${params.toString()}${hash}`;
}

export function resolveSelectedVoiceProfileId(input: {
  requestedProfileId?: string | null;
  storedProfileId?: string | null;
  profiles: Array<{ id: string; isPrimary?: boolean; archived?: boolean }>;
}): {
  selectedProfileId: string | null;
  invalidRequestedProfileId: string | null;
  source: "url" | "storage" | "primary" | "first" | "none";
} {
  const profiles = input.profiles.filter((profile) => !profile.archived);
  const ids = new Set(profiles.map((profile) => profile.id));
  const requested = input.requestedProfileId?.trim() || null;
  if (requested) {
    if (ids.has(requested)) {
      return {
        selectedProfileId: requested,
        invalidRequestedProfileId: null,
        source: "url",
      };
    }
    return {
      selectedProfileId: null,
      invalidRequestedProfileId: requested,
      source: "none",
    };
  }

  const stored = input.storedProfileId?.trim() || null;
  if (stored && ids.has(stored)) {
    return {
      selectedProfileId: stored,
      invalidRequestedProfileId: null,
      source: "storage",
    };
  }
  const primary = profiles.find((profile) => profile.isPrimary);
  if (primary) {
    return {
      selectedProfileId: primary.id,
      invalidRequestedProfileId: null,
      source: "primary",
    };
  }
  if (profiles[0]) {
    return {
      selectedProfileId: profiles[0].id,
      invalidRequestedProfileId: null,
      source: "first",
    };
  }
  return {
    selectedProfileId: null,
    invalidRequestedProfileId: null,
    source: "none",
  };
}
