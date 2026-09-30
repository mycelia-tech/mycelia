import {
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "jsr:@std/assert@^1.0.15";
import { type Db, ObjectId } from "mongodb";
import { estimateMediaGrossUsd } from "@/lib/media/costs.ts";
import {
  assertRecognitionBatchRetryAllowed,
  assertRecognitionTasks,
  FOLDER_CHUNK_SIZE,
  folderCampaignProgress,
  geoBoundsQuery,
  listRecognitionBatches,
  mediaFolderReusableHashQuery,
  mediaLibraryRequestSchema,
  MediaLibraryResource,
  mediaLibrarySummaryQueries,
  mediaTimelineRangeQuery,
  normalizeRecognitionSelection,
  publicFolderCounts,
  RECOGNITION_WINDOW,
  recognitionBatchOwnerQuery,
  recognitionBatchProgress,
  recognitionEligibilityQuery,
  recognitionSelectionQuery,
  selectionDigest,
  timelineResolution,
} from "./resource.server.ts";

const googleProfile = {
  id: "google-cloud-media",
  name: "Google Cloud EU Photo Knowledge",
  providerType: "google-cloud" as const,
  enabled: true,
  concurrency: 1,
  projectId: "example-photo-project",
  location: "eu" as const,
  vertexModel: "gemini-3.5-flash-lite" as const,
  embeddingModel: "gemini-embedding-001" as const,
  embeddingLocation: "europe-west4" as const,
  documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07" as const,
  allowGlobalPhotoAnalysis: false,
};

Deno.test("ready photos require explicit reanalysis selection", () => {
  assertEquals(
    recognitionEligibilityQuery("owner").status.$in.includes("ready"),
    false,
  );
  assertEquals(
    recognitionEligibilityQuery("owner", true).status.$in.includes("ready"),
    true,
  );
});

Deno.test("ordinary recognition excludes published results even after a failed replacement", () => {
  assertEquals(recognitionEligibilityQuery("owner").currentRunId, {
    $exists: false,
  });
  assertEquals(
    recognitionEligibilityQuery("owner", true).currentRunId,
    undefined,
  );
});

const selfHostedProfile = {
  id: "self-hosted-media",
  name: "Self-hosted Photo Knowledge",
  providerType: "self-hosted" as const,
  enabled: true,
  concurrency: 1,
  baseUrl: "http://media-provider:8090",
};

Deno.test("folder and recognition campaigns use bounded work windows", () => {
  assertEquals(FOLDER_CHUNK_SIZE, 25);
  assertEquals(RECOGNITION_WINDOW, 16);
});

Deno.test("stream progress counts imported work while discovery total remains unknown", () => {
  const progress = folderCampaignProgress({
    status: "importing",
    streaming: {},
    inventoryInitialized: false,
  }, {
    total: 130,
    unsupported: 30,
    pending: 50,
    ready: 25,
    imported: 25,
  });
  assertEquals(progress.stage, "streaming");
  assertEquals(progress.totalKnown, false);
  assertEquals(progress.processed, 25);
  assertEquals(progress.remaining, 75);
  const waiting = folderCampaignProgress({
    status: "importing",
    streaming: {},
    updatedAt: new Date(Date.now() - 120_000),
  }, { total: 10, pending: 10 });
  assertEquals(waiting.waitingForRecovery, true);
  assertEquals(waiting.totalKnown, false);
});

Deno.test("stream authorization requires explicit consent and bounded costs", () => {
  assertEquals(
    mediaLibraryRequestSchema.safeParse({
      action: "confirmFolderStream",
      previewId: String(new ObjectId()),
    }).success,
    false,
  );
  assertEquals(
    mediaLibraryRequestSchema.safeParse({
      action: "previewFolderStream",
      campaignId: String(new ObjectId()),
      profileId: "google",
      maxGrossUsd: 301,
    }).success,
    false,
  );
  assertEquals(
    mediaLibraryRequestSchema.safeParse({
      action: "previewFolderStream",
      campaignId: String(new ObjectId()),
      profileId: "google",
      maxGrossUsd: 50,
      batchSize: 501,
    }).success,
    false,
  );
});

Deno.test("folder scan progress separates checked ready files from pending work", () => {
  const raw = {
    total: 904,
    unsupported: 103,
    pending: 775,
    inspecting: 1,
    ready: 24,
  };
  assertEquals(publicFolderCounts(raw), {
    total: 904,
    pending: 775,
    processing: 1,
    ready: 24,
    imported: 0,
    duplicate: 0,
    unsupported: 103,
    changed: 0,
    failed: 0,
  });
  const progress = folderCampaignProgress({ status: "scanning" }, raw);
  assertEquals(progress.stage, "metadata_scan");
  assertEquals(progress.processed, 25);
  assertEquals(progress.total, 801);
  assertEquals(progress.remaining, 776);
  assertEquals(progress.percent, 3.1);

  const interrupted = folderCampaignProgress({
    status: "scanning",
    createdAt: new Date(Date.now() - 10 * 60_000),
    lastProgressAt: new Date(Date.now() - 2 * 60_000),
  }, {
    total: 904,
    unsupported: 103,
    inspecting: 2,
    ready: 799,
  });
  assertEquals(interrupted.waitingForRecovery, true);
  assertEquals(interrupted.etaSeconds, undefined);
});

Deno.test("inventory progress reports discovered files without inventing a total or ETA", () => {
  const progress = folderCampaignProgress({
    status: "queued",
    relativePath: "external-photos",
    inventoryDiscovered: 23_500,
    inventoryCurrentPath: "external-photos/2026",
    createdAt: new Date(Date.now() - 10_000),
  }, { total: 23_500, pending: 23_000, unsupported: 500 });
  assertEquals(progress.stage, "inventory");
  assertEquals(progress.processed, 23_500);
  assertEquals(progress.totalKnown, false);
  assertEquals(progress.percent, 0);
  assertEquals(progress.etaSeconds, undefined);
  assertEquals(progress.currentPath, "external-photos/2026");
});

Deno.test("recognition batch progress reports terminal work and live queue states", () => {
  assertEquals(
    recognitionBatchProgress("running", {
      total: 20,
      pending: 2,
      queued: 10,
      processing: 3,
      ready: 4,
      failed: 1,
    }, "0123456789abcdef01234567"),
    {
      stage: "processing",
      status: "running",
      processed: 5,
      total: 20,
      remaining: 15,
      percent: 25,
      pending: 2,
      queued: 10,
      processing: 3,
      ready: 4,
      skipped: 0,
      failed: 1,
      cancelled: 0,
      batchId: "0123456789abcdef01234567",
    },
  );
  assertEquals(
    recognitionBatchProgress("cancelled", {
      total: 20,
      ready: 4,
      failed: 1,
      cancelled: 15,
    }).percent,
    100,
  );
});

Deno.test("bulk photo knowledge is provider-neutral and fixes the safe task package", () => {
  assertRecognitionTasks(googleProfile, ["visual-understanding", "ocr"]);
  assertRecognitionTasks(selfHostedProfile, ["visual-understanding", "ocr"]);
  assertThrows(
    () => assertRecognitionTasks(googleProfile, ["labels"]),
    Error,
    "intentionally supports visual understanding and OCR only",
  );
  assertEquals(
    estimateMediaGrossUsd(
      "image",
      1,
      ["visual-understanding", "ocr"],
      googleProfile,
    ),
    0.0075,
  );
  assertEquals(Number((928 * 0.0075).toFixed(2)), 6.96);
});

Deno.test("batch selection digest binds owner cutoff profile tasks and every SHA", () => {
  const cutoff = new Date("2026-08-25T12:00:00.000Z");
  const selection = normalizeRecognitionSelection({
    mode: "all_matching",
    inventoryFilter: "unprocessed",
    placement: "missing_location",
    query: "garden",
  });
  const assets = [
    { _id: new ObjectId("68a000000000000000000001"), sha256: "a".repeat(64) },
    { _id: new ObjectId("68a000000000000000000002"), sha256: "b".repeat(64) },
  ];
  const first = selectionDigest(
    "admin",
    cutoff,
    googleProfile,
    ["visual-understanding", "ocr"],
    assets,
    selection,
  );
  assertEquals(
    first,
    selectionDigest(
      "admin",
      cutoff,
      googleProfile,
      ["ocr", "visual-understanding"],
      assets,
      selection,
    ),
  );
  assertNotEquals(
    first,
    selectionDigest(
      "admin",
      cutoff,
      googleProfile,
      ["visual-understanding", "ocr"],
      [{ ...assets[0], sha256: "c".repeat(64) }, assets[1]],
      selection,
    ),
  );
  assertNotEquals(
    first,
    selectionDigest(
      "admin",
      cutoff,
      googleProfile,
      ["visual-understanding", "ocr"],
      assets,
      normalizeRecognitionSelection({
        mode: "all_matching",
        inventoryFilter: "unprocessed",
        placement: "all",
        query: "garden",
      }),
    ),
  );
  assertThrows(
    () => assertRecognitionBatchRetryAllowed(googleProfile),
    Error,
    "new exact batch preview",
  );
  assertRecognitionBatchRetryAllowed(selfHostedProfile);
});

Deno.test("all-matching recognition selection scopes server-side filters", () => {
  const cutoff = new Date("2026-08-25T12:00:00.000Z");
  const selection = normalizeRecognitionSelection({
    mode: "all_matching",
    inventoryFilter: "needs_attention",
    placement: "missing_location",
    query: "trip (final)",
    capturedFrom: "2025-01-01T00:00:00.000Z",
    capturedTo: "2025-12-31T23:59:59.000Z",
  });
  const query = recognitionSelectionQuery("alice", cutoff, selection) as any;
  assertEquals(query.$and[0], recognitionEligibilityQuery("alice"));
  assertEquals(query.$and[1].$and, [
    { owner: "alice", kind: "image" },
    { createdAt: { $lte: cutoff } },
    {
      recognitionIgnoredAt: { $exists: false },
      status: {
        $in: [
          "failed",
          "budget_blocked",
          "recognition_disabled",
          "source_missing",
          "source_changed",
        ],
      },
    },
    { $nor: [{ "geo.type": "Point" }] },
    {
      $or: [
        { fileName: { $regex: "trip \\(final\\)", $options: "i" } },
        {
          "source.relativePath": {
            $regex: "trip \\(final\\)",
            $options: "i",
          },
        },
      ],
    },
    {
      capturedAt: {
        $gte: new Date("2025-01-01T00:00:00.000Z"),
        $lte: new Date("2025-12-31T23:59:59.000Z"),
      },
    },
  ]);
});

Deno.test("explicit recognition selection is unique, normalized, and ID-scoped", () => {
  const first = "68A000000000000000000002";
  const second = "68a000000000000000000001";
  const selection = normalizeRecognitionSelection({
    mode: "explicit",
    inventoryFilter: "unprocessed",
    placement: "all",
    assetIds: [first, second],
  });
  assertEquals(selection.assetIds, [second, first.toLowerCase()]);
  const query = recognitionSelectionQuery(
    "alice",
    new Date("2026-08-25T12:00:00.000Z"),
    selection,
  ) as any;
  assertEquals(
    query.$and[1].$and.at(-1)._id.$in.map(String),
    [second, first.toLowerCase()],
  );
  const parsed = mediaLibraryRequestSchema.parse({
    action: "previewRecognitionBatch",
    profileId: "google-cloud-media",
    requestedTasks: ["visual-understanding", "ocr"],
    selection: { mode: "explicit", assetIds: [second] },
  });
  if (parsed.action !== "previewRecognitionBatch") {
    throw new Error("Unexpected parsed recognition action");
  }
  assertEquals(
    parsed.selection,
    {
      mode: "explicit",
      inventoryFilter: "unprocessed",
      placement: "all",
      assetIds: [second],
    },
  );
});

Deno.test("ignore processing accepts explicit and all-matching selections", () => {
  const assetId = new ObjectId().toString();
  assertEquals(
    mediaLibraryRequestSchema.parse({
      action: "setRecognitionIgnored",
      selection: { mode: "explicit", assetIds: [assetId] },
      ignored: true,
      confirm: true,
    }),
    {
      action: "setRecognitionIgnored",
      selection: {
        mode: "explicit",
        inventoryFilter: "unprocessed",
        placement: "all",
        assetIds: [assetId],
      },
      ignored: true,
      confirm: true,
    },
  );
  const restored = mediaLibraryRequestSchema.parse({
    action: "setRecognitionIgnored",
    selection: {
      mode: "all_matching",
      inventoryFilter: "ignored",
    },
    ignored: false,
    confirm: true,
  });
  if (restored.action !== "setRecognitionIgnored") {
    throw new Error("Unexpected parsed action");
  }
  assertEquals(restored.selection.inventoryFilter, "ignored");
});

Deno.test("recognition eligibility excludes ready, active, deleting, and ignored assets", () => {
  assertEquals(recognitionEligibilityQuery("admin"), {
    owner: "admin",
    currentRunId: { $exists: false },
    kind: "image",
    "preview.fileId": { $type: "objectId" },
    derivedDeletionPending: { $exists: false },
    originalDeletionPending: { $exists: false },
    recognitionIgnoredAt: { $exists: false },
    status: {
      $in: ["staged", "failed", "budget_blocked", "recognition_disabled"],
    },
    $or: [
      {
        storageMode: "managed_original",
        "managedOriginal.fileId": { $exists: true },
      },
      {
        storageMode: "external_reference",
        "source.relativePath": { $type: "string" },
      },
    ],
  });
});

Deno.test("recognition batch listing is owner-scoped and bounded", async () => {
  let observedQuery: Record<string, unknown> | undefined;
  let observedLimit = 0;
  const cursor = {
    sort() {
      return cursor;
    },
    limit(limit: number) {
      observedLimit = limit;
      return cursor;
    },
    toArray() {
      return Promise.resolve([]);
    },
  };
  const fakeDb = {
    collection(name: string) {
      if (name !== "media_recognition_batches") {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return {
        find(query: Record<string, unknown>) {
          observedQuery = query;
          return cursor;
        },
      };
    },
  } as unknown as Db;
  assertEquals(await listRecognitionBatches(fakeDb, "alice", 7), []);
  assertEquals(observedQuery, recognitionBatchOwnerQuery("alice"));
  assertEquals(observedLimit, 7);
  assertEquals(
    mediaLibraryRequestSchema.parse({ action: "listRecognitionBatches" }),
    { action: "listRecognitionBatches", limit: 10 },
  );
  assertThrows(() =>
    mediaLibraryRequestSchema.parse({
      action: "listRecognitionBatches",
      limit: 21,
    })
  );
});

Deno.test("media summary exposes mutually observable queue and attention counts", () => {
  const queries = mediaLibrarySummaryQueries("alice");
  assertEquals(queries.processing, {
    owner: "alice",
    kind: "image",
    status: { $in: ["queued", "processing"] },
  });
  assertEquals(queries.unprocessed, {
    owner: "alice",
    currentRunId: { $exists: false },
    kind: "image",
    recognitionIgnoredAt: { $exists: false },
    status: { $nin: ["ready", "queued", "processing"] },
  });
  assertEquals(queries.needsAttention, {
    owner: "alice",
    kind: "image",
    recognitionIgnoredAt: { $exists: false },
    status: {
      $in: [
        "failed",
        "budget_blocked",
        "recognition_disabled",
        "source_missing",
        "source_changed",
      ],
    },
  });
  assertEquals(queries.ignored, {
    owner: "alice",
    kind: "image",
    recognitionIgnoredAt: { $type: "date" },
  });
});

Deno.test("folder sync reuses SHA only for an unchanged owner-scoped path", () => {
  const campaignId = new ObjectId();
  assertEquals(
    mediaFolderReusableHashQuery(
      "alice",
      campaignId,
      "900-photos/IMG_0001.JPG",
      1_234_567,
      1_787_000_000_000,
    ),
    {
      owner: "alice",
      campaignId: { $ne: campaignId },
      relativePath: "900-photos/IMG_0001.JPG",
      byteLength: 1_234_567,
      sourceModifiedAtMs: 1_787_000_000_000,
      sha256: { $type: "string" },
      kind: "image",
      state: { $in: ["ready", "duplicate", "imported"] },
    },
  );
});

Deno.test("photo Timeline switches from hour to day and month density", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  assertEquals(
    timelineResolution(start, new Date("2026-01-08T00:00:00Z")),
    "hour",
  );
  assertEquals(
    timelineResolution(start, new Date("2026-06-01T00:00:00Z")),
    "day",
  );
  assertEquals(
    timelineResolution(start, new Date("2029-01-01T00:00:00Z")),
    "month",
  );
});

Deno.test("photo Timeline range is owner-scoped and ignores missing times", () => {
  assertEquals(mediaTimelineRangeQuery("alice"), {
    owner: "alice",
    kind: "image",
    capturedAt: { $type: "date" },
  });
  const resource = new MediaLibraryResource();
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({ action: "timeRange" }),
    ),
    [{ path: ["media-library", "timeRange"], actions: ["use"] }],
  );
});

Deno.test("map bounds use GeoJSON and split an antimeridian viewport", () => {
  const normal = geoBoundsQuery({
    west: 40,
    south: 39,
    east: 45,
    north: 42,
  });
  assertEquals((normal as any).geo.$geoWithin.$geometry.type, "Polygon");
  const crossing = geoBoundsQuery({
    west: 170,
    south: -10,
    east: -170,
    north: 10,
  });
  assertEquals((crossing as any).$or.length, 2);
  assertEquals(
    geoBoundsQuery({ west: -180, south: -80, east: 40, north: 80 }),
    { "geo.type": "Point" },
  );
});

Deno.test("worker-only campaign actions require process capability", () => {
  const resource = new MediaLibraryResource();
  const jobId = new ObjectId().toString();
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({
        action: "listMountedFolders",
        relativePath: ".",
      }),
    ),
    [{ path: ["media-library", "listMountedFolders"], actions: ["use"] }],
  );
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({ action: "getActiveFolderCampaign" }),
    ),
    [{
      path: ["media-library", "getActiveFolderCampaign"],
      actions: ["use"],
    }],
  );
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({
        action: "processRecognitionBatch",
        jobId,
      }),
    ),
    [{
      path: ["media-library", "processRecognitionBatch"],
      actions: ["process"],
    }],
  );
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({ action: "summary" }),
    ),
    [{ path: ["media-library", "summary"], actions: ["use"] }],
  );
  assertEquals(
    resource.extractActions(
      mediaLibraryRequestSchema.parse({ action: "listRecognitionBatches" }),
    ),
    [{
      path: ["media-library", "listRecognitionBatches"],
      actions: ["use"],
    }],
  );
});
