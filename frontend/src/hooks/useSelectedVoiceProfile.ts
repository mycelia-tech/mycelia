import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { normalizeObjectId } from "@/lib/diarization";
import {
  loadVoiceProfiles,
  voiceIdentityKeys,
  type VoiceProfile,
} from "@/lib/voiceIdentity";
import {
  resolveSelectedVoiceProfileId,
  SELECTED_VOICE_PROFILE_STORAGE_KEY,
} from "@/lib/voiceProfileNavigation";

function readStoredProfileId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_VOICE_PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function isArchived(profile: VoiceProfile): boolean {
  return Boolean(
    profile.archivedAt || profile.lifecycleStatus === "archived" ||
      profile.status === "archived",
  );
}

export function useSelectedVoiceProfile() {
  const [searchParams, setSearchParams] = useSearchParams();
  const profilesQuery = useQuery<VoiceProfile[]>({
    queryKey: voiceIdentityKeys.profiles,
    queryFn: loadVoiceProfiles,
    staleTime: 30_000,
  });
  const profiles = profilesQuery.data ?? [];
  const requestedProfileId = searchParams.get("profileId");
  const resolution = useMemo(
    () =>
      resolveSelectedVoiceProfileId({
        requestedProfileId,
        storedProfileId: readStoredProfileId(),
        profiles: profiles.map((profile) => ({
          id: normalizeObjectId(profile._id) ?? "",
          isPrimary: Boolean(profile.is_primary),
          archived: isArchived(profile),
        })).filter((profile) => profile.id),
      }),
    [profiles, requestedProfileId],
  );
  const selectedProfile =
    profiles.find((profile) =>
      normalizeObjectId(profile._id) === resolution.selectedProfileId
    ) ?? null;

  useEffect(() => {
    if (!resolution.selectedProfileId) return;
    try {
      window.localStorage.setItem(
        SELECTED_VOICE_PROFILE_STORAGE_KEY,
        resolution.selectedProfileId,
      );
    } catch {
      // URL remains authoritative when storage is unavailable.
    }
    if (requestedProfileId) return;
    const next = new URLSearchParams(searchParams);
    next.set("profileId", resolution.selectedProfileId);
    setSearchParams(next, { replace: true });
  }, [
    requestedProfileId,
    resolution.selectedProfileId,
    searchParams,
    setSearchParams,
  ]);

  const selectProfile = (profileId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("profileId", profileId);
    try {
      window.localStorage.setItem(
        SELECTED_VOICE_PROFILE_STORAGE_KEY,
        profileId,
      );
    } catch {
      // URL remains authoritative when storage is unavailable.
    }
    setSearchParams(next);
  };

  return {
    ...profilesQuery,
    profiles,
    selectedProfile,
    selectedProfileId: resolution.selectedProfileId,
    invalidRequestedProfileId: resolution.invalidRequestedProfileId,
    selectionSource: resolution.source,
    selectProfile,
  };
}

export type SelectedVoiceProfile = ReturnType<typeof useSelectedVoiceProfile>;
