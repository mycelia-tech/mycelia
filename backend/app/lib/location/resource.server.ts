import type { LocationOrigin } from "@myceliasdk/location-sources.ts";
import {
  focusedSourceFilterSchema,
  importProviderQuery,
  locationProviderSchema,
  locationSourceFilterSchema,
  locationSourceQuery,
} from "./sources.server.ts";
import { getMapSourceExtent, getMapSourcePoints } from "./source-map.server.ts";
import { ObjectId } from "bson";
import { z } from "zod";
import tzLookup from "tz-lookup";
import { type Auth } from "@/lib/auth/core.server.ts";
import { type Resource } from "@/lib/auth/resources.ts";
import { getMongoResource, getRootDB } from "@/lib/mongo/core.server.ts";
import { getJobsResource } from "@/lib/resources/worker.ts";
import { getFsResource } from "@/lib/mongo/fs.server.ts";
import {
  backfillLocationImport,
  backfillLocationImports,
  bumpLocationImportRevision,
  removeLocationEntitySourceRefs,
} from "@/lib/location/import.server.ts";
import { zDateOrString } from "@myceliasdk/zod-json-schema.ts";
import { createSingleFlightBackoff } from "@/lib/location/query-backoff.ts";
import {
  getConversationMapClusterGroups,
  getConversationMapGroupItems,
  getMapDensity,
  getMapTimelineSummary,
} from "@/lib/location/conversation-map.server.ts";
import {
  DEFAULT_GAP_DISTANCE_M,
  DEFAULT_GAP_MINUTES,
  getMapRouteDetail,
  getRouteConflictPreview,
  listRouteConflicts,
  resolveRouteConflict,
  reviewStatusQuery,
} from "@/lib/location/route-projection.server.ts";
import { MAP_CELL_ZOOMS } from "@/lib/location/map-spatial.ts";

const SEGMENTS = "location_segments";
const POINTS = "location_points";
const IMPORTS = "location_imports";
const GEONAMES = "geonames_cities";
const TZ_PERIODS = "timeline_timezone_periods";
const TRACKS = "location_tracks";
const TRACK_GEOMETRY = "location_track_geometry";
const BOOKMARKS = "location_bookmarks";
const CONFLICTS = "location_point_conflicts";
const METADATA_CONFLICTS = "location_metadata_conflicts";
const MAP_CONVERSATION_RANGE_INDEX = "objects_conversation_time_range_start_v1";
const MAP_CONVERSATION_TIMEOUT_BACKOFF_MS = 60 * 1000;

function isMongoDeadlineError(error: unknown): boolean {
  const candidate = error as { code?: unknown; codeName?: unknown } | null;
  return candidate?.code === 50 || candidate?.codeName === "MaxTimeMSExpired" ||
    /MaxTimeMSExpired|operation exceeded time limit/i.test(String(error));
}

const runMapConversationQuery = createSingleFlightBackoff<any[]>({
  backoffMs: MAP_CONVERSATION_TIMEOUT_BACKOFF_MS,
  isDeadlineError: isMongoDeadlineError,
});

/** Window padding used when re-running processing around an edit. */
const REPROCESS_PAD_MS = 6 * 60 * 60 * 1000;

const listSegmentsSchema = z.object({
  sourceFilter: locationSourceFilterSchema.optional(),
  action: z.literal("list-segments"),
  start: zDateOrString(),
  end: zDateOrString(),
  maxPoints: z.number().int().min(100).max(50000).default(5000),
  coalesceMs: z.number().min(0).optional(),
});

const atSchema = z.object({
  action: z.literal("at"),
  time: zDateOrString(),
});

const forRangeSchema = z.object({
  action: z.literal("for-range"),
  start: zDateOrString(),
  end: zDateOrString(),
});

const searchPlacesSchema = z.object({
  action: z.literal("search-places"),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const assignManualSchema = z.object({
  action: z.literal("assign-manual"),
  start: zDateOrString(),
  end: zDateOrString(),
  place: z.object({
    geonameId: z.number().optional(),
    name: z.string().trim().min(1).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  }),
  timeZone: z.string().optional(),
}).refine((v) => v.end.getTime() > v.start.getTime(), {
  message: "Range end must be after its start",
  path: ["end"],
}).refine(
  (v) =>
    v.place.geonameId !== undefined ||
    (v.place.latitude !== undefined && v.place.longitude !== undefined),
  { message: "Provide either a geonameId or latitude+longitude" },
);

const deleteSegmentSchema = z.object({
  action: z.literal("delete-segment"),
  id: z.string().refine(ObjectId.isValid, "Invalid segment id"),
});

const listGeotagsSchema = z.object({
  sourceFilter: locationSourceFilterSchema.optional(),
  action: z.literal("list-geotags"),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  type: z.enum(["stay", "move", "gap", "manual"]).optional(),
  importId: z.string().refine(ObjectId.isValid, "Invalid import id")
    .optional(),
  limit: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).default(0),
});

const updateSegmentSchema = z.object({
  action: z.literal("update-segment"),
  id: z.string().refine(ObjectId.isValid, "Invalid segment id"),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  place: z.object({
    geonameId: z.number().optional(),
    name: z.string().trim().min(1).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  }).optional(),
  timeZone: z.string().optional(),
});

const conversationsOnMapSchema = z.object({
  action: z.literal("conversations-on-map"),
  manual: z.literal(true),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
});

const mapBoundsSchema = z.object({
  west: z.number().min(-180).max(180),
  south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
}).refine((bounds) => bounds.north > bounds.south, {
  message: "Map bounds north must be greater than south",
});

const mapDensitySchema = z.object({
  sourceFilter: locationSourceFilterSchema.optional(),
  action: z.literal("map-density"),
  start: zDateOrString(),
  end: zDateOrString(),
  bounds: mapBoundsSchema,
  zoom: z.number().min(0).max(24),
  layers: z.array(z.enum(["presence", "conversations"]))
    .default(["presence", "conversations"]),
  maxClusters: z.number().int().min(1).max(2000).default(1200),
}).refine((value) => value.end > value.start, {
  message: "Map density end must be after start",
});

const mapSourceExtentSchema = z.object({
  action: z.literal("map-source-extent"),
  layer: z.enum(["markers", "routes", "all"]),
  sourceFilter: focusedSourceFilterSchema,
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
}).refine(({ start, end }) => !start && !end || Boolean(start && end && end > start), {
  message: "Provide both ends of a valid period, or omit both for all dates",
});

const mapSourcePointsSchema = z.object({
  action: z.literal("map-source-points"),
  start: zDateOrString(),
  end: zDateOrString(),
  bounds: mapBoundsSchema,
  sourceFilter: focusedSourceFilterSchema,
}).refine(({ start, end }) => end > start, {
  message: "Period end must follow its start",
});

const conversationMapClusterGroupsSchema = z.object({
  action: z.literal("conversation-map-cluster-groups"),
  start: zDateOrString(),
  end: zDateOrString(),
  cell: z.object({
    z: z.number().int().refine((value) =>
      MAP_CELL_ZOOMS.includes(value as (typeof MAP_CELL_ZOOMS)[number])
    ),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }),
  revision: z.number().int().min(0).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(20),
});

const conversationMapGroupItemsSchema = z.object({
  action: z.literal("conversation-map-group-items"),
  start: zDateOrString(),
  end: zDateOrString(),
  groupKey: z.string().min(1),
  revision: z.number().int().min(0).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(20),
});

const mapRouteDetailSchema = z.object({
  sourceFilter: locationSourceFilterSchema.optional(),
  action: z.literal("map-route-detail"),
  start: zDateOrString(),
  end: zDateOrString(),
  bounds: mapBoundsSchema,
  zoom: z.number().min(0).max(24),
  includeConnectors: z.boolean().default(false),
  includeSourceTracks: z.boolean().default(false),
  gapDistanceM: z.number().int().min(50).max(2000).default(
    DEFAULT_GAP_DISTANCE_M,
  ),
  gapMinutes: z.number().int().min(1).max(30).default(DEFAULT_GAP_MINUTES),
});

const mapTimelineSummarySchema = z.object({
  action: z.literal("map-timeline-summary"),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  maxBuckets: z.number().int().min(1).max(512).default(256),
});

const listRouteConflictsSchema = z.object({
  action: z.literal("list-route-conflicts"),
  status: z.enum(["pending", "deferred", "resolved", "superseded"]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).default(0),
});

const resolveRouteConflictSchema = z.object({
  action: z.literal("resolve-route-conflict"),
  id: z.string().min(1),
  resolution: z.enum([
    "use_first",
    "use_second",
    "keep_both",
    "defer",
    "resume",
    "undo",
  ]),
  expectedResolvedAt: zDateOrString().optional(),
}).refine((input) => input.resolution !== "undo" || !!input.expectedResolvedAt);

const routeConflictPreviewSchema = z.object({
  action: z.literal("route-conflict-preview"),
  id: z.string().min(1),
  gapDistanceM: z.number().min(10).max(100000).optional(),
  gapMinutes: z.number().min(0.1).max(1440).optional(),
});

const statusSchema = z.object({
  action: z.literal("status"),
});

const listImportsSchema = z.object({
  action: z.literal("list-imports"),
  provider: locationProviderSchema.optional(),
  search: z.string().trim().max(200).optional(),
  skip: z.number().int().min(0).default(0),
  sort: z.enum(["recent", "source"]).default("recent"),
});

const listImportSourcesSchema = z.object({ action: z.literal("list-import-sources") });

const listSourceFilesSchema = z.object({
  action: z.literal("list-source-files"),
  provider: locationProviderSchema,
  search: z.string().trim().max(200).optional(),
  skip: z.number().int().min(0).default(0),
});

function importFilenameQuery(search: string | undefined) {
  if (!search) return {};
  return { filename: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } };
}

const updateImportSourceSchema = z.object({
  action: z.literal("update-import-source"),
  id: z.string().refine(ObjectId.isValid, "Invalid import id"),
  provider: locationProviderSchema,
});

const deleteImportSchema = z.object({
  action: z.literal("delete-import"),
  id: z.string().refine(ObjectId.isValid, "Invalid import id"),
});

const listSavedPlacesSchema = z.object({
  sourceFilter: locationSourceFilterSchema.optional(),
  action: z.literal("list-saved-places"),
  limit: z.number().int().min(1).max(2000).default(500),
  skip: z.number().int().min(0).default(0),
});

const listRecordedTracksSchema = z.object({
  action: z.literal("list-recorded-tracks"),
  limit: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).default(0),
});

const getRecordedTrackGeometrySchema = z.object({
  action: z.literal("get-recorded-track-geometry"),
  id: z.string().refine(ObjectId.isValid, "Invalid track id"),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

const backfillLocationImportSchema = z.object({
  action: z.literal("backfill-import"),
  id: z.string().refine(ObjectId.isValid, "Invalid import id"),
});

const backfillLocationImportsSchema = z.object({
  action: z.literal("backfill-imports"),
  limit: z.number().int().min(1).max(500).default(100),
});

const listLocationConflictsSchema = z.object({
  action: z.literal("list-conflicts"),
  status: z.enum(["pending", "deferred", "resolved"]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).default(0),
});

const resolveLocationConflictSchema = z.object({
  action: z.literal("resolve-conflict"),
  id: z.string().refine(ObjectId.isValid, "Invalid conflict id"),
  resolution: z.enum(["keep_existing", "use_incoming", "defer", "resume"]),
  candidateImportId: z.string().refine(ObjectId.isValid).optional(),
});

const listMetadataConflictsSchema = z.object({
  action: z.literal("list-metadata-conflicts"),
  status: z.enum(["pending", "deferred", "resolved"]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).default(0),
});

const resolveMetadataConflictSchema = z.object({
  action: z.literal("resolve-metadata-conflict"),
  id: z.string().refine(ObjectId.isValid, "Invalid conflict id"),
  resolution: z.enum(["keep_existing", "use_incoming", "defer", "resume"]),
});

export const locationRequestSchema = z.discriminatedUnion("action", [
  listSegmentsSchema,
  atSchema,
  forRangeSchema,
  searchPlacesSchema,
  assignManualSchema,
  deleteSegmentSchema,
  listGeotagsSchema,
  updateSegmentSchema,
  conversationsOnMapSchema,
  mapDensitySchema,
  mapSourceExtentSchema,
  mapSourcePointsSchema,
  conversationMapClusterGroupsSchema,
  conversationMapGroupItemsSchema,
  mapRouteDetailSchema,
  mapTimelineSummarySchema,
  listRouteConflictsSchema,
  resolveRouteConflictSchema,
  routeConflictPreviewSchema,
  statusSchema,
  listImportsSchema,
  listImportSourcesSchema,
  listSourceFilesSchema,
  updateImportSourceSchema,
  deleteImportSchema,
  listSavedPlacesSchema,
  listRecordedTracksSchema,
  getRecordedTrackGeometrySchema,
  backfillLocationImportSchema,
  backfillLocationImportsSchema,
  listLocationConflictsSchema,
  resolveLocationConflictSchema,
  listMetadataConflictsSchema,
  resolveMetadataConflictSchema,
]);

export type LocationRequest = z.input<typeof locationRequestSchema>;
export type LocationResponse = unknown;

function decimatePath(
  path: [number, number][],
  budget: number,
): [number, number][] {
  if (path.length <= budget || path.length <= 2) return path;
  const result: [number, number][] = [path[0]];
  const stride = (path.length - 1) / (budget - 1);
  for (let i = 1; i < budget - 1; i++) {
    result.push(path[Math.round(i * stride)]);
  }
  result.push(path[path.length - 1]);
  return result;
}

export interface SegmentSource {
  manual?: boolean;
  createdBy?: string;
  importId?: string;
  filename?: string | null;
  origin?: LocationOrigin;
}

/**
 * Resolve each segment's provenance into display-ready `sources`:
 * manual segments → who set them; derived → contributing import files.
 */
async function attachSources(
  mongo: (input: any) => Promise<any>,
  segments: any[],
): Promise<void> {
  const importIds = new Map<string, ObjectId>();
  for (const segment of segments) {
    for (const id of segment.importIds ?? []) {
      importIds.set(String(id), new ObjectId(String(id)));
    }
  }
  let files = new Map<string, { filename: string; origin?: LocationOrigin }>();
  if (importIds.size > 0) {
    const imports: any[] = await mongo({
      action: "find",
      collection: "location_imports",
      query: { _id: { $in: [...importIds.values()] } },
      options: { projection: { filename: 1, origin: 1 } },
    });
    files = new Map(
      imports.map((doc) => [String(doc._id), doc]),
    );
  }
  for (const segment of segments) {
    if (segment.type === "manual") {
      segment.sources = [
        { manual: true, createdBy: segment.createdBy } as SegmentSource,
      ];
    } else {
      segment.sources = (segment.importIds ?? []).map((
        id: unknown,
      ): SegmentSource => ({
        importId: String(id),
        filename: files.get(String(id))?.filename ?? null,
        origin: files.get(String(id))?.origin,
      }));
    }
  }
}

function overlapMs(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): number {
  return Math.max(
    0,
    Math.min(aEnd.getTime(), bEnd.getTime()) -
      Math.max(aStart.getTime(), bStart.getTime()),
  );
}

async function moveConflictReview(
  mongo: Awaited<ReturnType<typeof getMongoResource>>,
  collection: string,
  id: ObjectId,
  resolution: "defer" | "resume",
  principal: string,
) {
  const defer = resolution === "defer";
  const result = await mongo({
    action: "updateOne",
    collection,
    query: { _id: id, ...reviewStatusQuery(defer ? "pending" : "deferred") },
    update: defer
      ? { $set: { resolution, decidedAt: new Date(), decidedBy: principal } }
      : { $unset: { resolution: "", decidedAt: "", decidedBy: "" } },
  });
  return result.matchedCount ? { success: true, status: "pending" } : {
    success: false,
    error: "This item changed. Refresh and review it again.",
  };
}

export class LocationResource
  implements Resource<LocationRequest, LocationResponse> {
  code = "location";
  description =
    "Location tracks: derived stay/move/gap segments, offline reverse geocoding, manual range assignments and map queries";
  schemas = {
    request: locationRequestSchema,
    response: z.any(),
  };

  extractActions(input: LocationRequest) {
    return [{
      path: ["location"],
      actions: [input.action],
    }];
  }

  async use(rawInput: LocationRequest, auth: Auth): Promise<LocationResponse> {
    const input = locationRequestSchema.parse(rawInput);
    const mongo = await getMongoResource(auth);

    switch (input.action) {
      case "map-source-extent":
        return await getMapSourceExtent(await getRootDB(), input);
      case "map-source-points":
        return await getMapSourcePoints(await getRootDB(), input);
      case "list-segments": {
        const segments: any[] = await mongo({
          action: "find",
          collection: SEGMENTS,
          query: {
            start: { $lt: input.end },
            end: { $gt: input.start },
            ...(input.sourceFilter
              ? await locationSourceQuery(await getRootDB(), input.sourceFilter, "importIds", true)
              : {}),
          },
          options: { sort: { start: 1 } },
        });

        const rangeMs = input.end.getTime() - input.start.getTime();
        const minVisibleMs = input.coalesceMs ?? 0;
        const visible = segments.filter((s) => {
          if (s.type === "stay" || s.type === "manual") return true;
          const durMs = new Date(s.end).getTime() - new Date(s.start).getTime();
          return durMs >= minVisibleMs;
        });

        const totalCoords = visible.reduce(
          (sum, s) => sum + (s.path?.length ?? 0),
          0,
        );
        if (totalCoords > input.maxPoints) {
          const scale = input.maxPoints / totalCoords;
          for (const s of visible) {
            if (s.path && s.path.length > 2) {
              s.path = decimatePath(
                s.path,
                Math.max(2, Math.floor(s.path.length * scale)),
              );
            }
          }
        }
        await attachSources(mongo, visible);
        return { segments: visible, rangeMs, totalSegments: segments.length };
      }

      case "at": {
        const time = input.time;
        const segments: any[] = await mongo({
          action: "find",
          collection: SEGMENTS,
          query: { start: { $lte: time }, end: { $gte: time } },
          options: { sort: { start: 1 } },
        });
        const priority = { manual: 0, stay: 1, move: 2, gap: 3 } as const;
        segments.sort((a, b) =>
          (priority[a.type as keyof typeof priority] ?? 9) -
          (priority[b.type as keyof typeof priority] ?? 9)
        );
        const segment = segments[0] ?? null;
        if (segment) await attachSources(mongo, [segment]);

        const [before] = await mongo({
          action: "find",
          collection: POINTS,
          query: {
            ts: { $lte: time },
            visible: true,
            selection: "accepted",
          },
          options: { sort: { ts: -1 }, limit: 1 },
        });
        const [after] = await mongo({
          action: "find",
          collection: POINTS,
          query: {
            ts: { $gt: time },
            visible: true,
            selection: "accepted",
          },
          options: { sort: { ts: 1 }, limit: 1 },
        });
        const candidates = segment?.type === "gap"
          ? []
          : [before, after].filter(Boolean).filter((p) => {
            const timestamp = new Date(p.ts).getTime();
            if (Math.abs(timestamp - time.getTime()) >= 30 * 60 * 1000) {
              return false;
            }
            return segment?.type !== "move" ||
              (timestamp >= new Date(segment.start).getTime() &&
                timestamp <= new Date(segment.end).getTime());
          });
        candidates.sort((a, b) =>
          Math.abs(new Date(a.ts).getTime() - time.getTime()) -
          Math.abs(new Date(b.ts).getTime() - time.getTime())
        );
        const point = candidates[0] ?? null;

        return {
          segment,
          point,
          place: segment?.place ?? null,
          timeZone: segment?.timeZone ?? null,
        };
      }

      case "for-range": {
        const segments: any[] = await mongo({
          action: "find",
          collection: SEGMENTS,
          query: { start: { $lt: input.end }, end: { $gt: input.start } },
          options: { sort: { start: 1 } },
        });
        const rangeMs = Math.max(
          1,
          input.end.getTime() - input.start.getTime(),
        );

        const stays = segments
          .filter((s) => (s.type === "stay" || s.type === "manual") && s.loc)
          .map((s) => ({
            ...s,
            overlapMs: overlapMs(
              new Date(s.start),
              new Date(s.end),
              input.start,
              input.end,
            ),
          }))
          .sort((a, b) => b.overlapMs - a.overlapMs);

        const knownMs = segments
          .filter((s) => s.type !== "gap")
          .reduce(
            (sum, s) =>
              sum +
              overlapMs(
                new Date(s.start),
                new Date(s.end),
                input.start,
                input.end,
              ),
            0,
          );

        return {
          stays,
          primaryPlace: stays.find((s) => s.place)?.place ?? null,
          primaryStay: stays[0] ?? null,
          coveragePct: Math.min(100, Math.round((knownMs / rangeMs) * 100)),
        };
      }

      case "search-places": {
        const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = `^${escaped}`;
        return await mongo({
          action: "find",
          collection: GEONAMES,
          query: {
            $or: [
              { asciiName: { $regex: pattern, $options: "i" } },
              { name: { $regex: pattern, $options: "i" } },
            ],
          },
          options: {
            sort: { population: -1 },
            limit: input.limit,
            projection: {
              geonameId: 1,
              name: 1,
              asciiName: 1,
              country: 1,
              countryCode: 1,
              admin1: 1,
              population: 1,
              loc: 1,
              tz: 1,
            },
          },
        });
      }

      case "assign-manual": {
        let lat: number;
        let lng: number;
        let placeName: string | undefined = input.place.name;
        let country: string | undefined;
        let countryCode: string | undefined;
        const geonameId: number | undefined = input.place.geonameId;
        let cityTz: string | undefined;

        if (geonameId !== undefined) {
          const city = await mongo({
            action: "findOne",
            collection: GEONAMES,
            query: { geonameId },
          });
          if (!city) throw new Error(`Unknown geonameId: ${geonameId}`);
          lat = city.loc.coordinates[1];
          lng = city.loc.coordinates[0];
          placeName = placeName ?? city.name;
          country = city.country;
          countryCode = city.countryCode;
          cityTz = city.tz;
        } else {
          lat = input.place.latitude!;
          lng = input.place.longitude!;
        }

        let timeZone = input.timeZone ?? cityTz;
        if (!timeZone) {
          try {
            timeZone = tzLookup(lat, lng);
          } catch {
            timeZone = undefined;
          }
        }

        const now = new Date();
        const segmentDoc = {
          type: "manual",
          start: input.start,
          end: input.end,
          loc: { type: "Point", coordinates: [lng, lat] },
          place: {
            name: placeName ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
            ...(placeName ? { city: placeName } : {}),
            ...(country ? { country } : {}),
            ...(countryCode ? { countryCode } : {}),
            ...(geonameId !== undefined ? { geonameId } : {}),
          },
          ...(timeZone ? { timeZone } : {}),
          source: "manual",
          createdAt: now,
          updatedAt: now,
          createdBy: auth.principal,
        };
        const inserted = await mongo({
          action: "insertOne",
          collection: SEGMENTS,
          doc: segmentDoc,
        });

        if (timeZone) {
          // Replace only periods this feature created earlier for overlapping
          // ranges; hand-created manual periods are left untouched.
          await mongo({
            action: "deleteMany",
            collection: TZ_PERIODS,
            query: {
              "metadata.origin": "location-manual",
              start: { $lt: input.end },
              end: { $gt: input.start },
            },
          });
          await mongo({
            action: "insertOne",
            collection: TZ_PERIODS,
            doc: {
              start: input.start,
              end: input.end,
              timeZone,
              location: { name: placeName, latitude: lat, longitude: lng },
              source: "manual",
              metadata: { origin: "location-manual" },
              createdAt: now,
              updatedAt: now,
              createdBy: auth.principal,
            },
          });
        }

        await this.enqueueReprocess(
          auth,
          input.start,
          input.end,
          "Manual location assigned; re-clipping derived segments",
        );

        return { ...segmentDoc, _id: inserted.insertedId };
      }

      case "delete-segment": {
        const segment = await mongo({
          action: "findOne",
          collection: SEGMENTS,
          query: { _id: new ObjectId(input.id) },
        });
        if (!segment) return { success: false, error: "Segment not found" };

        if (segment.type === "manual") {
          await mongo({
            action: "deleteOne",
            collection: SEGMENTS,
            query: { _id: new ObjectId(input.id) },
          });
          await mongo({
            action: "deleteMany",
            collection: TZ_PERIODS,
            query: {
              "metadata.origin": "location-manual",
              start: segment.start,
              end: segment.end,
            },
          });
          await this.enqueueReprocess(
            auth,
            new Date(segment.start),
            new Date(segment.end),
            "Manual location removed; regenerating derived segments",
          );
          return { success: true, deletedPoints: 0 };
        }

        // Derived segments are rebuilt from GPS points on every processing
        // run — real deletion means deleting the underlying points (re-import
        // of the same file is then blocked by point-level dedupe).
        const pointQuery: Record<string, unknown> = {
          ts: { $gte: new Date(segment.start), $lte: new Date(segment.end) },
        };
        if (segment.importIds?.length) {
          pointQuery.importId = {
            $in: segment.importIds.map((id: unknown) =>
              new ObjectId(String(id))
            ),
          };
        }
        const deleted = await mongo({
          action: "deleteMany",
          collection: POINTS,
          query: pointQuery,
        });
        await mongo({
          action: "deleteOne",
          collection: SEGMENTS,
          query: { _id: new ObjectId(input.id) },
        });
        await this.enqueueReprocess(
          auth,
          new Date(segment.start),
          new Date(segment.end),
          "Geotag deleted; regenerating segments without its points",
        );
        return { success: true, deletedPoints: deleted.deletedCount ?? 0 };
      }

      case "list-geotags": {
        const query: Record<string, unknown> = {};
        if (input.start && input.end) {
          query.start = { $lt: input.end };
          query.end = { $gt: input.start };
        }
        if (input.type) query.type = input.type;
        if (input.importId) {
          query.importIds = new ObjectId(input.importId);
        }
        if (input.sourceFilter) {
          query.$and = [
            await locationSourceQuery(await getRootDB(), input.sourceFilter, "importIds", true),
          ];
        }
        const [segments, total] = await Promise.all([
          mongo({
            action: "find",
            collection: SEGMENTS,
            query,
            options: {
              sort: { start: -1 },
              skip: input.skip,
              limit: input.limit,
              projection: { path: 0 },
            },
          }),
          mongo({ action: "count", collection: SEGMENTS, query }),
        ]);
        await attachSources(mongo, segments);
        // Flag time overlaps within the page (manual vs derived leftovers,
        // anything the clipping has not cleaned up yet).
        for (const a of segments) {
          const overlaps = segments.filter((b: any) =>
            String(b._id) !== String(a._id) &&
            new Date(b.start).getTime() < new Date(a.end).getTime() &&
            new Date(b.end).getTime() > new Date(a.start).getTime()
          );
          if (overlaps.length > 0) {
            a.overlapIds = overlaps.map((b: any) => String(b._id));
          }
        }
        return { segments, total };
      }

      case "update-segment": {
        const segment = await mongo({
          action: "findOne",
          collection: SEGMENTS,
          query: { _id: new ObjectId(input.id) },
        });
        if (!segment) return { success: false, error: "Segment not found" };
        if (segment.type !== "manual") {
          throw new Error(
            "Only manual segments can be edited; override a derived one with assign-manual instead",
          );
        }

        const start = input.start ?? new Date(segment.start);
        const end = input.end ?? new Date(segment.end);
        if (end.getTime() <= start.getTime()) {
          throw new Error("Range end must be after its start");
        }

        let lat = segment.loc?.coordinates?.[1];
        let lng = segment.loc?.coordinates?.[0];
        let place = segment.place;
        let timeZone: string | undefined = input.timeZone ?? segment.timeZone;

        if (input.place) {
          if (input.place.geonameId !== undefined) {
            const city = await mongo({
              action: "findOne",
              collection: GEONAMES,
              query: { geonameId: input.place.geonameId },
            });
            if (!city) {
              throw new Error(`Unknown geonameId: ${input.place.geonameId}`);
            }
            lat = city.loc.coordinates[1];
            lng = city.loc.coordinates[0];
            place = {
              name: input.place.name ?? city.name,
              city: city.name,
              country: city.country,
              countryCode: city.countryCode,
              geonameId: city.geonameId,
            };
            if (!input.timeZone) timeZone = city.tz ?? timeZone;
          } else if (
            input.place.latitude !== undefined &&
            input.place.longitude !== undefined
          ) {
            lat = input.place.latitude;
            lng = input.place.longitude;
            place = {
              name: input.place.name ??
                `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
            };
          } else if (input.place.name) {
            place = { ...place, name: input.place.name };
          }
        }
        if (!timeZone && lat !== undefined && lng !== undefined) {
          try {
            timeZone = tzLookup(lat, lng);
          } catch {
            timeZone = undefined;
          }
        }

        await mongo({
          action: "updateOne",
          collection: SEGMENTS,
          query: { _id: new ObjectId(input.id) },
          update: {
            $set: {
              start,
              end,
              ...(lat !== undefined && lng !== undefined
                ? { loc: { type: "Point", coordinates: [lng, lat] } }
                : {}),
              place,
              ...(timeZone ? { timeZone } : {}),
            },
          },
        });

        // Recreate the paired manual timezone period.
        await mongo({
          action: "deleteMany",
          collection: TZ_PERIODS,
          query: {
            "metadata.origin": "location-manual",
            start: segment.start,
            end: segment.end,
          },
        });
        if (timeZone) {
          await mongo({
            action: "insertOne",
            collection: TZ_PERIODS,
            doc: {
              start,
              end,
              timeZone,
              location: {
                name: place?.name,
                ...(lat !== undefined ? { latitude: lat } : {}),
                ...(lng !== undefined ? { longitude: lng } : {}),
              },
              source: "manual",
              metadata: { origin: "location-manual" },
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: auth.principal,
            },
          });
        }

        const windowStart = new Date(
          Math.min(start.getTime(), new Date(segment.start).getTime()),
        );
        const windowEnd = new Date(
          Math.max(end.getTime(), new Date(segment.end).getTime()),
        );
        await this.enqueueReprocess(
          auth,
          windowStart,
          windowEnd,
          "Manual location edited; re-clipping derived segments",
        );
        return { success: true };
      }

      case "conversations-on-map": {
        const rangeQuery: Record<string, unknown> = {
          type: { $in: ["stay", "manual"] },
          loc: { $exists: true },
        };
        if (input.start && input.end) {
          rangeQuery.start = { $lt: input.end };
          rangeQuery.end = { $gt: input.start };
        }
        const stays: any[] = await mongo({
          action: "find",
          collection: SEGMENTS,
          query: rangeQuery,
          options: { sort: { start: 1 } },
        });
        if (stays.length === 0) {
          return { groups: [], unmatched: 0, conversationCount: 0 };
        }

        // Query conversations per merged stay window instead of "newest N
        // overall": with tens of thousands of conversations a global limit
        // silently drops everything that overlaps older stays.
        const SLACK_MS = 6 * 60 * 60 * 1000; // long conversation may start before the stay
        const staysForWindows = stays.slice(0, 500);
        const windows: Array<{ start: Date; end: Date }> = [];
        for (const stay of staysForWindows) {
          const start = new Date(new Date(stay.start).getTime() - SLACK_MS);
          const end = new Date(stay.end);
          const last = windows[windows.length - 1];
          if (last && start.getTime() <= last.end.getTime()) {
            if (end.getTime() > last.end.getTime()) last.end = end;
          } else {
            windows.push({ start, end });
          }
        }

        // One indexed OR query replaces one Mongo cursor per stay window. Use
        // the indexed multikey field rather than timeRanges.0.start, which
        // cannot use the compound conversation range index.
        const mapQueryKey = windows.map((window) =>
          `${window.start.getTime()}:${window.end.getTime()}`
        ).join("|");
        const conversationRows = windows.length === 0
          ? []
          : await runMapConversationQuery(mapQueryKey, async () =>
            await mongo({
              action: "find",
              collection: "objects",
              query: {
                isConversation: true,
                $or: windows.map((window) => ({
                  "timeRanges.start": {
                    $gte: window.start,
                    $lt: window.end,
                  },
                })),
              },
              options: {
                limit: 10_000,
                projection: { name: 1, icon: 1, timeRanges: 1 },
                hint: MAP_CONVERSATION_RANGE_INDEX,
                maxTimeMS: 5_000,
              },
            }) as any[]);
        const conversations = [...new Map<string, any>(
          conversationRows.map((conversation) => [
            String(conversation._id),
            conversation,
          ]),
        ).values()];

        const groups = new Map<string, {
          key: string;
          loc: any;
          place: any;
          stayCount: number;
          conversations: any[];
        }>();
        let matched = 0;

        for (const conv of conversations) {
          const range = conv.timeRanges?.[0];
          if (!range?.start) continue;
          const convStart = new Date(range.start).getTime();
          const convEnd = range.end ? new Date(range.end).getTime() : convStart;
          if (input.start && convEnd < input.start.getTime()) continue;
          const mid = (convStart + convEnd) / 2;

          const stay = stays.find((s) =>
            new Date(s.start).getTime() <= mid &&
            new Date(s.end).getTime() >= mid
          );
          if (!stay) continue;
          matched++;

          const key = stay.place?.geonameId
            ? `place:${stay.place.geonameId}`
            : `stay:${stay._id}`;
          let group = groups.get(key);
          if (!group) {
            group = {
              key,
              loc: stay.loc,
              place: stay.place ?? null,
              stayCount: 0,
              conversations: [],
            };
            groups.set(key, group);
          }
          if (group.conversations.length < 100) {
            group.conversations.push({
              _id: conv._id,
              name: conv.name,
              icon: conv.icon,
              start: range.start,
              end: range.end ?? null,
              stayId: stay._id,
              stayLoc: stay.loc,
            });
          }
        }

        // Count distinct stays per group
        for (const stay of stays) {
          const key = stay.place?.geonameId
            ? `place:${stay.place.geonameId}`
            : `stay:${stay._id}`;
          const group = groups.get(key);
          if (group) group.stayCount++;
        }

        return {
          groups: [...groups.values()].map((g) => ({
            ...g,
            conversationCount: g.conversations.length,
          })).sort((a, b) => b.conversationCount - a.conversationCount),
          unmatched: conversations.length - matched,
          conversationCount: matched,
        };
      }

      case "map-density": {
        const db = await getRootDB();
        return await getMapDensity(db, {
          start: input.start,
          end: input.end,
          bounds: input.bounds,
          zoom: input.zoom,
          layers: input.layers,
          maxClusters: input.maxClusters,
          cacheScope: auth.principal,
          sourceFilter: input.sourceFilter,
        });
      }

      case "conversation-map-cluster-groups": {
        const db = await getRootDB();
        return await getConversationMapClusterGroups(db, {
          start: input.start,
          end: input.end,
          cell: input.cell as any,
          revision: input.revision,
          cursor: input.cursor,
          limit: input.limit,
        });
      }

      case "conversation-map-group-items": {
        const db = await getRootDB();
        return await getConversationMapGroupItems(db, {
          start: input.start,
          end: input.end,
          groupKey: input.groupKey,
          revision: input.revision,
          cursor: input.cursor,
          limit: input.limit,
        });
      }

      case "map-route-detail": {
        const db = await getRootDB();
        return await getMapRouteDetail(db, input);
      }

      case "map-timeline-summary": {
        const db = await getRootDB();
        return await getMapTimelineSummary(db, input);
      }

      case "list-route-conflicts": {
        const db = await getRootDB();
        return await listRouteConflicts(db, input);
      }

      case "resolve-route-conflict": {
        const db = await getRootDB();
        return await resolveRouteConflict(db, {
          id: input.id,
          resolution: input.resolution,
          expectedResolvedAt: input.expectedResolvedAt,
          principal: auth.principal,
        });
      }
      case "route-conflict-preview":
        return await getRouteConflictPreview(await getRootDB(), input);

      case "status": {
        const [
          pointCount,
          segmentCount,
          bookmarkCount,
          recordedTrackCount,
          geonamesCount,
          lastImport,
          geoMeta,
        ] = await Promise.all([
          mongo({
            action: "count",
            collection: POINTS,
            query: { visible: true, selection: "accepted" },
            options: { mode: "cached-location-points" },
          }),
          mongo({ action: "count", collection: SEGMENTS, query: {} }),
          mongo({
            action: "count",
            collection: BOOKMARKS,
            query: { visible: { $ne: false } },
          }),
          mongo({
            action: "count",
            collection: TRACKS,
            query: { visible: { $ne: false } },
          }),
          mongo({
            action: "count",
            collection: GEONAMES,
            query: {},
            options: { mode: "estimated" },
          }),
          mongo({
            action: "find",
            collection: IMPORTS,
            query: {},
            options: { sort: { createdAt: -1 }, limit: 1 },
          }).then((docs: any[]) => docs[0] ?? null),
          mongo({
            action: "findOne",
            collection: "location_meta",
            query: { key: "geonames" },
          }),
        ]);
        return {
          hasData: pointCount > 0 || segmentCount > 0 || bookmarkCount > 0 ||
            recordedTrackCount > 0,
          pointCount,
          segmentCount,
          bookmarkCount,
          recordedTrackCount,
          geonamesReady: geonamesCount > 0,
          geonamesCount,
          geonamesRefreshedAt: geoMeta?.refreshedAt ?? null,
          geonamesSourceUrl: geoMeta?.sourceUrl ?? null,
          lastImportAt: lastImport?.createdAt ?? null,
        };
      }

      case "list-imports": {
        const query = {
          ...(input.provider ? importProviderQuery(input.provider) : {}),
          ...importFilenameQuery(input.search),
        };
        return await mongo({
          action: "find",
          collection: IMPORTS,
          query,
          options: {
            sort: input.sort === "source"
              ? { "origin.provider": 1, filename: 1, createdAt: -1, _id: 1 }
              : { createdAt: -1, _id: 1 },
            skip: input.skip,
            limit: 100,
          },
        });
      }

      case "list-import-sources": {
        return await mongo({
          action: "aggregate",
          collection: IMPORTS,
          pipeline: [
            { $match: { committedAt: { $type: "date" } } },
            { $group: { _id: { $ifNull: ["$origin.provider", "unknown"] }, count: { $sum: 1 } } },
            { $project: { _id: 0, provider: "$_id", count: 1 } },
          ],
          options: { maxTimeMS: 3000 },
        });
      }

      case "list-source-files": {
        const files = await mongo({
          action: "find",
          collection: IMPORTS,
          query: {
            committedAt: { $type: "date" },
            ...importProviderQuery(input.provider),
            ...importFilenameQuery(input.search),
          },
          options: {
            projection: { filename: 1 },
            sort: { filename: 1, createdAt: -1, _id: 1 },
            skip: input.skip,
            limit: 41,
            maxTimeMS: 3000,
          },
        });
        return { files: files.slice(0, 40), hasMore: files.length > 40 };
      }

      case "update-import-source": {
        const result = await mongo({
          action: "updateOne",
          collection: IMPORTS,
          query: { _id: new ObjectId(input.id), committedAt: { $type: "date" } },
          update: { $set: { origin: { provider: input.provider, evidence: "confirmed" } } },
          options: { touchUpdatedAt: false },
        });
        return { success: result.matchedCount === 1 };
      }

      case "list-saved-places": {
        const query = {
          reviewStatus: { $ne: "rejected" },
          visible: { $ne: false },
          ...(input.sourceFilter
            ? await locationSourceQuery(await getRootDB(), input.sourceFilter, "sourceRefs.importId")
            : {}),
        };
        const [places, total] = await Promise.all([
          mongo({
            action: "find",
            collection: BOOKMARKS,
            query,
            options: {
              sort: { sourceTimestamp: -1, displayName: 1 },
              limit: input.limit,
              skip: input.skip,
            },
          }),
          mongo({ action: "count", collection: BOOKMARKS, query }),
        ]);
        return { places, total };
      }

      case "list-recorded-tracks": {
        const query = { visible: { $ne: false } };
        const [tracks, total] = await Promise.all([
          mongo({
            action: "find",
            collection: TRACKS,
            query,
            options: {
              sort: { "metadata.sourceTimestamp": -1, displayName: 1 },
              limit: input.limit,
              skip: input.skip,
            },
          }),
          mongo({ action: "count", collection: TRACKS, query }),
        ]);
        return { tracks, total };
      }

      case "get-recorded-track-geometry": {
        const trackId = new ObjectId(input.id);
        const track = await mongo({
          action: "findOne",
          collection: TRACKS,
          query: { _id: trackId, visible: { $ne: false } },
          options: {
            projection: {
              fingerprint: 1,
              pointCount: 1,
              geometryPointCount: 1,
              geometryChunkCount: 1,
              geometryCompleteness: 1,
            },
          },
        });
        if (!track) return { success: false, error: "Track not found" };
        const chunks = await mongo({
          action: "find",
          collection: TRACK_GEOMETRY,
          query: { trackId, chunkIndex: { $gte: input.cursor } },
          options: { sort: { chunkIndex: 1 }, limit: input.limit },
        });
        const nextCursor = chunks.length === input.limit
          ? Number(chunks[chunks.length - 1].chunkIndex) + 1
          : null;
        return {
          track,
          chunks,
          nextCursor,
          complete: nextCursor === null,
        };
      }

      case "backfill-import":
        return await backfillLocationImport(auth, input.id);

      case "backfill-imports":
        return await backfillLocationImports(auth, input.limit);

      case "list-conflicts": {
        const query = reviewStatusQuery(input.status);
        const [conflicts, total] = await Promise.all([
          mongo({
            action: "find",
            collection: CONFLICTS,
            query,
            options: {
              sort: input.status === "resolved"
                ? { decidedAt: -1, _id: 1 }
                : { ts: 1, _id: 1 },
              limit: input.limit,
              skip: input.skip,
            },
          }),
          mongo({ action: "count", collection: CONFLICTS, query }),
        ]);
        return { conflicts, total };
      }

      case "list-metadata-conflicts": {
        const query = reviewStatusQuery(input.status);
        const [conflicts, total] = await Promise.all([
          mongo({
            action: "find",
            collection: METADATA_CONFLICTS,
            query,
            options: {
              sort: input.status === "resolved"
                ? { decidedAt: -1, _id: 1 }
                : { createdAt: -1, _id: 1 },
              limit: input.limit,
              skip: input.skip,
            },
          }),
          mongo({ action: "count", collection: METADATA_CONFLICTS, query }),
        ]);
        return { conflicts, total };
      }

      case "resolve-metadata-conflict": {
        const conflictId = new ObjectId(input.id);
        if (input.resolution === "defer" || input.resolution === "resume") {
          return await moveConflictReview(
            mongo,
            METADATA_CONFLICTS,
            conflictId,
            input.resolution,
            auth.principal,
          );
        }
        const conflict = await mongo({
          action: "findOne",
          collection: METADATA_CONFLICTS,
          query: { _id: conflictId, ...reviewStatusQuery("pending") },
        });
        if (!conflict) {
          return {
            success: false,
            error: "This item is no longer awaiting review",
          };
        }
        if (
          input.resolution === "use_incoming" ||
          input.resolution === "keep_existing"
        ) {
          const collection = conflict.entityType === "track"
            ? TRACKS
            : conflict.entityType === "bookmark"
            ? BOOKMARKS
            : POINTS;
          const entity = await mongo({
            action: "findOne",
            collection,
            query: { _id: conflict.entityId },
          });
          if (!entity) return { success: false, error: "Entity not found" };
          const selectedValue = input.resolution === "use_incoming"
            ? conflict.incomingValue
            : conflict.existingValue;
          if (conflict.entityType === "point") {
            await mongo({
              action: "updateOne",
              collection: POINTS,
              query: { _id: conflict.entityId },
              update: {
                $set: {
                  [conflict.field]: selectedValue,
                  [`metadataOverrides.${conflict.field}`]: {
                    value: selectedValue,
                    decidedAt: new Date(),
                    decidedBy: auth.principal || "web",
                  },
                },
              },
            });
          } else {
            const metadata = {
              ...(entity.metadata ?? {}),
              [conflict.field]: selectedValue,
            };
            const displayName = metadata.customNames?.default ??
              metadata.localizedNames?.default ?? metadata.name ?? null;
            await mongo({
              action: "updateOne",
              collection,
              query: { _id: conflict.entityId },
              update: {
                $set: {
                  metadata,
                  displayName,
                  manualOverrides: true,
                  metadataPriority: 100,
                  ...(conflict.field === "description"
                    ? { description: selectedValue }
                    : {}),
                  ...(conflict.field === "featureTypes"
                    ? { featureTypes: selectedValue }
                    : {}),
                  ...(conflict.field === "icon" ? { icon: selectedValue } : {}),
                  ...(conflict.field === "scale"
                    ? { scale: selectedValue }
                    : {}),
                  ...(conflict.field === "visibility"
                    ? { visibility: selectedValue }
                    : {}),
                  ...(conflict.field === "sourceTimestamp"
                    ? { sourceTimestamp: selectedValue }
                    : {}),
                  ...(conflict.field === "style"
                    ? { style: selectedValue }
                    : {}),
                },
              },
            });
          }
        }
        await mongo({
          action: "updateOne",
          collection: METADATA_CONFLICTS,
          query: { _id: conflictId },
          update: {
            $set: {
              status: "resolved",
              resolution: input.resolution,
              decidedAt: new Date(),
              decidedBy: auth.principal || "web",
            },
          },
        });
        return { success: true, status: "resolved" };
      }

      case "resolve-conflict": {
        const conflictId = new ObjectId(input.id);
        if (input.resolution === "defer" || input.resolution === "resume") {
          return await moveConflictReview(
            mongo,
            CONFLICTS,
            conflictId,
            input.resolution,
            auth.principal,
          );
        }
        const conflict = await mongo({
          action: "findOne",
          collection: CONFLICTS,
          query: { _id: conflictId, ...reviewStatusQuery("pending") },
        });
        if (!conflict) {
          return {
            success: false,
            error: "This item is no longer awaiting review",
          };
        }

        if (input.resolution === "use_incoming") {
          const candidate = (conflict.candidates ?? []).find((item: any) =>
            !input.candidateImportId ||
            String(item.importId) === input.candidateImportId
          );
          if (!candidate) {
            return { success: false, error: "Candidate not found" };
          }
          const candidateImport = await mongo({
            action: "findOne",
            collection: IMPORTS,
            query: { _id: new ObjectId(String(candidate.importId)) },
          });
          if (!candidateImport?.committedAt) {
            return {
              success: false,
              error: "Candidate import is not committed",
            };
          }
          const existingHashes = (conflict.existingPoints ?? []).map((
            point: any,
          ) => point.hash);
          if (existingHashes.length > 0) {
            await mongo({
              action: "updateMany",
              collection: POINTS,
              query: { hash: { $in: existingHashes } },
              update: { $set: { selection: "rejected", visible: false } },
            });
          }
          const operations = (candidate.points ?? []).map((point: any) => ({
            updateOne: {
              filter: { hash: point.hash },
              update: {
                $set: {
                  ts: new Date(conflict.ts),
                  loc: point.loc,
                  ...(point.ele !== undefined ? { ele: point.ele } : {}),
                  selection: "accepted",
                  visible: true,
                  importId: candidate.importId,
                  visibilityOwner: candidate.importId,
                },
                $setOnInsert: {
                  _id: new ObjectId(),
                  hash: point.hash,
                  createdAt: new Date(),
                },
                $addToSet: { importIds: candidate.importId },
              },
              upsert: true,
            },
          }));
          if (operations.length > 0) {
            await mongo({
              action: "bulkWrite",
              collection: POINTS,
              operations,
              options: { ordered: false },
            });
          }
        }

        await mongo({
          action: "updateOne",
          collection: CONFLICTS,
          query: { _id: conflictId },
          update: {
            $set: {
              status: "resolved",
              resolution: input.resolution,
              ...(input.candidateImportId
                ? { selectedImportId: new ObjectId(input.candidateImportId) }
                : {}),
              decidedAt: new Date(),
              decidedBy: auth.principal || "web",
            },
          },
        });
        await bumpLocationImportRevision(mongo);
        const timestamp = new Date(conflict.ts);
        await this.enqueueReprocess(
          auth,
          timestamp,
          new Date(timestamp.getTime() + 1),
          "Location conflict resolved; regenerating derived segments",
        );
        return { success: true, status: "resolved" };
      }

      case "delete-import": {
        const importId = new ObjectId(input.id);
        const importDoc = await mongo({
          action: "findOne",
          collection: IMPORTS,
          query: { _id: importId },
        });
        if (!importDoc) return { success: false, error: "Import not found" };

        const deletedLegacy = await mongo({
          action: "deleteMany",
          collection: POINTS,
          query: { importId, importIds: { $exists: false } },
        });
        const deletedSole = await mongo({
          action: "deleteMany",
          collection: POINTS,
          query: {
            $and: [{ importIds: importId }, { importIds: { $size: 1 } }],
          },
        });
        await mongo({
          action: "updateMany",
          collection: POINTS,
          query: { importIds: importId },
          update: {
            $pull: { importIds: importId, sourceRefs: { importId } },
          },
        });
        await removeLocationEntitySourceRefs(mongo, importId);
        await mongo({
          action: "updateMany",
          collection: CONFLICTS,
          query: { sourceImportIds: importId },
          update: {
            $pull: {
              sourceImportIds: importId,
              candidates: { importId },
            },
          },
        });
        await mongo({
          action: "deleteMany",
          collection: METADATA_CONFLICTS,
          query: { incomingImportId: importId },
        });
        await mongo({
          action: "deleteOne",
          collection: IMPORTS,
          query: { _id: importId },
        });
        if (importDoc.fileId) {
          try {
            const fs = await getFsResource(auth);
            await fs({
              action: "delete",
              bucket: "location_files",
              id: String(importDoc.fileId),
            });
          } catch (error) {
            console.warn(
              "[location] Import source removed but GridFS cleanup failed:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        await bumpLocationImportRevision(mongo);
        if (importDoc.timeRange?.start && importDoc.timeRange?.end) {
          await this.enqueueReprocess(
            auth,
            new Date(importDoc.timeRange.start),
            new Date(importDoc.timeRange.end),
            "Import deleted; regenerating derived segments",
          );
        }
        return {
          success: true,
          deletedPoints: (deletedLegacy.deletedCount ?? 0) +
            (deletedSole.deletedCount ?? 0),
        };
      }
    }
  }

  private async enqueueReprocess(
    auth: Auth,
    start: Date,
    end: Date,
    reason: string,
  ): Promise<void> {
    try {
      const jobs = await getJobsResource(auth);
      await jobs({
        action: "enqueue",
        data: {
          type: "location_processing",
          start: new Date(start.getTime() - REPROCESS_PAD_MS).toISOString(),
          end: new Date(end.getTime() + REPROCESS_PAD_MS).toISOString(),
        },
        trigger: { type: "manual", reason },
      });
    } catch (err) {
      console.warn(
        "[location] Failed to enqueue location_processing:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
