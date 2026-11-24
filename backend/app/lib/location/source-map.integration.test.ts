import { expect } from "@std/expect";
import { ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { getMapSourceExtent, getMapSourcePoints } from "./source-map.server.ts";
import { locationSourceQuery } from "./sources.server.ts";

Deno.test(
  "focused map shows canonical fixes, shared files and timeless saved places",
  withFixtures(["Mongo"], async ({ db }) => {
    const a = new ObjectId(), b = new ObjectId(), draft = new ObjectId();
    const start = new Date(1000), end = new Date(2000);
    await db.collection("location_imports").insertMany([
      { _id: a, committedAt: start, origin: { provider: "reitti" } },
      { _id: b, committedAt: start, origin: { provider: "comaps" } },
      { _id: draft, origin: { provider: "reitti" } },
    ]);
    const loc = (lng: number, lat = 3) => ({
      type: "Point",
      coordinates: [lng, lat],
    });
    const fix = { ts: start, visible: true, selection: "accepted" };
    await db.collection("location_points").insertMany([
      { ...fix, importId: b, importIds: [a, b], loc: loc(179) },
      { ...fix, importId: String(a), loc: loc(-179) },
      { ...fix, importId: a, importIds: [b], loc: loc(15) },
      { ...fix, importIds: [draft], loc: loc(10) },
      { ...fix, importIds: [a], loc: loc(16), ts: new Date(10000) },
      { ...fix, importIds: [a], loc: loc(17), visible: false },
      { ...fix, importIds: [a], loc: loc(18), selection: "rejected" },
    ]);
    await db.collection("location_segments").insertMany([
      { type: "stay", importIds: [a], start, end, loc: loc(5, -8) },
      { type: "manual", importIds: [a], start, end, loc: loc(0, -90) },
    ]);
    await db.collection("location_bookmarks").insertMany([
      { loc: loc(90, 7), sourceRefs: [{ importId: a }, { importId: b }] },
      {
        loc: loc(-16, 70),
        sourceRefs: [{ importId: a }],
        reviewStatus: "rejected",
      },
    ]);
    const sourceFilter = {
      onlyProvider: "reitti",
      excludedProviders: [],
      excludedImportIds: [],
    };
    const request = { start, end, sourceFilter };
    const { clusters } = await getMapSourcePoints(db, {
      ...request,
      bounds: { west: 170, east: -170, south: -10, north: 10 },
    });
    expect(clusters.map((row) => row.lng).sort((a, b) => a - b)).toEqual([
      -179,
      179,
    ]);
    expect(clusters.map((row) => row.count)).toEqual([1, 1]);
    expect(await getMapSourceExtent(db, { ...request, layer: "markers" }))
      .toEqual({
        bounds: { west: -179, east: 179, south: -8, north: 7 },
        firstAt: start,
        lastAt: end,
      });
    expect(
      (await getMapSourceExtent(db, { sourceFilter, layer: "markers" })).lastAt,
    ).toEqual(new Date(10000));
    const straddling = {
      ...request,
      start: new Date(8000),
      end: new Date(9000),
    };
    expect(await getMapSourceExtent(db, { ...straddling, layer: "markers" }))
      .toEqual({
        bounds: { west: 90, east: 90, south: 7, north: 7 },
        firstAt: null,
        lastAt: null,
      });
    const file = {
      onlyImportId: String(b),
      excludedProviders: [],
      excludedImportIds: [],
    };
    const allFixes = await getMapSourcePoints(db, {
      ...request,
      sourceFilter: file,
      bounds: { west: -180, east: 180, south: -90, north: 90 },
    });
    expect(allFixes.clusters.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    const empty = await getMapSourceExtent(db, {
      ...request,
      layer: "markers",
      sourceFilter: { ...file, onlyImportId: String(draft) },
    });
    expect(empty.bounds).toBeNull();
    const matches = await locationSourceQuery(
      db,
      sourceFilter,
      "importIds",
      true,
    );
    expect(await db.collection("location_segments").countDocuments(matches))
      .toBe(1);
  }),
);

Deno.test(
  "focused route bounds use active visible fragments and clip partial date ranges in storage",
  withFixtures(["Mongo"], async ({ db }) => {
    const importId = new ObjectId(),
      trackId = new ObjectId(),
      otherId = new ObjectId();
    const gen = "active";
    const time = (n: number) => new Date(n * 1000);
    await db.collection("location_imports").insertOne({
      _id: importId,
      committedAt: time(1),
    });
    await db.collection("location_tracks").insertMany(
      [trackId, otherId].map((_id) => ({ _id, sourceRefs: [{ importId }] })),
    );
    await db.collection("location_route_projection_state")
      .insertOne({
        _id: "current",
        ready: true,
        activeGeneration: gen,
      } as never);
    await db.collection("location_route_fragments").insertMany([
      {
        generation: gen,
        trackId,
        fragmentIndex: 0,
        timeStart: time(1),
        timeEnd: time(8),
        bbox: { west: 0, east: 20, south: 0, north: 20 },
      },
      {
        generation: gen,
        trackId,
        fragmentIndex: 1,
        bbox: { west: 3, east: 4, south: 3, north: 4 },
      },
      {
        generation: "old",
        trackId,
        fragmentIndex: 1,
        bbox: { west: -100, east: -90, south: -80, north: -70 },
      },
      {
        generation: gen,
        trackId: otherId,
        fragmentIndex: 0,
        bbox: { west: 40, east: 50, south: 40, north: 50 },
      },
    ]);
    await db.collection("location_route_conflicts").insertOne({
      status: "resolved",
      resolution: "use_first",
      trackIds: [trackId, otherId],
      overlapStart: time(1),
      overlapEnd: time(8),
    });
    await db.collection("location_route_geometry").insertOne({
      generation: gen,
      trackId,
      fragmentIndex: 0,
      chunkIndex: 0,
      points: [
        { ts: time(1), coordinates: [0, 0] },
        { ts: time(3), coordinates: [6, 9] },
        { ts: time(4), coordinates: [8, 10] },
        { ts: time(8), coordinates: [20, 20] },
      ],
    });
    const sourceFilter = {
      onlyImportId: String(importId),
      excludedProviders: [],
      excludedImportIds: [],
    };
    expect(
      await getMapSourceExtent(db, {
        sourceFilter,
        layer: "routes",
        start: time(2),
        end: time(5),
      }),
    ).toEqual({
      bounds: { west: 3, east: 8, south: 3, north: 10 },
      firstAt: time(3),
      lastAt: time(4),
    });
    expect(await getMapSourceExtent(db, { sourceFilter, layer: "all" }))
      .toEqual({
        bounds: { west: 0, east: 20, south: 0, north: 20 },
        firstAt: time(1),
        lastAt: time(8),
      });
  }),
);
