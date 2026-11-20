import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

const TAG_NAME_INDEX = "objects_tag_name_v1";
const NAME_INDEX = "objects_name_v1";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(
    db,
    "objects",
    { isTag: 1, name: 1 },
    {
      name: TAG_NAME_INDEX,
      partialFilterExpression: { isTag: true },
    },
  );
  await ensureIndexExists(db, "objects", { name: 1 }, { name: NAME_INDEX });
}

export async function down(db: Db): Promise<void> {
  const objects = db.collection("objects");
  for (const indexName of [TAG_NAME_INDEX, NAME_INDEX]) {
    if (await objects.indexExists(indexName)) {
      await objects.dropIndex(indexName);
    }
  }
}
