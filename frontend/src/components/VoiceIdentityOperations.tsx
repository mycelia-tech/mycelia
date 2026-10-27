import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { formatPickerRange } from "@/lib/datePicker";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateRangePicker } from "@/components/DateRangePicker";
import { useSettingsStore } from "@/stores/settingsStore";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SpeakerIdentityLaunchPanel } from "@/components/SpeakerIdentityLaunchDialog";
import {
  getRunComparison,
  validateOperationRange,
} from "@/lib/voiceIdentityOperations";
import { useActionDialog } from "@/components/ActionDialogProvider";
import { getSpeakerIdentityProgressView } from "@/lib/speakerIdentityProgress";
import { useSelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { VoiceProfileContextBar } from "@/components/voice/VoiceProfileContextBar";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import { shortTechnicalId } from "@/lib/speakerIdentityLaunch";
import {
  buildEmptyActivationRepairPreviewRequest,
  buildEmptyActivationRepairRequest,
  type EmptyActivationRepairList,
  type EmptyActivationRepairPreview,
  type EmptyActivationRepairResult,
} from "@/lib/activationRepair";

type Run = {
  runId: string;
  status:
    | "building"
    | "interrupted"
    | "ready"
    | "active"
    | "superseded"
    | "failed";
  generation: number;
  embeddingSpaceId: string;
  range?: { start: Date; end: Date };
  replacesRunId?: string;
  campaign?: {
    campaignId: string;
    status: string;
    processedChunks?: number;
    totalChunks?: number;
    pendingChunks?: number;
    etaSeconds?: number | null;
    batchNumber?: number;
    estimatedBatches?: number;
    errorCount?: number;
    currentJobId?: string;
  };
};

type IdentityCampaign = {
  campaignId: string;
  status:
    | "queued"
    | "counting"
    | "running"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled";
  range?: { start?: Date; end?: Date };
  processedSegments?: number;
  totalSegments?: number | null;
  pendingSegments?: number | null;
  matched?: number;
  rejected?: number;
  uncertain?: number;
  incompatibleSkipped?: number;
  etaSeconds?: number | null;
  segmentsPerSecond?: number | null;
  batchNumber?: number;
  estimatedBatches?: number;
  currentJobId?: string;
  updatedAt?: Date;
};

type PurgePreview = {
  runId: string;
  status: string;
  documents: number;
  embeddings: number;
  activeSegments: number;
  snapshotFingerprint: string;
  confirmation: string;
};

function operationDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function runStatusExplanation(status: Run["status"]): string {
  switch (status) {
    case "active":
      return "Currently shown on Timeline and used for identity classification.";
    case "building":
      return "Still being calculated; it does not change active Timeline data.";
    case "interrupted":
      return "No worker is continuing this build. Mark it failed before replacing it.";
    case "ready":
      return "Build finished and can be compared before activation.";
    case "superseded":
      return "Kept for rollback; safe to preview before any manual purge.";
    case "failed":
      return "The build is not active and can be inspected or purged manually.";
  }
}

export function VoiceIdentityOperations() {
  const { promptAction } = useActionDialog();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const voiceSelection = useSelectedVoiceProfile();
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const pickerTimeZone = resolveDefaultTimeZone(defaultTimeZone);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [purgePreview, setPurgePreview] = useState<PurgePreview | null>(null);
  const [repairPreview, setRepairPreview] = useState<
    EmptyActivationRepairPreview | null
  >(null);
  const [hours, setHours] = useState(24 * 7);
  const [rangeMode, setRangeMode] = useState<"preset" | "custom">("preset");
  const [customStart, setCustomStart] = useState(
    () => new Date(Date.now() - 24 * 3_600_000),
  );
  const [customEnd, setCustomEnd] = useState(() => new Date());
  const [actionResult, setActionResult] = useState<
    {
      title: string;
      value: unknown;
    } | null
  >(null);
  const presetRange = useMemo(
    () => ({
      start: new Date(Date.now() - hours * 3_600_000),
      end: new Date(),
    }),
    [hours],
  );
  const range = rangeMode === "custom"
    ? { start: customStart, end: customEnd }
    : presetRange;
  const rangeError = validateOperationRange(range.start, range.end);
  const requestedRepairRun = searchParams.get("repairRun");
  const repairPreviewsQuery = useQuery<EmptyActivationRepairList>({
    queryKey: ["empty-activation-repair-previews"],
    queryFn: () =>
      callResource(
        "speaker-segments",
        buildEmptyActivationRepairPreviewRequest(),
      ) as Promise<EmptyActivationRepairList>,
    staleTime: 15_000,
    retry: 1,
  });
  const repairablePreviews = (repairPreviewsQuery.data?.repairs ?? []).filter(
    (preview) => preview.repairable,
  );
  const blockedRepairPreviews = (repairPreviewsQuery.data?.repairs ?? [])
    .filter(
      (preview) => !preview.repairable,
    );

  useEffect(() => {
    if (!requestedRepairRun || repairPreview) return;
    const requested = repairPreviewsQuery.data?.repairs.find((preview) =>
      preview.runId === requestedRepairRun
    );
    if (requested) setRepairPreview(requested);
  }, [
    repairPreview,
    repairPreviewsQuery.data?.repairs,
    requestedRepairRun,
  ]);

  const closeRepairPreview = () => {
    setRepairPreview(null);
    if (!requestedRepairRun) return;
    const next = new URLSearchParams(searchParams);
    next.delete("repairRun");
    setSearchParams(next, { replace: true });
  };
  const openRepairPreview = (preview: EmptyActivationRepairPreview) => {
    setRepairPreview(preview);
    const next = new URLSearchParams(searchParams);
    next.set("repairRun", preview.runId);
    setSearchParams(next, { replace: true });
  };

  const { data: runs = [] } = useQuery<Run[]>({
    queryKey: ["speaker-runs"],
    queryFn: () =>
      callResource("speaker-segments", { action: "list-runs" }) as Promise<
        Run[]
      >,
    refetchInterval: (query) => {
      if (document.visibilityState !== "visible") return false;
      return query.state.data?.some((run) =>
          ["building", "interrupted", "ready"].includes(run.status)
        )
        ? 10_000
        : false;
    },
  });
  const primary = voiceSelection.selectedProfile;
  const primaryId = voiceSelection.selectedProfileId;
  const activeRun = runs.find((run) => run.status === "active");
  const { data: identityCampaigns = [] } = useQuery<IdentityCampaign[]>({
    queryKey: ["speaker-identity-campaigns", primaryId, activeRun?.runId],
    enabled: Boolean(primaryId),
    queryFn: () =>
      callResource("speaker-segments", {
        action: "list-identity-campaigns",
        profileId: primaryId,
        runId: activeRun?.runId,
        limit: 10,
      }) as Promise<IdentityCampaign[]>,
    refetchInterval: (query) => {
      if (document.visibilityState !== "visible") return false;
      return query.state.data?.some((campaign) =>
          ["queued", "counting", "running"].includes(campaign.status)
        )
        ? 5_000
        : false;
    },
  });
  const latestIdentityCampaign = identityCampaigns[0];
  const identityProgress = latestIdentityCampaign
    ? getSpeakerIdentityProgressView({
      processed: latestIdentityCampaign.processedSegments,
      total: latestIdentityCampaign.totalSegments,
      remaining: latestIdentityCampaign.pendingSegments,
      segmentsPerSecond: latestIdentityCampaign.segmentsPerSecond,
      etaSeconds: latestIdentityCampaign.etaSeconds,
      status: latestIdentityCampaign.status,
    })
    : null;

  const repairEmptyActivation = useMutation({
    mutationFn: async (preview: EmptyActivationRepairPreview) => {
      if (!preview.repairable || !preview.confirmation) {
        throw new Error(preview.summary);
      }
      const confirmation = await promptAction({
        title: "Restore previous diarization coverage?",
        description:
          `This restores exactly ${preview.counts.recoverableSupersededSegments.toLocaleString()} previous segments and marks the empty active generation failed. It deletes 0 records and preserves raw audio, transcripts, embeddings, and segment documents.`,
        confirmationPhrase: preview.confirmation,
        inputLabel: `Type ${preview.confirmation} to confirm`,
        actionLabel: "Restore coverage",
        destructive: false,
      });
      if (!confirmation) return null;
      return await callResource(
        "speaker-segments",
        buildEmptyActivationRepairRequest(preview, confirmation),
      ) as EmptyActivationRepairResult;
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success(
        `${result.restoredSegments.toLocaleString()} speaker segments restored · 0 deleted`,
      );
      closeRepairPreview();
      void queryClient.invalidateQueries({
        queryKey: ["empty-activation-repair-previews"],
      });
      void queryClient.invalidateQueries({ queryKey: ["speaker-runs"] });
      void queryClient.invalidateQueries({
        queryKey: ["speaker-identity-preflight"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["speaker-timeline-summary"],
      });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Coverage repair failed",
      ),
  });

  const operation = useMutation({
    mutationFn: async (kind: "missing" | "rediarize") => {
      if (kind === "missing") {
        return await callResource("jobs", {
          action: "enqueue",
          data: {
            type: "diarization",
            mode: "missing",
            ...range,
            limit: 4,
            batchSize: 4,
          },
          trigger: { type: "manual", reason: "Diarize missing speech chunks" },
          priority: 3,
        });
      }
      const health = await callResource("jobs", {
        action: "services_health",
        force: true,
      }) as any;
      const service = health.services?.find((item: any) =>
        item.id === "diarizator"
      );
      const metadata = service?.metadata;
      if (
        service?.status !== "healthy" || !metadata?.embeddingSpaceId ||
        !metadata?.diarizationFingerprint
      ) {
        throw new Error(
          "Healthy diarizator with runtime fingerprint is required",
        );
      }
      const runId = `diar-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await callResource("speaker-segments", {
        action: "create-run",
        runId,
        mode: "rediarize",
        generation: Math.max(0, ...runs.map((run) => run.generation)) + 1,
        ...range,
        replacesRunId: activeRun?.runId,
        diarizationFingerprint: metadata.diarizationFingerprint,
        embeddingSpaceId: metadata.embeddingSpaceId,
      });
      return await callResource("jobs", {
        action: "enqueue",
        data: {
          type: "diarization",
          mode: "build_generation",
          runId,
          ...range,
          limit: 4,
          batchSize: 4,
        },
        trigger: {
          type: "manual",
          reason: `Build diarization generation ${runId}`,
        },
        priority: 5,
      });
    },
    onSuccess: () => {
      toast.success("Voice Identity operation queued");
      void queryClient.invalidateQueries({ queryKey: ["speaker-runs"] });
      void queryClient.invalidateQueries({
        queryKey: ["speaker-identity-campaigns"],
      });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Operation failed"),
  });

  const runAction = useMutation({
    mutationFn: async (
      { action, runId }: {
        action:
          | "compare-run"
          | "mark-run-failed"
          | "activate-run"
          | "preview-purge"
          | "purge-superseded";
        runId: string;
      },
    ) => {
      if (action === "purge-superseded") {
        const preview = purgePreview;
        if (!preview || preview.runId !== runId) {
          throw new Error("Preview this generation again before purging it");
        }
        const phrase = preview.confirmation;
        const confirmation = await promptAction({
          title: `Purge superseded run ${runId}?`,
          description:
            "Only superseded diarization documents and embeddings will be deleted. Raw audio and transcripts are not affected.",
          confirmationPhrase: phrase,
          inputLabel: `Type ${phrase} to confirm`,
          actionLabel: "Purge run",
          destructive: true,
        });
        if (!confirmation) return null;
        const value = await callResource("speaker-segments", {
          action,
          runId,
          snapshotFingerprint: preview.snapshotFingerprint,
          confirmation,
        });
        return { kind: action, runId, value };
      }
      if (action === "compare-run") {
        const run = runs.find((item) => item.runId === runId);
        if (!run) throw new Error("Run not found");
        const comparison = getRunComparison(run, runs);
        if (!comparison.enabled || !comparison.baseline) {
          throw new Error(comparison.reason);
        }
        const [selected, baseline] = await Promise.all([
          callResource("speaker-segments", { action, runId }),
          callResource("speaker-segments", {
            action,
            runId: comparison.baseline.runId,
          }),
        ]);
        return {
          kind: "comparison",
          runId,
          baselineRunId: comparison.baseline.runId,
          selected,
          baseline,
        };
      }
      const value = await callResource("speaker-segments", { action, runId });
      return { kind: action, runId, value };
    },
    onSuccess: (result) => {
      if (result) {
        if (result.kind === "preview-purge") {
          setPurgePreview(result.value as PurgePreview);
        } else {
          if (result.kind === "purge-superseded") setPurgePreview(null);
          setActionResult({
            title: result.kind === "comparison"
              ? `Comparison: ${shortTechnicalId(result.runId)} vs ${
                shortTechnicalId(result.baselineRunId)
              }`
              : `${result.kind}: ${shortTechnicalId(result.runId)}`,
            value: result,
          });
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["speaker-runs"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Run action failed"),
  });

  return (
    <Card data-testid="voice-identity-operations">
      <CardHeader>
        <CardTitle>
          Voice Identity — {primary?.name ?? "select a voice"}
        </CardTitle>
        <CardDescription>
          Cheap classification uses stored embeddings. Re-diarization creates a
          separate generation and never replaces active data before activation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <VoiceProfileContextBar selection={voiceSelection} compact />
        <nav
          aria-label="Related voice identity pages"
          className="flex flex-wrap gap-x-4 gap-y-1 border-b pb-3 text-sm font-medium"
        >
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/settings/voice-identity", primaryId)}
          >
            Review & calibration
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/jobs?type=speakerIdentity", primaryId)}
          >
            Identity jobs
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/jobs?type=diarization", primaryId)}
          >
            Diarization jobs
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/settings/diarization", primaryId)}
          >
            Diarization servers
          </Link>
          <Link
            className="text-primary hover:underline"
            to={withVoiceProfile("/audio/pipeline", primaryId)}
          >
            Audio Pipeline
          </Link>
        </nav>
        {repairPreviewsQuery.isPending && (
          <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
            Checking active diarization coverage…
          </p>
        )}
        {repairPreviewsQuery.isError && (
          <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <h3 className="font-semibold text-destructive">
              Coverage repair check failed
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {repairPreviewsQuery.error instanceof Error
                ? repairPreviewsQuery.error.message
                : "The server could not inspect active generations."}
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => repairPreviewsQuery.refetch()}
            >
              Retry coverage check
            </Button>
          </section>
        )}
        {repairablePreviews.length > 0 && (
          <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-amber-800 dark:text-amber-300">
                  Repair active diarization coverage before classification
                </h3>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  An empty generation is marked active while its previous
                  segments are superseded. This recovery only restores lifecycle
                  state and marks the empty generation failed. It deletes
                  nothing.
                </p>
              </div>
              <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
                {repairablePreviews.length} repairable
              </Badge>
            </div>
            <div className="mt-3 space-y-2">
              {repairablePreviews.map((preview) => (
                <div
                  key={preview.runId}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-background/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      Restore exactly{" "}
                      {preview.counts.recoverableSupersededSegments
                        .toLocaleString()} speaker segments
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Generation {shortTechnicalId(preview.runId)}{" "}
                      · 0 records deleted
                    </p>
                  </div>
                  <Button
                    className="ml-auto"
                    size="sm"
                    onClick={() => openRepairPreview(preview)}
                  >
                    Preview repair
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
        {!repairPreviewsQuery.isError && blockedRepairPreviews.length > 0 && (
          <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <h3 className="font-semibold text-amber-800 dark:text-amber-300">
              Coverage issue needs manual inspection
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {blockedRepairPreviews.length} empty active generation
              {blockedRepairPreviews.length === 1 ? " is" : "s are"}{" "}
              not safe to restore automatically. No data was changed.
            </p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              {blockedRepairPreviews.map((preview) => (
                <p key={preview.runId}>
                  {shortTechnicalId(preview.runId)} · {preview.summary}
                </p>
              ))}
            </div>
          </section>
        )}
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">Classify voices</h3>
            <p className="text-xs text-muted-foreground">
              Preflight resolves every compatible generation and prevents a
              partial raw-job launch.
            </p>
          </div>
          <SpeakerIdentityLaunchPanel profileId={primaryId ?? undefined} />
        </section>

        <section className="space-y-3 rounded-md border p-3">
          <div>
            <h3 className="text-sm font-semibold">Diarization maintenance</h3>
            <p className="text-xs text-muted-foreground">
              These controls process missing audio or build a separate
              generation. They do not classify speaker identity.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[24, 24 * 7, 24 * 14, 24 * 30].map((value) => (
              <Button
                key={value}
                size="sm"
                variant={rangeMode === "preset" && hours === value
                  ? "default"
                  : "outline"}
                onClick={() => {
                  setHours(value);
                  setRangeMode("preset");
                }}
              >
                {value === 24 ? "24 hours" : `${value / 24} days`}
              </Button>
            ))}
            <Button
              size="sm"
              variant={rangeMode === "custom" ? "default" : "outline"}
              onClick={() => setRangeMode("custom")}
            >
              Custom range
            </Button>
          </div>
          {rangeMode === "custom" && (
            <DateRangePicker
              label="Custom audio range"
              value={{ start: customStart, end: customEnd }}
              onChange={(value) => {
                setCustomStart(value.start);
                if (value.end) setCustomEnd(value.end);
              }}
              showAudioTimeline
            />
          )}
          <div className="text-xs text-muted-foreground">
            Selected: {formatPickerRange(range, pickerTimeZone, "minute")}
            {rangeError && (
              <span className="ml-2 text-destructive">{rangeError}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => operation.mutate("missing")}
              disabled={operation.isPending || Boolean(rangeError)}
            >
              Diarize missing
            </Button>
            <Button
              variant="outline"
              onClick={() => operation.mutate("rediarize")}
              disabled={operation.isPending || Boolean(rangeError)}
            >
              Re-diarize range
            </Button>
            <Link
              to={withVoiceProfile(
                `/transcript?start=${range.start.getTime()}&end=${range.end.getTime()}`,
                primaryId,
              )}
            >
              <Button variant="ghost">Open transcript</Button>
            </Link>
          </div>
        </section>
        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Identity backfill</p>
              <p className="text-xs text-muted-foreground">
                {latestIdentityCampaign
                  ? `${latestIdentityCampaign.status} · batch ${
                    latestIdentityCampaign.batchNumber ?? 0
                  }/${latestIdentityCampaign.estimatedBatches ?? "?"}`
                  : "No classification campaign has run for this active generation."}
              </p>
            </div>
            <div className="flex gap-2">
              {latestIdentityCampaign?.currentJobId && (
                <Link
                  to={withVoiceProfile(
                    `/jobs/${latestIdentityCampaign.currentJobId}`,
                    primaryId,
                  )}
                >
                  <Button size="sm" variant="outline">Job details</Button>
                </Link>
              )}
              {latestIdentityCampaign?.range?.start && (
                <Link
                  to={withVoiceProfile(
                    `/timeline?start=${
                      new Date(latestIdentityCampaign.range.start).getTime()
                    }&end=${
                      latestIdentityCampaign.range.end
                        ? new Date(latestIdentityCampaign.range.end).getTime()
                        : Date.now()
                    }`,
                    primaryId,
                  )}
                >
                  <Button size="sm" variant="outline">Timeline</Button>
                </Link>
              )}
            </div>
          </div>
          {latestIdentityCampaign && identityProgress && (
            <div className="mt-3 space-y-2">
              {latestIdentityCampaign.totalSegments != null && (
                <Progress value={identityProgress.percent} className="h-2" />
              )}
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>{identityProgress.progressLabel}</span>
                <span>{identityProgress.etaLabel}</span>
              </div>
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="text-green-600">
                  {latestIdentityCampaign.matched ?? 0}{" "}
                  {primary?.name ?? "voice"}
                </span>
                <span>
                  {latestIdentityCampaign.rejected ?? 0} not{" "}
                  {primary?.name ?? "voice"}
                </span>
                <span className="text-amber-600">
                  {latestIdentityCampaign.uncertain ?? 0} uncertain
                </span>
                <span className="text-muted-foreground">
                  {latestIdentityCampaign.incompatibleSkipped ?? 0} incompatible
                </span>
                <span className="text-muted-foreground">
                  {identityProgress.remainingLabel}
                  {identityProgress.rateLabel
                    ? `${
                      identityProgress.remainingLabel ? " · " : ""
                    }${identityProgress.rateLabel}`
                    : ""}
                </span>
              </div>
            </div>
          )}
        </div>
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="w-full">
              Advanced · diarization generations
              <ChevronDown
                className={`ml-2 h-4 w-4 transition-transform ${
                  advancedOpen ? "rotate-180" : ""
                }`}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              <strong className="text-foreground">Active</strong>{" "}
              is visible on Timeline.{" "}
              <strong className="text-foreground">Building</strong> and{" "}
              <strong className="text-foreground">ready</strong>{" "}
              stay isolated until activation. Superseded generations remain
              available for rollback until you explicitly preview and confirm a
              purge.
            </div>
            {runs.length === 0 && (
              <p className="rounded-md border p-3 text-sm text-muted-foreground">
                No diarization generations found.
              </p>
            )}
            {runs.slice(0, 8).map((run) => {
              const comparison = getRunComparison(run, runs);
              return (
                <div key={run.runId} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-start gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          Generation {run.generation}
                        </span>
                        <Badge variant="outline">{run.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {runStatusExplanation(run.status)}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        run {shortTechnicalId(run.runId)} · space{" "}
                        {shortTechnicalId(run.embeddingSpaceId)}
                      </p>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          runAction.mutate({
                            action: "compare-run",
                            runId: run.runId,
                          })}
                        disabled={runAction.isPending || !comparison.enabled}
                        title={comparison.reason}
                      >
                        {runAction.isPending &&
                            runAction.variables?.runId === run.runId
                          ? "Working…"
                          : comparison.baseline
                          ? "Compare with active"
                          : "Compare unavailable"}
                      </Button>
                      {run.status === "ready" && (
                        <Button
                          size="sm"
                          onClick={() =>
                            runAction.mutate({
                              action: "activate-run",
                              runId: run.runId,
                            })}
                        >
                          Activate
                        </Button>
                      )}
                      {run.status === "interrupted" && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            runAction.mutate({
                              action: "mark-run-failed",
                              runId: run.runId,
                            })}
                        >
                          Mark failed
                        </Button>
                      )}
                      {run.status === "superseded" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            runAction.mutate({
                              action: "activate-run",
                              runId: run.runId,
                            })}
                        >
                          Roll back
                        </Button>
                      )}
                      {(run.status === "superseded" ||
                        run.status === "failed") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            runAction.mutate({
                              action: "preview-purge",
                              runId: run.runId,
                            })}
                        >
                          Preview purge
                        </Button>
                      )}
                    </div>
                  </div>
                  {run.campaign && (
                    <div className="mt-3 space-y-1.5 rounded bg-muted/30 p-2">
                      <div className="flex justify-between gap-3 text-xs">
                        <span>
                          {run.campaign.processedChunks ?? 0} /{" "}
                          {run.campaign.totalChunks ?? "?"} chunks
                        </span>
                        <span>
                          {run.campaign.status}
                          {run.campaign.batchNumber
                            ? ` · batch ${run.campaign.batchNumber}/${
                              run.campaign.estimatedBatches ?? "?"
                            }`
                            : ""}
                          {run.campaign.errorCount
                            ? ` · ${run.campaign.errorCount} errors`
                            : ""}
                        </span>
                      </div>
                      <Progress
                        className="h-1.5"
                        value={run.campaign.totalChunks
                          ? ((run.campaign.processedChunks ?? 0) /
                            run.campaign.totalChunks) * 100
                          : 0}
                      />
                      <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
                        <span className="font-mono">
                          campaign {shortTechnicalId(run.campaign.campaignId)}
                        </span>
                        {run.campaign.currentJobId && (
                          <Link
                            className="text-primary hover:underline"
                            to={withVoiceProfile(
                              `/jobs/${run.campaign.currentJobId}`,
                              primaryId,
                            )}
                          >
                            Current job
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {actionResult && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {actionResult.title}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActionResult(null)}
                  >
                    Close
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The operation completed. Generation state and coverage above
                  refresh automatically; use the related job for detailed logs.
                </p>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <Dialog
          open={Boolean(repairPreview)}
          onOpenChange={(open) => {
            if (!open) closeRepairPreview();
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Preview empty activation repair</DialogTitle>
              <DialogDescription>
                Read-only verification of the exact coverage that can be
                restored. Nothing changes until the next typed-confirmation step
                succeeds.
              </DialogDescription>
            </DialogHeader>
            {repairPreview && (
              <div className="space-y-4">
                <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
                  <p className="text-3xl font-semibold tabular-nums text-green-700 dark:text-green-400">
                    {repairPreview.counts.recoverableSupersededSegments
                      .toLocaleString()}
                  </p>
                  <p className="text-sm font-medium">
                    previous speaker segments will be restored
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    0 records deleted · raw audio, transcripts, embeddings, and
                    segment documents stay intact
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    <p className="text-xl font-semibold tabular-nums">
                      {repairPreview.counts.alreadyActiveReplacementSegments
                        .toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      replacement segments already active
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xl font-semibold tabular-nums">
                      {repairPreview.counts.competingActiveSegments
                        .toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      competing active segments
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xl font-semibold tabular-nums">
                      {repairPreview.replacementRunIds.length}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      predecessor generations
                    </p>
                  </div>
                </div>
                <div className="space-y-1 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
                  <p>
                    Range: {formatPickerRange(
                      {
                        start: operationDate(repairPreview.range.start),
                        end: operationDate(repairPreview.range.end),
                      },
                      pickerTimeZone,
                      "minute",
                    )}
                  </p>
                  <p>
                    Empty active generation:{" "}
                    {shortTechnicalId(repairPreview.runId)}
                  </p>
                  <p>{repairPreview.summary}</p>
                </div>
                {!repairPreview.repairable && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    Automatic repair is blocked: {repairPreview.blockers.join(
                      ", ",
                    )}.
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={closeRepairPreview}>
                Close preview
              </Button>
              <Button
                disabled={!repairPreview?.repairable ||
                  repairEmptyActivation.isPending}
                onClick={() => {
                  if (repairPreview) {
                    repairEmptyActivation.mutate(repairPreview);
                  }
                }}
              >
                {repairEmptyActivation.isPending
                  ? "Restoring…"
                  : "Continue to typed confirmation"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={Boolean(purgePreview)}
          onOpenChange={(open) => {
            if (!open) setPurgePreview(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Preview diarization purge</DialogTitle>
              <DialogDescription>
                This is a read-only preview. Raw audio and transcripts are not
                included.
              </DialogDescription>
            </DialogHeader>
            {purgePreview && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border p-3">
                    <p className="text-2xl font-semibold tabular-nums">
                      {purgePreview.documents.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      diarization documents
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-2xl font-semibold tabular-nums">
                      {purgePreview.embeddings.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">embeddings</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Generation run {shortTechnicalId(purgePreview.runId)}{" "}
                  is not active. Continuing opens a separate typed confirmation.
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPurgePreview(null)}>
                Keep generation
              </Button>
              <Button
                variant="destructive"
                disabled={runAction.isPending || !purgePreview}
                onClick={() => {
                  if (!purgePreview) return;
                  runAction.mutate({
                    action: "purge-superseded",
                    runId: purgePreview.runId,
                  });
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Continue to confirmation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
