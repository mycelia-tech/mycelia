import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMap } from "react-leaflet";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bookmark,
  Clock,
  Crosshair,
  Database,
  Images,
  Link as LinkIcon,
  Loader2,
  MapPin,
  MessageSquare,
  Route,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { callResource } from "@/lib/api";
import { useTimelineRange } from "@/stores/timelineRange";
import {
  useLocationAt,
  useLocationConflicts,
  useLocationLiveUpdates,
  useLocationMetadataConflicts,
  useLocationRouteConflicts,
  useLocationSegments,
  useLocationStatus,
  useMapDensity,
  useMapRouteDetail,
  useMapTimelineSummary,
  useRecordedLocationTracks,
  useSavedPlaces,
} from "@/hooks/useLocationQueries";
import {
  formatDurationShort,
  LocationMap,
} from "@/components/location/LocationMap";
import {
  ConversationDensityLayer,
  PresenceDensityLayer,
  RouteProjectionLayer,
} from "@/components/location/MapProjectionLayers";
import { ConversationMapPanel } from "@/components/location/ConversationMapPanel";
import { PhotoClustersLayer } from "@/components/location/PhotoClustersLayer";
import { MapTimeNavigator } from "@/components/location/MapTimeNavigator";
import { ImportTracksDialog } from "@/components/location/ImportTracksDialog";
import {
  RecordedTracksLayer,
  SavedPlacesLayer,
} from "@/components/location/LocationSourceLayers";
import { LocationConflictReviewDialog } from "@/components/location/LocationConflictReviewDialog";
import { AssignLocationDialog } from "@/components/location/AssignLocationDialog";
import { GeotagsSheet } from "@/components/location/GeotagsSheet";
import type {
  ConversationMapCluster,
  LocationSegment,
  MapBounds,
  RecordedLocationTrack,
  SavedPlace,
} from "@/types/location";
import { formatPlace, segmentDurationMs } from "@/types/location";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAP_LAYERS = [
  "presence",
  "conversations",
  "routes",
  "connectors",
  "sourceTracks",
  "photos",
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "Day", days: 1 },
  { label: "Week", days: 7 },
  { label: "Month", days: 30 },
  { label: "Year", days: 365 },
  { label: "All", days: null },
];

function maxPointsForRange(rangeMs: number): number {
  if (rangeMs <= 7 * DAY_MS) return 5000;
  if (rangeMs <= 90 * DAY_MS) return 3000;
  return 2000;
}

export function readMapUrlState() {
  if (typeof window === "undefined") {
    return {
      viewport: null,
      layers: new Set<MapLayer>([
        "presence",
        "conversations",
        "routes",
        "photos",
      ]),
      at: undefined as Date | undefined,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const latParam = params.get("lat");
  const lngParam = params.get("lng");
  const zoomParam = params.get("z");
  const lat = Number(latParam);
  const lng = Number(lngParam);
  const zoom = Number(zoomParam);
  const viewport = latParam !== null && lngParam !== null &&
      zoomParam !== null && Number.isFinite(lat) && Number.isFinite(lng) &&
      Number.isFinite(zoom) && lat >= -90 && lat <= 90 && lng >= -180 &&
      lng <= 180 && zoom >= 0 && zoom <= 24
    ? { center: [lat, lng] as [number, number], zoom }
    : null;
  const layersParam = params.get("layers");
  const requestedLayers = (layersParam ?? "").split(",").filter(
    (value): value is MapLayer => MAP_LAYERS.includes(value as MapLayer),
  );
  const atValue = Number(params.get("at"));
  return {
    viewport,
    layers: new Set<MapLayer>(
      layersParam !== null
        ? requestedLayers
        : ["presence", "conversations", "routes", "photos"],
    ),
    at: Number.isFinite(atValue) && atValue > 0 ? new Date(atValue) : undefined,
  };
}

export function mapUrlWithoutPhotoFocus(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("photoAssetId");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function normalizeBounds(bounds: MapBounds): MapBounds {
  const span = bounds.east - bounds.west;
  if (span >= 360) return { ...bounds, west: -180, east: 180 };
  let west = bounds.west;
  let east = bounds.east;
  while (west < -180) west += 360;
  while (west > 180) west -= 360;
  while (east < -180) east += 360;
  while (east > 180) east -= 360;
  return {
    west,
    east,
    south: Math.max(-90, bounds.south),
    north: Math.min(90, bounds.north),
  };
}

export function updateMapUrl(
  viewport: { center: [number, number]; zoom: number } | null,
  layers: Set<MapLayer>,
  at?: Date,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (viewport) {
    url.searchParams.set("lat", viewport.center[0].toFixed(6));
    url.searchParams.set("lng", viewport.center[1].toFixed(6));
    url.searchParams.set("z", viewport.zoom.toFixed(2));
  }
  url.searchParams.set(
    "layers",
    MAP_LAYERS.filter((layer) => layers.has(layer)).join(","),
  );
  if (at) url.searchParams.set("at", String(at.getTime()));
  else url.searchParams.delete("at");
  window.history.replaceState({}, "", url);
}

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, Math.max(map.getZoom(), 14));
  }, [map, target?.[0], target?.[1]]);
  return null;
}

function LayerButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "outline"}
      className="h-8 bg-background/95 shadow-sm"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

const MapExperiencePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const initialUrl = useMemo(readMapUrlState, []);
  const focusedPhotoAssetId = useMemo(
    () =>
      new URLSearchParams(location.search).get("photoAssetId")?.trim() ||
      undefined,
    [location.search],
  );
  const { start, end, setRange } = useTimelineRange();
  const [layers, setLayers] = useState(initialUrl.layers);
  const [viewport, setViewport] = useState<
    {
      center: [number, number];
      zoom: number;
      bounds?: MapBounds;
    } | null
  >(initialUrl.viewport);
  const [queryViewport, setQueryViewport] = useState(viewport);
  const [viewportRequest, setViewportRequest] = useState<{
    center: [number, number];
    zoom: number;
    key: number;
  }>();
  const [fitToSegments, setFitToSegments] = useState(
    !initialUrl.viewport && !focusedPhotoAssetId,
  );
  const [fitRequestKey, setFitRequestKey] = useState(0);
  const [cursorTime, setCursorTime] = useState<Date | undefined>(initialUrl.at);
  const [selectedCluster, setSelectedCluster] = useState<
    ConversationMapCluster | null
  >(null);
  const [selectedSegment, setSelectedSegment] = useState<
    LocationSegment | null
  >(null);
  const [selectedSavedPlace, setSelectedSavedPlace] = useState<
    SavedPlace | null
  >(null);
  const [selectedRecordedTrack, setSelectedRecordedTrack] = useState<
    RecordedLocationTrack | null
  >(null);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [geotagsOpen, setGeotagsOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [assignRange, setAssignRange] = useState<
    {
      start: Date;
      end: Date;
    } | null
  >(null);
  const [downloadingGeonames, setDownloadingGeonames] = useState(false);

  const closeFocusedPhoto = useCallback(() => {
    setFlyTarget(null);
    navigate(mapUrlWithoutPhotoFocus(window.location.href), { replace: true });
  }, [navigate]);

  const { data: status } = useLocationStatus();
  const rangeMs = end.getTime() - start.getTime();
  const { data: segmentsData, isLoading: segmentsLoading } =
    useLocationSegments(
      start,
      end,
      { maxPoints: maxPointsForRange(rangeMs) },
    );
  useLocationLiveUpdates();
  const segments = segmentsData?.segments ?? [];
  const mapPresenceSegments = useMemo(
    () =>
      segments.filter((segment) =>
        segment.type === "stay" || segment.type === "manual"
      ),
    [segments],
  );
  useEffect(() => {
    const timeout = setTimeout(() => setQueryViewport(viewport), 250);
    return () => clearTimeout(timeout);
  }, [viewport]);

  const showPresenceClusters = layers.has("presence") &&
    (queryViewport?.zoom ?? 2) < 14;
  const densityLayers = [
    ...(showPresenceClusters ? ["presence" as const] : []),
    ...(layers.has("conversations") ? ["conversations" as const] : []),
  ];
  const density = useMapDensity(
    start,
    end,
    queryViewport?.bounds,
    queryViewport?.zoom ?? 2,
    densityLayers,
  );
  const routes = useMapRouteDetail(
    start,
    end,
    queryViewport?.bounds,
    queryViewport?.zoom ?? 2,
    layers.has("routes"),
    layers.has("connectors"),
  );
  const timeline = useMapTimelineSummary();
  const locationAt = useLocationAt(cursorTime, !!cursorTime);
  const savedPlaces = useSavedPlaces(true);
  const sourceTracks = useRecordedLocationTracks(layers.has("sourceTracks"));
  const pointConflicts = useLocationConflicts("pending", true);
  const metadataConflicts = useLocationMetadataConflicts("pending", true);
  const routeConflicts = useLocationRouteConflicts("pending", true);

  useEffect(() => {
    updateMapUrl(viewport, layers, cursorTime);
  }, [
    viewport?.center[0],
    viewport?.center[1],
    viewport?.zoom,
    layers,
    cursorTime?.getTime(),
  ]);

  useEffect(() => {
    if (!focusedPhotoAssetId) return;
    setFitToSegments(false);
    setLayers((current) => {
      if (current.has("photos")) return current;
      const next = new Set(current);
      next.add("photos");
      return next;
    });
  }, [focusedPhotoAssetId]);

  useEffect(() => {
    if (
      focusedPhotoAssetId || !cursorTime || locationAt.isLoading ||
      !locationAt.data
    ) return;
    const segment = locationAt.data.segment;
    if (segment?.type === "gap") {
      toast.info("No GPS near this time");
      return;
    }
    const loc = locationAt.data.point?.loc ?? segment?.loc;
    if (!loc) {
      toast.info("No GPS near this time");
      return;
    }
    setFlyTarget([loc.coordinates[1], loc.coordinates[0]]);
  }, [cursorTime?.getTime(), locationAt.data, locationAt.isLoading]);

  useEffect(() => {
    const onPopState = () => {
      const next = readMapUrlState();
      setLayers(next.layers);
      setCursorTime(next.at);
      if (next.viewport) {
        setFitToSegments(false);
        setViewport(next.viewport);
        setViewportRequest({ ...next.viewport, key: Date.now() });
      }
      const params = new URLSearchParams(window.location.search);
      const nextStart = Number(params.get("start"));
      const nextEnd = Number(params.get("end"));
      if (
        Number.isFinite(nextStart) && Number.isFinite(nextEnd) &&
        nextEnd > nextStart
      ) setRange(new Date(nextStart), new Date(nextEnd));
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, [setRange]);

  const toggleLayer = (layer: MapLayer) => {
    if (
      layer === "photos" && layers.has("photos") && focusedPhotoAssetId
    ) {
      closeFocusedPhoto();
    }
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      if (layer === "routes" && !next.has("routes")) next.delete("connectors");
      if (layer === "connectors" && next.has("connectors")) next.add("routes");
      return next;
    });
  };

  const applyPreset = (days: number | null) => {
    if (days === null && timeline.data) {
      setRange(
        new Date(timeline.data.dataRange.start),
        new Date(timeline.data.dataRange.end),
      );
      return;
    }
    const nextEnd = new Date();
    setRange(new Date(nextEnd.getTime() - (days ?? 30) * DAY_MS), nextEnd);
  };

  const startGeonamesDownload = async () => {
    setDownloadingGeonames(true);
    try {
      await callResource("jobs", {
        action: "enqueue",
        data: { type: "geonames_download" },
        trigger: {
          type: "manual",
          reason: "Places database requested from Map",
        },
      });
      toast.success(
        "Places database download started. Progress is visible in Jobs.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download failed");
      setDownloadingGeonames(false);
    }
  };

  const closeSelection = () => {
    setSelectedCluster(null);
    setSelectedSegment(null);
    setSelectedSavedPlace(null);
    setSelectedRecordedTrack(null);
  };

  const selectSegment = (segment: LocationSegment) => {
    if (segment.type === "gap") {
      setAssignRange({
        start: new Date(segment.start),
        end: new Date(segment.end),
      });
      return;
    }
    closeSelection();
    setSelectedSegment(segment);
  };

  const isRefreshing = density.data?.projection.stale === true ||
    (density.isFetching && !density.isLoading);
  const pendingConflicts = (pointConflicts.data?.total ?? 0) +
    (metadataConflicts.data?.total ?? 0) + (routeConflicts.data?.total ?? 0);
  const hasSelection = selectedCluster || selectedSegment ||
    selectedSavedPlace || selectedRecordedTrack;

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              variant="ghost"
              size="sm"
              onClick={() => applyPreset(preset.days)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (focusedPhotoAssetId) closeFocusedPhoto();
            setFitToSegments(true);
            setFitRequestKey((key) => key + 1);
          }}
        >
          <Crosshair className="mr-1.5 h-4 w-4" /> Fit selected data
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(window.location.href);
            toast.success("Exact map link copied");
          }}
        >
          <LinkIcon className="mr-1.5 h-4 w-4" /> Copy link
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {(segmentsLoading || density.isFetching || routes.isFetching) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          {status && !status.geonamesReady && (
            <Button
              variant="outline"
              size="sm"
              disabled={downloadingGeonames}
              onClick={startGeonamesDownload}
            >
              <Database className="mr-2 h-4 w-4" /> Download places
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setGeotagsOpen(true)}
          >
            <MapPin className="mr-2 h-4 w-4" /> Geotags
          </Button>
          {pendingConflicts > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConflictsOpen(true)}
            >
              <AlertTriangle className="mr-2 h-4 w-4 text-amber-600" />
              Review ({pendingConflicts})
            </Button>
          )}
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Import tracks
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="relative isolate min-h-0 flex-1 overflow-hidden rounded-lg border">
            <LocationMap
              segments={mapPresenceSegments}
              fitToSegments={fitToSegments && !focusedPhotoAssetId}
              fitRequestKey={fitRequestKey}
              initialCenter={initialUrl.viewport?.center ?? [20, 0]}
              initialZoom={initialUrl.viewport?.zoom ?? 2}
              viewportRequest={viewportRequest}
              selectedSegmentId={selectedSegment
                ? String(selectedSegment._id)
                : null}
              onSegmentClick={selectSegment}
              onViewportChange={(next) =>
                setViewport({ ...next, bounds: normalizeBounds(next.bounds) })}
              showStays={layers.has("presence") &&
                (viewport?.zoom ?? 2) >= 14}
              showMoves={false}
              showGaps={false}
            >
              {(layers.has("photos") || focusedPhotoAssetId) && (
                <PhotoClustersLayer
                  focusedAssetId={focusedPhotoAssetId}
                  onFocusedAssetClose={closeFocusedPhoto}
                />
              )}
              {layers.has("presence") && showPresenceClusters && (
                <PresenceDensityLayer
                  clusters={density.data?.presenceClusters ?? []}
                  stale={isRefreshing}
                />
              )}
              {layers.has("conversations") && (
                <ConversationDensityLayer
                  clusters={density.data?.conversationClusters ?? []}
                  stale={isRefreshing}
                  onOpenCluster={(cluster) => {
                    closeSelection();
                    setSelectedCluster(cluster);
                  }}
                />
              )}
              {layers.has("routes") && (
                <RouteProjectionLayer
                  data={routes.data}
                  showConnectors={layers.has("connectors")}
                  stale={routes.data?.projection.status === "stale" ||
                    (routes.isFetching && !routes.isLoading)}
                />
              )}
              {layers.has("sourceTracks") && (
                <RecordedTracksLayer
                  tracks={sourceTracks.data?.tracks ?? []}
                  onSelect={(track) => {
                    closeSelection();
                    setSelectedRecordedTrack(track);
                  }}
                />
              )}
              <SavedPlacesLayer
                places={savedPlaces.data?.places ?? []}
                onSelect={(place) => {
                  closeSelection();
                  setSelectedSavedPlace(place);
                }}
              />
              <FlyTo target={focusedPhotoAssetId ? null : flyTarget} />
            </LocationMap>

            <div className="pointer-events-none absolute inset-x-2 bottom-2 z-[1000] flex flex-wrap justify-center gap-1.5 [&>*]:pointer-events-auto">
              <LayerButton
                active={layers.has("presence")}
                onClick={() => toggleLayer("presence")}
              >
                <MapPin className="mr-1 h-3.5 w-3.5" /> Presence
              </LayerButton>
              <LayerButton
                active={layers.has("conversations")}
                onClick={() => toggleLayer("conversations")}
              >
                <MessageSquare className="mr-1 h-3.5 w-3.5" /> Conversations
              </LayerButton>
              <LayerButton
                active={layers.has("routes")}
                onClick={() => toggleLayer("routes")}
              >
                <Route className="mr-1 h-3.5 w-3.5" /> Routes
              </LayerButton>
              <LayerButton
                active={layers.has("connectors")}
                onClick={() => toggleLayer("connectors")}
              >
                Unrecorded connections
              </LayerButton>
              <LayerButton
                active={layers.has("sourceTracks")}
                onClick={() => toggleLayer("sourceTracks")}
              >
                Source tracks
              </LayerButton>
              <LayerButton
                active={layers.has("photos")}
                onClick={() => toggleLayer("photos")}
              >
                <Images className="mr-1 h-3.5 w-3.5" /> Photos
              </LayerButton>
            </div>

            {density.data?.projection.status === "building" && (
              <div className="absolute left-3 top-3 z-[1000] rounded bg-background/95 px-3 py-2 text-sm shadow">
                Preparing map index
                {density.data.projection.progress?.total
                  ? ` · ${density.data.projection.progress.processed}/${density.data.projection.progress.total}`
                  : ""}
              </div>
            )}
            {density.data?.projection.status === "failed" && (
              <div className="absolute left-3 top-3 z-[1000] rounded bg-destructive px-3 py-2 text-sm text-destructive-foreground shadow">
                Conversation map index failed. Retry it from Jobs.
              </div>
            )}
            {layers.has("conversations") &&
              density.data?.projection.status === "not-built" && (
              <div className="absolute left-3 top-3 z-[1000] rounded bg-background/95 px-3 py-2 text-sm shadow">
                Conversation map index is not built yet. Start Location map
                index in Jobs.
              </div>
            )}
            {layers.has("routes") && routes.data &&
              !routes.data.projection.ready && (
              <div className="absolute right-3 top-3 z-[1000] rounded bg-background/95 px-3 py-2 text-sm shadow">
                Route detail index is not built yet.
              </div>
            )}
            {routes.data?.detailLimited && (
              <div className="absolute right-3 top-3 z-[1000] rounded bg-background/95 px-3 py-2 text-sm shadow">
                Zoom in for full detail
              </div>
            )}
            {(routes.data?.conflicts.length ?? 0) > 0 && (
              <div className="absolute right-3 top-14 z-[1000] rounded bg-amber-500/95 px-3 py-2 text-sm text-black shadow">
                {routes.data!.conflicts.length} overlapping route source
                {routes.data!.conflicts.length === 1 ? "" : "s"}{" "}
                shown separately
              </div>
            )}
          </div>

          <MapTimeNavigator
            summary={timeline.data}
            start={start}
            end={end}
            cursor={cursorTime}
            onCommitRange={setRange}
            onSelectTime={setCursorTime}
          />
        </div>

        {selectedCluster && (
          <ConversationMapPanel
            cluster={selectedCluster}
            start={start}
            end={end}
            revision={density.data?.projection.revision ?? 0}
            onClose={() => setSelectedCluster(null)}
            onFlyTo={setFlyTarget}
          />
        )}

        {!selectedCluster && hasSelection && (
          <Card className="flex w-80 shrink-0 flex-col overflow-hidden">
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
              <CardTitle className="text-base">
                {selectedSavedPlace
                  ? selectedSavedPlace.displayName || "Saved place"
                  : selectedRecordedTrack
                  ? selectedRecordedTrack.displayName || "Source track"
                  : formatPlace(selectedSegment?.place)}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={closeSelection}
              >
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto text-sm">
              {selectedSegment && (
                <>
                  <p className="text-muted-foreground">
                    {new Date(selectedSegment.start).toLocaleString()} —{" "}
                    {new Date(selectedSegment.end).toLocaleString()}
                  </p>
                  <p>
                    Stayed{" "}
                    {formatDurationShort(segmentDurationMs(selectedSegment))}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const from = new Date(selectedSegment.start).getTime() -
                        60 * 60 * 1000;
                      const to = new Date(selectedSegment.end).getTime() +
                        60 * 60 * 1000;
                      navigate(`/timeline?start=${from}&end=${to}`);
                    }}
                  >
                    <Clock className="mr-2 h-4 w-4" /> Open in timeline
                  </Button>
                </>
              )}
              {selectedSavedPlace && (
                <>
                  {selectedSavedPlace.description && (
                    <p>{selectedSavedPlace.description}</p>
                  )}
                  <p className="font-mono text-xs text-muted-foreground">
                    {selectedSavedPlace.loc.coordinates[1].toFixed(6)},{"  "}
                    {selectedSavedPlace.loc.coordinates[0].toFixed(6)}
                  </p>
                  <Badge variant="secondary">
                    <Bookmark className="mr-1 h-3 w-3" /> Saved place
                  </Badge>
                </>
              )}
              {selectedRecordedTrack && (
                <>
                  <p>
                    {new Intl.NumberFormat().format(
                      selectedRecordedTrack.geometryPointCount ??
                        selectedRecordedTrack.pointCount,
                    )} source coordinates
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Raw source preview. The blue Routes layer uses
                    continuity-aware geometry.
                  </p>
                  {selectedRecordedTrack.routeBoundaryCompleteness !==
                      "full" && (
                    <p className="text-xs text-amber-600">
                      Explicit source segment boundaries are unavailable until
                      the saved original is reparsed.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <ImportTracksDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onShowImportOnMap={(item) => {
          if (!item.timeRange?.start || !item.timeRange.end) return;
          setImportOpen(false);
          setRange(
            new Date(item.timeRange.start),
            new Date(item.timeRange.end),
          );
        }}
      />
      <GeotagsSheet
        open={geotagsOpen}
        onOpenChange={setGeotagsOpen}
        start={start}
        end={end}
        onShowOnMap={(segment) => {
          setGeotagsOpen(false);
          if (segment.loc) {
            setFlyTarget([
              segment.loc.coordinates[1],
              segment.loc.coordinates[0],
            ]);
          } else if (segment.path?.length) {
            setFlyTarget([segment.path[0][1], segment.path[0][0]]);
          }
          if (segment.type === "stay" || segment.type === "manual") {
            selectSegment(segment);
          }
        }}
      />
      <LocationConflictReviewDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
      />
      <AssignLocationDialog
        open={assignRange !== null}
        onOpenChange={(open) => !open && setAssignRange(null)}
        initialStart={assignRange?.start}
        initialEnd={assignRange?.end}
      />
    </div>
  );
};

export default MapExperiencePage;
