import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiClient, callResource } from "@/lib/api";
import { normalizeObjectId } from "@/lib/diarization";
import {
  buildTimelineSampleMetadata,
  orderVoiceProfilesByRecent,
  readRecentVoiceProfileIds,
  rememberVoiceProfile,
  type VoiceProfileAttachTarget,
} from "@/lib/voiceProfiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { voiceIdentityKeys } from "@/lib/voiceIdentity";

interface ProfileDocument {
  _id: unknown;
  name: string;
  is_primary?: boolean;
}

const getProfileDocumentId = (profile: ProfileDocument) =>
  normalizeObjectId(profile._id) ?? "";

type SavedTimelineSample = {
  fileId: string;
  target: VoiceProfileAttachTarget;
};

class ProfileQueueError extends Error {}

interface AddTimelineVoiceSampleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startDate: Date;
  endDate: Date;
  originalId?: string;
  source?: "timeline_selection" | "review_selection";
  initialProfileId?: string | null;
  onProfileSelected?: (profileId: string) => void;
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function AddTimelineVoiceSampleDialog({
  open,
  onOpenChange,
  startDate,
  endDate,
  originalId,
  source = "timeline_selection",
  initialProfileId,
  onProfileSelected,
}: AddTimelineVoiceSampleDialogProps) {
  const queryClient = useQueryClient();
  const [profileId, setProfileId] = useState("");
  const [profileMode, setProfileMode] = useState<"existing" | "new">(
    "existing",
  );
  const [newProfileName, setNewProfileName] = useState("");
  const [recentProfileIds, setRecentProfileIds] = useState(
    readRecentVoiceProfileIds,
  );
  const [savedSample, setSavedSample] = useState<SavedTimelineSample | null>(
    null,
  );
  const [queueError, setQueueError] = useState<string | null>(null);
  const durationSeconds = Math.max(
    0,
    (endDate.getTime() - startDate.getTime()) / 1000,
  );
  const rangeProblem = durationSeconds < 3
    ? "Select at least 3 seconds of clear speech."
    : durationSeconds > 120
    ? "Select no more than 2 minutes; 10–30 seconds of one clear speaker works best."
    : null;
  const sourceOriginalId = originalId?.trim() ?? "";
  const provenanceProblem = sourceOriginalId
    ? null
    : "This selection is not tied to one source recording. Save a sample from a specific speaker interval in Voice Identity review.";
  const selectionProblem = rangeProblem ?? provenanceProblem;

  const { data: profiles = [], isLoading, error } = useQuery<ProfileDocument[]>(
    {
      queryKey: ["speaker_profiles", "timeline-sample"],
      enabled: open,
      queryFn: () =>
        callResource("mongo", {
          action: "find",
          collection: "speaker_profiles",
          query: {},
          options: { sort: { is_primary: -1, name: 1 } },
        }) as Promise<ProfileDocument[]>,
    },
  );

  const orderedProfiles = useMemo(
    () =>
      orderVoiceProfilesByRecent(
        profiles,
        getProfileDocumentId,
        recentProfileIds,
      ),
    [profiles, recentProfileIds],
  );

  useEffect(() => {
    if (!open || profileId || profiles.length === 0) return;
    const preferred = profiles.find((profile) =>
      getProfileDocumentId(profile) === initialProfileId
    ) ?? orderedProfiles[0] ??
      profiles.find((profile) =>
        profile.is_primary
      ) ?? profiles[0];
    setProfileId(getProfileDocumentId(preferred));
  }, [initialProfileId, open, orderedProfiles, profileId, profiles]);

  useEffect(() => {
    if (open && !isLoading && profiles.length === 0) setProfileMode("new");
  }, [isLoading, open, profiles.length]);

  const selectedProfile = useMemo(() => {
    const profile = profiles.find((item) =>
      getProfileDocumentId(item) === profileId
    );
    if (!profile) return null;
    return {
      id: profileId,
      name: profile.name,
      isPrimary: Boolean(profile.is_primary),
    } satisfies VoiceProfileAttachTarget;
  }, [profileId, profiles]);

  const addSample = useMutation({
    mutationFn: async () => {
      if (selectionProblem) throw new Error(selectionProblem);
      let uploaded = savedSample;
      if (!uploaded) {
        let target = selectedProfile;
        let createdProfile = false;
        if (profileMode === "new") {
          const name = newProfileName.trim();
          if (!name) throw new Error("Enter a name for the new speaker.");
          const profile = await callResource("speaker-segments", {
            action: "create-profile",
            name,
          }) as ProfileDocument;
          const id = getProfileDocumentId(profile);
          if (!id) throw new Error("New speaker profile has no valid ID.");
          target = { id, name: profile.name, isPrimary: false };
          createdProfile = true;
        }
        if (!target) {
          throw new Error("Choose a voice profile or create a new speaker.");
        }
        try {
          const query = new URLSearchParams({
            start: startDate.toISOString(),
            end: endDate.toISOString(),
          });
          query.set("original_id", sourceOriginalId);
          const wav = await apiClient.getBlob(`/api/audio/wav?${query}`);
          const upload = await apiClient.post<{ file_id: string }>(
            "/api/files/upload",
            {
              file: await blobToBase64(wav),
              filename: `timeline_voice_${startDate.toISOString()}.wav`,
              mimetype: "audio/wav",
              bucket: "voice_samples",
              metadata: buildTimelineSampleMetadata(
                target,
                startDate,
                endDate,
                sourceOriginalId,
                source,
              ),
            },
          );
          if (!upload.file_id) throw new Error("Audio sample was not saved.");
          uploaded = { fileId: upload.file_id, target };
          setSavedSample(uploaded);
          onProfileSelected?.(target.id);
          setRecentProfileIds(rememberVoiceProfile(target.id));
          void queryClient.invalidateQueries({ queryKey: ["voice_samples"] });
          void queryClient.invalidateQueries({
            queryKey: voiceIdentityKeys.profiles,
          });
        } catch (error) {
          if (createdProfile) {
            throw new Error(
              `${target.name} was created, but its audio sample was not saved. Select the existing profile and retry. ${
                error instanceof Error ? error.message : ""
              }`.trim(),
            );
          }
          throw error;
        }
      }

      setQueueError(null);
      try {
        return await callResource("jobs", {
          action: "enqueue",
          data: {
            type: "profileReenrollment",
            profileId: uploaded.target.id,
          },
          trigger: {
            type: "manual",
            reason: "Add Timeline selection to voice profile",
          },
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "The profile rebuild could not be queued.";
        setQueueError(message);
        throw new ProfileQueueError(message);
      }
    },
    onSuccess: () => {
      toast.success("Voice sample saved; profile rebuild queued", {
        description: "Track the profile re-enrollment job on the Jobs page.",
      });
      void queryClient.invalidateQueries({ queryKey: ["voice_samples"] });
      void queryClient.invalidateQueries({
        queryKey: voiceIdentityKeys.profiles,
      });
      void queryClient.invalidateQueries({
        queryKey: ["speaker_profiles", "timeline-sample"],
      });
      setNewProfileName("");
      setProfileMode("existing");
      setSavedSample(null);
      setQueueError(null);
      onOpenChange(false);
    },
    onError: (mutationError) => {
      if (mutationError instanceof ProfileQueueError) {
        toast.warning("Voice sample saved; profile update is waiting", {
          description:
            "The audio will not be uploaded again. Retry when a diarizator slot is free.",
        });
        return;
      }
      toast.error("Could not add Timeline sample", {
        description: mutationError instanceof Error
          ? mutationError.message
          : "Unknown error",
      });
    },
  });

  const closeDialog = () => {
    if (addSample.isPending) return;
    setSavedSample(null);
    setQueueError(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else closeDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add selection as voice sample</DialogTitle>
          <DialogDescription>
            Saves this audio clip in the selected profile, then rebuilds that
            profile embedding. The source interval stays attached for review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div>{startDate.toLocaleString()}</div>
            <div>{endDate.toLocaleString()}</div>
            <div className="mt-1 text-muted-foreground">
              {durationSeconds.toFixed(1)} seconds selected
            </div>
          </div>
          <div className="space-y-2">
            <Label>Speaker</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={profileMode === "existing" ? "default" : "outline"}
                onClick={() => setProfileMode("existing")}
                disabled={profiles.length === 0 || addSample.isPending ||
                  Boolean(savedSample)}
              >
                Existing profile
              </Button>
              <Button
                type="button"
                variant={profileMode === "new" ? "default" : "outline"}
                onClick={() => setProfileMode("new")}
                disabled={addSample.isPending || Boolean(savedSample)}
              >
                New speaker
              </Button>
            </div>
            {profileMode === "existing"
              ? (
                <Select
                  value={profileId}
                  onValueChange={setProfileId}
                  disabled={isLoading || addSample.isPending ||
                    Boolean(savedSample)}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={isLoading
                        ? "Loading profiles…"
                        : "Select profile"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {orderedProfiles.filter(getProfileDocumentId).map((
                      profile,
                    ) => (
                      <SelectItem
                        key={getProfileDocumentId(profile)}
                        value={getProfileDocumentId(profile)}
                      >
                        {profile.name}
                        {profile.is_primary ? " — My Voice" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
              : (
                <Input
                  value={newProfileName}
                  onChange={(event) => setNewProfileName(event.target.value)}
                  placeholder="Speaker name, e.g. Andrew Kislov"
                  disabled={addSample.isPending || Boolean(savedSample)}
                  aria-label="New speaker name"
                  autoFocus
                />
              )}
          </div>
          {(selectionProblem || error) && (
            <p className="text-sm text-destructive">
              {selectionProblem ?? "Voice profiles could not be loaded."}
            </p>
          )}
          {savedSample && queueError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">
                Audio saved and linked to {savedSample.target.name}
              </p>
              <p className="mt-1 text-muted-foreground">
                The profile update was not queued. Retry below when the
                diarizator is available; this clip will not be uploaded twice.
              </p>
              <p className="mt-2 break-words text-xs text-muted-foreground">
                {queueError}
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={closeDialog}
            disabled={addSample.isPending}
          >
            {savedSample ? "Close" : "Cancel"}
          </Button>
          <Button
            onClick={() => addSample.mutate()}
            disabled={addSample.isPending || Boolean(selectionProblem) ||
              (!savedSample && (profileMode === "existing"
                ? !selectedProfile
                : !newProfileName.trim()))}
          >
            {addSample.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {addSample.isPending
              ? savedSample ? "Queueing profile update…" : "Saving audio…"
              : savedSample
              ? "Retry profile update"
              : profileMode === "new"
              ? "Create speaker and save sample"
              : "Save and rebuild profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
