import type { Job } from "bullmq";
import { z } from "zod";
import type { JobData, JobResult } from "@/lib/jobs/types.ts";
import { env } from "#/env.ts";
import { callResource } from "@myceliasdk/resources.ts";
import { zDateOrString } from "@myceliasdk/zod-json-schema.ts";
import { getTriggerTiming } from "@/lib/jobs/trigger-config.ts";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import { hasIndexedPendingWork } from "@/lib/jobs/pending-work.ts";

export const schema = z.object({
  type: z.literal("location_processing"),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
});

const name = "location_processing";
export const locationPendingImportQuery = { status: "parsed" } as const;

/** Points within this radius of the running centroid belong to one stay. */
const STAY_RADIUS_M = 200;
/** Minimum dwell time for a cluster to count as a stay. */
const MIN_STAY_MS = 10 * 60 * 1000;
/** Silence longer than this splits the track and becomes a "gap" segment. */
const GAP_MS = 30 * 60 * 1000;
/** Douglas-Peucker tolerance for stored move paths. */
const MOVE_SIMPLIFY_M = 25;
/** Window padding so segments spanning an import boundary get rebuilt. */
const WINDOW_PAD_MS = 6 * 60 * 60 * 1000;
const POINT_BATCH = 10000;

export interface TrackPoint {
  ts: Date;
  lat: number;
  lng: number;
  /** Source import this point came from (provenance). */
  importId?: unknown;
  /** All source imports for a deduplicated canonical point. */
  importIds?: unknown[];
}

export interface Segment {
  type: "stay" | "move" | "gap";
  start: Date;
  end: Date;
  loc?: { type: "Point"; coordinates: [number, number] };
  radiusM?: number;
  path?: [number, number][];
  distanceM?: number;
  assumed?: boolean;
  /** Imports whose points contributed to this segment. */
  importIds?: unknown[];
}

/** Unique import ids of the given points, order-stable. */
function importIdsOf(points: TrackPoint[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const p of points) {
    for (const importId of p.importIds ?? []) {
      if (importId != null) seen.set(String(importId), importId);
    }
    if (p.importId != null) seen.set(String(p.importId), p.importId);
  }
  return [...seen.values()];
}

const EARTH_RADIUS_M = 6371000;

export function haversineM(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

function centroid(points: TrackPoint[]): { lat: number; lng: number } {
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

function pathDistanceM(points: TrackPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineM(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng,
    );
  }
  return total;
}

async function simplifyPath(
  points: TrackPoint[],
): Promise<[number, number][]> {
  if (points.length <= 2) {
    return points.map((p) => [p.lng, p.lat]);
  }
  const { default: simplify } = await import("simplify-js");
  const lat0 = points[0].lat * Math.PI / 180;
  const scaleX = Math.cos(lat0);
  const toleranceDeg = MOVE_SIMPLIFY_M / 111320;
  const projected = points.map((p) => ({ x: p.lng * scaleX, y: p.lat }));
  const simplified = simplify(projected, toleranceDeg, true);
  return simplified.map((pt: { x: number; y: number }) =>
    [pt.x / scaleX, pt.y] as [number, number]
  );
}

/**
 * Split a sorted point run (no internal gaps) into alternating stays and
 * moves using sequential stay-point detection.
 */
async function segmentSession(points: TrackPoint[]): Promise<Segment[]> {
  const segments: Segment[] = [];
  let movePts: TrackPoint[] = [];

  const flushMove = async (connectTo?: TrackPoint) => {
    const pts = connectTo ? [...movePts, connectTo] : movePts;
    movePts = [];
    if (pts.length < 2) return;
    const distanceM = pathDistanceM(pts);
    if (distanceM < 50) return; // GPS jitter, not an actual move
    segments.push({
      type: "move",
      start: pts[0].ts,
      end: pts[pts.length - 1].ts,
      path: await simplifyPath(pts),
      distanceM: Math.round(distanceM),
      importIds: importIdsOf(pts),
    });
  };

  let i = 0;
  while (i < points.length) {
    const cluster: TrackPoint[] = [points[i]];
    let center = { lat: points[i].lat, lng: points[i].lng };
    let k = i + 1;
    while (k < points.length) {
      const p = points[k];
      if (haversineM(center.lat, center.lng, p.lat, p.lng) > STAY_RADIUS_M) {
        break;
      }
      cluster.push(p);
      center = centroid(cluster);
      k++;
    }

    const dwellMs = cluster[cluster.length - 1].ts.getTime() -
      cluster[0].ts.getTime();
    if (dwellMs >= MIN_STAY_MS) {
      await flushMove(cluster[0]);
      let radiusM = 30;
      for (const p of cluster) {
        radiusM = Math.max(
          radiusM,
          haversineM(center.lat, center.lng, p.lat, p.lng),
        );
      }
      segments.push({
        type: "stay",
        start: cluster[0].ts,
        end: cluster[cluster.length - 1].ts,
        loc: { type: "Point", coordinates: [center.lng, center.lat] },
        radiusM: Math.round(radiusM),
        importIds: importIdsOf(cluster),
      });
      movePts = [cluster[cluster.length - 1]];
      i = k;
    } else {
      movePts.push(points[i]);
      i++;
    }
  }
  await flushMove();
  return segments;
}

/** Split sorted points into gap-free sessions and connect them with gaps. */
export async function segmentPoints(points: TrackPoint[]): Promise<Segment[]> {
  if (points.length === 0) return [];
  const sessions: TrackPoint[][] = [];
  let current: TrackPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].ts.getTime() - points[i - 1].ts.getTime() > GAP_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  sessions.push(current);

  const segments: Segment[] = [];
  for (let s = 0; s < sessions.length; s++) {
    if (s > 0) {
      const prev = sessions[s - 1][sessions[s - 1].length - 1];
      const next = sessions[s][0];
      segments.push({
        type: "gap",
        start: prev.ts,
        end: next.ts,
        path: [[prev.lng, prev.lat], [next.lng, next.lat]],
        distanceM: Math.round(
          haversineM(prev.lat, prev.lng, next.lat, next.lng),
        ),
        assumed: true,
        importIds: importIdsOf([prev, next]),
      });
    }
    segments.push(...await segmentSession(sessions[s]));
  }
  segments.sort((a, b) => a.start.getTime() - b.start.getTime());
  return segments;
}

interface Interval {
  start: Date;
  end: Date;
}

/** Subtract blocked intervals from one interval; returns the remainder. */
export function subtractIntervals(
  interval: Interval,
  blocked: Interval[],
): Interval[] {
  let remaining: Interval[] = [{ ...interval }];
  for (const block of blocked) {
    const next: Interval[] = [];
    for (const part of remaining) {
      if (
        block.end.getTime() <= part.start.getTime() ||
        block.start.getTime() >= part.end.getTime()
      ) {
        next.push(part);
        continue;
      }
      if (block.start.getTime() > part.start.getTime()) {
        next.push({ start: part.start, end: block.start });
      }
      if (block.end.getTime() < part.end.getTime()) {
        next.push({ start: block.end, end: part.end });
      }
    }
    remaining = next;
  }
  return remaining;
}

type MongoCall = (input: any) => Promise<any>;

export async function loadPoints(
  mongo: MongoCall,
  start: Date,
  end: Date,
): Promise<TrackPoint[]> {
  const points: TrackPoint[] = [];
  let cursorTs = new Date(start.getTime() - 1);
  let cursorId: unknown = null;
  while (true) {
    const cursorQuery = cursorId == null
      ? { ts: { $gt: cursorTs, $lte: end } }
      : {
        $and: [
          { ts: { $lte: end } },
          {
            $or: [
              { ts: { $gt: cursorTs } },
              { ts: cursorTs, _id: { $gt: cursorId } },
            ],
          },
        ],
      };
    const batch = await mongo({
      action: "find",
      collection: "location_points",
      query: {
        ...cursorQuery,
        visible: true,
        selection: "accepted",
      },
      options: {
        sort: { ts: 1, _id: 1 },
        limit: POINT_BATCH,
        projection: { ts: 1, loc: 1, importId: 1, importIds: 1 },
      },
    });
    for (const doc of batch) {
      points.push({
        ts: new Date(doc.ts),
        lng: doc.loc.coordinates[0],
        lat: doc.loc.coordinates[1],
        importId: doc.importId,
        importIds: doc.importIds,
      });
    }
    if (batch.length < POINT_BATCH) break;
    cursorTs = new Date(batch[batch.length - 1].ts);
    cursorId = batch[batch.length - 1]._id;
  }
  return points;
}

export interface Place {
  name: string;
  city: string;
  country: string;
  countryCode: string;
  geonameId: number;
  admin1?: string;
}

export async function reverseGeocode(
  mongo: MongoCall,
  lng: number,
  lat: number,
): Promise<{ place: Place | null }> {
  const candidates = await mongo({
    action: "aggregate",
    collection: "geonames_cities",
    pipeline: [
      {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distM",
          maxDistance: 50000,
          spherical: true,
        },
      },
      { $limit: 10 },
    ],
  });
  if (!candidates || candidates.length === 0) return { place: null };
  // Prefer a bigger city when it is nearly as close as a hamlet.
  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = (c.distM + 500) /
      Math.max(1, Math.log10((c.population ?? 0) + 10));
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return {
    place: {
      name: best.name,
      city: best.name,
      country: best.country,
      countryCode: best.countryCode,
      geonameId: best.geonameId,
      ...(best.admin1 ? { admin1: best.admin1 } : {}),
    },
  };
}

async function upsertTimezonePeriods(
  mongo: MongoCall,
  tzLookup: (lat: number, lng: number) => string,
  segments: Segment[],
  winStart: Date,
  winEnd: Date,
): Promise<number> {
  const located = segments.filter((s) => s.type === "stay" && s.loc);
  if (located.length === 0) return 0;

  const runs: Array<{ timeZone: string; start: Date; end: Date }> = [];
  for (const stay of located) {
    const [lng, lat] = stay.loc!.coordinates;
    let timeZone: string;
    try {
      timeZone = tzLookup(lat, lng);
    } catch {
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.timeZone === timeZone) {
      last.end = stay.end;
    } else {
      if (last) last.end = stay.start; // previous zone lasts until arrival
      runs.push({ timeZone, start: stay.start, end: stay.end });
    }
  }

  const manualPeriods: Interval[] = await mongo({
    action: "find",
    collection: "timeline_timezone_periods",
    query: {
      source: "manual",
      start: { $lt: winEnd },
      end: { $gt: winStart },
    },
    options: { projection: { start: 1, end: 1 } },
  }).then((docs: any[]) =>
    docs.map((d) => ({ start: new Date(d.start), end: new Date(d.end) }))
  );

  await mongo({
    action: "deleteMany",
    collection: "timeline_timezone_periods",
    query: {
      source: "import",
      start: { $lt: winEnd },
      end: { $gt: winStart },
    },
  });

  const now = new Date();
  const docs: any[] = [];
  for (const run of runs) {
    for (const part of subtractIntervals(run, manualPeriods)) {
      if (part.end.getTime() - part.start.getTime() < 5 * 60 * 1000) continue;
      docs.push({
        start: part.start,
        end: part.end,
        timeZone: run.timeZone,
        source: "import",
        metadata: { origin: "location-worker" },
        createdAt: now,
        updatedAt: now,
        createdBy: "location_processing",
      });
    }
  }
  if (docs.length > 0) {
    await mongo({
      action: "insertMany",
      collection: "timeline_timezone_periods",
      docs,
    });
  }
  return docs.length;
}

async function processWindow(
  mongo: MongoCall,
  tzLookup: (lat: number, lng: number) => string,
  geonamesReady: boolean,
  winStart: Date,
  winEnd: Date,
): Promise<{ segments: number; tzPeriods: number }> {
  const points = await loadPoints(mongo, winStart, winEnd);
  const segments = await segmentPoints(points);

  const manualSegments: Interval[] = await mongo({
    action: "find",
    collection: "location_segments",
    query: {
      type: "manual",
      start: { $lt: winEnd },
      end: { $gt: winStart },
    },
    options: { projection: { start: 1, end: 1 } },
  }).then((docs: any[]) =>
    docs.map((d) => ({ start: new Date(d.start), end: new Date(d.end) }))
  );

  // Manual assignments are ground truth: every derived segment type is
  // clipped around them, so a manual override fully replaces derived data
  // for its range. Clipped stays keep centroid/place; clipped moves keep
  // their full path (display-only simplification).
  const MIN_CLIPPED_MS = 60 * 1000;
  const finalSegments: Segment[] = [];
  for (const segment of segments) {
    const parts = subtractIntervals(segment, manualSegments);
    if (
      parts.length === 1 &&
      parts[0].start.getTime() === segment.start.getTime() &&
      parts[0].end.getTime() === segment.end.getTime()
    ) {
      finalSegments.push(segment);
      continue;
    }
    for (const part of parts) {
      if (part.end.getTime() - part.start.getTime() < MIN_CLIPPED_MS) continue;
      finalSegments.push({ ...segment, start: part.start, end: part.end });
    }
  }

  const now = new Date();
  const docs: any[] = [];
  for (const segment of finalSegments) {
    let place: Place | null = null;
    let timeZone: string | undefined;
    if (segment.type === "stay" && segment.loc) {
      const [lng, lat] = segment.loc.coordinates;
      if (geonamesReady) {
        place = (await reverseGeocode(mongo, lng, lat)).place;
      }
      try {
        timeZone = tzLookup(lat, lng);
      } catch {
        timeZone = undefined;
      }
    }
    docs.push({
      ...segment,
      place,
      ...(timeZone ? { timeZone } : {}),
      source: "derived",
      createdAt: now,
      updatedAt: now,
    });
  }

  await mongo({
    action: "deleteMany",
    collection: "location_segments",
    query: {
      source: "derived",
      start: { $lt: winEnd },
      end: { $gt: winStart },
    },
  });
  if (docs.length > 0) {
    await mongo({
      action: "insertMany",
      collection: "location_segments",
      docs,
    });
  }

  const tzPeriods = await upsertTimezonePeriods(
    mongo,
    tzLookup,
    finalSegments,
    winStart,
    winEnd,
  );
  return { segments: docs.length, tzPeriods };
}

function mergeWindows(windows: Interval[]): Interval[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const merged: Interval[] = [sorted[0]];
  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (w.start.getTime() <= last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = w.end;
    } else {
      merged.push(w);
    }
  }
  return merged;
}

async function use(job: Job<JobData>): Promise<JobResult> {
  const jobData = schema.parse(job.data);
  const jwt = Deno.env.get("MYCELIA_JWT")!;
  const myceliaUrl = env.MYCELIA_URL;
  const mongo: MongoCall = (input) =>
    callResource("mongo", input, { jwt, myceliaUrl });

  const { default: tzLookup } = await import("tz-lookup");

  const geonamesReady = (await mongo({
    action: "count",
    collection: "geonames_cities",
    query: {},
  })) > 0;

  let windows: Interval[];
  let pendingImportIds: any[] = [];

  if (jobData.start && jobData.end) {
    windows = [{ start: new Date(jobData.start), end: new Date(jobData.end) }];
  } else {
    const pending = await mongo({
      action: "find",
      collection: "location_imports",
      query: locationPendingImportQuery,
      options: { projection: { timeRange: 1 } },
    });
    pendingImportIds = pending.map((doc: any) => doc._id);
    windows = mergeWindows(
      pending.map((doc: any) => ({
        start: new Date(
          new Date(doc.timeRange.start).getTime() - WINDOW_PAD_MS,
        ),
        end: new Date(new Date(doc.timeRange.end).getTime() + WINDOW_PAD_MS),
      })),
    );
  }

  let totalSegments = 0;
  let totalTzPeriods = 0;
  for (const [index, window] of windows.entries()) {
    await job.updateProgress({
      stage: "segmenting",
      window: index + 1,
      windows: windows.length,
    });
    const { segments, tzPeriods } = await processWindow(
      mongo,
      tzLookup,
      geonamesReady,
      window.start,
      window.end,
    );
    totalSegments += segments;
    totalTzPeriods += tzPeriods;
  }

  if (pendingImportIds.length > 0) {
    await mongo({
      action: "updateMany",
      collection: "location_imports",
      query: { _id: { $in: pendingImportIds } },
      update: { $set: { status: "processed" } },
    });
  }

  // Backfill place labels on stays created before GeoNames was downloaded.
  let relabeled = 0;
  if (geonamesReady) {
    await job.updateProgress({ stage: "labeling" });
    while (true) {
      const unlabeled = await mongo({
        action: "find",
        collection: "location_segments",
        query: { type: "stay", place: null },
        options: { limit: 200, projection: { loc: 1 } },
      });
      if (unlabeled.length === 0) break;
      for (const stay of unlabeled) {
        const [lng, lat] = stay.loc.coordinates;
        const { place } = await reverseGeocode(mongo, lng, lat);
        await mongo({
          action: "updateOne",
          collection: "location_segments",
          query: { _id: stay._id },
          update: { $set: { place: place ?? { name: "Unknown" } } },
        });
        relabeled++;
      }
      if (unlabeled.length < 200) break;
    }
  }

  return {
    success: true,
    windows: windows.length,
    segments: totalSegments,
    tzPeriods: totalTzPeriods,
    relabeled,
    hasMore: false,
  };
}

const capability: JobCapability = {
  name,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(
    z.object({
      success: z.boolean(),
      windows: z.number().optional(),
      segments: z.number().optional(),
      tzPeriods: z.number().optional(),
      relabeled: z.number().optional(),
      hasMore: z.boolean().optional(),
    }),
  ),
  policies: [
    { resource: "db/location_points", action: "read", effect: "allow" },
    { resource: "db/location_segments", action: "*", effect: "allow" },
    { resource: "db/location_imports", action: "*", effect: "allow" },
    { resource: "db/geonames_cities", action: "read", effect: "allow" },
    { resource: "db/timeline_timezone_periods", action: "*", effect: "allow" },
  ],
  maxConcurrency: 1,
  triggers: {
    sources: [
      {
        channel: "mycelia:mongo:location_imports",
        name: "auto_new_import",
        filter: {
          event: "mongo.change",
          "data.operationType": "insert",
        },
      },
      {
        channel: "mycelia:mongo:location_imports",
        name: "auto_committed_import",
        filter: {
          event: "mongo.change",
          "data.operationType": "update",
          "data.changedFields": { $in: ["status", "committedAt"] },
        },
      },
    ],
    ...getTriggerTiming("location_processing"),
  },
  hasPendingWork: async ({ mongo }) => {
    const parsed = await hasIndexedPendingWork(mongo, {
      collection: "location_imports",
      query: locationPendingImportQuery,
    });
    return parsed ? 1 : 0;
  },
  use,
};

export default capability;
