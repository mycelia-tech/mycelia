import type { Db, Document } from "mongodb";
import type { LocationSourceFilter } from "@myceliasdk/location-sources.ts";
import type { MapBounds } from "./map-spatial.ts";
import { focusedSourceLinks } from "./sources.server.ts";
import {
  hiddenRouteTracks,
  LOCATION_ROUTE_CONFLICTS,
  LOCATION_ROUTE_FRAGMENTS,
  LOCATION_ROUTE_GEOMETRY,
  LOCATION_ROUTE_STATE,
} from "./route-projection.server.ts";

type Range = { start?: Date; end?: Date };
type BoundsRow = MapBounds & { firstAt?: Date; lastAt?: Date };
const readOptions = { maxTimeMS: 10_000 };

function fixReadOptions(fileCount: number) {
  // Each contributing file can have both string and ObjectId references.
  // Large providers create hundreds of seeks on both legacy and current
  // indexes. Scan the canonical date interval once in that case.
  return fileCount >= 128
    ? { maxTimeMS: 20_000, hint: "location_point_canonical_cursor_v1" }
    : readOptions;
}

function fixesQuery(links: Document, range: Range) {
  return {
    ...links,
    visible: true,
    selection: "accepted",
    ...(range.start && range.end
      ? { ts: { $gte: range.start, $lte: range.end } }
      : {}),
  };
}

function coordinateFields(path: string) {
  return { lng: { $arrayElemAt: [path, 0] }, lat: { $arrayElemAt: [path, 1] } };
}

function coordinateExtent(first: string | null, last: string | null) {
  return {
    $group: {
      _id: null,
      west: { $min: "$lng" },
      east: { $max: "$lng" },
      south: { $min: "$lat" },
      north: { $max: "$lat" },
      firstAt: { $min: first },
      lastAt: { $max: last },
    },
  };
}

function mergeExtents(field: string, first: string, last: string) {
  return {
    $group: {
      _id: null,
      west: { $min: field + ".west" },
      east: { $max: field + ".east" },
      south: { $min: field + ".south" },
      north: { $max: field + ".north" },
      firstAt: { $min: first },
      lastAt: { $max: last },
    },
  };
}

async function routeExtents(db: Db, sourceLinks: Document, range: Range) {
  const state = await db.collection<
    { _id: string; ready?: boolean; activeGeneration?: string }
  >(LOCATION_ROUTE_STATE)
    .findOne({ _id: "current" }, {
      projection: { ready: 1, activeGeneration: 1 },
      ...readOptions,
    });
  if (!state?.ready || !state.activeGeneration) return [];
  const [tracks, conflicts] = await Promise.all([
    db.collection("location_tracks").find(sourceLinks, {
      projection: { _id: 1 },
      ...readOptions,
    }).toArray(),
    db.collection(LOCATION_ROUTE_CONFLICTS).find({
      status: "resolved",
      ...(range.start && range.end
        ? {
          overlapStart: { $lte: range.end },
          overlapEnd: { $gte: range.start },
        }
        : {}),
    }, {
      projection: { status: 1, resolution: 1, trackIds: 1 },
      ...readOptions,
    }).toArray(),
  ]);
  const hidden = hiddenRouteTracks(conflicts);
  const ids = tracks.map(({ _id }) => _id).filter((id) =>
    !hidden.has(String(id))
  );
  if (!ids.length) return [];
  const fragments = db.collection(LOCATION_ROUTE_FRAGMENTS);
  const base = { generation: state.activeGeneration, trackId: { $in: ids } };
  const entire = fragments.aggregate<BoundsRow>([
    {
      $match: {
        ...base,
        ...(range.start && range.end
          ? {
            $or: [
              { timeStart: { $exists: false } },
              {
                timeStart: { $gte: range.start },
                timeEnd: { $lte: range.end },
              },
            ],
          }
          : {}),
      },
    },
    mergeExtents("$bbox", "$timeStart", "$timeEnd"),
  ], readOptions).toArray();
  if (!range.start || !range.end) return entire;

  // Most fragments can use the precomputed bbox. Only a fragment straddling
  // a date boundary needs its indexed geometry, reduced to bounds in Mongo.
  const partial = fragments.aggregate<BoundsRow>([
    {
      $match: {
        ...base,
        timeStart: { $lte: range.end },
        timeEnd: { $gte: range.start },
        $or: [{ timeStart: { $lt: range.start } }, {
          timeEnd: { $gt: range.end },
        }],
      },
    },
    {
      $lookup: {
        from: LOCATION_ROUTE_GEOMETRY,
        let: { track: "$trackId", fragment: "$fragmentIndex" },
        pipeline: [
          {
            $match: {
              generation: state.activeGeneration,
              $expr: {
                $and: [
                  { $eq: ["$trackId", "$$track"] },
                  { $eq: ["$fragmentIndex", "$$fragment"] },
                ],
              },
            },
          },
          { $unwind: "$points" },
          {
            $match: {
              $or: [{ "points.ts": null }, {
                "points.ts": { $gte: range.start, $lte: range.end },
              }],
            },
          },
          {
            $project: {
              ...coordinateFields("$points.coordinates"),
              ts: "$points.ts",
            },
          },
          coordinateExtent("$ts", "$ts"),
        ],
        as: "extent",
      },
    },
    { $unwind: "$extent" },
    mergeExtents("$extent", "$extent.firstAt", "$extent.lastAt"),
  ], readOptions).toArray();
  return (await Promise.all([entire, partial])).flat();
}

export async function getMapSourceExtent(
  db: Db,
  input: Range & {
    layer: "markers" | "routes" | "all";
    sourceFilter: LocationSourceFilter;
  },
) {
  const links = await focusedSourceLinks(db, input.sourceFilter);
  const tasks: Array<Promise<BoundsRow[]>> = [];
  if (input.layer !== "routes") {
    const range = input.start && input.end
      ? { start: { $lt: input.end }, end: { $gt: input.start } }
      : {};
    const pointBounds = (
      collection: string,
      match: Document,
      first: string | null,
      last: string | null,
      options = readOptions,
    ) =>
      db.collection(collection).aggregate<BoundsRow>([
        { $match: { ...match, "loc.coordinates.1": { $type: "number" } } },
        {
          $project: {
            ...coordinateFields("$loc.coordinates"),
            begin: first,
            finish: last,
          },
        },
        coordinateExtent("$begin", "$finish"),
      ], options).toArray();
    tasks.push(
      pointBounds(
        "location_points",
        fixesQuery(links.points, input),
        "$ts",
        "$ts",
        fixReadOptions(links.fileCount),
      ),
      pointBounds(
        "location_segments",
        { ...links.linked("importIds"), type: "stay", ...range },
        "$start",
        "$end",
      ),
      pointBounds(
        "location_bookmarks",
        {
          ...links.linked("sourceRefs.importId"),
          visible: { $ne: false },
          reviewStatus: { $ne: "rejected" },
        },
        null,
        null,
      ),
    );
  }
  if (input.layer !== "markers") {
    tasks.push(routeExtents(db, links.linked("sourceRefs.importId"), input));
  }
  const rows = (await Promise.all(tasks)).flat();
  const first = rows.flatMap((row) =>
    row.firstAt ? [row.firstAt.getTime()] : []
  );
  const last = rows.flatMap((row) => row.lastAt ? [row.lastAt.getTime()] : []);
  return {
    bounds: rows.length
      ? {
        west: Math.min(...rows.map((row) => row.west)),
        east: Math.max(...rows.map((row) => row.east)),
        south: Math.min(...rows.map((row) => row.south)),
        north: Math.max(...rows.map((row) => row.north)),
      }
      : null,
    firstAt: first.length ? new Date(Math.min(...first)) : null,
    lastAt: last.length ? new Date(Math.max(...last)) : null,
  };
}

export async function getMapSourcePoints(
  db: Db,
  input: {
    start: Date;
    end: Date;
    bounds: MapBounds;
    sourceFilter: LocationSourceFilter;
  },
) {
  const links = await focusedSourceLinks(db, input.sourceFilter);
  const { west, east, south, north } = input.bounds;
  const lngField = "loc.coordinates.0";
  const span = east > west ? east - west : east + 360 - west;
  const longitude = east >= west
    ? { [lngField]: { $gte: west, $lte: east } }
    : {
      $or: [{ [lngField]: { $gte: west } }, { [lngField]: { $lte: east } }],
    };
  const offset = { $subtract: ["$lng", west] };
  const wrappedOffset = {
    $cond: [{ $lt: [offset, 0] }, { $add: [offset, 360] }, offset],
  };
  // A viewport-relative grid bounds both the response and the aggregation's
  // group count. Each shared canonical fix contributes once, even across files.
  const cell = (offset: Document, span: number, cells: number) => ({
    $min: [cells - 1, {
      $floor: { $multiply: [{ $divide: [offset, span || 360] }, cells] },
    }],
  });
  const clusters = await db.collection("location_points").aggregate([
    {
      $match: {
        $and: [fixesQuery(links.points, input), longitude],
        "loc.coordinates.1": { $gte: south, $lte: north },
      },
    },
    { $project: { ...coordinateFields("$loc.coordinates"), ts: 1 } },
    {
      $group: {
        _id: {
          x: cell(wrappedOffset, span, 24),
          y: cell({ $subtract: ["$lat", south] }, north - south, 16),
        },
        lat: { $avg: "$lat" },
        offset: { $avg: wrappedOffset },
        count: { $sum: 1 },
        firstAt: { $min: "$ts" },
        lastAt: { $max: "$ts" },
      },
    },
    {
      $project: {
        _id: 0,
        lat: 1,
        count: 1,
        firstAt: 1,
        lastAt: 1,
        lng: {
          $subtract: [{ $mod: [{ $add: ["$offset", west + 540] }, 360] }, 180],
        },
      },
    },
  ], fixReadOptions(links.fileCount)).toArray();
  return { clusters };
}
