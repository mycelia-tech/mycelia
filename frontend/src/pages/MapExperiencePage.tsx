import {
  activeSourceFilter,
  LocationSourceFilter,
} from "@/components/location/LocationSourceFilter";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  DEFAULT_MAP_ROUTE_DISPLAY,
  useSettingsStore,
} from "@/stores/settingsStore";
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
  useMapSourceExtent,
  useMapSourcePoints,
  type MapSourceLayerSelection,
  useMapTimelineSummary,
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
import { MapSourcePointsLayer } from "@/components/location/MapSourcePointsLayer";
import { UNKNOWN_LOCATION_PROVIDER, type LocationSourceFilter as SourceFilter } from "@myceliasdk/location-sources.ts";
import { PhotoClustersLayer } from "@/components/location/PhotoClustersLayer";
import {
  GAP_DISTANCES_M,
  GAP_MINUTES,
  MapDisplaySettings,
} from "@/components/location/MapDisplaySettings";
import { MapTimeNavigator } from "@/components/location/MapTimeNavigator";
import { ImportTracksDialog } from "@/components/location/ImportTracksDialog";
import { SavedPlacesLayer } from "@/components/location/LocationSourceLayers";
import { LocationConflictReviewDialog } from "@/components/location/LocationConflictReviewDialog";
import { AssignLocationDialog } from "@/components/location/AssignLocationDialog";
import { GeotagsSheet } from "@/components/location/GeotagsSheet";
import type {
  ConversationMapCluster,
  LocationImport,
  MapSourceSelection,
  LocationSegment,
  MapBounds,
  MapRouteSourceTrack,
  SavedPlace,
} from "@/types/location";
import { formatPlace, segmentDurationMs } from "@/types/location";

function readGapThresholds(params: URLSearchParams) {
  const saved = useSettingsStore.getState().mapRouteDisplay;
  const distance = Number(params.get("gapM"));
  const minutes = Number(params.get("gapMin"));
  return {
    gapDistanceM: GAP_DISTANCES_M.includes(distance)
      ? distance
      : saved.gapDistanceM,
    gapMinutes: GAP_MINUTES.includes(minutes) ? minutes : saved.gapMinutes,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ROUTE_SOURCES: MapRouteSourceTrack[] = [];
export const MAP_LAYERS = [
  "presence",
  "conversations",
  "routes",
  "connectors",
  "sourceTracks",
  "photos",
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

type FocusedSource = {
  layer: MapSourceLayerSelection;
  source: MapSourceSelection;
  filter: SourceFilter;
};

function SourceBounds({ bounds, onFit }: { bounds: MapBounds; onFit: () => void }) {
  const map = useMap();
  useEffect(() => {
    const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
    map.fitBounds([[bounds.south, bounds.west], [bounds.north, east]], {
      maxZoom: 16, padding: [24, 24], animate: false,
    });
    onFit();
  }, [map, bounds, onFit]);
  return null;
}

function LayerGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 max-w-full flex-col gap-1">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function maxPointsForRange(rangeMs: number): number {
  if (rangeMs <= 7 * DAY_MS) return 5000;
  if (rangeMs <= 90 * DAY_MS) return 3000;
  return 2000;
}

export function readMapUrlState() {
  if (typeof window === "undefined") {
    return {
      viewport: null,
      showPlaces: true,
      layers: new Set<MapLayer>([
        "presence",
        "conversations",
        "routes",
        "photos",
      ]),
      at: undefined as Date | undefined,
      ...readGapThresholds(new URLSearchParams()),
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
    showPlaces: params.get("places") !== "off",
    layers: new Set<MapLayer>(
      layersParam !== null
        ? requestedLayers
        : ["presence", "conversations", "routes", "photos"],
    ),
    ...readGapThresholds(params),
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
  gapDistanceM = DEFAULT_MAP_ROUTE_DISPLAY.gapDistanceM,
  gapMinutes = DEFAULT_MAP_ROUTE_DISPLAY.gapMinutes,
  showPlaces = true,
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
  url.searchParams.set("gapM", String(gapDistanceM));
  url.searchParams.set("gapMin", String(gapMinutes));
  if (showPlaces) url.searchParams.delete("places");
  else url.searchParams.set("places", "off");
  window.history.replaceState(window.history.state, "", url);
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
      variant="outline"
      className="h-8 gap-1 px-2.5 shadow-none aria-pressed:border-primary/45 aria-pressed:bg-primary/10 aria-pressed:text-primary"
      onClick={onClick}
      aria-pressed={active}
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
  const [gapDistanceM, setGapDistanceM] = useState(initialUrl.gapDistanceM);
  const [gapMinutes, setGapMinutes] = useState(initialUrl.gapMinutes);
  const { routeOpacity, gapOpacity } = useSettingsStore(
    (state) => state.mapRouteDisplay,
  );
  const setMapRouteDisplay = useSettingsStore((state) =>
    state.setMapRouteDisplay
  );
  const { markers: markerSources, routes: routeSources } = useSettingsStore(
    (state) => state.mapSourceFilters,
  );
  const setMapSourceFilter = useSettingsStore((state) => state.setMapSourceFilter);
  const markerSourceFilter = activeSourceFilter(markerSources);
  const routeSourceFilter = activeSourceFilter(routeSources);
  const [layers, setLayers] = useState(initialUrl.layers);
  const [showPlaces, setShowPlaces] = useState(initialUrl.showPlaces);
  const sourceLabels = useSettingsStore((state) => state.mapSourceSelections);
  const [lastFocusedLayer, setLastFocusedLayer] = useState<MapSourceLayerSelection>();
  const focus = useMemo<FocusedSource | undefined>(() => {
    const { markers, routes } = sourceLabels;
    if (routes && (!markers || lastFocusedLayer === "routes")) {
      return { layer: "routes", source: routes, filter: routeSources };
    }
    if (markers) {
      const sameFileOrProvider = routes && (markers.importId
        ? markers.importId === routes.importId
        : !routes.importId && markers.provider === routes.provider);
      const layer = sameFileOrProvider && lastFocusedLayer !== "markers" ? "all" : "markers";
      return { layer, source: markers, filter: markerSources };
    }
  }, [sourceLabels, markerSources, routeSources, lastFocusedLayer]);
  const [extentMode, setExtentMode] = useState<"period" | "source">();
  const [sourceBounds, setSourceBounds] = useState<MapBounds>();
  const [sourceMessage, setSourceMessage] = useState("");
  const finishSourceFit = useCallback(() => setSourceBounds(undefined), []);
  const importEntry = useRef(location.state?.mapImport as MapSourceSelection | undefined);
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
  const [autoFitSegments, setAutoFitSegments] = useState(
    !initialUrl.viewport && !focusedPhotoAssetId && !importEntry.current && !focus &&
      initialUrl.layers.has("presence"),
  );
  const [fitRequest, setFitRequest] = useState<{
    range: string;
    status: "loading" | "ready";
  }>();
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
    MapRouteSourceTrack | null
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
  const rangeKey = `${start.getTime()}:${end.getTime()}`;
  const showPresence = layers.has("presence");
  const fitPending = fitRequest?.range === rangeKey &&
    fitRequest.status === "loading";
  const fitReady = fitRequest?.range === rangeKey &&
    fitRequest.status === "ready";
  const segmentsQuery = useLocationSegments(start, end, {
    maxPoints: maxPointsForRange(rangeMs),
    enabled: (showPresence && (viewport?.zoom ?? 2) >= 14) || fitPending || autoFitSegments,
    sourceFilter: markerSourceFilter,
  });
  useLocationLiveUpdates();
  const segments = segmentsQuery.data?.segments;
  const mapPresenceSegments = useMemo(
    () =>
      (segments ?? []).filter((segment) =>
        segment.type === "stay" || segment.type === "manual"
      ),
    [segments],
  );
  useEffect(() => {
    if (!fitRequest) return;
    if (fitRequest.range !== rangeKey) {
      setFitRequest(undefined);
      return;
    }
    if (!fitPending || focusedPhotoAssetId) return;
    if (segmentsQuery.isError) {
      setFitRequest(undefined);
      toast.error("Could not load locations to fit the map.");
      return;
    }
    if (segmentsQuery.data && !segmentsQuery.isPlaceholderData) {
      setFitRequest({ range: rangeKey, status: "ready" });
      setFitRequestKey((key) => key + 1);
    }
  }, [
    fitRequest,
    fitPending,
    focusedPhotoAssetId,
    rangeKey,
    segmentsQuery.data,
    segmentsQuery.isError,
    segmentsQuery.isPlaceholderData,
  ]);
  useEffect(() => {
    const timeout = setTimeout(() => setQueryViewport(viewport), 250);
    return () => clearTimeout(timeout);
  }, [viewport]);

  const showRoutes = layers.has("routes") || layers.has("sourceTracks");
  const showConversations = layers.has("conversations");
  const showGaps = layers.has("connectors");
  const showPresenceClusters = showPresence &&
    (queryViewport?.zoom ?? 2) < 14;
  const density = useMapDensity(
    start,
    end,
    queryViewport?.bounds,
    queryViewport?.zoom ?? 2,
    showConversations ? ["conversations"] : [],
  );
  const presence = useMapDensity(
    start,
    end,
    queryViewport?.bounds,
    queryViewport?.zoom ?? 2,
    showPresenceClusters ? ["presence"] : [],
    showPresenceClusters ? markerSourceFilter : undefined,
  );
  const routes = useMapRouteDetail(
    start,
    end,
    queryViewport?.bounds,
    queryViewport?.zoom ?? 2,
    showRoutes,
    showGaps,
    gapDistanceM,
    gapMinutes,
    layers.has("sourceTracks"),
    routeSourceFilter,
  );
  const timeline = useMapTimelineSummary();
  const locationAt = useLocationAt(cursorTime, !!cursorTime);
  const savedPlaces = useSavedPlaces(showPlaces, markerSourceFilter);
  const sourcePoints = useMapSourcePoints(
    start, end, !extentMode && !sourceBounds && viewport === queryViewport ? queryViewport?.bounds : undefined,
    showPresence ? markerSourceFilter : undefined,
  );
  const sourceExtent = useMapSourceExtent(
    extentMode ? focus?.layer : undefined, focus?.filter,
    extentMode === "period" ? start : undefined, extentMode === "period" ? end : undefined,
  );
  const pointConflicts = useLocationConflicts("pending", true);
  const metadataConflicts = useLocationMetadataConflicts("pending", true);
  const routeConflicts = useLocationRouteConflicts("pending", true);

  useEffect(() => {
    updateMapUrl(viewport, layers, cursorTime, gapDistanceM, gapMinutes, showPlaces);
  }, [
    viewport?.center[0],
    viewport?.center[1],
    viewport?.zoom,
    layers,
    cursorTime?.getTime(),
    gapDistanceM,
    gapMinutes,
    showPlaces,
  ]);

  useEffect(() => {
    if (!focusedPhotoAssetId) return;
    setAutoFitSegments(false);
    setFitRequest(undefined);
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
      setShowPlaces(next.showPlaces);
      setExtentMode(undefined);
      setSourceBounds(undefined);
      setCursorTime(next.at);
      setGapDistanceM(next.gapDistanceM);
      setGapMinutes(next.gapMinutes);
      if (next.viewport) {
        setAutoFitSegments(false);
        setFitRequest(undefined);
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
      if (layer === "routes" && !next.has("routes")) {
        next.delete("connectors");
        next.delete("sourceTracks");
      }
      if (
        (layer === "connectors" || layer === "sourceTracks") && next.has(layer)
      ) next.add("routes");
      return next;
    });
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

  const closeSelection = useCallback(() => {
    setSelectedCluster(null);
    setSelectedSegment(null);
    setSelectedSavedPlace(null);
    setSelectedRecordedTrack(null);
  }, []);

  const showSource = useCallback((
    source: MapSourceSelection,
    layer: MapSourceLayerSelection,
    mode: "period" | "source" = "period",
  ) => {
    const filter: SourceFilter = {
      excludedProviders: [], excludedImportIds: [],
      ...(source.importId ? { onlyImportId: source.importId } : { onlyProvider: source.provider }),
    };
    if (focusedPhotoAssetId) closeFocusedPhoto();
    closeSelection();
    setFlyTarget(null);
    setCursorTime(undefined);
    setAutoFitSegments(false);
    setFitRequest(undefined);
    setSourceBounds(undefined);
    setSourceMessage("");
    if (layer !== "routes") {
      setMapSourceFilter("markers", filter, source);
      setShowPlaces(true);
    }
    if (layer !== "markers") setMapSourceFilter("routes", filter, source);
    setLayers((current) => {
      const next = new Set(current);
      if (layer === "all") {
        next.delete("conversations");
        next.delete("photos");
      }
      if (layer !== "routes") next.add("presence");
      if (layer !== "markers") next.add("routes");
      return next;
    });
    setLastFocusedLayer(layer);
    setExtentMode(mode);
  }, [closeFocusedPhoto, closeSelection, focusedPhotoAssetId, setMapSourceFilter]);

  useEffect(() => {
    if (!importEntry.current) return;
    const source = importEntry.current;
    importEntry.current = undefined;
    showSource(source, "all", "source");
    navigate(window.location.pathname + window.location.search, { replace: true, state: null });
  }, [showSource, navigate]);

  useEffect(() => {
    if (!extentMode) return;
    if (sourceExtent.isError) {
      setSourceMessage("Could not load this source.");
    } else if (sourceExtent.data) {
      const { bounds, firstAt, lastAt } = sourceExtent.data;
      if (bounds) setSourceBounds({ ...bounds });
      if (extentMode === "source" && firstAt && lastAt) {
        setRange(new Date(firstAt), new Date(Math.max(+new Date(lastAt) + 1, +new Date(firstAt) + 1000)));
      }
      setSourceMessage(bounds
        ? (extentMode === "source" && !firstAt ? "This source has no recorded dates." : "")
        : extentMode === "source" ? "No mapped data in this source." : "No matches in the selected period.");
    } else return;
    setExtentMode(undefined);
  }, [extentMode, sourceExtent.isError, sourceExtent.data, setRange]);

  function changeSourceFilter(layer: "markers" | "routes", filter: SourceFilter) {
    if (focus?.layer === layer || focus?.layer === "all") {
      setExtentMode(undefined);
      setSourceBounds(undefined);
      setSourceMessage("");
    }
    if (layer === "markers") {
      setAutoFitSegments(false);
      setFitRequest(undefined);
      setSelectedSegment(null);
      setSelectedSavedPlace(null);
    } else {
      setSelectedRecordedTrack(null);
    }
    setMapSourceFilter(layer, filter);
  }

  function openImport(item: LocationImport) {
    setImportOpen(false);
    showSource({
      importId: String(item._id), provider: item.origin?.provider ?? UNKNOWN_LOCATION_PROVIDER,
      label: item.filename,
    }, "all", "source");
  }

  const selectRecordedTrack = useCallback((track: MapRouteSourceTrack) => {
    closeSelection();
    setSelectedRecordedTrack(track);
  }, [closeSelection]);

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
  const isLoadingLayers = fitPending || segmentsQuery.isLoading ||
    density.isLoading || presence.isLoading || savedPlaces.isLoading ||
    (showRoutes && routes.isLoading);
  const layerMessages: string[] = [];
  if (sourcePoints.isError) layerMessages.push("Could not load GPS points for this source.");
  if (presence.isError || (showPlaces && savedPlaces.isError) || segmentsQuery.isError) {
    layerMessages.push("Could not load location markers.");
  }
  if (showConversations) {
    const projection = density.data?.projection.status;
    if (density.isError) layerMessages.push("Could not load conversations.");
    else if (
      density.isFetching && (!density.data || density.isPlaceholderData)
    ) {
      layerMessages.push("Loading conversations…");
    } else if (projection === "building") {
      layerMessages.push("Updating the conversation map index…");
    } else if (projection === "failed") {
      layerMessages.push("Conversation map index failed. Retry it from Jobs.");
    } else if (projection === "not-built") {
      layerMessages.push(
        "Build the Location map index in Jobs to show conversations.",
      );
    } else if (density.data?.conversationClusters.length === 0) {
      layerMessages.push(
        "No indexed conversations with a location in this area and period.",
      );
    }
  }
  if (showRoutes) {
    if (routes.isError) layerMessages.push("Could not load routes.");
    else if (routes.isLoading) {
      layerMessages.push("Loading routes…");
    } else if (routes.data && !routes.data.projection.ready) {
      layerMessages.push(
        routes.data.projection.status === "building"
          ? "Preparing the route index…"
          : "Build the Location map index in Jobs to show routes.",
      );
    } else if (routes.data && !routes.isPlaceholderData) {
      if (routes.data.fragments.length === 0) {
        layerMessages.push(
          `No continuous routes here in this period at ${gapDistanceM} m / ${gapMinutes} min.`,
        );
      }
      if (showGaps) {
        const count = routes.data.connectors.length;
        layerMessages.push(
          count > 0
            ? `Recording gap links: ${count}`
            : "No recording gaps in this area and period.",
        );
      }
    }
  }
  const pendingConflicts = (pointConflicts.data?.total ?? 0) +
    (metadataConflicts.data?.total ?? 0) + (routeConflicts.data?.total ?? 0);
  const hasSelection = selectedCluster || selectedSegment ||
    selectedSavedPlace || selectedRecordedTrack;

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[34rem] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h1 className="mr-auto text-lg font-semibold tracking-tight">Location map</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={fitPending || !!extentMode}
          onClick={() => {
            if (focusedPhotoAssetId) closeFocusedPhoto();
            if (focus) setExtentMode("period");
            else setFitRequest({ range: rangeKey, status: "loading" });
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
        <div className="flex flex-wrap items-center gap-1.5">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConflictsOpen(true)}
          >
            <AlertTriangle
              className={pendingConflicts > 0
                ? "mr-2 h-4 w-4 text-amber-600"
                : "mr-2 h-4 w-4 text-muted-foreground"}
            />
            {pendingConflicts > 0 ? `Review (${pendingConflicts})` : "Review"}
          </Button>
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Import tracks
          </Button>
        </div>
      </div>

      <section aria-label="Map layers and sources" className="flex flex-wrap items-start gap-x-5 gap-y-2 rounded-lg border bg-muted/25 px-3 py-2">
        <LayerGroup label="Location markers">
          <LayerButton active={showPresence} onClick={() => toggleLayer("presence")}>
            <MapPin className="size-3.5" /> Presence
          </LayerButton>
          <LayerButton active={showPlaces} onClick={() => {
            setShowPlaces(!showPlaces);
            setSelectedSavedPlace(null);
          }}>
            <Bookmark className="size-3.5" /> Saved places
          </LayerButton>
          <LocationSourceFilter label="Marker sources" includeManual filter={markerSources}
            focus={sourceLabels.markers} onChange={(filter) => changeSourceFilter("markers", filter)}
            onShowOnMap={(source) => showSource(source, "markers")} />
        </LayerGroup>
        <LayerGroup label="Recorded routes">
          <LayerButton active={showRoutes} onClick={() => toggleLayer("routes")}>
            <Route className="size-3.5" /> Routes
          </LayerButton>
          <LayerButton active={layers.has("sourceTracks")} onClick={() => toggleLayer("sourceTracks")}>
            Source colours
          </LayerButton>
          <LocationSourceFilter label="Route sources" filter={routeSources}
            focus={sourceLabels.routes} onChange={(filter) => changeSourceFilter("routes", filter)}
            onShowOnMap={(source) => showSource(source, "routes")} />
        </LayerGroup>
        <LayerGroup label="Other activity">
          <LayerButton active={showConversations} onClick={() => toggleLayer("conversations")}>
            <MessageSquare className="size-3.5" /> Conversations
          </LayerButton>
          <LayerButton active={layers.has("photos")} onClick={() => toggleLayer("photos")}>
            <Images className="size-3.5" /> Photos
          </LayerButton>
        </LayerGroup>
      </section>
      {focus && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
          <span className="min-w-0 truncate" title={focus.source.label}>
            {focus.layer === "all" ? "File" : focus.layer === "routes" ? "Route source" : "Marker source"}
            <span aria-hidden="true"> · </span><strong>{focus.source.label}</strong>
          </span>
          <span role="status" className="text-muted-foreground">
            {extentMode ? "Locating source…" : sourceMessage}
          </span>
          <Button variant="outline" size="sm" className="h-7" disabled={!!extentMode}
            onClick={() => setExtentMode("source")}>Use source dates</Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="relative isolate min-h-0 flex-1 overflow-hidden rounded-lg border">
            <LocationMap
              segments={mapPresenceSegments}
              fitToSegments={((autoFitSegments && showPresence) || fitReady) &&
                !focusedPhotoAssetId && !segmentsQuery.isPlaceholderData}
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
              showStays={showPresence &&
                (viewport?.zoom ?? 2) >= 14}
              showMoves={false}
              showGaps={false}
            >
              {(layers.has("photos") || focusedPhotoAssetId) && (
                <PhotoClustersLayer
                  focusedAssetId={focusedPhotoAssetId}
                  onFocusedAssetClose={closeFocusedPhoto}
                  fitOnLoad={!initialUrl.viewport && !focus && !importEntry.current}
                />
              )}
              {layers.has("presence") && showPresenceClusters && (
                <PresenceDensityLayer
                  clusters={presence.data?.presenceClusters ?? []}
                  stale={isRefreshing}
                />
              )}
              {showConversations && (
                <ConversationDensityLayer
                  clusters={density.data?.conversationClusters ?? []}
                  stale={isRefreshing}
                  onOpenCluster={(cluster) => {
                    closeSelection();
                    setSelectedCluster(cluster);
                  }}
                />
              )}
              {showRoutes && (
                <RouteProjectionLayer
                  data={routes.data}
                  showConnectors={showGaps}
                  routeOpacity={routeOpacity / 100}
                  gapOpacity={gapOpacity / 100}
                  sourceTracks={layers.has("sourceTracks")
                    ? routes.data?.sourceTracks ?? NO_ROUTE_SOURCES
                    : undefined}
                  onSelectTrack={selectRecordedTrack}
                  stale={routes.isPlaceholderData}
                />
              )}
              <SavedPlacesLayer
                places={showPlaces ? (savedPlaces.data?.places ?? []) : []}
                onSelect={(place) => {
                  closeSelection();
                  setSelectedSavedPlace(place);
                }}
              />
              {showPresence && sourcePoints.data && (
                <MapSourcePointsLayer clusters={sourcePoints.data.clusters} />
              )}
              {sourceBounds && <SourceBounds bounds={sourceBounds} onFit={finishSourceFit} />}
              <FlyTo target={focusedPhotoAssetId ? null : flyTarget} />
            </LocationMap>

            <div className="pointer-events-none absolute top-3 right-3 left-14 z-[1000] flex flex-col items-end gap-1.5 text-xs">
              <div role="status" className="max-w-sm empty:sr-only">
                {(isLoadingLayers || layerMessages.length > 0) && (
                  <div className="flex items-start gap-2 rounded-md border bg-background/95 px-3 py-2 shadow">
                    {isLoadingLayers && (
                      <Loader2
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
                      />
                    )}
                    <div className="space-y-1">
                      {layerMessages.length > 0
                        ? layerMessages.map((message) => (
                          <p key={message}>{message}</p>
                        ))
                        : <p>Loading map data…</p>}
                    </div>
                  </div>
                )}
              </div>
              {showRoutes && routes.data?.detailLimited && (
                <div className="max-w-sm rounded-md border bg-background/95 px-3 py-2 shadow">
                  Some sections omitted · zoom in or shorten the period
                </div>
              )}
              {showRoutes && (routes.data?.conflicts.length ?? 0) > 0 && (
                <div className="max-w-sm rounded-md bg-amber-500/95 px-3 py-2 text-black shadow">
                  {routes.data!.conflicts.length} overlapping route source
                  {routes.data!.conflicts.length === 1 ? "" : "s"}{" "}
                  shown separately
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
              aria-label="Map layer legend"
            >
              {showConversations && (
                <span>
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-violet-500" />
                  {" "}
                  Conversations
                </span>
              )}
              {showRoutes && (
                <span className="flex items-center gap-1.5">
                  <span className="w-5 border-t-2 border-blue-600" />
                  {layers.has("sourceTracks")
                    ? "Recorded routes · source colours"
                    : "Recorded routes"}
                </span>
              )}
              {showGaps && (
                <span className="flex items-center gap-1.5">
                  <span className="w-5 border-t-2 border-dashed border-slate-400" />
                  Recording gaps
                </span>
              )}
            </div>
            <MapDisplaySettings
              gapDistanceM={gapDistanceM}
              gapMinutes={gapMinutes}
              routeOpacity={routeOpacity}
              gapOpacity={gapOpacity}
              showGaps={showGaps}
              onToggleGaps={() => toggleLayer("connectors")}
              onChange={(patch) => {
                if (patch.gapDistanceM !== undefined) {
                  setGapDistanceM(
                    patch.gapDistanceM,
                  );
                }
                if (patch.gapMinutes !== undefined) {
                  setGapMinutes(
                    patch.gapMinutes,
                  );
                }
                setMapRouteDisplay(patch);
              }}
            />
          </div>
          <MapTimeNavigator
            summary={timeline.data}
            start={start}
            end={end}
            cursor={cursorTime}
            onCommitRange={(from, to) => {
              setSourceMessage("");
              if (focus) setExtentMode("period");
              setRange(from, to);
            }}
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
          <Card className="z-[1001] flex w-80 max-w-full shrink-0 flex-col overflow-hidden max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[65%] max-md:w-full">
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
                aria-label="Close location details"
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
                    Source colours identify recorded tracks within the selected
                    dates. To see recording gaps, enable them in Map settings.
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
        onShowImportOnMap={openImport}
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
        gapDistanceM={gapDistanceM}
        gapMinutes={gapMinutes}
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
