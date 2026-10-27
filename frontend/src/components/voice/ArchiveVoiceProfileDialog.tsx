import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { voiceIdentityKeys } from "@/lib/voiceIdentity";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ArchivePreview = {
  profileId: string;
  profileName: string;
  isPrimary: boolean;
  archivable: boolean;
  blockers: string[];
  references: Record<string, number>;
  retainedReferences: number;
  snapshotFingerprint: string;
  confirmation: string | null;
  preserves: string[];
};

type ProfileOption = { id: string; name: string };

export function ArchiveVoiceProfileDialog(props: {
  profile: ProfileOption & { isPrimary: boolean };
  replacementProfiles: ProfileOption[];
  onArchived?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [replacementPrimaryProfileId, setReplacementPrimaryProfileId] =
    useState("");

  useEffect(() => {
    if (!open) return;
    setReplacementPrimaryProfileId((current) =>
      current || props.replacementProfiles[0]?.id || ""
    );
  }, [open, props.replacementProfiles]);

  const replacementReady = !props.profile.isPrimary ||
    Boolean(replacementPrimaryProfileId);
  const previewQuery = useQuery<ArchivePreview>({
    queryKey: [
      "speaker-profile-archive-preview",
      props.profile.id,
      replacementPrimaryProfileId,
    ],
    enabled: open && replacementReady,
    queryFn: () =>
      callResource("speaker-segments", {
        action: "profile-archive-preview",
        profileId: props.profile.id,
        ...(props.profile.isPrimary && replacementPrimaryProfileId
          ? { replacementPrimaryProfileId }
          : {}),
      }) as Promise<ArchivePreview>,
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const preview = previewQuery.data;
      if (!preview?.confirmation) {
        throw new Error("Preview the latest profile references first");
      }
      return await callResource("speaker-segments", {
        action: "archive-profile",
        profileId: props.profile.id,
        ...(props.profile.isPrimary && replacementPrimaryProfileId
          ? { replacementPrimaryProfileId }
          : {}),
        snapshotFingerprint: preview.snapshotFingerprint,
        confirmation: preview.confirmation,
      });
    },
    onSuccess: () => {
      toast.success(`${props.profile.name} archived`, {
        description:
          "Samples, labels, calibrations, and history were preserved.",
      });
      void queryClient.invalidateQueries({
        queryKey: voiceIdentityKeys.profiles,
      });
      setOpen(false);
      props.onArchived?.();
    },
    onError: (error: Error) => {
      toast.error("Could not archive voice profile", {
        description: error.message,
      });
      void previewQuery.refetch();
    },
  });

  const referenceRows = previewQuery.data
    ? Object.entries(previewQuery.data.references).filter(([, count]) =>
      count > 0
    )
    : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="Archive voice profile">
          <Archive className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {props.profile.name}?</DialogTitle>
          <DialogDescription>
            The profile disappears from normal voice selection. Its samples,
            labels, identity history, and Timeline references stay intact and
            the profile can be restored later.
          </DialogDescription>
        </DialogHeader>

        {props.profile.isPrimary && (
          <div className="space-y-2">
            <div className="text-sm font-medium">New primary voice</div>
            <Select
              value={replacementPrimaryProfileId}
              onValueChange={setReplacementPrimaryProfileId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose another active voice" />
              </SelectTrigger>
              <SelectContent>
                {props.replacementProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!replacementReady
          ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Create or restore another profile before archiving the primary
              voice.
            </div>
          )
          : previewQuery.isPending
          ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking references…
            </div>
          )
          : previewQuery.isError
          ? (
            <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              {(previewQuery.error as Error).message}
            </div>
          )
          : previewQuery.data
          ? (
            <div className="space-y-3 text-sm">
              {referenceRows.length > 0 && (
                <div className="rounded-md border p-3">
                  <div className="mb-2 font-medium">
                    Preserved references
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                    {referenceRows.map(([name, count]) => (
                      <div key={name} className="flex justify-between gap-2">
                        <span>{name.replace(/([A-Z])/g, " $1")}</span>
                        <span className="tabular-nums text-foreground">
                          {count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!previewQuery.data.archivable && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  Finish or stop active work first: {previewQuery.data.blockers
                    .join(", ")}
                </div>
              )}
            </div>
          )
          : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!previewQuery.data?.archivable ||
              archiveMutation.isPending}
            onClick={() => archiveMutation.mutate()}
          >
            {archiveMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Archive profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
