import type { Db } from "mongodb";
import {
  cellsForBounds,
  isCoordinateInBounds,
  MAP_CELL_ZOOMS,
  type MapBounds,
  type MapCell,
  mapCellForCoordinate,
  mapCellKey,
  type MapCellZoom,
  parseMapCellKey,
  selectMapCellZoom,
} from "./map-spatial.ts";

export const LOCATION_CONVERSATION_PROJECTION =
  "location_conversation_projection";
export const LOCATION_CONVERSATION_PENDING =
  "location_conversation_projection_pending";
export const LOCATION_CONVERSATION_STATE =
  "location_conversation_projection_state";

const SEGMENTS = "location_segments";
const POINTS = "location_points";
const OBJECTS = "objects";
const MAX_SUMMARY_CACHE_KEYS = 256;
const SUMMARY_CACHE_TTL_MS = 60_000;
const PROJECTION_BATCH = 1_000;

type GeoPoint = { type: "Point"; coordinates: [number, number] };

type LocationSegmentProjection = {
  _id: unknown;
  type: "manual" | "stay" | "move" | "gap";
  start: Date;
  end: Date;
  loc?: GeoPoint;
  place?: unknown;
};

type LocationPointProjection = {
  _id?: unknown;
  ts: Date;
  loc: GeoPoint;
};

type ConversationLike = {
  _id: unknown;
  isConversation?: boolean;
  name?: string;
  icon?: unknown;
  timeRanges?: Array<{ start?: Date; end?: Date }>;
  updatedAt?: Date;
};

export type ConversationProjectionRow = {
  _id: string;
  generation: string;
  conversationId: unknown;
  name?: string;
  icon?: unknown;
  start: Date;
  end: Date;
  anchorAt: Date;
  matched: boolean;
  matchKind: "manual" | "stay" | "move" | "unmatched";
  segmentId?: unknown;
  groupKey?: string;
  loc?: GeoPoint;
  place?: unknown;
  cellZ4?: string;
  cellZ7?: string;
  cellZ10?: string;
  cellZ13?: string;
  cellZ16?: string;
  cellZ19?: string;
  sourceUpdatedAt?: Date;
  projectedAt: Date;
};

type ProjectionState = {
  _id: "current";
  ready?: boolean;
  building?: boolean;
  stale?: boolean;
  status?: string;
  revision?: number;
  activeGeneration?: string;
  error?: string;
  progress?: { processed: number; total?: number };
};

export type ProjectionPublicState = {
  status: "building" | "ready" | "stale" | "failed" | "not-built";
  revision: number;
  stale: boolean;
  progress?: { processed: number; total?: number };
  error?: string;
};

export type MapDensityInput = {
  start: Date;
  end: Date;
  bounds: MapBounds;
  zoom: number;
  layers: Array<"presence" | "conversations">;
  maxClusters?: number;
  cacheScope?: string;
};

type SummaryCacheEntry = {
  expiresAt: number;
  value?: unknown;
  promise?: Promise<unknown>;
};

const summaryCache = new Map<string, SummaryCacheEntry>();

function projectionState(state: ProjectionState | null): ProjectionPublicState {
  const stale = state?.stale === true;
  return {
    status: state?.building && !state?.ready
      ? "building"
      : state?.status === "failed"
      ? "failed"
      : state?.ready
      ? stale ? "stale" : "ready"
      : "not-built",
    revision: Number(state?.revision ?? 0),
    stale,
    ...(state?.progress ? { progress: state.progress } : {}),
    ...(state?.error ? { error: state.error } : {}),
  };
}

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(value as never);
  return Number.isFinite(date.getTime()) ? date : null;
}

function canonicalConversationRange(
  conversation: ConversationLike,
): { start: Date; end: Date; anchorAt: Date } | null {
  const range = conversation.timeRanges?.[0];
  const start = validDate(range?.start);
  if (!start) return null;
  const parsedEnd = validDate(range?.end);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : start;
  return {
    start,
    end,
    anchorAt: new Date(start.getTime() + (end.getTime() - start.getTime()) / 2),
  };
}

function lowerBoundByTime<T>(
  values: T[],
  target: number,
  timeOf: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (timeOf(values[mid]) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function matchPriority(type: LocationSegmentProjection["type"]): number {
  return type === "manual" ? 3 : type === "stay" ? 2 : type === "move" ? 1 : 0;
}

export function selectCoveringLocationSegment(
  segments: LocationSegmentProjection[],
  anchorAt: Date,
): LocationSegmentProjection | null {
  const target = anchorAt.getTime();
  let selected: LocationSegmentProjection | null = null;
  for (const segment of segments) {
    const start = new Date(segment.start).getTime();
    if (start > target) break;
    const end = new Date(segment.end).getTime();
    if (end < target || segment.type === "gap") continue;
    if (
      !selected || matchPriority(segment.type) > matchPriority(selected.type)
    ) {
      selected = segment;
    }
  }
  return selected;
}

export function nearestPointInsideSegment(
  points: LocationPointProjection[],
  anchorAt: Date,
  segment: LocationSegmentProjection,
): LocationPointProjection | null {
  const start = new Date(segment.start).getTime();
  const end = new Date(segment.end).getTime();
  const target = anchorAt.getTime();
  const index = lowerBoundByTime(points, target, (point) => point.ts.getTime());
  let selected: LocationPointProjection | null = null;
  for (const candidateIndex of [index - 1, index]) {
    const point = points[candidateIndex];
    if (!point) continue;
    const timestamp = point.ts.getTime();
    if (timestamp < start || timestamp > end) continue;
    if (
      !selected ||
      Math.abs(timestamp - target) < Math.abs(selected.ts.getTime() - target)
    ) selected = point;
  }
  return selected;
}

export function projectConversation(
  conversation: ConversationLike,
  generation: string,
  segments: LocationSegmentProjection[],
  points: LocationPointProjection[],
  projectedAt = new Date(),
): ConversationProjectionRow | null {
  if (conversation.isConversation !== true) return null;
  const range = canonicalConversationRange(conversation);
  if (!range) return null;
  const segment = selectCoveringLocationSegment(segments, range.anchorAt);
  const point = segment?.type === "move"
    ? nearestPointInsideSegment(points, range.anchorAt, segment)
    : null;
  const loc = segment?.type === "move" ? point?.loc : segment?.loc;
  const matched = Boolean(segment && loc);
  const matchKind = matched
    ? segment!.type as "manual" | "stay" | "move"
    : "unmatched";
  const groupKey = !matched
    ? undefined
    : segment!.type === "move"
    ? `move:${String(segment!._id)}:${
      mapCellKey(mapCellForCoordinate(
        loc!.coordinates[1],
        loc!.coordinates[0],
        19,
      ))
    }`
    : `segment:${String(segment!._id)}`;
  const cells = loc
    ? Object.fromEntries(MAP_CELL_ZOOMS.map((zoom) => [
      `cellZ${zoom}`,
      mapCellKey(
        mapCellForCoordinate(loc.coordinates[1], loc.coordinates[0], zoom),
      ),
    ]))
    : {};
  return {
    _id: `${generation}:${String(conversation._id)}`,
    generation,
    conversationId: conversation._id,
    ...(conversation.name ? { name: conversation.name } : {}),
    ...(conversation.icon !== undefined ? { icon: conversation.icon } : {}),
    ...range,
    matched,
    matchKind,
    ...(segment ? { segmentId: segment._id } : {}),
    ...(groupKey ? { groupKey } : {}),
    ...(loc ? { loc } : {}),
    ...(segment?.place ? { place: segment.place } : {}),
    ...cells,
    ...(conversation.updatedAt
      ? { sourceUpdatedAt: conversation.updatedAt }
      : {}),
    projectedAt,
  };
}

function loadMatchingSegments(db: Db): Promise<LocationSegmentProjection[]> {
  return db.collection<LocationSegmentProjection>(SEGMENTS).find(
    { type: { $in: ["manual", "stay", "move", "gap"] } },
    {
      projection: { type: 1, start: 1, end: 1, loc: 1, place: 1 },
      sort: { start: 1, _id: 1 },
    },
  ).toArray();
}

async function loadNearestPoints(
  db: Db,
  anchorAt: Date,
  segment: LocationSegmentProjection,
): Promise<LocationPointProjection[]> {
  const points = db.collection(POINTS);
  const filter = { selection: "accepted", visible: true };
  const projection = { ts: 1, loc: 1 };
  const [before, after] = await Promise.all([
    points.findOne<LocationPointProjection>(
      { ...filter, ts: { $gte: segment.start, $lt: anchorAt } },
      { projection, sort: { ts: -1, _id: -1 } },
    ),
    points.findOne<LocationPointProjection>(
      { ...filter, ts: { $gte: anchorAt, $lte: segment.end } },
      { projection, sort: { ts: 1, _id: 1 } },
    ),
  ]);
  return [before, after].filter((point) => point !== null);
}

async function projectPendingConversation(
  db: Db,
  conversation: ConversationLike,
  generation: string,
  segments: LocationSegmentProjection[],
): Promise<ConversationProjectionRow | null> {
  if (conversation.isConversation !== true) return null;
  const range = canonicalConversationRange(conversation);
  if (!range) return null;
  const segment = selectCoveringLocationSegment(segments, range.anchorAt);
  const points = segment?.type === "move"
    ? await loadNearestPoints(db, range.anchorAt, segment)
    : [];
  return projectConversation(
    conversation,
    generation,
    segment ? [segment] : [],
    points,
  );
}

export async function rebuildLocationConversationProjection(
  db: Db,
  options: {
    onProgress?: (
      progress: { processed: number; total?: number },
    ) => Promise<void> | void;
  } = {},
): Promise<{ generation: string; revision: number; processed: number }> {
  const generation = crypto.randomUUID();
  const buildStartedAt = new Date();
  const states = db.collection<ProjectionState>(LOCATION_CONVERSATION_STATE);
  const projections = db.collection<ConversationProjectionRow>(
    LOCATION_CONVERSATION_PROJECTION,
  );
  await states.updateOne(
    { _id: "current" },
    {
      $set: {
        building: true,
        stale: true,
        status: "building",
        buildGeneration: generation,
        buildStartedAt,
        progress: { processed: 0 },
      },
      $unset: { error: "" },
    },
    { upsert: true },
  );
  summaryCache.clear();
  try {
    const [segments, points] = await Promise.all([
      loadMatchingSegments(db),
      db.collection<LocationPointProjection>(POINTS).find(
        { selection: "accepted", visible: true } as never,
        { projection: { ts: 1, loc: 1 }, sort: { ts: 1, _id: 1 } },
      ).toArray(),
    ]);
    const total = await db.collection(OBJECTS).countDocuments({
      isConversation: true,
      "timeRanges.0.start": { $type: "date" },
    });
    const cursor = db.collection<ConversationLike>(OBJECTS).find(
      { isConversation: true, "timeRanges.0.start": { $type: "date" } },
      {
        projection: {
          name: 1,
          icon: 1,
          isConversation: 1,
          timeRanges: 1,
          updatedAt: 1,
        },
        sort: { "timeRanges.0.start": 1, _id: 1 },
        batchSize: PROJECTION_BATCH,
      },
    );
    let processed = 0;
    let operations: never[] = [];
    for await (const conversation of cursor) {
      const row = projectConversation(
        conversation,
        generation,
        segments,
        points,
      );
      if (row) {
        operations.push({
          replaceOne: {
            filter: { _id: row._id },
            replacement: row,
            upsert: true,
          },
        } as never);
      }
      processed++;
      if (operations.length >= PROJECTION_BATCH) {
        await projections.bulkWrite(operations, { ordered: false });
        operations = [];
        const progress = { processed, total };
        await states.updateOne(
          { _id: "current", buildGeneration: generation } as never,
          { $set: { progress } },
        );
        await options.onProgress?.(progress);
      }
    }
    if (operations.length > 0) {
      await projections.bulkWrite(operations, { ordered: false });
    }
    const state = await states.findOne({ _id: "current" });
    const revision = Number(state?.revision ?? 0) + 1;
    const swapped = await states.updateOne(
      { _id: "current", buildGeneration: generation } as never,
      {
        $set: {
          activeGeneration: generation,
          revision,
          ready: true,
          building: false,
          stale: false,
          status: "ready",
          calculatedAt: new Date(),
          progress: { processed, total },
        },
        $unset: { buildGeneration: "", error: "" },
      },
    );
    if (swapped.modifiedCount !== 1) {
      throw new Error("Conversation map generation changed before publish");
    }
    await projections.deleteMany({ generation: { $ne: generation } });
    const pending = db.collection(LOCATION_CONVERSATION_PENDING);
    await pending.deleteMany({ queuedAt: { $lte: buildStartedAt } });
    if (await pending.findOne({}, { projection: { _id: 1 } })) {
      await states.updateOne(
        { _id: "current", activeGeneration: generation } as never,
        { $set: { stale: true, status: "stale" } },
      );
    }
    summaryCache.clear();
    return { generation, revision, processed };
  } catch (error) {
    await states.updateOne(
      { _id: "current", buildGeneration: generation } as never,
      {
        $set: {
          building: false,
          stale: true,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        $unset: { buildGeneration: "" },
      },
    );
    await projections.deleteMany({ generation });
    throw error;
  }
}

export function shouldQueueConversationProjectionChange(
  operationType: string,
  changedFields: string[] = [],
): boolean {
  if (["insert", "replace", "delete"].includes(operationType)) return true;
  if (operationType !== "update") return false;
  const roots = new Set(["isConversation", "timeRanges", "name", "icon"]);
  return changedFields.some((field) => roots.has(field.split(".", 1)[0]));
}

export async function enqueueConversationProjectionChange(
  db: Db,
  input: { kind: "object" | "segments"; documentId?: unknown },
): Promise<void> {
  const id = input.kind === "segments"
    ? "segments:changed"
    : `object:${String(input.documentId ?? "unknown")}`;
  await db.collection<any>(LOCATION_CONVERSATION_PENDING).updateOne(
    { _id: id },
    {
      $set: {
        kind: input.kind,
        ...(input.documentId !== undefined
          ? { documentId: input.documentId }
          : {}),
        queuedAt: new Date(),
      },
    },
    { upsert: true },
  );
  await db.collection<ProjectionState>(LOCATION_CONVERSATION_STATE).updateOne(
    { _id: "current" },
    { $set: { stale: true } },
    { upsert: true },
  );
  summaryCache.clear();
}

export async function drainConversationProjectionPending(
  db: Db,
): Promise<{ processed: number; rebuilt: boolean; ready: boolean }> {
  const pending = await db.collection(LOCATION_CONVERSATION_PENDING).find(
    {},
    { sort: { queuedAt: 1 }, limit: 500 },
  ).toArray();
  if (pending.length === 0) {
    const state = await db.collection<ProjectionState>(
      LOCATION_CONVERSATION_STATE,
    ).findOne({ _id: "current" });
    return { processed: 0, rebuilt: false, ready: state?.ready === true };
  }
  const state = await db.collection<ProjectionState>(
    LOCATION_CONVERSATION_STATE,
  ).findOne({ _id: "current" });
  if (!state?.ready) {
    return { processed: 0, rebuilt: false, ready: false };
  }
  if (pending.some((row) => row.kind === "segments")) {
    const result = await rebuildLocationConversationProjection(db);
    return { processed: result.processed, rebuilt: true, ready: true };
  }

  const ids = pending.map((row) => row.documentId).filter((id) => id != null);
  const conversations = ids.length === 0
    ? []
    : await db.collection<ConversationLike>(
      OBJECTS,
    ).find(
      { _id: { $in: ids } } as never,
      {
        projection: {
          name: 1,
          icon: 1,
          isConversation: 1,
          timeRanges: 1,
          updatedAt: 1,
        },
      },
    ).toArray();
  const byId = new Map(conversations.map((row) => [String(row._id), row]));
  const segments = conversations.length ? await loadMatchingSegments(db) : [];
  const generation = state.activeGeneration!;
  const operations: never[] = [];
  for (const id of ids) {
    const conversation = byId.get(String(id));
    const row = conversation
      ? await projectPendingConversation(
        db,
        conversation,
        generation,
        segments,
      )
      : null;
    operations.push(
      row
        ? {
          replaceOne: {
            filter: { generation, conversationId: id },
            replacement: row,
            upsert: true,
          },
        } as never
        : {
          deleteOne: { filter: { generation, conversationId: id } },
        } as never,
    );
  }
  if (operations.length > 0) {
    await db.collection(LOCATION_CONVERSATION_PROJECTION).bulkWrite(
      operations,
      { ordered: false },
    );
  }
  await db.collection(LOCATION_CONVERSATION_PENDING).deleteMany({
    $or: pending.map((row) => ({ _id: row._id, queuedAt: row.queuedAt })),
  });
  const hasNewerPending = Boolean(
    await db.collection(LOCATION_CONVERSATION_PENDING).findOne({}, {
      projection: { _id: 1 },
    }),
  );
  await db.collection<ProjectionState>(LOCATION_CONVERSATION_STATE).updateOne(
    { _id: "current", activeGeneration: generation } as never,
    {
      $inc: { revision: 1 },
      $set: {
        stale: hasNewerPending,
        status: hasNewerPending ? "stale" : "ready",
        calculatedAt: new Date(),
      },
    },
  );
  summaryCache.clear();
  return { processed: ids.length, rebuilt: false, ready: true };
}

function clampMaxClusters(value: number | undefined): number {
  return Math.min(2_000, Math.max(1, value ?? 1_200));
}

function nextCoarserZoom(current: MapCellZoom): MapCellZoom | null {
  const index = MAP_CELL_ZOOMS.indexOf(current);
  return index > 0 ? MAP_CELL_ZOOMS[index - 1] : null;
}

async function conversationClusters(
  db: Db,
  state: ProjectionState,
  input: MapDensityInput,
  requestedZoom: MapCellZoom,
): Promise<
  {
    clusters: any[];
    effectiveCellZoom: MapCellZoom;
    coarsened: boolean;
    matched: number;
    unmatched: number;
  }
> {
  if (!state.ready || !state.activeGeneration) {
    return {
      clusters: [],
      effectiveCellZoom: requestedZoom,
      coarsened: false,
      matched: 0,
      unmatched: 0,
    };
  }
  const maxClusters = clampMaxClusters(input.maxClusters);
  let effectiveCellZoom = requestedZoom;
  let coarsened = false;
  while (true) {
    const cellField = `cellZ${effectiveCellZoom}`;
    const allowedCells = cellsForBounds(input.bounds, effectiveCellZoom);
    const match: Record<string, unknown> = {
      generation: state.activeGeneration,
      matched: true,
      anchorAt: { $gte: input.start, $lte: input.end },
      ...(allowedCells ? { [cellField]: { $in: allowedCells } } : {}),
    };
    const rows = await db.collection<ConversationProjectionRow>(
      LOCATION_CONVERSATION_PROJECTION,
    ).find(match, {
      projection: {
        [cellField]: 1,
        loc: 1,
        groupKey: 1,
      },
      maxTimeMS: 2_000,
    }).toArray();
    const groups = new Map<string, {
      id: string;
      cell: MapCell;
      count: number;
      latTotal: number;
      lngTotal: number;
      west: number;
      east: number;
      south: number;
      north: number;
      minGroup?: string;
      maxGroup?: string;
    }>();
    let matched = 0;
    for (const row of rows) {
      if (!row.loc) continue;
      const [lng, lat] = row.loc.coordinates;
      if (!isCoordinateInBounds(lat, lng, input.bounds)) continue;
      matched++;
      const key = String((row as any)[cellField] ?? "");
      const cell = parseMapCellKey(key);
      if (!cell) continue;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: `conversation:${key}`,
          cell,
          count: 0,
          latTotal: 0,
          lngTotal: 0,
          west: lng,
          east: lng,
          south: lat,
          north: lat,
        };
        groups.set(key, group);
      }
      group.count++;
      group.latTotal += lat;
      group.lngTotal += lng;
      group.west = Math.min(group.west, lng);
      group.east = Math.max(group.east, lng);
      group.south = Math.min(group.south, lat);
      group.north = Math.max(group.north, lat);
      if (row.groupKey) {
        group.minGroup = !group.minGroup || row.groupKey < group.minGroup
          ? row.groupKey
          : group.minGroup;
        group.maxGroup = !group.maxGroup || row.groupKey > group.maxGroup
          ? row.groupKey
          : group.maxGroup;
      }
    }
    if (groups.size <= maxClusters || !nextCoarserZoom(effectiveCellZoom)) {
      const unmatched = await db.collection(LOCATION_CONVERSATION_PROJECTION)
        .countDocuments({
          generation: state.activeGeneration,
          matched: false,
          anchorAt: { $gte: input.start, $lte: input.end },
        }, { maxTimeMS: 2_000 });
      return {
        effectiveCellZoom,
        coarsened,
        matched,
        unmatched,
        clusters: [...groups.values()].map((group) => ({
          id: group.id,
          cell: group.cell,
          center: [group.lngTotal / group.count, group.latTotal / group.count],
          bounds: {
            west: group.west,
            east: group.east,
            south: group.south,
            north: group.north,
          },
          conversationCount: group.count,
          ...(group.minGroup && group.minGroup === group.maxGroup
            ? { singleGroupKey: group.minGroup }
            : {}),
        })),
      };
    }
    effectiveCellZoom = nextCoarserZoom(effectiveCellZoom)!;
    coarsened = true;
  }
}

function presenceClusters(
  rows: LocationSegmentProjection[],
  input: MapDensityInput,
  zoom: MapCellZoom,
): any[] {
  const groups = new Map<string, any>();
  for (const segment of rows) {
    if (!segment.loc) continue;
    const [lng, lat] = segment.loc.coordinates;
    if (!isCoordinateInBounds(lat, lng, input.bounds)) continue;
    const overlapStart = Math.max(
      input.start.getTime(),
      new Date(segment.start).getTime(),
    );
    const overlapEnd = Math.min(
      input.end.getTime(),
      new Date(segment.end).getTime(),
    );
    if (overlapEnd <= overlapStart) continue;
    const cell = mapCellForCoordinate(lat, lng, zoom);
    const key = mapCellKey(cell);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: `presence:${key}`,
        cell,
        dwellMs: 0,
        visitCount: 0,
        latTotal: 0,
        lngTotal: 0,
      };
      groups.set(key, group);
    }
    group.dwellMs += overlapEnd - overlapStart;
    group.visitCount++;
    group.latTotal += lat;
    group.lngTotal += lng;
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    cell: group.cell,
    center: [
      group.lngTotal / group.visitCount,
      group.latTotal / group.visitCount,
    ],
    dwellMs: group.dwellMs,
    visitCount: group.visitCount,
  }));
}

function cacheKey(input: MapDensityInput, revision: number): string {
  return JSON.stringify({
    scope: input.cacheScope ?? "default",
    revision,
    start: input.start.getTime(),
    end: input.end.getTime(),
    bounds: input.bounds,
    zoom: Math.round(input.zoom * 10) / 10,
    layers: [...input.layers].sort(),
    maxClusters: clampMaxClusters(input.maxClusters),
  });
}

async function cachedSummary<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = summaryCache.get(key);
  if (existing?.value !== undefined && existing.expiresAt > now) {
    return existing.value as T;
  }
  if (existing?.promise) return await existing.promise as T;
  const promise = load().then((value) => {
    summaryCache.delete(key);
    summaryCache.set(key, {
      value,
      expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
    });
    while (summaryCache.size > MAX_SUMMARY_CACHE_KEYS) {
      summaryCache.delete(summaryCache.keys().next().value!);
    }
    return value;
  }).catch((error) => {
    summaryCache.delete(key);
    throw error;
  });
  summaryCache.set(key, { expiresAt: now + SUMMARY_CACHE_TTL_MS, promise });
  return await promise;
}

export async function getMapDensity(db: Db, input: MapDensityInput) {
  const state = await db.collection<ProjectionState>(
    LOCATION_CONVERSATION_STATE,
  ).findOne({ _id: "current" }, { maxTimeMS: 1_000 });
  const revision = Number(state?.revision ?? 0);
  return await cachedSummary(cacheKey(input, revision), async () => {
    const requestedCellZoom = selectMapCellZoom(input.zoom);
    const stays = input.layers.includes("presence")
      ? await db.collection<LocationSegmentProjection>(SEGMENTS).find(
        {
          type: { $in: ["stay", "manual"] },
          start: { $lt: input.end },
          end: { $gt: input.start },
          loc: { $exists: true },
        },
        { projection: { type: 1, start: 1, end: 1, loc: 1 } },
      ).toArray()
      : [];
    const maxClusters = clampMaxClusters(input.maxClusters);
    let effectiveCellZoom = requestedCellZoom;
    let coarsened = false;
    let conversations: Awaited<ReturnType<typeof conversationClusters>>;
    let presence: any[];
    while (true) {
      conversations = input.layers.includes("conversations")
        ? await conversationClusters(
          db,
          state ?? { _id: "current" },
          input,
          effectiveCellZoom,
        )
        : {
          clusters: [],
          effectiveCellZoom,
          coarsened: false,
          matched: 0,
          unmatched: 0,
        };
      if (conversations.effectiveCellZoom !== effectiveCellZoom) {
        coarsened = true;
        effectiveCellZoom = conversations.effectiveCellZoom;
      }
      presence = presenceClusters(stays, input, effectiveCellZoom);
      if (
        presence.length + conversations.clusters.length <= maxClusters
      ) break;
      const next = nextCoarserZoom(effectiveCellZoom);
      if (!next) break;
      effectiveCellZoom = next;
      coarsened = true;
    }
    return {
      projection: projectionState(state),
      effectiveCellZoom,
      coarsened: coarsened || conversations.coarsened,
      presenceClusters: presence,
      conversationClusters: conversations.clusters,
      totals: {
        matchedConversations: conversations.matched,
        unmatchedConversations: conversations.unmatched,
        stays: stays.length,
      },
    };
  });
}

function encodeCursor(values: Record<string, string | number>): string {
  return btoa(JSON.stringify(values)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string | undefined): Record<string, any> | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(normalized));
  } catch {
    return null;
  }
}

async function requireProjectionState(db: Db, revision?: number) {
  const state = await db.collection<ProjectionState>(
    LOCATION_CONVERSATION_STATE,
  ).findOne({ _id: "current" });
  if (!state?.ready || !state.activeGeneration) {
    return {
      error: "projection_not_ready",
      projection: projectionState(state),
    } as const;
  }
  if (revision !== undefined && revision !== Number(state.revision ?? 0)) {
    return {
      error: "projection_changed",
      projection: projectionState(state),
    } as const;
  }
  return { state } as const;
}

export async function getConversationMapClusterGroups(
  db: Db,
  input: {
    start: Date;
    end: Date;
    cell: MapCell;
    revision?: number;
    cursor?: string;
    limit: number;
  },
) {
  const checked = await requireProjectionState(db, input.revision);
  if ("error" in checked) return checked;
  const { state } = checked;
  const field = `cellZ${input.cell.z}`;
  const key = mapCellKey(input.cell);
  const rows = await db.collection<ConversationProjectionRow>(
    LOCATION_CONVERSATION_PROJECTION,
  ).find({
    generation: state.activeGeneration,
    matched: true,
    anchorAt: { $gte: input.start, $lte: input.end },
    [field]: key,
  }, { projection: { groupKey: 1, loc: 1, place: 1 } }).toArray();
  const grouped = new Map<string, any>();
  for (const row of rows) {
    if (!row.groupKey) continue;
    const current = grouped.get(row.groupKey) ?? {
      groupKey: row.groupKey,
      conversationCount: 0,
      loc: row.loc,
      place: row.place ?? null,
    };
    current.conversationCount++;
    grouped.set(row.groupKey, current);
  }
  const sorted = [...grouped.values()].sort((left, right) =>
    right.conversationCount - left.conversationCount ||
    left.groupKey.localeCompare(right.groupKey)
  );
  const cursor = decodeCursor(input.cursor);
  const startIndex = cursor
    ? sorted.findIndex((row) => row.groupKey === cursor.groupKey) + 1
    : 0;
  const items = sorted.slice(
    Math.max(0, startIndex),
    Math.max(0, startIndex) + input.limit,
  );
  return {
    projection: projectionState(state),
    total: sorted.length,
    items,
    nextCursor: startIndex + items.length < sorted.length && items.length > 0
      ? encodeCursor({ groupKey: items.at(-1).groupKey })
      : null,
  };
}

export async function getConversationMapGroupItems(
  db: Db,
  input: {
    start: Date;
    end: Date;
    groupKey: string;
    revision?: number;
    cursor?: string;
    limit: number;
  },
) {
  const checked = await requireProjectionState(db, input.revision);
  if ("error" in checked) return checked;
  const { state } = checked;
  const cursor = decodeCursor(input.cursor);
  const pageQuery = cursor
    ? {
      $or: [
        { anchorAt: { $lt: new Date(Number(cursor.anchorAt)) } },
        {
          anchorAt: new Date(Number(cursor.anchorAt)),
          _id: { $lt: cursor.rowId },
        },
      ],
    }
    : {};
  const base = {
    generation: state.activeGeneration,
    groupKey: input.groupKey,
    anchorAt: { $gte: input.start, $lte: input.end },
  };
  const [total, rows] = await Promise.all([
    db.collection(LOCATION_CONVERSATION_PROJECTION).countDocuments(base),
    db.collection<ConversationProjectionRow>(LOCATION_CONVERSATION_PROJECTION)
      .find({ ...base, ...pageQuery } as never, {
        sort: { anchorAt: -1, _id: -1 },
        limit: input.limit + 1,
        projection: {
          conversationId: 1,
          name: 1,
          icon: 1,
          start: 1,
          end: 1,
          loc: 1,
          matchKind: 1,
          anchorAt: 1,
        },
      }).toArray(),
  ]);
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return {
    projection: projectionState(state),
    total,
    items,
    nextCursor: hasMore && last
      ? encodeCursor({
        anchorAt: last.anchorAt.getTime(),
        rowId: String(last._id),
      })
      : null,
  };
}

export async function getMapTimelineSummary(
  db: Db,
  input: { start?: Date; end?: Date; maxBuckets: number },
) {
  const state = await db.collection<ProjectionState>(
    LOCATION_CONVERSATION_STATE,
  ).findOne({ _id: "current" });
  const [firstSegment, lastSegment] = await Promise.all([
    db.collection<LocationSegmentProjection>(SEGMENTS).findOne({}, {
      sort: { start: 1 },
      projection: { start: 1 },
    }),
    db.collection<LocationSegmentProjection>(SEGMENTS).findOne({}, {
      sort: { end: -1 },
      projection: { end: 1 },
    }),
  ]);
  const dataStart = firstSegment?.start
    ? new Date(firstSegment.start)
    : input.start ?? new Date();
  const dataEnd = lastSegment?.end
    ? new Date(lastSegment.end)
    : input.end ?? dataStart;
  const start = input.start ?? dataStart;
  const end = input.end ?? dataEnd;
  const count = Math.min(512, Math.max(1, input.maxBuckets));
  const bucketMs = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / count),
  );
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: new Date(start.getTime() + index * bucketMs),
    end: new Date(
      Math.min(end.getTime(), start.getTime() + (index + 1) * bucketMs),
    ),
    dwellMs: 0,
    stayCount: 0,
    conversationCount: 0,
  }));
  const stays = await db.collection<LocationSegmentProjection>(SEGMENTS).find({
    type: { $in: ["stay", "manual"] },
    start: { $lt: end },
    end: { $gt: start },
  }, { projection: { start: 1, end: 1 } }).toArray();
  for (const stay of stays) {
    const from = Math.max(start.getTime(), new Date(stay.start).getTime());
    const to = Math.min(end.getTime(), new Date(stay.end).getTime());
    for (
      let index = Math.floor((from - start.getTime()) / bucketMs);
      index <= Math.floor((to - start.getTime()) / bucketMs);
      index++
    ) {
      const bucket = buckets[index];
      if (!bucket) continue;
      const overlap = Math.max(
        0,
        Math.min(to, bucket.end.getTime()) -
          Math.max(from, bucket.start.getTime()),
      );
      if (overlap > 0) {
        bucket.dwellMs += overlap;
        bucket.stayCount++;
      }
    }
  }
  if (state?.ready && state.activeGeneration) {
    const rows = await db.collection<ConversationProjectionRow>(
      LOCATION_CONVERSATION_PROJECTION,
    )
      .find({
        generation: state.activeGeneration,
        anchorAt: { $gte: start, $lte: end },
      }, { projection: { anchorAt: 1 } })
      .toArray();
    for (const row of rows) {
      const index = Math.min(
        count - 1,
        Math.max(
          0,
          Math.floor((row.anchorAt.getTime() - start.getTime()) / bucketMs),
        ),
      );
      buckets[index].conversationCount++;
    }
  }
  return {
    dataRange: { start: dataStart, end: dataEnd },
    range: { start, end },
    bucketMs,
    buckets,
    projection: projectionState(state),
  };
}
