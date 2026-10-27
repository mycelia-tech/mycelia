import { expect } from "@std/expect";
import { ObjectId } from "bson";
import type { Auth } from "@/lib/auth/core.server.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { up as upgradeLocationImports } from "../../../migrations/0050_location_import_review.ts";
import { up as addFullLocationGeometry } from "../../../migrations/0054_location_full_geometry_metadata.ts";
import {
  analyzeLocationFile,
  backfillLocationImport,
  confirmLocationPreview,
} from "./import.server.ts";
import { LocationResource } from "./resource.server.ts";

function gpx(
  points: Array<{ time: string; lat: number; lng: number; ele?: number }>,
) {
  return `<?xml version="1.0"?><gpx version="1.1"><trk><name>Test route</name><trkseg>${
    points.map((point) =>
      `<trkpt lat="${point.lat}" lon="${point.lng}">${
        point.ele === undefined ? "" : `<ele>${point.ele}</ele>`
      }<time>${point.time}</time></trkpt>`
    ).join("")
  }</trkseg></trk><wpt lat="41.71" lon="44.81"><name>Saved</name></wpt></gpx>`;
}

function upload(filename: string, text: string) {
  return {
    originalname: filename,
    mimetype: "application/gpx+xml",
    buffer: new TextEncoder().encode(text),
  };
}

Deno.test(
  "location analyze/confirm is idempotent and imports only partial-overlap additions",
  withFixtures(["Admin", "Mongo"], async (auth: Auth, { db }) => {
    await upgradeLocationImports(db);
    await addFullLocationGeometry(db);
    const firstFile = gpx([
      { time: "2026-08-01T00:00:00Z", lat: 41.7, lng: 44.8, ele: 10 },
      { time: "2026-08-01T00:01:00Z", lat: 41.7001, lng: 44.8001 },
    ]);
    const first = await analyzeLocationFile(
      auth,
      upload("first.gpx", firstFile),
    );
    expect(first.counts.newPoints).toBe(2);
    expect(first.counts.bookmarksNew).toBe(1);
    const receipt = await confirmLocationPreview(auth, first.previewId);
    const repeated = await confirmLocationPreview(auth, first.previewId);
    expect(repeated.importId).toBe(receipt.importId);
    expect(
      await db.collection("location_points").countDocuments({
        visible: true,
        selection: "accepted",
      }),
    ).toBe(2);
    const track = await db.collection("location_tracks").findOne({});
    expect(track?.geometryCompleteness).toBe("full");
    expect(track?.geometryPointCount).toBe(2);
    expect(track?.renderPath).toHaveLength(2);
    const geometry = await db.collection("location_track_geometry").find({
      trackId: track?._id,
    }).sort({ chunkIndex: 1 }).toArray();
    expect(geometry).toHaveLength(1);
    expect(geometry[0].points).toHaveLength(2);

    await db.collection("location_track_geometry").deleteMany({
      trackId: track?._id,
    });
    await db.collection("location_tracks").updateOne(
      { _id: track?._id },
      {
        $set: { geometryCompleteness: "render-only" },
        $unset: { geometryChunkCount: "" },
      },
    );
    await db.collection("location_imports").updateOne(
      { _id: new ObjectId(receipt.importId) },
      { $set: { contentProfileVersion: 1 } },
    );
    const backfilled = await backfillLocationImport(auth, receipt.importId);
    expect(backfilled.contentProfile.version).toBe(3);
    expect(
      await db.collection("location_track_geometry").countDocuments({
        trackId: track?._id,
      }),
    ).toBe(1);
    const backfilledImport = await db.collection("location_imports").findOne({
      _id: new ObjectId(receipt.importId),
    });
    expect(backfilledImport?.receipt?.schemaVersion).toBe(3);
    expect(backfilledImport?.receipt?.timedCoordinates).toBe(2);
    expect(backfilledImport?.receipt?.file?.parserVersion).toBe(3);

    const exact = await analyzeLocationFile(
      auth,
      upload("renamed.gpx", firstFile),
    );
    expect(exact.exactFileMatch?.filename).toBe("first.gpx");
    expect(exact.canConfirm).toBe(false);

    const partial = await analyzeLocationFile(
      auth,
      upload(
        "partial.gpx",
        gpx([
          { time: "2026-08-01T00:01:00Z", lat: 41.7001, lng: 44.8001 },
          { time: "2026-08-01T00:02:00Z", lat: 41.7002, lng: 44.8002 },
        ]),
      ),
    );
    expect(partial.counts.matchedPoints).toBe(1);
    expect(partial.counts.newPoints).toBe(1);
    await confirmLocationPreview(auth, partial.previewId);
    expect(
      await db.collection("location_points").countDocuments({
        visible: true,
        selection: "accepted",
      }),
    ).toBe(3);
    const shared = await db.collection("location_points").findOne({
      ts: new Date("2026-08-01T00:01:00Z"),
    });
    expect(shared?.importIds).toHaveLength(2);

    const elevationDifference = await analyzeLocationFile(
      auth,
      upload(
        "elevation.gpx",
        gpx([{
          time: "2026-08-01T00:00:00Z",
          lat: 41.7,
          lng: 44.8,
          ele: 20,
        }]),
      ),
    );
    expect(elevationDifference.counts.matchedPoints).toBe(1);
    expect(elevationDifference.counts.metadataReview).toBe(1);
    await confirmLocationPreview(auth, elevationDifference.previewId);
    const elevationConflict = await db.collection("location_metadata_conflicts")
      .findOne({
        entityType: "point",
        field: "ele",
        status: "pending",
      });
    expect(elevationConflict).not.toBeNull();
    await new LocationResource().use({
      action: "resolve-metadata-conflict",
      id: String(elevationConflict?._id),
      resolution: "keep_existing",
    }, auth);
    expect(
      await db.collection("location_points").findOne({
        ts: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toMatchObject({ ele: 10 });

    const conflicting = await analyzeLocationFile(
      auth,
      upload(
        "conflict.gpx",
        gpx([
          { time: "2026-08-01T00:00:00Z", lat: 10, lng: 20 },
        ]),
      ),
    );
    expect(conflicting.counts.newPoints).toBe(0);
    expect(conflicting.counts.conflictGroups).toBe(1);
    await confirmLocationPreview(auth, conflicting.previewId);
    expect(
      await db.collection("location_points").countDocuments({
        ts: new Date("2026-08-01T00:00:00Z"),
        visible: true,
        selection: "accepted",
      }),
    ).toBe(1);
    expect(
      await db.collection("location_point_conflicts").countDocuments({
        status: "pending",
      }),
    ).toBe(1);
  }),
);

Deno.test(
  "KMZ/KML enriches a GPX route and deletion restores remaining provenance",
  withFixtures(["Admin", "Mongo"], async (auth: Auth, { db }) => {
    await upgradeLocationImports(db);
    await addFullLocationGeometry(db);
    const gpxFile =
      `<?xml version="1.0"?><gpx version="1.1"><rte><name>Portable name</name><extensions><color>#FF804633</color></extensions><rtept lat="41.7" lon="44.8"/><rtept lat="41.8" lon="44.9"/></rte></gpx>`;
    const kmlFile =
      `<?xml version="1.0"?><kml><Document><Placemark><name>Rich name</name><description>KMZ semantics</description><Style><LineStyle><color>FF334680</color><width>5</width></LineStyle></Style><LineString><coordinates>44.8,41.7 44.9,41.8</coordinates></LineString></Placemark></Document></kml>`;

    const gpxPreview = await analyzeLocationFile(
      auth,
      upload("portable.gpx", gpxFile),
    );
    const gpxReceipt = await confirmLocationPreview(auth, gpxPreview.previewId);
    const richPreview = await analyzeLocationFile(
      auth,
      upload("rich.kml", kmlFile),
    );
    expect(richPreview.counts.tracksNew).toBe(0);
    expect(richPreview.counts.tracksMatched).toBe(1);
    const richReceipt = await confirmLocationPreview(
      auth,
      richPreview.previewId,
    );

    let track = await db.collection("location_tracks").findOne({});
    expect(await db.collection("location_tracks").countDocuments({})).toBe(1);
    expect(track?.metadata?.name).toBe("Rich name");
    expect(track?.metadata?.description).toBe("KMZ semantics");
    expect(track?.sourceRefs).toHaveLength(2);
    expect(track?.metadataPriority).toBe(20);
    expect(
      await db.collection("location_metadata_conflicts").countDocuments({}),
    ).toBe(1);
    expect(
      await db.collection("location_metadata_conflicts").findOne({}),
    ).toMatchObject({ field: "name" });

    await new LocationResource().use({
      action: "delete-import",
      id: richReceipt.importId,
    }, auth);
    track = await db.collection("location_tracks").findOne({});
    expect(track?.metadata?.name).toBe("Portable name");
    expect(track?.metadata?.description).toBeUndefined();
    expect(track?.sourceRefs).toHaveLength(1);
    expect(track?.metadataPriority).toBe(10);

    await new LocationResource().use({
      action: "delete-import",
      id: gpxReceipt.importId,
    }, auth);
    expect(await db.collection("location_tracks").countDocuments({})).toBe(0);
    expect(
      await db.collection("location_track_geometry").countDocuments({}),
    ).toBe(0);
  }),
);

Deno.test(
  "location import chunks full geometry and collapses repeated typed entities",
  withFixtures(["Admin", "Mongo"], async (auth: Auth, { db }) => {
    await upgradeLocationImports(db);
    await addFullLocationGeometry(db);
    const trackPoints = Array.from({ length: 2001 }, (_, index) => {
      const lat = 41.7 + index / 1_000_000;
      const lng = 44.8 + index / 1_000_000;
      return `<rtept lat="${lat}" lon="${lng}" />`;
    }).join("");
    const track = `<rte><name>Repeated route</name>${trackPoints}</rte>`;
    const waypoint =
      `<wpt lat="41.71" lon="44.81"><name>Repeated saved place</name></wpt>`;
    const file =
      `<?xml version="1.0"?><gpx version="1.1">${track}${track}${waypoint}${waypoint}</gpx>`;

    const preview = await analyzeLocationFile(
      auth,
      upload("repeated.gpx", file),
    );
    expect(preview.counts.tracks).toBe(2);
    expect(preview.counts.tracksNew).toBe(1);
    expect(preview.counts.withinFileTrackDuplicates).toBe(1);
    expect(preview.counts.bookmarks).toBe(2);
    expect(preview.counts.bookmarksNew).toBe(1);
    expect(preview.counts.withinFileBookmarkDuplicates).toBe(1);

    const receipt = await confirmLocationPreview(auth, preview.previewId);
    expect(await db.collection("location_tracks").countDocuments({})).toBe(1);
    expect(await db.collection("location_bookmarks").countDocuments({})).toBe(
      1,
    );
    const storedTrack = await db.collection("location_tracks").findOne({});
    expect(storedTrack?.sourceRefs).toHaveLength(2);
    const geometry = await db.collection("location_track_geometry").find({
      trackId: storedTrack?._id,
    }).sort({ chunkIndex: 1 }).toArray();
    expect(geometry).toHaveLength(2);
    expect(
      geometry.reduce(
        (total: number, item: { points: unknown[] }) =>
          total + item.points.length,
        0,
      ),
    )
      .toBe(2001);
    const storedBookmark = await db.collection("location_bookmarks").findOne(
      {},
    );
    expect(storedBookmark?.sourceRefs).toHaveLength(2);

    await new LocationResource().use({
      action: "delete-import",
      id: receipt.importId,
    }, auth);
    expect(await db.collection("location_tracks").countDocuments({})).toBe(0);
    expect(await db.collection("location_bookmarks").countDocuments({})).toBe(
      0,
    );
    expect(
      await db.collection("location_track_geometry").countDocuments({}),
    ).toBe(0);
  }),
);
