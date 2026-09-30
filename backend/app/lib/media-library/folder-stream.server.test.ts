import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.15";
import { type Db, ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { up } from "../../../migrations/0084_media_folder_streams.ts";
import {
  authorizeFolderStream,
  dispatchFolderStream,
} from "./folder-stream.server.ts";

const owner = "photo-owner";
const profile = {
  id: "google",
  providerType: "google-cloud",
  name: "EU photos",
};
async function seed(db: Db, count = 5, ceiling = 22_500) {
  await up(db);
  const campaignId = new ObjectId();
  await db.collection("media_folder_campaigns").insertOne({
    _id: campaignId,
    owner,
    relativePath: "archive",
    status: "scanning",
    inventoryInitialized: false,
  });
  const previewId = await preview(db, campaignId, ceiling);
  await authorizeFolderStream(db, owner, previewId);
  const ids: ObjectId[] = [];
  for (let i = 0; i < count; i++) {
    const assetId = new ObjectId();
    ids.push(assetId);
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      status: "staged",
    });
    await db.collection("media_folder_items").insertOne({
      campaignId,
      owner,
      relativePath: `${i}.jpg`,
      state: "imported",
      assetId,
    });
  }
  // Partial waves flush after 30 seconds even if discovery is not complete.
  await db.collection("media_folder_campaigns").updateOne({ _id: campaignId }, {
    $set: { "streaming.confirmedAt": new Date(0) },
  });
  return { campaignId, previewId, ids };
}
async function preview(db: Db, campaignId: ObjectId, ceiling: number) {
  const _id = new ObjectId();
  await db.collection("media_folder_stream_previews").insertOne({
    _id,
    campaignId,
    owner,
    relativePath: "archive",
    sourceRealPath: "/media-source/archive",
    profileSnapshot: profile,
    requestedTasks: ["visual-understanding", "ocr"],
    perAssetMicros: 7_500,
    authorizedMicros: ceiling,
    batchSize: 2,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return _id;
}
function dependencies(db: Db) {
  return {
    eligibleQuery: (principal: string) => ({
      owner: principal,
      status: { $in: ["staged", "failed"] },
    }),
    capacity: () => Promise.resolve({ photos: 500 }),
    prepare: async (campaign: any, ids: string[]) => {
      const _id = new ObjectId();
      await db.collection("media_recognition_batch_previews").insertOne({
        _id,
        owner: campaign.owner,
        profileSnapshot: profile,
        authorizedGrossUsd: ids.length * 0.0075,
        assetRefs: ids.map((id) => ({ assetId: new ObjectId(id), sha256: id })),
        expiresAt: new Date(Date.now() + 60_000),
      });
      return { previewId: String(_id) };
    },
    confirm: async (campaign: any, id: string) => {
      const previewId = new ObjectId(id);
      const existing = await db.collection("media_recognition_batches").findOne(
        { previewId },
      );
      if (existing) return { batch: existing };
      const batch = {
        _id: new ObjectId(),
        previewId,
        owner: campaign.owner,
        status: "running",
      };
      await db.collection("media_recognition_batches").insertOne(batch);
      return { batch };
    },
  };
}
const get = (db: Db, _id: ObjectId) =>
  db.collection<any>("media_folder_campaigns").findOne({ _id });
const finish = (db: Db) =>
  db.collection("media_recognition_batches").updateMany({}, {
    $set: { status: "completed" },
  });

Deno.test(
  "stream imports before scan completion; immutable waves stop exactly at ceiling",
  withFixtures(["Mongo"], async ({ db }) => {
    const { campaignId, previewId } = await seed(db);
    const deps = dependencies(db);
    await authorizeFolderStream(db, owner, previewId); // idempotent confirm
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      (await get(db, campaignId))?.streaming.allocatedMicros,
      15_000,
    );
    assertEquals((await get(db, campaignId))?.inventoryInitialized, false);
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      await db.collection("media_recognition_batches").countDocuments({}),
      1,
    ); // window one
    await finish(db);
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      (await get(db, campaignId))?.streaming.allocatedMicros,
      22_500,
    );
    await finish(db);
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      (await get(db, campaignId))?.streaming.state,
      "budget_exhausted",
    );
    assertEquals(
      await db.collection("media_folder_stream_assets").countDocuments({}),
      3,
    );
    await assertRejects(
      () => authorizeFolderStream(db, "other-owner", previewId),
      Error,
      "not found",
    );
  }),
);

Deno.test(
  "stream replays lost confirmation without double allocation or charging late duplicates",
  withFixtures(["Mongo"], async ({ db }) => {
    const { campaignId, ids } = await seed(db, 2, 100_000);
    const deps = dependencies(db);
    await dispatchFolderStream(db, campaignId, {
      ...deps,
      confirm: async (campaign, id) => {
        await deps.confirm(campaign, id);
        throw new Error("lost response after durable confirmation");
      },
    });
    const interrupted = await get(db, campaignId);
    assertEquals(interrupted?.streaming.state, "paused");
    assertEquals(interrupted?.streaming.allocatedMicros, 15_000);
    // Simulate a preview TTL expiring while paused, then re-authorize.
    await db.collection("media_recognition_batch_previews").deleteMany({});
    const resumeId = await preview(db, campaignId, 100_000);
    await authorizeFolderStream(db, owner, resumeId);
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      (await get(db, campaignId))?.streaming.allocatedMicros,
      15_000,
    );
    assertEquals(
      await db.collection("media_recognition_batches").countDocuments({}),
      1,
    );
    await finish(db);
    await db.collection("media_assets").updateMany({}, {
      $set: { status: "failed" },
    });
    await db.collection("media_folder_items").insertOne({
      campaignId,
      owner,
      relativePath: "late-duplicate.jpg",
      state: "duplicate",
      duplicateAssetId: ids[0],
    });
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      await db.collection("media_recognition_batches").countDocuments({}),
      1,
    );
    assertEquals(
      (await db.collection("media_folder_items").findOne({
        relativePath: "late-duplicate.jpg",
      }))?.streamSkipped,
      true,
    );
  }),
);

Deno.test(
  "paused stream preserves local import and budget waits allocate nothing",
  withFixtures(["Mongo"], async ({ db }) => {
    const { campaignId } = await seed(db, 1);
    const deps = dependencies(db);
    const retryAt = new Date(Date.now() + 86_400_000);
    await dispatchFolderStream(db, campaignId, {
      ...deps,
      capacity: () => Promise.resolve({ photos: 0, retryAt }),
    });
    assertEquals((await get(db, campaignId))?.streaming.allocatedMicros, 0);
    assertEquals((await get(db, campaignId))?.streaming.nextCheckAt, retryAt);
    await db.collection("media_folder_campaigns").updateOne(
      { _id: campaignId },
      { $set: { "streaming.state": "paused" } },
    );
    await dispatchFolderStream(db, campaignId, deps);
    assertEquals(
      await db.collection("media_recognition_batches").countDocuments({}),
      0,
    );
    assertEquals((await get(db, campaignId))?.status, "importing");
  }),
);

Deno.test(
  "concurrent dispatchers allocate one exact wave and reject a changed provider",
  withFixtures(["Mongo"], async ({ db }) => {
    const { campaignId } = await seed(db, 2, 100_000);
    const deps = dependencies(db);
    // Leave the committed wave pending so concurrent confirm recovery is deterministic.
    await Promise.all(
      [1, 2].map(() =>
        dispatchFolderStream(db, campaignId, {
          ...deps,
          confirm: () => Promise.reject(new Error("offline")),
        })
      ),
    );
    assertEquals(
      (await get(db, campaignId))?.streaming.allocatedMicros,
      15_000,
    );
    const resumeId = await preview(db, campaignId, 100_000);
    await authorizeFolderStream(db, owner, resumeId);
    await dispatchFolderStream(db, campaignId, {
      ...deps,
      validate: () => Promise.reject(new Error("profile changed")),
    });
    assertEquals((await get(db, campaignId))?.streaming.state, "paused");
    assertEquals(
      await db.collection("media_recognition_batches").countDocuments({}),
      0,
    );
  }),
);
