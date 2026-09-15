import type { Db } from "mongodb";
import {
  ensureCollectionExists,
  ensureIndexExists,
} from "@/utils/migrations.ts";

const indexes = [
  ["media_folder_stream_previews", { expiresAt: 1 }, {
    name: "folder_stream_preview_ttl_v1",
    expireAfterSeconds: 0,
  }],
  ["media_folder_stream_assets", { campaignId: 1, assetId: 1 }, {
    name: "folder_stream_asset_once_v1",
    unique: true,
  }],
  ["media_folder_campaigns", {
    "streaming.state": 1,
    "streaming.nextCheckAt": 1,
  }, { name: "folder_stream_runnable_v1" }],
  ["media_folder_items", {
    campaignId: 1,
    state: 1,
    streamHandled: 1,
    relativePath: 1,
  }, { name: "folder_stream_waiting_v1" }],
  ["media_recognition_batches", {
    folderCampaignId: 1,
    owner: 1,
    createdAt: -1,
  }, { name: "folder_stream_batches_v1" }],
] as const;

export async function up(db: Db): Promise<void> {
  for (const [collection, keys, options] of indexes) {
    await ensureCollectionExists(db, collection);
    await ensureIndexExists(db, collection, keys, options);
  }
}

export async function down(db: Db): Promise<void> {
  for (const [collection, _keys, options] of indexes) {
    if (await db.collection(collection).indexExists(options.name)) {
      await db.collection(collection).dropIndex(options.name);
    }
  }
  // Never remove authorization receipts or per-photo assignments on rollback.
}
