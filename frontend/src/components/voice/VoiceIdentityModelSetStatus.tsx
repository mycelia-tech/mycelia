import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import { voiceIdentityKeys } from "@/lib/voiceIdentity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type IdentityModelSet = {
  modelSetId: string;
  status: "building" | "ready" | "active" | "superseded" | "failed";
  profileIds?: string[];
  coverage?: { totalSegments?: number; projectedSegments?: number };
  failureReason?: string;
};

type IdentityModelSetHead = {
  status: "active" | "no_active_model_set";
  modelSet?: IdentityModelSet | null;
};

export function VoiceIdentityModelSetStatus({
  profileId,
}: {
  profileId: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const setsQuery = useQuery<IdentityModelSet[]>({
    queryKey: ["identity-model-sets", profileId],
    enabled: Boolean(profileId),
    queryFn: () =>
      callResource("speaker-segments", {
        action: "list-identity-model-sets",
        profileId,
        limit: 10,
      }) as Promise<IdentityModelSet[]>,
    refetchInterval: (query) =>
      Array.isArray(query.state.data) &&
        query.state.data.some((item) => item.status === "building")
        ? 10_000
        : false,
  });
  const headQuery = useQuery<IdentityModelSetHead>({
    queryKey: ["identity-model-set-head", profileId],
    enabled: Boolean(profileId),
    queryFn: () =>
      callResource("speaker-segments", {
        action: "identity-model-set-head",
        profileId,
      }) as Promise<IdentityModelSetHead>,
  });
  const modelSets = Array.isArray(setsQuery.data) ? setsQuery.data : [];
  const latest =
    modelSets.find((item) =>
      ["building", "ready", "active"].includes(item.status)
    ) ?? null;
  const active = headQuery.data?.modelSet ?? null;
  const visible = latest ?? active;
  const total = Number(visible?.coverage?.totalSegments ?? 0);
  const projected = Number(visible?.coverage?.projectedSegments ?? 0);
  const percent = total > 0 ? Math.min(100, projected / total * 100) : 0;

  const activate = useMutation({
    mutationFn: () =>
      callResource("speaker-segments", {
        action: "activate-identity-model-set",
        modelSetId: latest!.modelSetId,
      }),
    onSuccess: () => {
      toast.success("Voice results are active on Timeline");
      void queryClient.invalidateQueries({
        queryKey: ["identity-model-sets", profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["identity-model-set-head", profileId],
      });
      void queryClient.invalidateQueries({
        queryKey: voiceIdentityKeys.status(profileId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["speaker-timeline-summary"],
      });
    },
    onError: (error: Error) =>
      toast.error("Could not activate voice results", {
        description: error.message,
      }),
  });

  if (!profileId || (setsQuery.isPending && headQuery.isPending)) {
    return null;
  }
  if (!visible) {
    return (
      <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
        Automatic Timeline results are not built yet. Start classification;
        manual labels are already visible.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-medium">
            {visible.status === "active" && (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            )}
            Timeline voice model
            <Badge variant="outline">{visible.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {visible.status === "building"
              ? `${projected.toLocaleString()} of ${total.toLocaleString()} segments classified`
              : visible.status === "ready"
              ? "Classification finished. Activate it to show automatic voice matches on Timeline and Transcript."
              : "Timeline and Transcript use this model set. Manual corrections still win."}
          </p>
        </div>
        {visible.status === "ready" && (
          <Button
            size="sm"
            disabled={activate.isPending}
            onClick={() => activate.mutate()}
          >
            {activate.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Show results on Timeline
          </Button>
        )}
        {visible.status === "active" && (
          <Button asChild size="sm" variant="outline">
            <Link
              to={withVoiceProfile(
                "/timeline?speakerIdentity=selected",
                profileId,
              )}
            >
              Open selected voice
            </Link>
          </Button>
        )}
      </div>
      {visible.status === "building" && <Progress value={percent} />}
    </div>
  );
}
