import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.15";
import { type Db, ObjectId } from "mongodb";
import {
  activateMediaAnalysis,
  loadMediaAssetDetailProjections,
  mediaAssetListFilterQuery,
  mediaAssetLocation,
  mediaAssetSortSpec,
  mediaImportTemporalSpatialFields,
  mediaPlacementFilterQuery,
  MediaResource,
  mediaSearchQuerySchema,
  stageAnalysis,
} from "./resource.server.ts";

Deno.test("visual descriptions persist without an embedding", async () => {
  const writes: unknown[] = [];
  const db = {
    collection: () => ({
      updateOne: (...args: unknown[]) => {
        writes.push(args);
      },
    }),
  };
  await stageAnalysis(db as unknown as Db, { _id: new ObjectId() }, "run", {
    visualUnderstanding: { description: "tree" },
    searchText: "tree",
    pages: [],
    annotations: [],
  } as any);
  assertEquals(writes.length, 1);
});

Deno.test("unplaced inventory treats legacy nulls as missing", () => {
  assertEquals(mediaPlacementFilterQuery("missing_time"), {
    $nor: [{ capturedAt: { $type: "date" } }],
  });
  assertEquals(mediaPlacementFilterQuery("missing_location"), {
    $nor: [{ "geo.type": "Point" }],
  });
});

Deno.test("media inventory filters filename kind and capture range on the server", () => {
  assertEquals(
    mediaAssetListFilterQuery("admin", {
      inventoryFilter: "unprocessed",
      placement: "missing_location",
      kind: "image",
      query: "IMG_[1].jpg",
      capturedFrom: "2026-01-01T00:00:00.000Z",
      capturedTo: "2026-12-31T23:59:59.999Z",
    }),
    {
      owner: "admin",
      currentRunId: { $exists: false },
      recognitionIgnoredAt: { $exists: false },
      status: { $nin: ["ready", "queued", "processing"] },
      $nor: [{ "geo.type": "Point" }],
      kind: "image",
      $or: [
        { fileName: { $regex: "IMG_\\[1\\]\\.jpg", $options: "i" } },
        {
          "source.relativePath": {
            $regex: "IMG_\\[1\\]\\.jpg",
            $options: "i",
          },
        },
      ],
      capturedAt: {
        $gte: new Date("2026-01-01T00:00:00.000Z"),
        $lte: new Date("2026-12-31T23:59:59.999Z"),
      },
    },
  );
});

Deno.test("media inventory sorting is server-side and stable", () => {
  assertEquals(mediaAssetSortSpec("capturedAt", "asc"), {
    capturedAt: 1,
    _id: 1,
  });
  assertEquals(mediaAssetSortSpec("fileName", "desc"), {
    fileName: -1,
    _id: -1,
  });
  assertEquals(
    mediaAssetListFilterQuery("admin", {
      inventoryFilter: "ignored",
      placement: "all",
      kind: "image",
    }),
    {
      owner: "admin",
      kind: "image",
      recognitionIgnoredAt: { $type: "date" },
    },
  );
});

Deno.test("media semantic search accepts a bounded query", () => {
  assertEquals(
    mediaSearchQuerySchema.parse("  garden photo  "),
    "garden photo",
  );
  assertThrows(
    () => mediaSearchQuerySchema.parse("x".repeat(513)),
    Error,
  );
});

Deno.test("derived photo deletion declares the Event Object mutation", () => {
  const assetId = new ObjectId().toString();
  const resource = new MediaResource();
  assertEquals(
    resource.extractActions({
      action: "deleteDerived",
      assetId,
      target: "previews",
      confirm: true,
    }),
    [
      { path: ["media", "deleteDerived"], actions: ["use"] },
      { path: ["objects"], actions: ["update"] },
    ],
  );
  assertEquals(
    resource.extractActions({
      action: "deleteDerived",
      assetId,
      target: "asset_record",
      confirm: true,
    }),
    [
      { path: ["media", "deleteDerived"], actions: ["use"] },
      { path: ["objects"], actions: ["update"] },
    ],
  );
  assertEquals(
    resource.extractActions({
      action: "deleteDerived",
      assetId,
      target: "source_reference",
      confirm: true,
    }),
    [{ path: ["media", "deleteDerived"], actions: ["use"] }],
  );
  assertEquals(
    resource.extractActions({
      action: "cancelOriginalDeletionPreview",
      deletionPreviewId: new ObjectId().toString(),
    }),
    [{
      path: ["media", "cancelOriginalDeletionPreview"],
      actions: ["use"],
    }],
  );
});

Deno.test("confirmed imports persist normalized temporal and spatial fields", () => {
  const capturedAt = new Date("2026-08-21T08:34:56.000Z");
  assertEquals(
    mediaImportTemporalSpatialFields({
      capturedAt,
      capturedAtTimeZone: "+04:00",
      capturedAtTimeZoneSource: "exif_offset",
      location: { latitude: 40.18, longitude: 44.51 },
    }),
    {
      capturedAt,
      capturedAtSource: "exif",
      capturedAtTimeZone: "+04:00",
      capturedAtTimeZoneSource: "exif_offset",
      location: { latitude: 40.18, longitude: 44.51 },
      geo: { type: "Point", coordinates: [44.51, 40.18] },
      locationSource: "exif",
    },
  );
});

Deno.test("legacy media location falls back to metadata", () => {
  const location = { latitude: 40.18, longitude: 44.51 };
  assertEquals(mediaAssetLocation({ metadata: { location } }), location);
  assertEquals(
    mediaImportTemporalSpatialFields({
      capturedAt: new Date("2026-08-21T12:34:56.000Z"),
      metadata: { location },
    }),
    {
      capturedAt: new Date("2026-08-21T12:34:56.000Z"),
      capturedAtSource: "exif",
      capturedAtTimeZoneSource: "unknown",
      location,
      geo: { type: "Point", coordinates: [44.51, 40.18] },
      locationSource: "exif",
    },
  );
});

Deno.test("ready media projections switch without hiding the accepted old run", async () => {
  const calls: string[] = [];
  const fakeDb = {
    collection(name: string) {
      return {
        updateMany(filter: Record<string, unknown>) {
          calls.push(
            `${name}:${
              filter.runId && typeof filter.runId === "object" ? "old" : "new"
            }`,
          );
          return Promise.resolve({ modifiedCount: 1 });
        },
        updateOne() {
          calls.push(`${name}:pointer`);
          return Promise.resolve({ modifiedCount: 1 });
        },
      };
    },
  } as unknown as Db;

  await activateMediaAnalysis(fakeDb, new ObjectId(), "ready-run");
  assertEquals(calls, [
    "media_ocr_pages:new",
    "media_annotations:new",
    "media_visual_descriptions:new",
    "media_assets:pointer",
    "media_ocr_pages:old",
    "media_annotations:old",
    "media_visual_descriptions:old",
  ]);
});

Deno.test("asset detail projections are pinned to the asset current run", async () => {
  const assetId = new ObjectId();
  const currentRunId = "current-run";
  const filters = new Map<string, Record<string, unknown>>();
  const fakeDb = {
    collection(name: string) {
      const cursor = {
        sort() {
          return cursor;
        },
        limit() {
          return cursor;
        },
        toArray() {
          return Promise.resolve([]);
        },
      };
      return {
        find(filter: Record<string, unknown>) {
          filters.set(name, filter);
          return cursor;
        },
        findOne(filter: Record<string, unknown>) {
          filters.set(name, filter);
          return Promise.resolve(null);
        },
      };
    },
  } as unknown as Db;

  await loadMediaAssetDetailProjections(fakeDb, {
    _id: assetId,
    currentRunId,
  });

  for (
    const collection of [
      "media_ocr_pages",
      "media_annotations",
      "media_visual_descriptions",
    ]
  ) {
    assertEquals(filters.get(collection), {
      assetId,
      active: true,
      runId: currentRunId,
    });
  }
  assertEquals(filters.get("media_analysis_runs"), { assetId });
});
