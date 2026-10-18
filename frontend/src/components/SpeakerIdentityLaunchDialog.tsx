import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, Play, UserRoundSearch } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatPickerRange } from "@/lib/datePicker";
import { normalizeObjectId } from "@/lib/diarization";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import {
  buildSpeakerIdentityCampaignRequest,
  buildSpeakerIdentityPreflightRequest,
  shortTechnicalId,
  type SpeakerIdentityCampaignStart,
  type SpeakerIdentityPreflight,
  speakerIdentityPreflightState,
  type SpeakerIdentityScope,
} from "@/lib/speakerIdentityLaunch";
import {
  loadVoiceIdentityStatus,
  voiceIdentityKeys,
  type VoiceIdentityStatus,
} from "@/lib/voiceIdentity";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { VoiceProfileContextBar } from "@/components/voice/VoiceProfileContextBar";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/DateRangePicker";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type RangeMode = 24 | 168 | 336 | "custom";

type SpeakerIdentityLauncherProps = {
  enabled: boolean;
  profileId?: string;
  showProfileSelector?: boolean;
  onCancel?: () => void;
  onQueued?: (jobId: string) => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function SpeakerIdentityLauncher({
  enabled,
  profileId: requestedProfileId,
  showProfileSelector = false,
  onCancel,
  onQueued,
}: SpeakerIdentityLauncherProps) {
  const queryClient = useQueryClient();
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const pickerTimeZone = resolveDefaultTimeZone(defaultTimeZone);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scopeMode, setScopeMode] = useState<"all_compatible" | "range">(
    "all_compatible",
  );
  const [rangeMode, setRangeMode] = useState<RangeMode>(24);
  const [rangeAnchor, setRangeAnchor] = useState(() => new Date());
  const [customStart, setCustomStart] = useState(
    () => new Date(Date.now() - 86_400_000),
  );
  const [customEnd, setCustomEnd] = useState(() => new Date());

  useEffect(() => {
    if (enabled) setRangeAnchor(new Date());
  }, [enabled]);

  const voiceSelection = useSelectedVoiceProfile();
  const primaryId = requestedProfileId ?? voiceSelection.selectedProfileId;
  const primary = voiceSelection.profiles.find((profile) =>
    normalizeObjectId(profile._id) === primaryId
  );
  const statusQuery = useQuery<VoiceIdentityStatus>({
    queryKey: voiceIdentityKeys.status(primaryId),
    queryFn: () => loadVoiceIdentityStatus(primaryId!),
    enabled: enabled && Boolean(primaryId),
  });
  const status = statusQuery.data;
  const calibration = status?.usableCalibration;
  const calibrationPolicy = calibration
    ? calibration.classificationPolicy ??
      (calibration.targetPrecision >= 0.98 ? "full" : "pilot")
    : null;
  const pilotOnly = calibrationPolicy === "pilot";
  const maxRangeHours = calibration?.maxRangeHours ?? (pilotOnly ? 24 : null);

  useEffect(() => {
    if (pilotOnly && scopeMode === "all_compatible") {
      setScopeMode("range");
      setRangeMode(24);
    }
  }, [pilotOnly, scopeMode]);

  const range = rangeMode === "custom"
    ? { start: customStart, end: customEnd }
    : {
      start: new Date(rangeAnchor.getTime() - rangeMode * 3_600_000),
      end: rangeAnchor,
    };
  const scope = useMemo<SpeakerIdentityScope>(
    () =>
      scopeMode === "all_compatible"
        ? { mode: "all_compatible" }
        : { mode: "range", start: range.start, end: range.end },
    [range.end, range.start, scopeMode],
  );

  const preflightQuery = useQuery<SpeakerIdentityPreflight>({
    queryKey: [
      "speaker-identity-preflight",
      primaryId,
      scope.mode,
      scope.mode === "range" ? scope.start.getTime() : null,
      scope.mode === "range" ? scope.end.getTime() : null,
    ],
    queryFn: () =>
      api.callResource(
        "speaker-segments",
        buildSpeakerIdentityPreflightRequest(primaryId!, scope),
      ) as Promise<SpeakerIdentityPreflight>,
    enabled: enabled && Boolean(primaryId),
    staleTime: 15_000,
    retry: 1,
    refetchInterval: (query) =>
      (query.state.data as SpeakerIdentityPreflight | undefined)?.status ===
          "counting"
        ? 3_000
        : false,
  });
  const preflight = preflightQuery.data;
  const { sourcePreparing, noCompatibleSegments } =
    speakerIdentityPreflightState(preflight);
  const resolved = preflight?.resolved;
  const effectivePolicy = resolved?.classificationPolicy ??
    calibrationPolicy;
  const effectivePilot = effectivePolicy === "pilot";
  const activeCampaign = status?.latestCampaign &&
      ["queued", "counting", "running"].includes(status.latestCampaign.status)
    ? status.latestCampaign
    : null;
  const loading = voiceSelection.isLoading ||
    (Boolean(primaryId) && statusQuery.isLoading) ||
    (Boolean(primaryId) && preflightQuery.isLoading);
  const rangeInvalid = scope.mode === "range" && scope.end <= scope.start;
  const rangeTooLarge = scope.mode === "range" && maxRangeHours != null &&
    scope.end.getTime() - scope.start.getTime() >
      maxRangeHours * 3_600_000;
  const eligibleSegments = preflight?.totals.eligibleSegments ?? null;

  const blockers = useMemo(() => {
    const values: string[] = [];
    if (!voiceSelection.isLoading && voiceSelection.isError) {
      values.push(
        `Could not load voice profiles: ${errorMessage(voiceSelection.error)}`,
      );
    } else if (!voiceSelection.isLoading && !primaryId) {
      values.push(
        voiceSelection.invalidRequestedProfileId
          ? "The requested voice profile is unavailable or archived"
          : "Create or select a voice profile first",
      );
    }
    if (!statusQuery.isLoading && statusQuery.isError) {
      values.push(
        `Could not verify identity readiness: ${
          errorMessage(statusQuery.error)
        }`,
      );
    }
    if (!preflightQuery.isLoading && preflightQuery.isError) {
      values.push(
        `Could not preview compatible segments: ${
          errorMessage(preflightQuery.error)
        }`,
      );
    }
    values.push(
      ...(preflight?.blockers ?? []).filter((blocker) =>
        !(noCompatibleSegments && /no compatible segments/i.test(blocker))
      ),
    );
    if (rangeInvalid) values.push("End time must be after start time");
    if (rangeTooLarge) {
      values.push(
        `This provisional calibration is limited to ${maxRangeHours} hours per pilot`,
      );
    }
    return [...new Set(values)];
  }, [
    maxRangeHours,
    noCompatibleSegments,
    preflight?.blockers,
    preflightQuery.error,
    preflightQuery.isError,
    preflightQuery.isLoading,
    primaryId,
    voiceSelection.error,
    voiceSelection.invalidRequestedProfileId,
    voiceSelection.isError,
    voiceSelection.isLoading,
    rangeInvalid,
    rangeTooLarge,
    statusQuery.error,
    statusQuery.isError,
    statusQuery.isLoading,
  ]);

  const launch = useMutation({
    mutationFn: async () => {
      if (
        !primaryId || !preflight?.canStart || !preflight.preflightToken ||
        sourcePreparing || noCompatibleSegments
      ) {
        throw new Error(blockers[0] ?? "No compatible segments to classify");
      }
      return await api.callResource(
        "speaker-segments",
        buildSpeakerIdentityCampaignRequest(
          primaryId,
          preflight.preflightToken,
        ),
      ) as SpeakerIdentityCampaignStart;
    },
    onSuccess: (result) => {
      toast.success(
        scope.mode === "all_compatible"
          ? "Full-history identity campaign queued"
          : "Speaker identity classification queued",
      );
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({
        queryKey: ["speaker-identity-campaigns"],
      });
      void queryClient.invalidateQueries({
        queryKey: voiceIdentityKeys.status(primaryId),
      });
      void queryClient.invalidateQueries({
        queryKey: ["identity-model-sets", primaryId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["identity-model-set-head", primaryId],
      });
      if (result.jobId) onQueued?.(result.jobId);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const snapshotCutoff = preflight?.snapshotCutoff
    ? new Date(preflight.snapshotCutoff)
    : null;
  const canStart = Boolean(
    !loading && !sourcePreparing && preflight?.canStart &&
      preflight.preflightToken && !noCompatibleSegments &&
      blockers.length === 0,
  );

  return (
    <div className="space-y-4">
      {showProfileSelector && (
        <VoiceProfileContextBar selection={voiceSelection} compact />
      )}
      <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">
                {effectivePilot
                  ? "Run a bounded identity pilot"
                  : "Classify all compatible history"}
              </p>
              {!effectivePilot && <Badge>Recommended</Badge>}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              The server selects every compatible active diarization partition,
              freezes a cutoff, and resumes in batches. Existing audio is not
              processed again.
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">
              {sourcePreparing
                ? preflight?.sourceIndex.scannedSegments.toLocaleString() ?? "…"
                : preflightQuery.isLoading
                ? "…"
                : eligibleSegments == null
                ? "—"
                : eligibleSegments.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">
              {sourcePreparing
                ? "segments scanned"
                : noCompatibleSegments
                ? "No compatible segments"
                : "segments ready"}
            </p>
          </div>
        </div>
        {preflight && !sourcePreparing && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {preflight.partitions.length} compatible generation
              {preflight.partitions.length === 1 ? "" : "s"}
            </span>
            <span>{preflight.totals.alreadyCurrent} already current</span>
            <span>
              {preflight.totals.incompatibleSegments} incompatible skipped
            </span>
            <span>~{preflight.totals.estimatedBatches} batches</span>
          </div>
        )}
      </div>

      {sourcePreparing && preflight?.sourceIndex && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <p className="font-medium">Preparing classification source</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {preflight.sourceIndex.scannedSegments.toLocaleString()}{" "}
            segments scanned · batch{" "}
            {preflight.sourceIndex.batchCount.toLocaleString()}. This one-time
            index continues in the background and this page updates
            automatically.
          </p>
          {preflight.sourceIndex.currentJobId && (
            <Link
              className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
              to={withVoiceProfile(
                `/jobs/${preflight.sourceIndex.currentJobId}`,
                primaryId,
              )}
            >
              Open source preparation job →
            </Link>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">Voice profile</p>
          <p className="mt-1 text-sm font-medium">
            {loading
              ? "Loading…"
              : resolved?.profileName ?? primary?.name ?? "No voice profile"}
          </p>
          {(resolved?.profileRevision ?? status?.profile?.revision) && (
            <p className="text-xs text-muted-foreground">
              Revision {resolved?.profileRevision ?? status?.profile?.revision}
            </p>
          )}
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">Calibration</p>
          <p className="mt-1 text-sm font-medium">
            {loading
              ? "Checking…"
              : effectivePolicy === "full"
              ? "Full history ready"
              : effectivePolicy === "pilot"
              ? "Provisional pilot"
              : "Not ready"}
          </p>
          {(resolved?.calibrationId ?? calibration) && (
            <Badge
              className={effectivePilot
                ? "mt-1 bg-amber-500/10 text-amber-600"
                : "mt-1 bg-green-500/10 text-green-600"}
            >
              {(
                (resolved?.targetPrecision ??
                  calibration?.targetPrecision ?? 0) * 100
              ).toFixed(0)}% held-out target
            </Badge>
          )}
        </div>
      </div>

      {effectivePilot && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          This calibration is provisional. It can classify at most{" "}
          {maxRangeHours ?? 24}{" "}
          hours so you can review false positives before enabling full history.
        </div>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            Advanced · period and technical details
            <ChevronDown
              className={`ml-2 h-4 w-4 transition-transform ${
                advancedOpen ? "rotate-180" : ""
              }`}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Classification period</p>
            <p className="text-xs text-muted-foreground">
              Full compatible history is recommended. Choose a bounded period
              for diagnostics or a provisional calibration.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!effectivePilot && (
              <Button
                type="button"
                size="sm"
                variant={scopeMode === "all_compatible" ? "default" : "outline"}
                onClick={() => setScopeMode("all_compatible")}
              >
                All compatible history
              </Button>
            )}
            {([
              [24, "24 hours"],
              [168, "7 days"],
              [336, "14 days"],
            ] as const).map(([hours, label]) => (
              <Button
                key={hours}
                type="button"
                size="sm"
                variant={scopeMode === "range" && rangeMode === hours
                  ? "default"
                  : "outline"}
                onClick={() => {
                  setScopeMode("range");
                  setRangeMode(hours);
                }}
                disabled={maxRangeHours != null && hours > maxRangeHours}
              >
                {label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={scopeMode === "range" && rangeMode === "custom"
                ? "default"
                : "outline"}
              onClick={() => {
                setScopeMode("range");
                setRangeMode("custom");
              }}
            >
              Custom period
            </Button>
          </div>
          {scopeMode === "range" && rangeMode === "custom" && (
            <DateRangePicker
              label="Custom audio range"
              value={{ start: customStart, end: customEnd }}
              onChange={(value) => {
                setCustomStart(value.start);
                if (value.end) setCustomEnd(value.end);
              }}
              maxDurationMs={maxRangeHours == null
                ? undefined
                : maxRangeHours * 3_600_000}
              showAudioTimeline
            />
          )}
          <p className="text-xs text-muted-foreground">
            {scope.mode === "all_compatible"
              ? snapshotCutoff
                ? `Frozen through ${
                  formatPickerRange(
                    { start: snapshotCutoff, end: snapshotCutoff },
                    pickerTimeZone,
                    "minute",
                  )
                }`
                : "The server will freeze the history cutoff before starting."
              : `Selected: ${
                formatPickerRange(scope, pickerTimeZone, "minute")
              }`}
          </p>
          {(preflight?.partitions.length ?? 0) > 0 && (
            <div className="space-y-1 rounded bg-muted/30 p-2 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                Resolved partitions
              </p>
              {preflight!.partitions.slice(0, 8).map((partition) => (
                <div
                  key={`${partition.runId}-${partition.start}`}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>
                    Generation {partition.generation ?? "legacy"} ·{" "}
                    {partition.eligibleSegments.toLocaleString()} segments
                  </span>
                  <span className="font-mono">
                    run {shortTechnicalId(partition.runId)} · space{" "}
                    {shortTechnicalId(partition.embeddingSpaceId)}
                  </span>
                </div>
              ))}
              {preflight!.partitions.length > 8 && (
                <p>+{preflight!.partitions.length - 8} more partitions</p>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      {activeCampaign?.currentJobId && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          Current classification is {activeCampaign.status}.{" "}
          <Link
            className="font-medium text-primary hover:underline"
            to={withVoiceProfile(
              `/jobs/${activeCampaign.currentJobId}`,
              primaryId,
            )}
          >
            Open job details
          </Link>
        </div>
      )}

      {preflight?.coverageRepair?.repairable && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            Active diarization coverage needs repair
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {preflight.coverageRepair.counts.recoverableSupersededSegments
              .toLocaleString()}{" "}
            previous speaker segments can be restored. The repair deletes
            nothing and must be explicitly confirmed.
          </p>
          <Link
            className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
            to={withVoiceProfile(
              `/settings/voice-identity/operations?repairRun=${
                encodeURIComponent(preflight.coverageRepair.runId)
              }`,
              primaryId,
            )}
          >
            Preview safe coverage repair →
          </Link>
        </div>
      )}

      {!loading && blockers.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-sm font-medium text-amber-600">
            Classification is blocked
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>
          <div className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
            <Link
              className="text-primary hover:underline"
              to={withVoiceProfile(
                "/settings/voice-identity#calibration",
                primaryId,
              )}
            >
              Review and validate →
            </Link>
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void preflightQuery.refetch()}
            >
              Check again
            </button>
          </div>
        </div>
      )}

      {!loading && noCompatibleSegments && blockers.length === 0 && (
        <div className="rounded-md border bg-muted/20 p-3 text-sm">
          <p className="font-medium">No compatible segments</p>
          <p className="text-xs text-muted-foreground">
            Everything in this scope is already current, incompatible with the
            profile embedding space, or outside active diarization generations.
          </p>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          onClick={() => launch.mutate()}
          disabled={!canStart || launch.isPending || preflightQuery.isFetching}
        >
          <Play className="mr-2 h-4 w-4" />
          {launch.isPending
            ? "Starting…"
            : sourcePreparing
            ? "Preparing source…"
            : effectivePilot
            ? "Start provisional pilot"
            : scope.mode === "all_compatible"
            ? "Classify all compatible history"
            : "Classify selected period"}
        </Button>
      </div>
    </div>
  );
}

export function SpeakerIdentityLaunchPanel({
  profileId,
  onQueued,
}: {
  profileId?: string;
  onQueued?: (jobId: string) => void;
}) {
  return (
    <SpeakerIdentityLauncher
      enabled
      profileId={profileId}
      onQueued={onQueued}
    />
  );
}

export function SpeakerIdentityLaunchDialog({
  profileId,
}: {
  profileId?: string;
} = {}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Run speaker identity job"
        >
          <Play className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRoundSearch className="h-5 w-5 text-primary" />
            Classify existing voice segments
          </DialogTitle>
          <DialogDescription>
            The server resolves compatible generations, profile revision and
            calibration. Review the preflight count, then start one resumable
            campaign.
          </DialogDescription>
        </DialogHeader>
        <SpeakerIdentityLauncher
          enabled={open}
          profileId={profileId}
          showProfileSelector={!profileId}
          onCancel={() => setOpen(false)}
          onQueued={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
