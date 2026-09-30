import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarRange,
  Link2,
  Loader2,
  MapPin,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { AuthenticatedMediaImage } from "./AuthenticatedMediaImage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Props = {
  status?: {
    enabled?: boolean;
    activeProfileId?: string;
    profiles?: Array<{
      id: string;
      name: string;
      enabled: boolean;
      providerType: "google-cloud" | "self-hosted" | "openai-compatible";
    }>;
    eventAggregation?: {
      maxGapMinutes?: number;
      maxDistanceKm?: number;
      maxPreviewsPerAnalysis?: number;
      perEventGrossLimitUsd?: number;
    };
  };
  candidateAssetIds?: string[];
  onOpenAsset?: (assetId: string) => void | Promise<void>;
};

const MAX_EVENTS_PER_CONFIRMATION = 100;

function formattedPeriod(start: unknown, end: unknown): string {
  const startDate = new Date(String(start ?? ""));
  const endDate = new Date(String(end ?? start ?? ""));
  if (!Number.isFinite(startDate.getTime())) return "Unknown period";
  const format = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${format.format(startDate)} – ${format.format(endDate)}`;
}

function timelineHref(start: unknown, end: unknown): string {
  const startDate = new Date(String(start ?? ""));
  const endDate = new Date(String(end ?? start ?? ""));
  if (!Number.isFinite(startDate.getTime())) return "/timeline";
  const safeEnd = Number.isFinite(endDate.getTime()) ? endDate : startDate;
  return `/timeline?start=${startDate.getTime()}&end=${safeEnd.getTime()}`;
}

export function MediaEventsPanel({
  status,
  candidateAssetIds = [],
  onOpenAsset,
}: Props) {
  const [events, setEvents] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>();
  const [analysisPreview, setAnalysisPreview] = useState<any>();
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [profileId, setProfileId] = useState("");
  const [queueAnalysis, setQueueAnalysis] = useState(false);
  const [maxGapMinutes, setMaxGapMinutes] = useState(240);
  const [maxDistanceKm, setMaxDistanceKm] = useState(25);
  const [busy, setBusy] = useState(false);

  const enabledProfiles = useMemo(
    () =>
      status?.enabled
        ? (status.profiles ?? []).filter((profile) =>
          profile.enabled && profile.providerType !== "openai-compatible"
        )
        : [],
    [status?.enabled, status?.profiles],
  );
  const providerPreviewLimit = status?.eventAggregation
    ?.maxPreviewsPerAnalysis ?? 8;
  const selectedProfile = enabledProfiles.find((entry) =>
    entry.id === profileId
  );

  const loadEvents = async (showError = true) => {
    try {
      const result = await callResource("media-events", {
        action: "list",
        limit: 30,
      });
      setEvents(result.events ?? []);
    } catch (error) {
      if (showError) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to load photo events",
        );
      }
    }
  };

  useEffect(() => {
    setMaxGapMinutes(status?.eventAggregation?.maxGapMinutes ?? 240);
    setMaxDistanceKm(status?.eventAggregation?.maxDistanceKm ?? 25);
    setProfileId((current) => {
      if (enabledProfiles.some((profile) => profile.id === current)) {
        return current;
      }
      return enabledProfiles.some((profile) =>
          profile.id === status?.activeProfileId
        )
        ? String(status?.activeProfileId)
        : "";
    });
  }, [status, enabledProfiles]);

  useEffect(() => {
    void loadEvents();
  }, []);

  useEffect(() => {
    if (
      !events.some((entry) =>
        ["queued", "processing"].includes(entry.event?.status ?? entry.status)
      )
    ) return;
    const timer = setInterval(() => void loadEvents(false), 3000);
    return () => clearInterval(timer);
  }, [events]);

  const buildPreview = async (explicitAssetIds?: string[]) => {
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "previewAggregation",
        maxGapMinutes,
        maxDistanceKm,
        limit: 500,
        ...(explicitAssetIds && explicitAssetIds.length >= 2
          ? { assetIds: explicitAssetIds }
          : {}),
        ...(profileId ? { profileId } : {}),
      });
      setPreview(result);
      setSelectedIndexes(
        (result.groups ?? []).slice(0, MAX_EVENTS_PER_CONFIRMATION).map(
          (group: any, index: number) => Number(group.index ?? index),
        ),
      );
      setQueueAnalysis(false);
      toast.success(
        `Built ${result.groups?.length ?? 0} local event proposal(s) and ${
          result.singletons?.length ?? 0
        } single photo(s); no provider was called`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Photo event proposal failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmPreview = async () => {
    if (!preview || selectedIndexes.length === 0) return;
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "confirmAggregation",
        previewId: String(preview.previewId),
        selectedGroupIndexes: selectedIndexes,
        consent: true,
        queueAnalysis: Boolean(queueAnalysis && profileId),
      });
      const confirmed = (result.events ?? []).length;
      const queued = (result.events ?? []).filter((entry: any) =>
        entry.queued || entry.jobId
      ).length;
      const failed = (result.events ?? []).filter((entry: any) =>
        entry.error
      )
        .length;
      if (queueAnalysis && (failed > 0 || queued < confirmed)) {
        toast.warning(
          `Confirmed ${confirmed} event(s); queued ${queued}. ${failed} event(s) remain available for Retry.`,
        );
      } else {
        toast.success(
          queueAnalysis
            ? `Confirmed ${confirmed} event(s); queued ${queued}`
            : `Confirmed ${confirmed} local event(s)`,
        );
      }
      setPreview(undefined);
      setSelectedIndexes([]);
      await loadEvents();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Photo event confirmation failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const reviewAnalysis = async (eventId: string) => {
    if (!profileId) return;
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "previewAnalysis",
        eventId,
        profileId,
      });
      setAnalysisPreview({
        ...result,
        eventId,
        idempotencyKey: globalThis.crypto?.randomUUID?.() ??
          `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
      toast.success("Analysis preview is ready; no provider was called");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Event analysis preview failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmAnalysis = async () => {
    if (!analysisPreview) return;
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "retry",
        eventId: String(analysisPreview.eventId),
        previewId: String(analysisPreview.previewId),
        consent: true,
        idempotencyKey: String(analysisPreview.idempotencyKey),
      });
      toast.success(
        result.queued === false
          ? "Event remains available for Retry"
          : "Event analysis queued",
      );
      setAnalysisPreview(undefined);
      await loadEvents();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Event analysis failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const publish = async (eventId: string, analysisRunId: string) => {
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "publishEvent",
        eventId,
        analysisRunId,
        confirm: true,
        reviewedSensitiveText: true,
      });
      toast.success("Published as a Mycelia Event and added to Timeline");
      await loadEvents();
      return result.objectId;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Event publication failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const refreshLinks = async (eventId: string) => {
    setBusy(true);
    try {
      const result = await callResource("media-events", {
        action: "refreshLinks",
        eventId,
      });
      toast.success(
        `Refreshed ${
          Number(result.createdOrRefreshed ?? 0)
        } local memory link(s)`,
      );
      await loadEvents();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Event link refresh failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleCandidate = (index: number, enabled: boolean) => {
    setSelectedIndexes((current) => {
      if (
        enabled && !current.includes(index) &&
        current.length >= MAX_EVENTS_PER_CONFIRMATION
      ) {
        toast.error(
          `Confirm at most ${MAX_EVENTS_PER_CONFIRMATION} event groups per batch`,
        );
        return current;
      }
      return enabled
        ? [...new Set([...current, index])].sort((a, b) => a - b)
        : current.filter((value) => value !== index);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarRange className="h-5 w-5" />Photo events
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Mycelia first clusters owned photos locally by capture time and GPS.
          Only after a separate confirmation can the selected provider receive
          up to {providerPreviewLimit}{" "}
          sanitized WebP thumbnails. Paths, SHA, raw EXIF, exact GPS, transcript
          text, and Object data are never included.
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="event-gap-minutes">Maximum gap, minutes</Label>
            <Input
              id="event-gap-minutes"
              type="number"
              min="15"
              max="1440"
              value={maxGapMinutes}
              disabled={busy || Boolean(preview)}
              onChange={(event) => setMaxGapMinutes(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-distance-km">Maximum distance, km</Label>
            <Input
              id="event-distance-km"
              type="number"
              min="0.1"
              max="500"
              step="0.1"
              value={maxDistanceKm}
              disabled={busy || Boolean(preview)}
              onChange={(event) => setMaxDistanceKm(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-provider">Event provider</Label>
            <select
              id="event-provider"
              className="w-full rounded-md border bg-background p-2"
              value={profileId}
              disabled={busy || Boolean(preview)}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="">Local clusters only</option>
              {enabledProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => buildPreview()}
            disabled={busy || Boolean(preview)}
          >
            {busy
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Sparkles className="mr-2 h-4 w-4" />}
            Build local event proposals
          </Button>
          <Button
            variant="outline"
            onClick={() => buildPreview(candidateAssetIds)}
            disabled={busy || Boolean(preview) || candidateAssetIds.length < 2}
          >
            Build from selected photos ({candidateAssetIds.length})
          </Button>
        </div>

        {preview && (
          <div className="space-y-4 rounded-md border border-primary/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">Review event groups</div>
                <p className="text-xs text-muted-foreground">
                  Local clustering is complete. No Google or self-hosted call
                  has happened yet. {preview.groupedAssetCount ?? 0} of{" "}
                  {preview.eligibleAssetCount ?? 0}{" "}
                  eligible photo(s) formed groups;{" "}
                  {preview.singletons?.length ?? 0}{" "}
                  remain single because no nearby photo matched the current
                  time/GPS limits.
                  {(preview.groups?.length ?? 0) > MAX_EVENTS_PER_CONFIRMATION
                    ? ` The first ${MAX_EVENTS_PER_CONFIRMATION} groups are selected; confirm them, then build another batch.`
                    : ""}
                </p>
              </div>
              <Badge variant="outline">
                Maximum selected cost ${Number(
                  (preview.groups ?? [])
                    .filter((group: any, index: number) =>
                      selectedIndexes.includes(Number(group.index ?? index))
                    )
                    .reduce(
                      (sum: number, group: any) =>
                        sum + Number(group.estimatedGrossUsd ?? 0),
                      0,
                    ),
                ).toFixed(4)}
              </Badge>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {(preview.groups ?? []).map((group: any, index: number) => {
                const groupIndex = Number(group.index ?? index);
                return (
                  <div
                    key={group.stableKey ?? groupIndex}
                    className="rounded-md border p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">
                          {group.assetCount} photos
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formattedPeriod(group.startAt, group.endAt)}
                        </div>
                        {group.centroid && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            <MapPin className="mr-1 inline h-3 w-3" />
                            GPS grouped locally
                          </div>
                        )}
                      </div>
                      <Switch
                        aria-label={`Include event group ${groupIndex + 1}`}
                        checked={selectedIndexes.includes(groupIndex)}
                        onCheckedChange={(enabled) =>
                          toggleCandidate(groupIndex, enabled)}
                      />
                    </div>
                    <div className="mt-3 text-xs font-medium">
                      Exact provider preview set ({(group.providerAssets ?? [])
                        .length}); sent only if analysis is queued
                    </div>
                    <div className="mt-2 flex -space-x-3 overflow-hidden">
                      {(group.providerAssets ?? group.assets ?? []).map((
                        asset: any,
                      ) => (
                        <AuthenticatedMediaImage
                          key={String(asset.assetId)}
                          path={asset.thumbnailUrl}
                          alt={asset.fileName ?? "Event photo"}
                          className="h-16 w-16 rounded border-2 border-background object-cover"
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {(preview.singletons?.length ?? 0) > 0 && (
              <div className="space-y-3 rounded-md border border-dashed p-3">
                <div>
                  <div className="font-medium">Single photos</div>
                  <p className="text-xs text-muted-foreground">
                    These photos were not lost. They do not make a 2+ photo
                    event with the current limits. Open one for ordinary photo
                    recognition, or select several in Media inventory and build
                    a proposal from that explicit selection.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {preview.singletons.map((asset: any) => (
                    <div
                      key={String(asset.assetId)}
                      className="flex items-center gap-3 rounded border p-2"
                    >
                      <AuthenticatedMediaImage
                        path={asset.thumbnailUrl}
                        alt={asset.fileName ?? "Single photo"}
                        className="h-14 w-14 rounded object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {asset.fileName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formattedPeriod(asset.capturedAt, asset.capturedAt)}
                        </div>
                      </div>
                      {onOpenAsset && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onOpenAsset(String(asset.assetId))}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Queue group understanding after confirmation</Label>
                <p className="text-xs text-muted-foreground">
                  {selectedProfile?.providerType === "google-cloud"
                    ? `The Google profile receives only selected thumbnails; the app reserves at most $${
                      Number(
                        status?.eventAggregation?.perEventGrossLimitUsd ?? 0.02,
                      ).toFixed(2)
                    } per event.`
                    : selectedProfile
                    ? "Previews stay on the selected self-hosted endpoint."
                    : "Choose a provider to analyze titles, activities, and highlights."}
                </p>
              </div>
              <Switch
                aria-label="Queue event understanding"
                checked={queueAnalysis}
                disabled={!profileId}
                onCheckedChange={setQueueAnalysis}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={confirmPreview}
                disabled={busy || selectedIndexes.length === 0}
              >
                Confirm {selectedIndexes.length} event group(s)
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(undefined);
                  setSelectedIndexes([]);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {events.length === 0
          ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No confirmed photo events yet.
            </div>
          )
          : (
            <div className="grid gap-4 lg:grid-cols-2">
              {events.map((entry) => {
                const event = entry.event ?? entry;
                const analysis = entry.analysis?.understanding ??
                  entry.analysis ?? event.analysis;
                const eventId = String(event._id ?? entry.eventId);
                const statusValue = event.status ?? "clustered";
                const linkCounts = entry.links ?? {};
                const linkCount = (value: unknown) =>
                  Array.isArray(value) ? value.length : Number(value ?? 0);
                const assetsById = new Map(
                  (entry.assets ?? []).map((asset: any) => [
                    String(asset.assetId ?? asset._id),
                    asset,
                  ]),
                );
                const transcriptions = Array.isArray(linkCounts.transcriptions)
                  ? linkCounts.transcriptions
                  : [];
                const audioSources = Array.isArray(linkCounts.audioSources)
                  ? linkCounts.audioSources
                  : [];
                const objectLinks = Array.isArray(linkCounts.objects)
                  ? linkCounts.objects
                  : [];
                return (
                  <div
                    key={eventId}
                    className="space-y-3 rounded-md border p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-lg font-semibold">
                          {analysis?.title ?? "Local photo event"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formattedPeriod(
                            event.period?.start ?? event.startAt,
                            event.period?.end ?? event.endAt,
                          )}
                        </div>
                      </div>
                      <Badge
                        variant={statusValue === "ready"
                          ? "default"
                          : "secondary"}
                      >
                        {statusValue}
                      </Badge>
                    </div>
                    <div className="flex -space-x-3 overflow-hidden">
                      {(entry.assets ?? []).slice(0, 8).map((asset: any) => (
                        <AuthenticatedMediaImage
                          key={String(asset.assetId ?? asset._id)}
                          path={asset.thumbnailUrl}
                          alt={asset.fileName ?? "Event photo"}
                          className="h-20 w-20 rounded border-2 border-background object-cover"
                        />
                      ))}
                    </div>
                    {analysis?.description && (
                      <p className="text-sm">{analysis.description}</p>
                    )}
                    {analysis && (
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="secondary">
                          {String(analysis.eventType ?? "unknown")}
                        </Badge>
                        <Badge variant="outline">
                          confidence{" "}
                          {Math.round(Number(analysis.confidence ?? 0) * 100)}%
                        </Badge>
                        {(analysis.keywords ?? []).slice(0, 8).map((
                          keyword: string,
                        ) => (
                          <Badge key={keyword} variant="outline">
                            {keyword}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {analysis?.place?.visualSummary && (
                      <div className="text-sm text-muted-foreground">
                        <MapPin className="mr-1 inline h-4 w-4" />
                        {analysis.place.visualSummary}
                      </div>
                    )}
                    {analysis?.keyActions?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {analysis.keyActions.slice(0, 6).map((
                          action: any,
                          index: number,
                        ) => (
                          <Badge
                            key={`${action.text ?? action}-${index}`}
                            variant="outline"
                          >
                            {action.text ?? action}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {analysis?.participants?.visiblePeopleRange && (
                      <div className="text-sm">
                        Visible people per frame:{" "}
                        {analysis.participants.visiblePeopleRange.min}–{analysis
                          .participants.visiblePeopleRange.max}
                        {analysis.participants.groups?.length > 0
                          ? `; roles: ${
                            analysis.participants.groups.map((group: any) =>
                              group.role
                            ).join(", ")
                          }`
                          : ""}
                      </div>
                    )}
                    {analysis?.highlights?.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-sm font-medium">Best frames</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {[...analysis.highlights]
                            .sort((left: any, right: any) =>
                              left.rank - right.rank
                            )
                            .slice(0, 6)
                            .map((highlight: any) => {
                              const asset = assetsById.get(
                                String(highlight.ref),
                              ) as any;
                              return (
                                <div
                                  key={`${highlight.ref}-${highlight.rank}`}
                                  className="flex gap-2 rounded border p-2"
                                >
                                  {asset?.thumbnailUrl && (
                                    <AuthenticatedMediaImage
                                      path={asset.thumbnailUrl}
                                      alt={asset.fileName ??
                                        "Highlighted event frame"}
                                      className="h-14 w-14 rounded object-cover"
                                    />
                                  )}
                                  <div className="text-xs">
                                    <div className="font-medium">
                                      #{highlight.rank}
                                    </div>
                                    <div>{highlight.reason}</div>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                    {analysis?.warnings?.length > 0 && (
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        {analysis.warnings.join(" · ")}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      <Link2 className="mr-1 inline h-3 w-3" />
                      {linkCount(linkCounts.transcriptions)} transcription(s),
                      {" "}
                      {linkCount(
                        linkCounts.audioSources,
                      )} audio source(s), {linkCount(linkCounts.objects)}{" "}
                      Object link(s)
                    </div>
                    {(transcriptions.length > 0 || audioSources.length > 0 ||
                      objectLinks.length > 0) && (
                      <div className="flex flex-wrap gap-2 text-xs">
                        {audioSources.slice(0, 4).map((
                          link: any,
                          index: number,
                        ) => (
                          <Link
                            key={String(link.id ?? link.targetId)}
                            className="underline"
                            to={`/audio/source_files/${link.targetId}`}
                          >
                            Audio {index + 1}
                          </Link>
                        ))}
                        {transcriptions.slice(0, 4).map((
                          link: any,
                          index: number,
                        ) => (
                          <Link
                            key={String(link.id ?? link.targetId)}
                            className="underline"
                            to={timelineHref(
                              link.overlap?.startAt ?? event.startAt,
                              link.overlap?.endAt ?? event.endAt,
                            )}
                          >
                            Transcript {index + 1} on Timeline
                          </Link>
                        ))}
                        {objectLinks.slice(0, 4).map((
                          link: any,
                          index: number,
                        ) => (
                          <Link
                            key={String(link.id ?? link.targetId)}
                            className="underline"
                            to={`/objects/${link.targetId}`}
                          >
                            Object {index + 1}
                          </Link>
                        ))}
                      </div>
                    )}
                    {event.safeError && (
                      <div className="text-sm text-destructive">
                        {event.safeError}
                      </div>
                    )}
                    {event.linkWarning && (
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        Local link warning: {event.linkWarning}
                      </div>
                    )}
                    {statusValue === "ready" && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Publishing confirms that you reviewed the provider text
                        for names, identity guesses, and sensitive claims.
                      </p>
                    )}
                    {analysisPreview?.eventId === eventId && (
                      <div className="space-y-3 rounded border border-primary/40 p-3">
                        <div className="text-sm font-medium">
                          Review exactly what will be sent
                        </div>
                        <p className="text-xs text-muted-foreground">
                          No provider has been called. Confirming sends only the
                          thumbnails below to {analysisPreview.provider?.name ??
                            "the selected provider"}. Originals, paths, SHA, raw
                          EXIF, GPS, links and transcript text remain local.
                          Maximum reserved cost: ${Number(
                            analysisPreview.estimatedGrossUsd ?? 0,
                          ).toFixed(4)}.
                        </p>
                        <div className="flex -space-x-3 overflow-hidden">
                          {(analysisPreview.providerAssets ?? []).map((
                            asset: any,
                          ) => (
                            <AuthenticatedMediaImage
                              key={String(asset.assetId)}
                              path={asset.thumbnailUrl}
                              alt={asset.fileName ?? "Provider event preview"}
                              className="h-16 w-16 rounded border-2 border-background object-cover"
                            />
                          ))}
                        </div>
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                          Provider text is untrusted model output. Review it
                          before publishing or updating the Event Object.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={confirmAnalysis}
                          >
                            Confirm and queue analysis
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setAnalysisPreview(undefined)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!["queued", "processing"].includes(statusValue) &&
                        profileId && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => reviewAnalysis(eventId)}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          {statusValue === "ready" ? "Reanalyze" : "Analyze"}
                        </Button>
                      )}
                      {statusValue === "ready" && (
                        <Button
                          size="sm"
                          disabled={busy || !event.currentRunId}
                          onClick={() =>
                            publish(eventId, String(event.currentRunId))}
                        >
                          {event.objectId
                            ? "Sync Event Object"
                            : "Publish to Mycelia"}
                        </Button>
                      )}
                      {event.objectId && (
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/objects/${event.objectId}`}>
                            Open Event Object
                          </Link>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => refreshLinks(eventId)}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />Refresh links
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </CardContent>
    </Card>
  );
}
