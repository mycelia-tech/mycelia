import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

export const JOBS_RECENT_LIST_INDEX = "jobs_recent_list_v1";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(
    db,
    "jobs",
    { createdAt: -1, _id: -1 },
    { name: JOBS_RECENT_LIST_INDEX },
  );
}

export async function down(db: Db): Promise<void> {
  const jobs = db.collection("jobs");
  if (await jobs.indexExists(JOBS_RECENT_LIST_INDEX)) {
    await jobs.dropIndex(JOBS_RECENT_LIST_INDEX);
  }
}
