import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

const INDEX_NAME = "speaker_timeline_active_end";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(
    db,
    "diarizations",
    { lifecycleStatus: 1, end: 1, start: 1 },
    { name: INDEX_NAME },
  );
}

export async function down(db: Db): Promise<void> {
  if (await db.collection("diarizations").indexExists(INDEX_NAME)) {
    await db.collection("diarizations").dropIndex(INDEX_NAME);
  }
}
