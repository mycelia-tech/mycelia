import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(db, "source_files", {
    ingested: 1,
    ingested_at: -1,
    _id: -1,
  }, {
    name: "audio_imports_recent_v1",
  });
}

export async function down(db: Db): Promise<void> {
  if (
    await db.collection("source_files").indexExists("audio_imports_recent_v1")
  ) {
    await db.collection("source_files").dropIndex("audio_imports_recent_v1");
  }
}
