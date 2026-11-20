import type { Db } from "mongodb";
import { ensureIndexExists } from "@/utils/migrations.ts";

const INDEX = "location_import_provider_filename";

export async function up(db: Db): Promise<void> {
  await ensureIndexExists(
    db,
    "location_imports",
    { "origin.provider": 1, filename: 1, createdAt: -1, _id: 1 },
    { name: INDEX },
  );
}

export async function down(db: Db): Promise<void> {
  const imports = db.collection("location_imports");
  if (await imports.indexExists(INDEX)) await imports.dropIndex(INDEX);
}
