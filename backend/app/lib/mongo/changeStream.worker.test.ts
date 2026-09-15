import { expect } from "@std/expect";
import {
  correctObjectListCategories,
  createObjectCatalogValidationQueue,
  createPerCollectionChangeDebouncer,
  DATABASE_CHANGE_PIPELINE,
  getCollectionChangeStreamOptions,
  isObjectCatalogOnlyChange,
  loadObjectUpdateDocument,
  normalizeChangedFields,
  shouldRefreshObjectDensity,
  shouldSuppressMongoChange,
} from "./changeStream.worker.ts";
import { CHANGE_STREAM_POOL_SIZE } from "./core.server.ts";

Deno.test("database stream excludes objects and uses a bounded separate pool", () => {
  expect(DATABASE_CHANGE_PIPELINE).toEqual([{
    $match: { "ns.coll": { $ne: "objects" } },
  }]);
  expect(CHANGE_STREAM_POOL_SIZE).toBe(4);
});

Deno.test("Mongo update metadata exposes every changed field name once", () => {
  expect(normalizeChangedFields({
    updatedFields: {
      "vad.has_speech": true,
      processing_by: "worker-1",
    },
    removedFields: ["claimed_at", "processing_by"],
    truncatedArrays: [{ field: "samples", newSize: 2 }],
  })).toEqual([
    "vad.has_speech",
    "processing_by",
    "claimed_at",
    "samples",
  ]);
});

Deno.test("object category corrector is idempotent and ignores its own update", async () => {
  const calls: unknown[] = [];
  const db = {
    collection: () => ({
      updateOne: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ modifiedCount: 1 });
      },
    }),
  } as any;

  expect(
    await correctObjectListCategories(db, "update", {
      _id: "object-1",
      isPerson: true,
      _listCategories: ["person"],
    }, { updatedFields: { name: "Renamed" } }),
  ).toBe(false);

  expect(
    await correctObjectListCategories(db, "update", {
      _id: "object-1",
      isPerson: true,
      _listCategories: ["event"],
    }, { updatedFields: { _listCategories: ["event"] } }),
  ).toBe(true);

  expect(
    await correctObjectListCategories(db, "update", {
      _id: "object-1",
      isPerson: true,
      _listCategories: ["event"],
    }, { updatedFields: { isPerson: true } }),
  ).toBe(true);
  expect(calls).toHaveLength(2);
});

Deno.test("object derived catalog updates do not publish or refresh density", () => {
  const catalogUpdate = { updatedFields: { _listCategories: ["person"] } };
  expect(isObjectCatalogOnlyChange("update", catalogUpdate)).toBe(true);
  expect(shouldRefreshObjectDensity("update", catalogUpdate)).toBe(false);
});

Deno.test("object density refreshes only for range/category mutations", () => {
  expect(shouldRefreshObjectDensity("insert")).toBe(true);
  expect(shouldRefreshObjectDensity("replace")).toBe(true);
  expect(shouldRefreshObjectDensity("delete")).toBe(true);
  expect(shouldRefreshObjectDensity("update", {
    updatedFields: { "timeRanges.0.start": new Date() },
  })).toBe(true);
  expect(shouldRefreshObjectDensity("update", {
    removedFields: ["isEvent"],
  })).toBe(true);
  expect(shouldRefreshObjectDensity("update", {
    updatedFields: { name: "Renamed" },
  })).toBe(false);
});

Deno.test("durable density queue churn is internal and not published", () => {
  expect(shouldSuppressMongoChange("object_timeline_density_pending")).toBe(
    true,
  );
  expect(shouldSuppressMongoChange("object_timeline_density_state")).toBe(
    false,
  );
});

Deno.test("objects avoid server-side fullDocument lookup during catalog backfill", () => {
  expect(getCollectionChangeStreamOptions("objects")).toEqual({});
  expect(getCollectionChangeStreamOptions("audio_chunks")).toEqual({
    fullDocument: "updateLookup",
  });
});

Deno.test("non-catalog object update hydration loads the full document", async () => {
  const calls: unknown[][] = [];
  const db = {
    collection: () => ({
      findOne: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ _id: "object-1" });
      },
    }),
  } as any;

  await loadObjectUpdateDocument(db, { _id: "object-1" });

  expect(calls).toEqual([[{ _id: "object-1" }]]);
});

Deno.test("catalog validation coalesces ids into one compact bounded query", async () => {
  const findCalls: unknown[][] = [];
  const db = {
    collection: () => ({
      find: (...args: unknown[]) => {
        findCalls.push(args);
        return {
          toArray: () =>
            Promise.resolve([
              {
                _id: "object-1",
                isPerson: true,
                _listCategories: ["person"],
              },
              {
                _id: "object-2",
                isEvent: true,
                _listCategories: ["event"],
              },
            ]),
        };
      },
    }),
  } as any;
  const queue = createObjectCatalogValidationQueue(db, { delayMs: 60_000 });
  queue.enqueue({ _id: "object-1" });
  queue.enqueue({ _id: "object-1" });
  queue.enqueue({ _id: "object-2" });

  expect(await queue.flushNow()).toBe(true);
  expect(findCalls).toHaveLength(1);
  expect(findCalls[0]?.[0]).toEqual({
    _id: { $in: ["object-1", "object-2"] },
  });
  expect(findCalls[0]?.[1]).toMatchObject({
    projection: { _listCategories: 1, isPerson: 1, isEvent: 1 },
    maxTimeMS: 3_000,
  });
});

Deno.test("frequent collection debounce keeps independent invalidations", async () => {
  const published: string[] = [];
  const queue = createPerCollectionChangeDebouncer(
    (collectionName) => {
      published.push(collectionName);
    },
    5,
  );

  queue("object_timeline_density");
  queue("object_timeline_density_state");
  queue("object_timeline_density");
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(published.sort()).toEqual([
    "object_timeline_density",
    "object_timeline_density_state",
  ]);
});
