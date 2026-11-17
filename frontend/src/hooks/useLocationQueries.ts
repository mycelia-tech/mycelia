import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callResource } from "@/lib/api";
import { useWebSocketSubscription } from "@/hooks/useWebSocket";
import type {
  ConversationMapGroup,
  ConversationMapGroupSummary,
  ConversationMapItem,
  GeonamesCity,
  LocationImport,
  LocationMetadataConflict,
  LocationPointConflict,
  LocationRouteConflict,
  LocationSegment,
  LocationStatus,
  LocationTrackGeometryChunk,
  MapBounds,
  MapCell,
  MapDensityResponse,
  MapRouteDetailResponse,
  MapTimelineSummary,
  RecordedLocationTrack,
  SavedPlace,
} from "@/types/location";

export const locationKeys = {
  all: ["location"] as const,
  status: () => [...locationKeys.all, "status"] as const,
  segments: (start: number, end: number, maxPoints?: number) =>
    [...locationKeys.all, "segments", start, end, maxPoints] as const,
  at: (time: number) => [...locationKeys.all, "at", time] as const,
  forRange: (start: number, end: number) =>
    [...locationKeys.all, "forRange", start, end] as const,
  places: (query: string) => [...locationKeys.all, "places", query] as const,
  imports: () => [...locationKeys.all, "imports"] as const,
  savedPlaces: () => [...locationKeys.all, "savedPlaces"] as const,
  recordedTracks: () => [...locationKeys.all, "recordedTracks"] as const,
  trackGeometry: (id: string) =>
    [...locationKeys.all, "trackGeometry", id] as const,
  conflicts: (status?: string) =>
    [...locationKeys.all, "conflicts", status ?? "all"] as const,
  metadataConflicts: (status?: string) =>
    [...locationKeys.all, "metadataConflicts", status ?? "all"] as const,
  routeConflicts: (status?: string) =>
    [...locationKeys.all, "routeConflicts", status ?? "all"] as const,
  geotags: (filters: Record<string, unknown>) =>
    [...locationKeys.all, "geotags", filters] as const,
  conversationsOnMap: (start?: number, end?: number) =>
    [
      ...locationKeys.all,
      "conversationsOnMap",
      start ?? "all",
      end ?? "all",
    ] as const,
  mapDensity: (
    start: number,
    end: number,
    bounds: MapBounds | undefined,
    zoom: number,
    layers: string[],
  ) =>
    [
      ...locationKeys.all,
      "mapDensity",
      start,
      end,
      bounds,
      Math.round(zoom * 10) / 10,
      [...layers].sort(),
    ] as const,
  mapRoutes: (
    start: number,
    end: number,
    bounds: MapBounds | undefined,
    zoom: number,
    connectors: boolean,
    gapDistanceM: number,
    gapMinutes: number,
  ) =>
    [
      ...locationKeys.all,
      "mapRoutes",
      start,
      end,
      bounds,
      Math.round(zoom * 10) / 10,
      connectors,
      gapDistanceM,
      gapMinutes,
    ] as const,
  mapTimeline: () => [...locationKeys.all, "mapTimeline"] as const,
  mapClusterGroups: (
    start: number,
    end: number,
    cell?: MapCell,
    revision?: number,
    cursor?: string,
  ) =>
    [
      ...locationKeys.all,
      "mapClusterGroups",
      start,
      end,
      cell,
      revision,
      cursor,
    ] as const,
  mapGroupItems: (
    start: number,
    end: number,
    groupKey?: string,
    revision?: number,
    cursor?: string,
  ) =>
    [
      ...locationKeys.all,
      "mapGroupItems",
      start,
      end,
      groupKey,
      revision,
      cursor,
    ] as const,
};

export function useLocationRouteConflicts(
  status: "pending" | "resolved" | "superseded" | undefined = "pending",
  enabled = true,
) {
  return useQuery<{ conflicts: LocationRouteConflict[]; total: number }>({
    queryKey: locationKeys.routeConflicts(status),
    queryFn: () =>
      callResource("location", {
        action: "list-route-conflicts",
        status,
        limit: 100,
        skip: 0,
      }),
    enabled,
    staleTime: 15 * 1000,
  });
}

export function useResolveLocationRouteConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      resolution: "use_first" | "use_second" | "keep_both";
    }) =>
      callResource("location", {
        action: "resolve-route-conflict",
        ...input,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useMapDensity(
  start: Date,
  end: Date,
  bounds: MapBounds | undefined,
  zoom: number,
  layers: Array<"presence" | "conversations">,
) {
  return useQuery<MapDensityResponse>({
    queryKey: locationKeys.mapDensity(
      start.getTime(),
      end.getTime(),
      bounds,
      zoom,
      layers,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "map-density",
        start,
        end,
        bounds,
        zoom,
        layers,
        maxClusters: 1200,
      }, { signal }),
    enabled: !!bounds && layers.length > 0,
    staleTime: 60 * 1000,
    placeholderData: (previous) => previous,
  });
}

export function useMapRouteDetail(
  start: Date,
  end: Date,
  bounds: MapBounds | undefined,
  zoom: number,
  enabled: boolean,
  includeConnectors: boolean,
  gapDistanceM: number,
  gapMinutes: number,
) {
  return useQuery<MapRouteDetailResponse>({
    queryKey: locationKeys.mapRoutes(
      start.getTime(),
      end.getTime(),
      bounds,
      zoom,
      includeConnectors,
      gapDistanceM,
      gapMinutes,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "map-route-detail",
        start,
        end,
        bounds,
        zoom,
        includeConnectors,
        gapDistanceM,
        gapMinutes,
      }, { signal }),
    enabled: enabled && !!bounds,
    staleTime: 30 * 1000,
  });
}

export function useMapTimelineSummary(enabled = true) {
  return useQuery<MapTimelineSummary>({
    queryKey: locationKeys.mapTimeline(),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "map-timeline-summary",
        maxBuckets: 256,
      }, { signal }),
    enabled,
    staleTime: 60 * 1000,
  });
}

export function useConversationMapClusterGroups(
  start: Date,
  end: Date,
  cell: MapCell | undefined,
  revision: number | undefined,
  cursor?: string,
) {
  return useQuery<{
    projection: { revision: number };
    total: number;
    items: ConversationMapGroupSummary[];
    nextCursor: string | null;
    error?: string;
  }>({
    queryKey: locationKeys.mapClusterGroups(
      start.getTime(),
      end.getTime(),
      cell,
      revision,
      cursor,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "conversation-map-cluster-groups",
        start,
        end,
        cell,
        revision,
        cursor,
        limit: 20,
      }, { signal }),
    enabled: !!cell,
    placeholderData: (previous) => previous,
  });
}

export function useConversationMapGroupItems(
  start: Date,
  end: Date,
  groupKey: string | undefined,
  revision: number | undefined,
  cursor?: string,
) {
  return useQuery<{
    projection: { revision: number };
    total: number;
    items: ConversationMapItem[];
    nextCursor: string | null;
    error?: string;
  }>({
    queryKey: locationKeys.mapGroupItems(
      start.getTime(),
      end.getTime(),
      groupKey,
      revision,
      cursor,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "conversation-map-group-items",
        start,
        end,
        groupKey,
        revision,
        cursor,
        limit: 20,
      }, { signal }),
    enabled: !!groupKey,
    placeholderData: (previous) => previous,
  });
}

export function useLocationStatus(enabled = true) {
  return useQuery<LocationStatus>({
    queryKey: locationKeys.status(),
    queryFn: () => callResource("location", { action: "status" }),
    enabled,
    staleTime: 60 * 1000,
  });
}

export function useLocationSegments(
  start: Date | undefined,
  end: Date | undefined,
  options: { enabled?: boolean; maxPoints?: number; coalesceMs?: number } = {},
) {
  const { enabled = true, maxPoints, coalesceMs } = options;
  return useQuery<{
    segments: LocationSegment[];
    totalSegments: number;
  }>({
    queryKey: locationKeys.segments(
      start?.getTime() ?? 0,
      end?.getTime() ?? 0,
      maxPoints,
    ),
    queryFn: () =>
      callResource("location", {
        action: "list-segments",
        start,
        end,
        ...(maxPoints ? { maxPoints } : {}),
        ...(coalesceMs ? { coalesceMs } : {}),
      }),
    enabled: enabled && !!start && !!end,
    staleTime: 30 * 1000,
    placeholderData: (prev) => prev,
  });
}

export function useLocationAt(time: Date | undefined, enabled = true) {
  return useQuery<{
    segment: LocationSegment | null;
    point: { ts: Date | string; loc: { coordinates: [number, number] } } | null;
    place: LocationSegment["place"];
    timeZone: string | null;
  }>({
    queryKey: locationKeys.at(time?.getTime() ?? 0),
    queryFn: () => callResource("location", { action: "at", time }),
    enabled: enabled && !!time,
    staleTime: 60 * 1000,
  });
}

export function useLocationForRange(
  start: Date | undefined,
  end: Date | undefined,
  enabled = true,
) {
  return useQuery<{
    stays: LocationSegment[];
    primaryPlace: LocationSegment["place"];
    primaryStay: LocationSegment | null;
    coveragePct: number;
  }>({
    queryKey: locationKeys.forRange(start?.getTime() ?? 0, end?.getTime() ?? 0),
    queryFn: () =>
      callResource("location", { action: "for-range", start, end }),
    enabled: enabled && !!start && !!end,
    staleTime: 60 * 1000,
  });
}

export function usePlaceSearch(query: string, enabled = true) {
  return useQuery<GeonamesCity[]>({
    queryKey: locationKeys.places(query),
    queryFn: () =>
      callResource("location", { action: "search-places", query, limit: 10 }),
    enabled: enabled && query.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLocationImports(enabled = true) {
  return useQuery<LocationImport[]>({
    queryKey: locationKeys.imports(),
    queryFn: () => callResource("location", { action: "list-imports" }),
    enabled,
    staleTime: 15 * 1000,
  });
}

export function useSavedPlaces(enabled = true) {
  return useQuery<{ places: SavedPlace[]; total: number }>({
    queryKey: locationKeys.savedPlaces(),
    queryFn: () =>
      callResource("location", {
        action: "list-saved-places",
        limit: 2000,
        skip: 0,
      }),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useRecordedLocationTracks(enabled = true) {
  return useQuery<{ tracks: RecordedLocationTrack[]; total: number }>({
    queryKey: locationKeys.recordedTracks(),
    queryFn: () =>
      callResource("location", {
        action: "list-recorded-tracks",
        limit: 500,
        skip: 0,
      }),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useRecordedTrackGeometry(
  id: string | undefined,
  enabled = true,
) {
  return useQuery<{
    chunks: LocationTrackGeometryChunk[];
    nextCursor: number | null;
    complete: boolean;
  }>({
    queryKey: locationKeys.trackGeometry(id ?? ""),
    queryFn: async () => {
      const chunks: LocationTrackGeometryChunk[] = [];
      let cursor = 0;
      while (true) {
        const page = await callResource("location", {
          action: "get-recorded-track-geometry",
          id,
          cursor,
          limit: 100,
        }) as {
          chunks: LocationTrackGeometryChunk[];
          nextCursor: number | null;
          complete: boolean;
        };
        chunks.push(...page.chunks);
        if (page.nextCursor === null) {
          return { chunks, nextCursor: null, complete: true };
        }
        cursor = page.nextCursor;
      }
    },
    enabled: enabled && !!id,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLocationConflicts(
  status: "pending" | "resolved" | undefined = "pending",
  enabled = true,
) {
  return useQuery<{ conflicts: LocationPointConflict[]; total: number }>({
    queryKey: locationKeys.conflicts(status),
    queryFn: () =>
      callResource("location", {
        action: "list-conflicts",
        ...(status ? { status } : {}),
        limit: 100,
        skip: 0,
      }),
    enabled,
    staleTime: 15 * 1000,
  });
}

export function useResolveLocationConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      resolution: "keep_existing" | "use_incoming" | "defer";
      candidateImportId?: string;
    }) => callResource("location", { action: "resolve-conflict", ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useLocationMetadataConflicts(
  status: "pending" | "resolved" | undefined = "pending",
  enabled = true,
) {
  return useQuery<{ conflicts: LocationMetadataConflict[]; total: number }>({
    queryKey: locationKeys.metadataConflicts(status),
    queryFn: () =>
      callResource("location", {
        action: "list-metadata-conflicts",
        ...(status ? { status } : {}),
        limit: 100,
        skip: 0,
      }),
    enabled,
    staleTime: 15 * 1000,
  });
}

export function useResolveLocationMetadataConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      resolution: "keep_existing" | "use_incoming" | "defer";
    }) =>
      callResource("location", {
        action: "resolve-metadata-conflict",
        ...input,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useConversationsOnMap(
  start: Date | undefined,
  end: Date | undefined,
  options: { enabled?: boolean; allTime?: boolean } = {},
) {
  const { enabled = true, allTime = false } = options;
  return useQuery<{
    groups: ConversationMapGroup[];
    unmatched: number;
    conversationCount: number;
  }>({
    queryKey: locationKeys.conversationsOnMap(
      allTime ? undefined : start?.getTime(),
      allTime ? undefined : end?.getTime(),
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "conversations-on-map",
        manual: true,
        ...(allTime ? {} : { start, end }),
      }, { signal }),
    enabled: enabled && (allTime || (!!start && !!end)),
    retry: false,
    staleTime: 60 * 1000,
    placeholderData: (prev) => prev,
  });
}

export function useGeotags(
  filters: {
    start?: Date;
    end?: Date;
    type?: string;
    importId?: string;
    limit?: number;
    skip?: number;
  },
  enabled = true,
) {
  return useQuery<{ segments: LocationSegment[]; total: number }>({
    queryKey: locationKeys.geotags({
      start: filters.start?.getTime(),
      end: filters.end?.getTime(),
      type: filters.type,
      importId: filters.importId,
      limit: filters.limit,
      skip: filters.skip,
    }),
    queryFn: () =>
      callResource("location", {
        action: "list-geotags",
        ...(filters.start && filters.end
          ? { start: filters.start, end: filters.end }
          : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.importId ? { importId: filters.importId } : {}),
        limit: filters.limit ?? 100,
        skip: filters.skip ?? 0,
      }),
    enabled,
    staleTime: 15 * 1000,
    placeholderData: (prev) => prev,
  });
}

export function useUpdateSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      start?: Date;
      end?: Date;
      place?: {
        geonameId?: number;
        name?: string;
        latitude?: number;
        longitude?: number;
      };
      timeZone?: string;
    }) => callResource("location", { action: "update-segment", ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useAssignManualLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      start: Date;
      end: Date;
      place: {
        geonameId?: number;
        name?: string;
        latitude?: number;
        longitude?: number;
      };
      timeZone?: string;
    }) => callResource("location", { action: "assign-manual", ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useDeleteLocationSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callResource("location", { action: "delete-segment", id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

export function useDeleteLocationImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callResource("location", { action: "delete-import", id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
    },
  });
}

/** Invalidate location queries when segments change server-side. */
export function useLocationLiveUpdates(enabled = true) {
  const queryClient = useQueryClient();
  useWebSocketSubscription(
    "mongo:location_segments",
    () => {
      for (
        const key of [
          "status",
          "segments",
          "at",
          "forRange",
          "geotags",
          "mapTimeline",
        ]
      ) {
        queryClient.invalidateQueries({
          queryKey: [...locationKeys.all, key],
        });
      }
    },
    enabled,
  );
  useWebSocketSubscription(
    "mongo:location_conversation_projection_state",
    () => {
      for (
        const key of [
          "mapDensity",
          "mapClusterGroups",
          "mapGroupItems",
          "mapTimeline",
        ]
      ) {
        queryClient.invalidateQueries({
          queryKey: [...locationKeys.all, key],
        });
      }
    },
    enabled,
  );
  useWebSocketSubscription(
    "mongo:location_route_projection_state",
    () => {
      queryClient.invalidateQueries({
        queryKey: [...locationKeys.all, "mapRoutes"],
      });
      queryClient.invalidateQueries({
        queryKey: [...locationKeys.all, "routeConflicts"],
      });
    },
    enabled,
  );
}
