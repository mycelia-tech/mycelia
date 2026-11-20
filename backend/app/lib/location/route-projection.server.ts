import type { Db, MongoClient, ObjectId } from "mongodb";
import simplify from "simplify-js";
import type { MapBounds } from "./map-spatial.ts";
import {
  detectRouteSeriesConflict,
  projectRoute,
  type RouteBreak,
  routeDistanceM,
  type RoutePoint,
} from "./route-projection.ts";

export const LOCATION_ROUTE_FRAGMENTS = "location_route_fragments";
export const LOCATION_ROUTE_GEOMETRY = "location_route_geometry";
export const LOCATION_ROUTE_BREAKS = "location_route_breaks";
export const LOCATION_ROUTE_CONFLICTS = "location_route_conflicts";
export const LOCATION_ROUTE_STATE = "location_route_projection_state";

const TRACKS = "location_tracks";
const IMPORTS = "location_imports";
const SOURCE_GEOMETRY = "location_track_geometry";
const GEOMETRY_CHUNK_SIZE = 2_000;
const OVERVIEW_POINTS = 500;
const ROUTE_INPUT_POINT_LIMIT = 350_000;
const ROUTE_INPUT_FRAGMENT_LIMIT = 1_500;
const PREPARED_ROUTE_POINT_LIMIT = 220_000;
const PREPARED_ROUTE_FRAGMENT_LIMIT = 1_500;
export const DEFAULT_GAP_DISTANCE_M = 300;
export const DEFAULT_GAP_MINUTES = 2;
const MAP_GEOMETRY_PAYLOAD_BUDGET = 200 * 1024;
const ROUTE_READ_TIMEOUT_MS = 10_000;

type RouteState = {
  _id: "current";
  ready?: boolean;
  building?: boolean;
  status?: string;
  revision?: number;
  activeGeneration?: string;
  projectionVersion?: number;
  decisionChangedAt?: Date;
  error?: string;
};

type TrackRow = {
  _id: unknown;
  fingerprint?: string;
  displayName?: string;
  geometryCompleteness?: string;
  routeBoundaryCompleteness?: string;
  sourceRefs?: unknown[];
};

type FragmentRow = {
  _id: string;
  generation: string;
  trackId: unknown;
  fragmentIndex: number;
  pointCount: number;
  overview: [number, number][];
  timeStart?: Date;
  timeEnd?: Date;
  bbox: MapBounds;
  bounds: { type: "Polygon"; coordinates: [number, number][][] };
  displayName?: string;
  sourceRefs?: unknown[];
  geometryCompleteness?: string;
  routeBoundaryCompleteness?: string;
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function decimate(points: RoutePoint[], budget: number): [number, number][] {
  if (points.length <= budget) return points.map((point) => point.coordinates);
  const result: [number, number][] = [];
  const stride = (points.length - 1) / (budget - 1);
  for (let index = 0; index < budget; index++) {
    result.push(points[Math.round(index * stride)].coordinates);
  }
  return result;
}

function pointBounds(points: RoutePoint[]): MapBounds {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const point of points) {
    const [lng, lat] = point.coordinates;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (west === east) {
    west -= 0.0000001;
    east += 0.0000001;
  }
  if (south === north) {
    south -= 0.0000001;
    north += 0.0000001;
  }
  return { west, east, south, north };
}

function boundsPolygon(bounds: MapBounds) {
  const { west, east, south, north } = bounds;
  return {
    type: "Polygon" as const,
    coordinates: [[
      [west, south] as [number, number],
      [east, south] as [number, number],
      [east, north] as [number, number],
      [west, north] as [number, number],
      [west, south] as [number, number],
    ]],
  };
}

function timedBounds(
  points: RoutePoint[],
): { timeStart?: Date; timeEnd?: Date } {
  const times = points.flatMap((point) => point.ts ? [point.ts.getTime()] : []);
  return times.length === 0 ? {} : {
    timeStart: new Date(Math.min(...times)),
    timeEnd: new Date(Math.max(...times)),
  };
}

async function loadTrackPoints(
  db: Db,
  trackId: unknown,
): Promise<RoutePoint[]> {
  const rows = await db.collection(SOURCE_GEOMETRY).find(
    { trackId },
    { sort: { chunkIndex: 1 }, projection: { points: 1 } },
  ).toArray();
  return rows.flatMap((row: any) => row.points ?? []).map((point: any) => ({
    index: Number(point.index),
    coordinates: point.coordinates as [number, number],
    ...(point.ts ? { ts: new Date(point.ts) } : {}),
    ...(point.sourceFragmentIndex !== undefined
      ? { sourceFragmentIndex: Number(point.sourceFragmentIndex) }
      : {}),
    ...(point.sourcePointIndex !== undefined
      ? { sourcePointIndex: Number(point.sourcePointIndex) }
      : {}),
  }));
}

function breakForStorage(
  generation: string,
  trackId: unknown,
  value: RouteBreak,
) {
  return {
    _id: `${generation}:${String(trackId)}:${value.breakIndex}`,
    generation,
    trackId,
    breakIndex: value.breakIndex,
    reason: value.reason,
    distanceM: Math.round(value.distanceM),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
    from: {
      coordinates: value.from.coordinates,
      ...(value.from.ts ? { ts: value.from.ts } : {}),
    },
    to: {
      coordinates: value.to.coordinates,
      ...(value.to.ts ? { ts: value.to.ts } : {}),
    },
  };
}

export async function rebuildLocationRouteProjection(
  db: Db,
  options: {
    onProgress?: (
      value: { processed: number; total: number },
    ) => Promise<void> | void;
  } = {},
) {
  const generation = crypto.randomUUID();
  const buildStartedAt = new Date();
  const states = db.collection<RouteState>(LOCATION_ROUTE_STATE);
  await states.updateOne(
    { _id: "current" },
    {
      $set: {
        building: true,
        status: "building",
        buildGeneration: generation,
        buildStartedAt,
      },
      $unset: { error: "" },
    },
    { upsert: true },
  );
  try {
    const tracks = await db.collection<TrackRow>(TRACKS).find(
      { geometryCompleteness: "full" },
      {
        projection: {
          fingerprint: 1,
          displayName: 1,
          geometryCompleteness: 1,
          routeBoundaryCompleteness: 1,
          sourceRefs: 1,
        },
        sort: { _id: 1 },
      },
    ).toArray();
    const series: Array<{ track: TrackRow; points: RoutePoint[] }> = [];
    let processed = 0;
    for (const track of tracks) {
      const points = await loadTrackPoints(db, track._id);
      const projection = projectRoute(points);
      series.push({ track, points });
      const fragmentOperations: never[] = [];
      const geometryOperations: never[] = [];
      for (const fragment of projection.fragments) {
        if (fragment.points.length < 2) continue;
        const bbox = pointBounds(fragment.points);
        const row: FragmentRow = {
          _id: `${generation}:${String(track._id)}:${fragment.fragmentIndex}`,
          generation,
          trackId: track._id,
          fragmentIndex: fragment.fragmentIndex,
          pointCount: fragment.points.length,
          overview: decimate(fragment.points, OVERVIEW_POINTS),
          ...timedBounds(fragment.points),
          bbox,
          bounds: boundsPolygon(bbox),
          ...(track.displayName ? { displayName: track.displayName } : {}),
          ...(track.sourceRefs ? { sourceRefs: track.sourceRefs } : {}),
          ...(track.geometryCompleteness
            ? { geometryCompleteness: track.geometryCompleteness }
            : {}),
          ...(track.routeBoundaryCompleteness
            ? { routeBoundaryCompleteness: track.routeBoundaryCompleteness }
            : {}),
        };
        fragmentOperations.push({ insertOne: { document: row } } as never);
        for (
          const [chunkIndex, points] of chunks(
            fragment.points,
            GEOMETRY_CHUNK_SIZE,
          ).entries()
        ) {
          geometryOperations.push({
            insertOne: {
              document: {
                _id: `${row._id}:${chunkIndex}`,
                generation,
                trackId: track._id,
                fragmentIndex: fragment.fragmentIndex,
                chunkIndex,
                points,
              },
            },
          } as never);
        }
      }
      if (fragmentOperations.length > 0) {
        await db.collection(LOCATION_ROUTE_FRAGMENTS).bulkWrite(
          fragmentOperations,
          { ordered: false },
        );
      }
      for (const batch of chunks(geometryOperations, 100)) {
        await db.collection(LOCATION_ROUTE_GEOMETRY).bulkWrite(batch, {
          ordered: false,
        });
      }
      if (projection.breaks.length > 0) {
        await db.collection<any>(LOCATION_ROUTE_BREAKS).insertMany(
          projection.breaks.map((value) =>
            breakForStorage(generation, track._id, value)
          ),
          { ordered: false },
        );
      }
      processed++;
      await options.onProgress?.({ processed, total: tracks.length });
    }

    const detectedPairs = new Set<string>();
    for (let leftIndex = 0; leftIndex < series.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < series.length;
        rightIndex++
      ) {
        const left = series[leftIndex];
        const right = series[rightIndex];
        if (
          left.track.fingerprint &&
          left.track.fingerprint === right.track.fingerprint
        ) continue;
        const conflict = detectRouteSeriesConflict(left.points, right.points);
        if (!conflict) continue;
        const ids = [String(left.track._id), String(right.track._id)].sort();
        const pairKey = ids.join(":");
        detectedPairs.add(pairKey);
        await db.collection(LOCATION_ROUTE_CONFLICTS).updateOne(
          { pairKey },
          {
            $set: {
              trackIds: [left.track._id, right.track._id],
              trackNames: [
                left.track.displayName ?? null,
                right.track.displayName ?? null,
              ],
              ...conflict,
              generation,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              _id: crypto.randomUUID(),
              status: "pending",
              createdAt: new Date(),
              audit: [],
            },
          },
          { upsert: true },
        );
      }
    }
    await db.collection(LOCATION_ROUTE_CONFLICTS).updateMany(
      { status: "pending", pairKey: { $nin: [...detectedPairs] } },
      { $set: { status: "superseded", supersededAt: new Date() } },
    );

    const state = await states.findOne({ _id: "current" });
    const revision = Number(state?.revision ?? 0) + 1;
    let swapped = await states.updateOne(
      {
        _id: "current",
        buildGeneration: generation,
        $or: [
          { sourceChangedAt: { $exists: false } },
          { sourceChangedAt: { $lte: buildStartedAt } },
        ],
      } as never,
      {
        $set: {
          activeGeneration: generation,
          revision,
          projectionVersion: 1,
          ready: true,
          dirty: false,
          building: false,
          status: "ready",
          calculatedAt: new Date(),
        },
        $unset: { buildGeneration: "", error: "" },
      },
    );
    if (swapped.modifiedCount !== 1) {
      swapped = await states.updateOne(
        { _id: "current", buildGeneration: generation } as never,
        {
          $set: {
            activeGeneration: generation,
            revision,
            projectionVersion: 1,
            ready: true,
            dirty: true,
            building: false,
            status: "stale",
            calculatedAt: new Date(),
          },
          $unset: { buildGeneration: "", error: "" },
        },
      );
    }
    if (swapped.modifiedCount !== 1) {
      throw new Error("Route projection generation changed before publish");
    }
    await Promise.all([
      db.collection(LOCATION_ROUTE_FRAGMENTS).deleteMany({
        generation: { $ne: generation },
      }),
      db.collection(LOCATION_ROUTE_GEOMETRY).deleteMany({
        generation: { $ne: generation },
      }),
      db.collection(LOCATION_ROUTE_BREAKS).deleteMany({
        generation: { $ne: generation },
      }),
    ]);
    return { generation, revision, processed, conflicts: detectedPairs.size };
  } catch (error) {
    await states.updateOne(
      { _id: "current", buildGeneration: generation } as never,
      {
        $set: {
          building: false,
          status: "failed",
          dirty: true,
          error: error instanceof Error ? error.message : String(error),
        },
        $unset: { buildGeneration: "" },
      },
    );
    await Promise.all([
      db.collection(LOCATION_ROUTE_FRAGMENTS).deleteMany({ generation }),
      db.collection(LOCATION_ROUTE_GEOMETRY).deleteMany({ generation }),
      db.collection(LOCATION_ROUTE_BREAKS).deleteMany({ generation }),
    ]);
    throw error;
  }
}

function intersects(left: MapBounds, right: MapBounds): boolean {
  const latitude = left.south <= right.north && left.north >= right.south;
  if (!latitude) return false;
  if (right.west <= right.east) {
    return left.west <= right.east && left.east >= right.west;
  }
  return left.east >= right.west || left.west <= right.east;
}

function bufferedBounds(bounds: MapBounds, zoom: number): MapBounds {
  const padding = Math.max(0.0001, 360 / 2 ** Math.max(1, zoom) * 0.25);
  return {
    west: Math.max(-180, bounds.west - padding),
    east: Math.min(180, bounds.east + padding),
    south: Math.max(-90, bounds.south - padding),
    north: Math.min(90, bounds.north + padding),
  };
}

function inside(point: RoutePoint, bounds: MapBounds): boolean {
  const [lng, lat] = point.coordinates;
  return lat >= bounds.south && lat <= bounds.north &&
    (bounds.west <= bounds.east
      ? lng >= bounds.west && lng <= bounds.east
      : lng >= bounds.west || lng <= bounds.east);
}

function clipRuns(points: RoutePoint[], bounds: MapBounds): RoutePoint[][] {
  const runs: RoutePoint[][] = [];
  let run: RoutePoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const currentInside = inside(points[index], bounds);
    const previousInside = index > 0 && inside(points[index - 1], bounds);
    const nextInside = index + 1 < points.length &&
      inside(points[index + 1], bounds);
    if (currentInside || previousInside || nextInside) {
      run.push(points[index]);
    } else if (run.length > 0) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function simplifyRun(
  points: RoutePoint[],
  zoom: number,
  pixels: number,
): [number, number][] {
  const latitude =
    points.reduce((total, point) => total + point.coordinates[1], 0) /
    points.length;
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) /
    2 ** zoom;
  const toleranceDegrees = Math.max(
    0.0000001,
    metersPerPixel * pixels / 111_320,
  );
  const scaleX = Math.max(0.01, Math.cos(latitude * Math.PI / 180));
  const simplified = simplify(
    points.map((point) => ({
      x: point.coordinates[0] * scaleX,
      y: point.coordinates[1],
    })),
    toleranceDegrees,
    true,
  );
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return simplified.map((point) => [round(point.x / scaleX), round(point.y)]);
}

type DisplayConnector = {
  _id: string;
  reason: "distance_threshold" | "time_threshold";
  distanceM: number;
  durationMs?: number;
  from: { coordinates: [number, number]; ts?: Date };
  to: { coordinates: [number, number]; ts?: Date };
};

type StoredConnector = Omit<DisplayConnector, "_id" | "reason"> & {
  _id: string;
  trackId: unknown;
  reason: RouteBreak["reason"];
};

export function splitDisplayRuns(
  points: RoutePoint[],
  { id, start, end, distanceM, durationMs, collectConnectors = true }: {
    id: string;
    start: Date;
    end: Date;
    distanceM: number;
    durationMs: number;
    collectConnectors?: boolean;
  },
): { runs: RoutePoint[][]; connectors: DisplayConnector[] } {
  const runs: RoutePoint[][] = [];
  const connectors: DisplayConnector[] = [];
  let run: RoutePoint[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  for (const point of points) {
    if (point.ts && (point.ts < start || point.ts > end)) {
      flush();
      continue;
    }
    const previous = run.at(-1);
    if (previous) {
      const distance = routeDistanceM(previous, point);
      const duration = previous.ts && point.ts
        ? point.ts.getTime() - previous.ts.getTime()
        : undefined;
      const byDistance = distance > distanceM;
      if (
        point.index !== previous.index + 1 || byDistance ||
        (duration !== undefined && duration > durationMs)
      ) {
        if (
          collectConnectors && point.index === previous.index + 1 &&
          distance >= 1
        ) {
          connectors.push({
            _id: `${id}:display-gap:${point.index}`,
            reason: byDistance ? "distance_threshold" : "time_threshold",
            distanceM: Math.round(distance),
            ...(duration !== undefined ? { durationMs: duration } : {}),
            from: { coordinates: previous.coordinates, ts: previous.ts },
            to: { coordinates: point.coordinates, ts: point.ts },
          });
        }
        flush();
      }
    }
    run.push(point);
  }
  flush();
  return { runs, connectors };
}

type PreparedFragment = ReturnType<typeof splitDisplayRuns>;
type PreparedRouteCache = {
  entries: Map<string, { fragment: PreparedFragment; weight: number }>;
  weight: number;
};
const preparedRoutes = new WeakMap<MongoClient, PreparedRouteCache>();

function rememberPreparedFragment(
  cache: PreparedRouteCache,
  key: string,
  fragment: PreparedFragment,
  pointCount: number,
) {
  const weight = pointCount + 2 * fragment.connectors.length;
  if (weight > PREPARED_ROUTE_POINT_LIMIT || cache.entries.has(key)) return;
  cache.entries.set(key, { fragment, weight });
  cache.weight += weight;
  while (
    cache.weight > PREPARED_ROUTE_POINT_LIMIT ||
    cache.entries.size > PREPARED_ROUTE_FRAGMENT_LIMIT
  ) {
    const [oldestKey, oldest] = cache.entries.entries().next().value!;
    cache.entries.delete(oldestKey);
    cache.weight -= oldest.weight;
  }
}

export async function getMapRouteDetail(
  db: Db,
  input: {
    start: Date;
    end: Date;
    bounds: MapBounds;
    zoom: number;
    includeConnectors: boolean;
    includeSourceTracks?: boolean;
    gapDistanceM?: number;
    gapMinutes?: number;
    reviewTrackIds?: unknown[];
  },
) {
  const deadline = performance.now() + ROUTE_READ_TIMEOUT_MS;
  const readOptions = () => ({
    timeoutMS: Math.max(1, Math.ceil(deadline - performance.now())),
  });
  const state = await db.collection<RouteState>(LOCATION_ROUTE_STATE).findOne({
    _id: "current",
  }, readOptions());
  if (!state?.ready || !state.activeGeneration) {
    return {
      projection: {
        status: state?.status ?? "not-built",
        revision: Number(state?.revision ?? 0),
        ready: false,
      },
      fragments: [],
      connectors: [],
      conflicts: [],
      ...(input.includeSourceTracks ? { sourceTracks: [] } : {}),
      lod: "overview",
      detailLimited: false,
    };
  }
  const rows = await db.collection<FragmentRow>(LOCATION_ROUTE_FRAGMENTS).find({
    generation: state.activeGeneration,
    ...(input.reviewTrackIds ? { trackId: { $in: input.reviewTrackIds } } : {}),
    $or: [
      { timeStart: { $exists: false } },
      { timeStart: { $lte: input.end }, timeEnd: { $gte: input.start } },
    ],
    "bbox.south": { $lte: input.bounds.north },
    "bbox.north": { $gte: input.bounds.south },
    ...(input.bounds.west <= input.bounds.east
      ? {
        "bbox.west": { $lte: input.bounds.east },
        "bbox.east": { $gte: input.bounds.west },
      }
      : {}),
  } as never, {
    projection: {
      trackId: 1,
      fragmentIndex: 1,
      pointCount: 1,
      timeStart: 1,
      timeEnd: 1,
      bbox: 1,
      displayName: 1,
    },
    sort: { timeEnd: -1, _id: 1 },
    ...readOptions(),
  }).toArray();
  const overlappingConflicts = input.reviewTrackIds
    ? []
    : await db.collection(LOCATION_ROUTE_CONFLICTS)
      .find({
        status: { $in: ["pending", "resolved"] },
        overlapStart: { $lte: input.end },
        overlapEnd: { $gte: input.start },
      }, readOptions()).toArray();
  const hiddenTrackIds = new Set<string>();
  for (const conflict of overlappingConflicts as any[]) {
    if (conflict.status !== "resolved") continue;
    if (conflict.resolution === "use_first" && conflict.trackIds?.[1]) {
      hiddenTrackIds.add(String(conflict.trackIds[1]));
    }
    if (conflict.resolution === "use_second" && conflict.trackIds?.[0]) {
      hiddenTrackIds.add(String(conflict.trackIds[0]));
    }
  }
  const visible = rows.filter((row) =>
    !hiddenTrackIds.has(String(row.trackId)) &&
    intersects(row.bbox, input.bounds)
  );
  // Use only consecutive, original fixes for display cuts. The stored
  // overview samples by stride and can draw shortcuts through whole blocks.
  const candidates: FragmentRow[] = [];
  let inputPoints = 0;
  let detailLimited = false;
  for (const row of visible) {
    if (
      candidates.length >= ROUTE_INPUT_FRAGMENT_LIMIT ||
      (candidates.length > 0 &&
        inputPoints + row.pointCount > ROUTE_INPUT_POINT_LIMIT)
    ) {
      detailLimited = true;
      continue;
    }
    candidates.push(row);
    inputPoints += row.pointCount;
  }
  if (inputPoints > ROUTE_INPUT_POINT_LIMIT) detailLimited = true;
  let cache = preparedRoutes.get(db.client);
  if (!cache) {
    cache = { entries: new Map(), weight: 0 };
    preparedRoutes.set(db.client, cache);
  }
  const distanceM = input.gapDistanceM ?? DEFAULT_GAP_DISTANCE_M;
  const durationMs = (input.gapMinutes ?? DEFAULT_GAP_MINUTES) * 60_000;
  const prepared = candidates.map((row) => {
    // The fragment ID includes its immutable projection generation. A wider
    // interval yields the same runs once it contains every timed point.
    const fullyIncluded = (!row.timeStart && !row.timeEnd) ||
      (row.timeStart && row.timeEnd && row.timeStart >= input.start &&
        row.timeEnd <= input.end);
    const key = JSON.stringify([
      db.databaseName,
      row._id,
      distanceM,
      durationMs,
      input.includeConnectors,
      fullyIncluded ? null : input.start.getTime(),
      fullyIncluded ? null : input.end.getTime(),
    ]);
    const cached = cache.entries.get(key);
    if (cached) {
      cache.entries.delete(key);
      cache.entries.set(key, cached);
    }
    return { row, key, fragment: cached?.fragment };
  });
  const byFragment = new Map<string, RoutePoint[]>();
  const chunkIds = prepared.filter(({ fragment }) => !fragment).flatMap((
    { row },
  ) =>
    Array.from(
      {
        length: Math.ceil(
          Math.min(row.pointCount, ROUTE_INPUT_POINT_LIMIT) /
            GEOMETRY_CHUNK_SIZE,
        ),
      },
      (_, chunkIndex) => `${row._id}:${chunkIndex}`,
    )
  );
  const geometry = db.collection<{ _id: string; points: RoutePoint[] }>(
    LOCATION_ROUTE_GEOMETRY,
  );
  let remaining = ROUTE_INPUT_POINT_LIMIT;
  // Geometry IDs encode the fragment and chunk ordinal. A batched lookup on
  // _id avoids planning one OR branch per fragment and keeps the read bounded.
  for (const ids of chunks(chunkIds, 128)) {
    const batch = await geometry.find(
      { _id: { $in: ids } },
      {
        projection: {
          "points.index": 1,
          "points.ts": 1,
          "points.coordinates": 1,
        },
        ...readOptions(),
      },
    ).toArray();
    const byId = new Map(batch.map((row) => [row._id, row.points]));
    for (const id of ids) {
      const points = byId.get(id);
      if (!points) continue;
      const fragmentId = id.slice(0, id.lastIndexOf(":"));
      const collected = byFragment.get(fragmentId) ?? [];
      const bounded = points.slice(0, remaining);
      collected.push(...bounded);
      byFragment.set(fragmentId, collected);
      remaining -= bounded.length;
    }
    if (remaining === 0) break;
  }
  const buffered = bufferedBounds(input.bounds, input.zoom);
  const displayRuns: Array<{ row: FragmentRow; run: RoutePoint[] }> = [];
  const MAX_MAP_CONNECTORS = 400;
  const connectors: Array<DisplayConnector | StoredConnector> = [];
  const addConnector = (connector: typeof connectors[number]) => {
    if (
      !intersects(
        pointBounds([
          { index: 0, coordinates: connector.from.coordinates },
          { index: 1, coordinates: connector.to.coordinates },
        ]),
        input.bounds,
      )
    ) return;
    if (connectors.length >= MAX_MAP_CONNECTORS) {
      detailLimited = true;
      return;
    }
    connectors.push(connector);
  };
  // Reserve room for both indexed breaks and gaps detected by display thresholds.
  if (input.includeConnectors) {
    const storedGaps = db.collection<StoredConnector>(LOCATION_ROUTE_BREAKS)
      .find({
        generation: state.activeGeneration,
        $or: [
          { "from.ts": { $exists: false } },
          { "from.ts": { $lte: input.end }, "to.ts": { $gte: input.start } },
          { "to.ts": { $lte: input.end }, "from.ts": { $gte: input.start } },
        ],
      }, {
        projection: {
          trackId: 1,
          reason: 1,
          distanceM: 1,
          durationMs: 1,
          from: 1,
          to: 1,
        },
        ...readOptions(),
      });
    for await (const connector of storedGaps) {
      if (hiddenTrackIds.has(String(connector.trackId))) continue;
      addConnector(connector);
      if (connectors.length >= MAX_MAP_CONNECTORS / 4) {
        detailLimited = true;
        break;
      }
    }
  }
  for (const { row, key, fragment } of prepared) {
    let split = fragment;
    if (!split) {
      const points = byFragment.get(row._id) ?? [];
      split = splitDisplayRuns(points, {
        id: row._id,
        start: input.start,
        end: input.end,
        distanceM,
        durationMs,
        collectConnectors: input.includeConnectors,
      });
      if (points.length === row.pointCount) {
        rememberPreparedFragment(cache, key, split, row.pointCount);
      }
    }
    for (const run of split.runs) {
      for (const clipped of clipRuns(run, buffered)) {
        displayRuns.push({ row, run: clipped });
      }
    }
    if (input.includeConnectors) split.connectors.forEach(addConnector);
  }
  const makeFragments = (pixels: number) =>
    displayRuns.flatMap(({ row, run }) => {
      const path = simplifyRun(run, input.zoom, pixels);
      // Share endpoints across response chunks, without adding a new edge.
      const parts = [];
      for (let offset = 0; offset < path.length - 1; offset += 1024) {
        parts.push({
          id: `${row.trackId}:${row.fragmentIndex}:${run[0].index}:${offset}`,
          trackId: row.trackId,
          fragmentIndex: row.fragmentIndex,
          path: path.slice(offset, offset + 1025),
          pointCount: run.length,
          displayName: row.displayName,
          timeStart: run[0].ts,
          timeEnd: run.at(-1)?.ts,
        });
      }
      return parts;
    });
  const encoder = new TextEncoder();
  const byteSize = (row: unknown) =>
    encoder.encode(JSON.stringify(row)).byteLength + 1;
  let fragments = makeFragments(0.75);
  const sumBytes = (rows: unknown[]) =>
    rows.reduce<number>((total, row) => total + byteSize(row), 2);
  if (sumBytes(fragments) > MAP_GEOMETRY_PAYLOAD_BUDGET) {
    fragments = makeFragments(1.5);
  }
  let remainingBytes = MAP_GEOMETRY_PAYLOAD_BUDGET;
  fragments = fragments.filter((row) => {
    const bytes = byteSize(row);
    if (bytes > remainingBytes) {
      detailLimited = true;
      return false;
    }
    remainingBytes -= bytes;
    return true;
  });
  const conflicts = overlappingConflicts.filter((conflict: any) =>
    conflict.status === "pending"
  );
  const sourceTracks = input.includeSourceTracks && fragments.length
    ? await db.collection(TRACKS).find({
      _id: {
        $in: [...new Map(
          fragments.map(({ trackId }) => [String(trackId), trackId]),
        ).values()],
      },
      visible: { $ne: false },
    } as never, {
      projection: {
        displayName: 1,
        pointCount: 1,
        geometryPointCount: 1,
        routeBoundaryCompleteness: 1,
        "style.color": 1,
      },
      ...readOptions(),
    }).toArray()
    : [];
  return {
    projection: {
      status: state.status ?? "ready",
      revision: Number(state.revision ?? 0),
      projectionVersion: Number(state.projectionVersion ?? 1),
      ready: true,
    },
    fragments,
    connectors,
    conflicts,
    ...(input.includeSourceTracks ? { sourceTracks } : {}),
    lod: "detail",
    detailLimited,
  };
}

export async function listRouteConflicts(
  db: Db,
  input: { status?: string; limit: number; skip: number },
) {
  type RefId = ObjectId | string;
  type SourceRef = { importId: RefId; format?: string };
  const collection = db.collection<{
    _id: string;
    trackIds?: RefId[];
    resolution?: string;
    resolvedAt?: Date;
  }>(LOCATION_ROUTE_CONFLICTS);
  const query = reviewStatusQuery(input.status);
  const [conflicts, total] = await Promise.all([
    collection.find(query, {
      sort: input.status === "resolved"
        ? { resolvedAt: -1, _id: 1 }
        : { overlapStart: 1, _id: 1 },
      skip: input.skip,
      limit: input.limit,
    }).toArray(),
    collection.countDocuments(query),
  ]);
  const trackIds = [
    ...new Map(
      conflicts.flatMap((conflict) =>
        (conflict.trackIds ?? []).map((id: RefId) => [String(id), id] as const)
      ),
    ).values(),
  ];
  if (trackIds.length === 0) return { conflicts, total };
  const tracks = await db.collection<
    { _id: RefId; displayName?: string | null; sourceRefs?: SourceRef[] }
  >(TRACKS)
    .find({ _id: { $in: trackIds } }, {
      projection: {
        displayName: 1,
        "sourceRefs.importId": 1,
        "sourceRefs.format": 1,
      },
    }).toArray();
  const trackById = new Map(tracks.map((track) => [String(track._id), track]));
  const importIds = [
    ...new Map(
      tracks.flatMap((track) =>
        (track.sourceRefs ?? []).map(({ importId }) =>
          [String(importId), importId] as const
        )
      ),
    ).values(),
  ];
  const imports = await db.collection<
    { _id: RefId; filename?: string; committedAt: Date }
  >(IMPORTS)
    .find({ _id: { $in: importIds }, committedAt: { $type: "date" } }, {
      projection: { filename: 1, committedAt: 1 },
      sort: { committedAt: 1, _id: 1 },
    }).toArray();
  const byImportId = new Map(
    imports.map((entry) => [String(entry._id), entry]),
  );
  return {
    conflicts: conflicts.map((conflict) => ({
      ...conflict,
      sources: (conflict.trackIds ?? []).map((id: RefId) => {
        const track = trackById.get(String(id));
        const source =
          (track?.sourceRefs ?? []).flatMap(({ importId, format }) => {
            const entry = byImportId.get(String(importId));
            return entry
              ? [{
                filename: entry.filename,
                importedAt: entry.committedAt,
                format,
              }]
              : [];
          }).sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime())[0];
        return { name: track?.displayName, ...source };
      }),
    })),
    total,
  };
}

export function reviewStatusQuery(status?: string) {
  if (status === "deferred") return { status: "pending", resolution: "defer" };
  if (status === "pending") {
    return { status, resolution: { $ne: "defer" } };
  }
  return status ? { status } : {};
}

export async function getRouteConflictPreview(
  db: Db,
  input: { id: string; gapDistanceM?: number; gapMinutes?: number },
) {
  const conflict = await db.collection<any>(LOCATION_ROUTE_CONFLICTS).findOne({
    _id: input.id,
  });
  if (!conflict) throw new Error("Route conflict not found");
  return await getMapRouteDetail(db, {
    start: conflict.overlapStart,
    end: conflict.overlapEnd,
    bounds: { west: -180, east: 180, south: -90, north: 90 },
    zoom: 10,
    includeConnectors: false,
    gapDistanceM: input.gapDistanceM,
    gapMinutes: input.gapMinutes,
    reviewTrackIds: conflict.trackIds,
  });
}

export async function resolveRouteConflict(
  db: Db,
  input: {
    id: string;
    resolution:
      | "use_first"
      | "use_second"
      | "keep_both"
      | "defer"
      | "resume"
      | "undo";
    expectedResolvedAt?: Date;
    principal: string;
  },
) {
  const undo = input.resolution === "undo";
  const defer = input.resolution === "defer";
  const resume = input.resolution === "resume";
  const pending = undo || defer || resume;
  const decision = {
    resolution: input.resolution,
    principal: input.principal,
    decidedAt: new Date(),
  };
  const result = await db.collection<any>(LOCATION_ROUTE_CONFLICTS).updateOne(
    {
      _id: input.id,
      ...(undo
        ? { status: "resolved", resolvedAt: input.expectedResolvedAt }
        : reviewStatusQuery(resume ? "deferred" : "pending")),
    },
    {
      $set: {
        status: pending ? "pending" : "resolved",
        ...(!pending || defer ? { resolution: input.resolution } : {}),
        ...(pending ? {} : { resolvedAt: decision.decidedAt }),
      },
      ...((undo || resume)
        ? { $unset: { resolution: "", resolvedAt: "" } }
        : {}),
      $push: { audit: decision } as never,
    },
  );
  if (!result.matchedCount) {
    return {
      success: false,
      error: "This route decision changed. Refresh and review it again.",
    };
  }
  await db.collection<RouteState>(LOCATION_ROUTE_STATE).updateOne(
    { _id: "current" },
    {
      $inc: { revision: 1 },
      $set: { decisionChangedAt: decision.decidedAt },
    },
  );
  return { success: true, decision };
}
