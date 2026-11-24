import type { LocationSourceFilter } from "@myceliasdk/location-sources.ts";
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
  MapSourcePointCluster,
  MapTimelineSummary,
  RecordedLocationTrack,
  SavedPlace,
} from "@/types/location";

export type LocationReviewStatus = "pending" | "deferred" | "resolved";
export const LOCATION_REVIEW_PAGE_SIZE = 100;

type ImportListOptions = {
  provider?: string;
  search?: string;
  skip?: number;
  sort?: "recent" | "source";
};

function sameSourceFilter(previous: unknown, filter?: LocationSourceFilter) {
  return JSON.stringify(previous) === JSON.stringify(filter);
}

export const locationKeys = {
  all: ["location"] as const,
  status: () => [...locationKeys.all, "status"] as const,
  segments: (
    start: number, end: number, maxPoints?: number, sourceFilter?: LocationSourceFilter,
  ) => [...locationKeys.all, "segments", start, end, maxPoints, sourceFilter] as const,
  at: (time: number) => [...locationKeys.all, "at", time] as const,
  forRange: (start: number, end: number) =>
    [...locationKeys.all, "forRange", start, end] as const,
  places: (query: string) => [...locationKeys.all, "places", query] as const,
  imports: () => [...locationKeys.all, "imports"] as const,
  importSources: () => [...locationKeys.all, "importSources"] as const,
  sourceFiles: () => [...locationKeys.all, "sourceFiles"] as const,
  savedPlaces: () => [...locationKeys.all, "savedPlaces"] as const,
  recordedTracks: () => [...locationKeys.all, "recordedTracks"] as const,
  trackGeometry: (id: string) =>
    [...locationKeys.all, "trackGeometry", id] as const,
  conflicts: (status?: string, skip = 0) =>
    [...locationKeys.all, "conflicts", status ?? "all", skip] as const,
  metadataConflicts: (status?: string, skip = 0) =>
    [...locationKeys.all, "metadataConflicts", status ?? "all", skip] as const,
  routeConflicts: (status?: string, skip = 0) =>
    [...locationKeys.all, "routeConflicts", status ?? "all", skip] as const,
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
    sourceFilter?: LocationSourceFilter,
  ) =>
    [
      ...locationKeys.all,
      "mapDensity",
      start,
      end,
      bounds,
      Math.round(zoom * 10) / 10,
      [...layers].sort(),
      sourceFilter,
    ] as const,
  mapRoutes: (
    start: number,
    end: number,
    bounds: MapBounds | undefined,
    zoom: number,
    connectors: boolean,
    gapDistanceM: number,
    gapMinutes: number,
    includeSourceTracks: boolean,
    sourceFilter?: LocationSourceFilter,
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
      includeSourceTracks,
      sourceFilter,
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
  status: LocationReviewStatus | "superseded" = "pending",
  enabled = true,
  skip = 0,
) {
  return useQuery<{ conflicts: LocationRouteConflict[]; total: number }>({
    queryKey: locationKeys.routeConflicts(status, skip),
    queryFn: () =>
      callResource("location", {
        action: "list-route-conflicts",
        status,
        limit: LOCATION_REVIEW_PAGE_SIZE,
        skip,
      }),
    enabled,
    staleTime: 15_000,
  });
}

export function useMapDensity(
  start: Date,
  end: Date,
  bounds: MapBounds | undefined,
  zoom: number,
  layers: Array<"presence" | "conversations">,
  sourceFilter?: LocationSourceFilter,
) {
  return useQuery<MapDensityResponse>({
    queryKey: locationKeys.mapDensity(
      start.getTime(),
      end.getTime(),
      bounds,
      zoom,
      layers,
      sourceFilter,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "map-density",
        start,
        end,
        bounds,
        zoom,
        layers,
        sourceFilter,
        maxClusters: 1200,
      }, { signal }),
    enabled: !!bounds && layers.length > 0,
    staleTime: 60 * 1000,
    placeholderData: (previous, query) =>
      sameSourceFilter(query?.queryKey.at(-1), sourceFilter) ? previous : undefined,
  });
}

export type MapSourceLayerSelection = "markers" | "routes" | "all";

export function useMapSourceExtent(
  layer: MapSourceLayerSelection | undefined,
  sourceFilter: LocationSourceFilter | undefined,
  start?: Date,
  end?: Date,
) {
  return useQuery<{ bounds: MapBounds | null; firstAt: Date | null; lastAt: Date | null }>({
    queryKey: ["location", "sourceExtent", layer, start?.getTime(), end?.getTime(), sourceFilter],
    queryFn: ({ signal }) => callResource("location", {
      action: "map-source-extent", sourceFilter, layer, start, end,
    }, { signal }),
    enabled: !!layer && !!(sourceFilter?.onlyImportId || sourceFilter?.onlyProvider),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useMapSourcePoints(
  start: Date,
  end: Date,
  bounds: MapBounds | undefined,
  sourceFilter?: LocationSourceFilter,
) {
  return useQuery<{ clusters: MapSourcePointCluster[] }>({
    queryKey: ["location", "sourcePoints", +start, +end, bounds, sourceFilter],
    queryFn: ({ signal }) => callResource("location", {
      action: "map-source-points", sourceFilter, start, end, bounds,
    }, { signal }),
    enabled: !!bounds && !!(sourceFilter?.onlyImportId || sourceFilter?.onlyProvider),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
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
  includeSourceTracks: boolean,
  sourceFilter?: LocationSourceFilter,
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
      includeSourceTracks,
      sourceFilter,
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
        includeSourceTracks,
        sourceFilter,
      }, { signal }),
    enabled: enabled && !!bounds,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (previous, query) =>
      query?.queryKey[2] === start.getTime() &&
        query.queryKey[3] === end.getTime() &&
        sameSourceFilter(query.queryKey.at(-1), sourceFilter)
        ? previous
        : undefined,
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
  options: {
    enabled?: boolean;
    maxPoints?: number;
    coalesceMs?: number;
    sourceFilter?: LocationSourceFilter;
  } = {},
) {
  const { enabled = true, maxPoints, coalesceMs, sourceFilter } = options;
  return useQuery<{
    segments: LocationSegment[];
    totalSegments: number;
  }>({
    queryKey: locationKeys.segments(
      start?.getTime() ?? 0,
      end?.getTime() ?? 0,
      maxPoints,
      sourceFilter,
    ),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "list-segments",
        start,
        end,
        sourceFilter,
        ...(maxPoints ? { maxPoints } : {}),
        ...(coalesceMs ? { coalesceMs } : {}),
      }, { signal }),
    enabled: enabled && !!start && !!end,
    staleTime: 30 * 1000,
    placeholderData: (prev, query) =>
      sameSourceFilter(query?.queryKey.at(-1), sourceFilter) ? prev : undefined,
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

export function useLocationImports(enabled = true, options?: ImportListOptions) {
  return useQuery<LocationImport[]>({
    queryKey: options ? [...locationKeys.imports(), options] : locationKeys.imports(),
    queryFn: ({ signal }) =>
      callResource("location", { action: "list-imports", ...options }, { signal }),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useLocationImportSources(enabled = true) {
  return useQuery<Array<{ provider: string; count: number }>>({
    queryKey: locationKeys.importSources(),
    queryFn: ({ signal }) =>
      callResource("location", { action: "list-import-sources" }, { signal }),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useLocationSourceFiles(
  provider: string | undefined, search: string, page: number, enabled: boolean,
) {
  return useQuery<{ files: Array<{ _id: string; filename: string }>; hasMore: boolean }>({
    queryKey: [...locationKeys.sourceFiles(), provider, search, page],
    queryFn: ({ signal }) => callResource("location", {
      action: "list-source-files", provider, search, skip: page * 40,
    }, { signal }),
    enabled: enabled && !!provider,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateLocationImportSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, provider }: { id: string; provider: string }) => {
      const result = await callResource("location", { action: "update-import-source", id, provider });
      if (!result?.success) throw new Error("Import source is unavailable.");
    },
    onSuccess: () => {
      const sourceKeys = ["imports", "importSources", "sourceFiles", "segments", "geotags"];
      const filteredKeys = ["sourceExtent", "sourcePoints", "mapRoutes", "mapDensity", "savedPlaces"];
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => queryKey[0] === "location" &&
          (sourceKeys.includes(String(queryKey[1])) ||
            (filteredKeys.includes(String(queryKey[1])) && !!queryKey.at(-1) && typeof queryKey.at(-1) === "object")),
      });
    },
  });
}

export function useSavedPlaces(enabled = true, sourceFilter?: LocationSourceFilter) {
  return useQuery<{ places: SavedPlace[]; total: number }>({
    queryKey: [...locationKeys.savedPlaces(), sourceFilter],
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "list-saved-places",
        sourceFilter,
        limit: 2000,
        skip: 0,
      }, { signal }),
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
  status: LocationReviewStatus = "pending",
  enabled = true,
  skip = 0,
) {
  return useQuery<{ conflicts: LocationPointConflict[]; total: number }>({
    queryKey: locationKeys.conflicts(status, skip),
    queryFn: () =>
      callResource("location", {
        action: "list-conflicts",
        status,
        limit: LOCATION_REVIEW_PAGE_SIZE,
        skip,
      }),
    enabled,
    staleTime: 15_000,
  });
}

export function useLocationMetadataConflicts(
  status: LocationReviewStatus = "pending",
  enabled = true,
  skip = 0,
) {
  return useQuery<{ conflicts: LocationMetadataConflict[]; total: number }>({
    queryKey: locationKeys.metadataConflicts(status, skip),
    queryFn: () =>
      callResource("location", {
        action: "list-metadata-conflicts",
        status,
        limit: LOCATION_REVIEW_PAGE_SIZE,
        skip,
      }),
    enabled,
    staleTime: 15_000,
  });
}

export function useLocationRouteConflictPreview(
  id: string,
  gapDistanceM: number,
  gapMinutes: number,
) {
  return useQuery<MapRouteDetailResponse>({
    queryKey: [
      ...locationKeys.all,
      "routeConflictPreview",
      id,
      gapDistanceM,
      gapMinutes,
    ],
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "route-conflict-preview",
        id,
        gapDistanceM,
        gapMinutes,
      }, { signal }),
    staleTime: 15_000,
  });
}

export type LocationReviewDecision =
  & { id: string }
  & (
    | {
      action: "resolve-conflict" | "resolve-metadata-conflict";
      resolution: "keep_existing" | "use_incoming" | "defer" | "resume";
      candidateImportId?: string;
    }
    | {
      action: "resolve-route-conflict";
      resolution:
        | "use_first"
        | "use_second"
        | "keep_both"
        | "defer"
        | "resume"
        | "undo";
      expectedResolvedAt?: Date | string;
    }
  );

const reviewQueryKeys = ["conflicts", "metadataConflicts", "routeConflicts"];

export function useLocationReviewDecisions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decisions: LocationReviewDecision[]) => {
      const failures: string[] = [];
      for (const decision of decisions) {
        try {
          const result = await callResource("location", decision);
          if (!result.success) {
            failures.push(result.error ?? "The decision could not be saved.");
          }
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error.message
              : "The decision could not be saved.",
          );
        }
      }
      return { saved: decisions.length - failures.length, failures };
    },
    onSuccess: async (_result, decisions) => {
      await queryClient.invalidateQueries({
        queryKey: locationKeys.all,
        predicate: ({ queryKey }) =>
          reviewQueryKeys.includes(String(queryKey[1])),
      });
      if (
        decisions.some(({ resolution }) =>
          resolution !== "defer" && resolution !== "resume"
        )
      ) {
        void queryClient.invalidateQueries({
          queryKey: locationKeys.all,
          predicate: ({ queryKey }) =>
            !reviewQueryKeys.includes(String(queryKey[1])),
        });
      }
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
    sourceFilter?: LocationSourceFilter;
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
      sourceFilter: filters.sourceFilter,
      importId: filters.importId,
      limit: filters.limit,
      skip: filters.skip,
    }),
    queryFn: ({ signal }) =>
      callResource("location", {
        action: "list-geotags",
        ...(filters.start && filters.end
          ? { start: filters.start, end: filters.end }
          : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.importId ? { importId: filters.importId } : {}),
        sourceFilter: filters.sourceFilter,
        limit: filters.limit ?? 100,
        skip: filters.skip ?? 0,
      }, { signal }),
    enabled,
    staleTime: 15 * 1000,
    placeholderData: (prev, query) => {
      const previous = query?.queryKey.at(-1) as typeof filters | undefined;
      return sameSourceFilter(previous?.sourceFilter, filters.sourceFilter) ? prev : undefined;
    },
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
