import type { Db } from "mongodb";
import {
  ensureCollectionExists,
  ensureIndexExists,
} from "@/utils/migrations.ts";

const ASSET_SORT_INDEXES = [
  ["createdAt", "media_asset_inventory_created_v1"],
  ["capturedAt", "media_asset_inventory_captured_v1"],
  ["fileName", "media_asset_inventory_filename_v1"],
  ["status", "media_asset_inventory_status_v1"],
  ["byteLength", "media_asset_inventory_size_v1"],
  ["updatedAt", "media_asset_inventory_updated_v1"],
] as const;

export async function up(db: Db): Promise<void> {
  await ensureCollectionExists(db, "media_asset_deletion_receipts");
  for (const [field, name] of ASSET_SORT_INDEXES) {
    await ensureIndexExists(
      db,
      "media_assets",
      { owner: 1, [field]: 1, _id: 1 },
      { name },
    );
  }
  await ensureIndexExists(
    db,
    "media_assets",
    { owner: 1, recognitionIgnoredAt: 1, status: 1, _id: 1 },
    { name: "media_asset_inventory_ignored_v1" },
  );
  await ensureIndexExists(
    db,
    "media_folder_items",
    {
      owner: 1,
      relativePath: 1,
      sourceModifiedAtMs: 1,
      byteLength: 1,
      updatedAt: -1,
    },
    { name: "media_folder_item_reusable_hash_v1" },
  );
  await ensureIndexExists(
    db,
    "media_asset_deletion_receipts",
    { owner: 1, assetId: 1, removedAt: -1 },
    { name: "media_asset_deletion_receipt_owner_asset_v1" },
  );
}

export async function down(db: Db): Promise<void> {
  for (
    const name of [
      ...ASSET_SORT_INDEXES.map(([, name]) => name),
      "media_asset_inventory_ignored_v1",
    ]
  ) {
    if (await db.collection("media_assets").indexExists(name)) {
      await db.collection("media_assets").dropIndex(name);
    }
  }
  if (
    await db.collection("media_folder_items").indexExists(
      "media_folder_item_reusable_hash_v1",
    )
  ) {
    await db.collection("media_folder_items").dropIndex(
      "media_folder_item_reusable_hash_v1",
    );
  }
  if (
    await db.collection("media_asset_deletion_receipts").indexExists(
      "media_asset_deletion_receipt_owner_asset_v1",
    )
  ) {
    await db.collection("media_asset_deletion_receipts").dropIndex(
      "media_asset_deletion_receipt_owner_asset_v1",
    );
  }
  // Deletion receipts are audit data and intentionally survive rollback.
}
