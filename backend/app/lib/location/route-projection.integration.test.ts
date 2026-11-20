import { expect } from "@std/expect";
import { MongoClient, ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { readTestSession } from "@/tests/test-session.ts";
import { up as createRouteProjection } from "../../../migrations/0069_location_route_projection.ts";
import {
  getMapRouteDetail,
  getRouteConflictPreview,
  listRouteConflicts,
  LOCATION_ROUTE_CONFLICTS,
  LOCATION_ROUTE_GEOMETRY,
  LOCATION_ROUTE_STATE,
  rebuildLocationRouteProjection,
  resolveRouteConflict,
} from "./route-projection.server.ts";

Deno.test(
  "independent simultaneous tracks remain separate and create review",
  withFixtures(["Mongo"], async ({ db }) => {
    await createRouteProjection(db);
    await createRouteProjection(db);
    const capeId = new ObjectId();
    const tbilisiId = new ObjectId();
    const firstImport = new ObjectId();
    const newerImport = new ObjectId();
    const reimport = new ObjectId();
    await db.collection("location_imports").insertMany([
      { _id: firstImport, filename: "first.kmz", committedAt: new Date(1000) },
      { _id: newerImport, filename: "second.gpx", committedAt: new Date(2000) },
      { _id: reimport, filename: "reimport.gpx", committedAt: new Date(3000) },
    ]);
    await db.collection("location_tracks").insertMany([
      {
        _id: capeId,
        fingerprint: "cape",
        displayName: "My Places",
        geometryCompleteness: "full",
        sourceRefs: [
          { importId: reimport, format: "gpx" },
          { importId: firstImport, format: "kmz" },
        ],
      },
      {
        _id: tbilisiId,
        fingerprint: "tbilisi",
        displayName: "may6-track.gpx",
        geometryCompleteness: "full",
        pointCount: 6,
        style: { color: "#234567", width: 3 },
        path: [[44.8, 41.7], [44.81, 41.7]],
        sourceRefs: [{ importId: newerImport, format: "gpx" }],
      },
    ]);
    const points = (lng: number, lat: number) =>
      Array.from({ length: 6 }, (_, index) => ({
        index,
        coordinates: [lng + index * 0.001, lat],
        ts: new Date(Date.UTC(2026, 4, 6, 12, index * 2, 0)),
        sourceFragmentIndex: 0,
        sourcePointIndex: index,
      }));
    await db.collection("location_track_geometry").insertMany([
      { trackId: capeId, chunkIndex: 0, points: points(18.4, -33.9) },
      { trackId: tbilisiId, chunkIndex: 0, points: points(44.8, 41.7) },
    ]);

    const rebuilt = await rebuildLocationRouteProjection(db, {
      onProgress: async ({ processed }) => {
        if (processed !== 1) return;
        await db.collection(LOCATION_ROUTE_STATE).updateOne(
          { _id: "current" },
          {
            $set: {
              dirty: true,
              sourceChangedAt: new Date(Date.now() + 60_000),
            },
          },
        );
      },
    });
    expect(rebuilt.conflicts).toBe(1);
    expect(
      await db.collection(LOCATION_ROUTE_CONFLICTS).countDocuments({
        status: "pending",
      }),
    ).toBe(1);

    const query = {
      start: new Date("2026-05-06T11:00:00Z"),
      end: new Date("2026-05-06T14:00:00Z"),
      bounds: { west: -180, east: 180, south: -90, north: 90 },
      zoom: 8,
      includeConnectors: false,
    };
    const detail = await getMapRouteDetail(db, query);
    expect(
      new Set(detail.fragments.map((fragment) => String(fragment.trackId)))
        .size,
    ).toBe(2);
    expect(detail.connectors).toEqual([]);
    expect(detail.conflicts).toHaveLength(1);
    const localDetail = await getMapRouteDetail(db, {
      ...query,
      bounds: { west: 44.79, east: 44.82, south: 41.69, north: 41.71 },
      zoom: 14,
      includeSourceTracks: true,
    });
    expect(
      [...new Set(localDetail.fragments.map(({ trackId }) => String(trackId)))],
    ).toEqual([tbilisiId.toString()]);
    expect(detail.sourceTracks).toBeUndefined();
    expect(localDetail.sourceTracks).toEqual([{
      _id: tbilisiId,
      displayName: "may6-track.gpx",
      pointCount: 6,
      style: { color: "#234567" },
    }]);
    let geometryReads = 0;
    const { mongoUri } = await readTestSession();
    const monitored = new MongoClient(mongoUri, { monitorCommands: true });
    monitored.on("commandStarted", ({ command }) => {
      if (command.find === LOCATION_ROUTE_GEOMETRY) geometryReads++;
    });
    const monitoredDb = monitored.db(db.databaseName);
    const pannedQuery = {
      ...query,
      start: new Date("2025-05-06T11:00:00Z"),
      bounds: { west: 44.78, east: 44.83, south: 41.69, north: 41.71 },
      zoom: 14,
    };
    try {
      await getMapRouteDetail(monitoredDb, query);
      expect(geometryReads).toBe(1);
      const warm = await getMapRouteDetail(
        monitored.db(db.databaseName),
        pannedQuery,
      );
      expect(warm.fragments).toEqual(localDetail.fragments);
      expect(geometryReads).toBe(1);

      const clipped = await getMapRouteDetail(monitoredDb, {
        ...pannedQuery,
        start: new Date("2026-05-06T12:04:00Z"),
      });
      expect(clipped.fragments[0]?.pointCount).toBe(4);
      expect(geometryReads).toBe(2);

      const smallerGap = await getMapRouteDetail(monitoredDb, {
        ...pannedQuery,
        gapDistanceM: 50,
      });
      expect(smallerGap.fragments).toEqual([]);
      expect(geometryReads).toBe(3);
    } finally {
      await monitored.close();
    }
    expect(
      await db.collection(LOCATION_ROUTE_STATE).findOne({
        _id: "current",
      }),
    ).toMatchObject({ ready: true, dirty: true, status: "stale" });

    const id = String(detail.conflicts[0]._id);
    const list = (status: string) =>
      listRouteConflicts(db, { status, limit: 10, skip: 0 });
    expect((await list("pending")).conflicts[0]).toMatchObject({
      sources: [
        {
          name: "My Places",
          filename: "first.kmz",
          importedAt: new Date(1000),
        },
        {
          name: "may6-track.gpx",
          filename: "second.gpx",
          importedAt: new Date(2000),
        },
      ],
    });
    const decide = (
      resolution: Parameters<typeof resolveRouteConflict>[1]["resolution"],
      expectedResolvedAt?: Date,
    ) =>
      resolveRouteConflict(db, {
        id,
        resolution,
        expectedResolvedAt,
        principal: "test",
      });
    const trackCount = (response: typeof detail) =>
      new Set(response.fragments.map(({ trackId }) => String(trackId))).size;
    expect((await decide("defer")).success).toBe(true);
    expect((await list("pending")).total).toBe(0);
    expect((await list("deferred")).total).toBe(1);
    expect(trackCount(await getMapRouteDetail(db, query))).toBe(2);
    expect((await decide("resume")).success).toBe(true);

    expect((await decide("use_first")).success).toBe(true);
    const applied = (await list("resolved")).conflicts[0];
    expect(applied.resolution).toBe("use_first");
    expect(trackCount(await getMapRouteDetail(db, query))).toBe(1);
    expect(trackCount(await getRouteConflictPreview(db, { id }))).toBe(2);
    expect((await decide("undo", new Date(0))).success).toBe(false);
    expect((await decide("undo", applied.resolvedAt)).success).toBe(true);
    expect((await list("pending")).total).toBe(1);
    expect(trackCount(await getMapRouteDetail(db, query))).toBe(2);
    const history = await db.collection(LOCATION_ROUTE_CONFLICTS).findOne(
      { _id: id } as never,
    );
    expect(
      history?.audit.map((entry: { resolution: string }) => entry.resolution),
    )
      .toEqual(["defer", "resume", "use_first", "undo"]);
  }),
);
