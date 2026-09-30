import type { Db } from "mongodb";
import {
  ensureCollectionExists,
  ensureIndexExists,
} from "@/utils/migrations.ts";

export async function up(db: Db): Promise<void> {
  await ensureCollectionExists(db, "media_folder_directories");
  await ensureIndexExists(db, "media_folder_directories", {
    campaignId: 1,
    relativePath: 1,
  }, { name: "media_folder_directory_path_v1", unique: true });
  await ensureIndexExists(db, "media_folder_directories", {
    campaignId: 1,
    state: 1,
    relativePath: 1,
  }, { name: "media_folder_directory_pending_v1" });
  await ensureIndexExists(db, "media_folder_items", {
    campaignId: 1,
    state: 1,
    relativePath: 1,
  }, { name: "media_folder_item_claim_path_v1" });
}

export async function down(db: Db): Promise<void> {
  for (
    const [collection, name] of [
      ["media_folder_directories", "media_folder_directory_path_v1"],
      ["media_folder_directories", "media_folder_directory_pending_v1"],
      ["media_folder_items", "media_folder_item_claim_path_v1"],
    ]
  ) {
    if (await db.collection(collection).indexExists(name)) {
      await db.collection(collection).dropIndex(name);
    }
  }
  // Preserve the discovery cursor and audit history on rollback.
}
