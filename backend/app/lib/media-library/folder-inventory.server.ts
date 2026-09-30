import { createHash } from "node:crypto";
import { type Db, ObjectId } from "mongodb";
import { readMediaSourceDirectoryPage } from "@/lib/media/local.server.ts";

function inventoryId(campaignId: ObjectId, kind: string, path: string) {
  return new ObjectId(
    createHash("sha256")
      .update(`${campaignId}\0${kind}\0${path}`).digest("hex").slice(0, 24),
  );
}

/** Resume directory discovery before the separate metadata/preview stages. */
export async function processMediaFolderInventory(
  db: Db,
  campaign: {
    _id: ObjectId;
    owner: string;
    relativePath: string;
    streaming?: unknown;
  },
  readPage = readMediaSourceDirectoryPage,
  maxPages = 1,
): Promise<{ processed: number; complete: boolean }> {
  const directories = db.collection<any>("media_folder_directories");
  const now = new Date();
  const directoryUpsert = (relativePath: string) => ({
    updateOne: {
      filter: { campaignId: campaign._id, relativePath },
      update: {
        $setOnInsert: {
          _id: inventoryId(campaign._id, "directory", relativePath),
          campaignId: campaign._id,
          owner: campaign.owner,
          relativePath,
          state: "pending",
          afterName: "",
          createdAt: now,
        },
      },
      upsert: true,
    },
  });
  const seed = directoryUpsert(campaign.relativePath).updateOne;
  await directories.updateOne(seed.filter, seed.update, { upsert: true });
  let directory: any;
  let processed = 0;
  const started = Date.now();
  for (let pageNumber = 0; pageNumber < Math.min(25, maxPages); pageNumber++) {
    directory = await directories.findOne({
      campaignId: campaign._id,
      state: "pending",
    }, { sort: { relativePath: 1 } });
    if (!directory) break;
    const page = await readPage(
      directory.relativePath,
      directory.afterName,
      1_000,
    );
    const childDirectories = page.entries.filter((entry) =>
      entry.kind === "directory"
    );
    const files = page.entries.filter((entry) => entry.kind !== "directory");
    if (childDirectories.length) {
      await directories.bulkWrite(
        childDirectories.map((entry) => directoryUpsert(entry.relativePath)),
        { ordered: false },
      );
    }
    if (files.length) {
      await db.collection("media_folder_items").bulkWrite(
        files.map((entry) => ({
          updateOne: {
            filter: {
              campaignId: campaign._id,
              relativePath: entry.relativePath,
            },
            update: {
              $setOnInsert: {
                _id: inventoryId(campaign._id, "file", entry.relativePath),
                campaignId: campaign._id,
                owner: campaign.owner,
                relativePath: entry.relativePath,
                state: entry.kind === "image" ? "pending" : "unsupported",
                ...(entry.kind === "unsupported"
                  ? { safeError: "Unsupported photo file type" }
                  : {}),
                createdAt: now,
                updatedAt: now,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    // Advance only after every discovered child/file is durable. Replaying a
    // page after a crash is idempotent and never resets inspected file state.
    await directories.updateOne({
      _id: directory._id,
      state: "pending",
      afterName: directory.afterName,
    }, {
      $set: {
        state: page.nextAfterName ? "pending" : "completed",
        afterName: page.nextAfterName ?? directory.afterName,
        updatedAt: now,
      },
    });
    processed += Math.max(1, page.entries.length);
    if (processed >= 1_000 || Date.now() - started >= 1_000) break;
  }
  const remaining = await directories.countDocuments({
    campaignId: campaign._id,
    state: "pending",
  });
  const complete = remaining === 0;
  const discovered = await db.collection("media_folder_items").countDocuments({
    campaignId: campaign._id,
  });
  await db.collection("media_folder_campaigns").updateOne({
    _id: campaign._id,
    inventoryInitialized: { $ne: true },
  }, {
    $set: {
      inventoryDiscovered: discovered,
      inventoryCurrentPath: directory?.relativePath ?? campaign.relativePath,
      inventoryDirectoriesRemaining: remaining,
      lastProgressAt: now,
      updatedAt: now,
      ...(complete
        ? {
          inventoryInitialized: true,
          inventoryTruncated: false,
          scanStartedAt: now,
        }
        : {}),
    },
  });
  if (complete) {
    // A stream can be authorized while an older discovery request is in
    // flight. Never overwrite its newer importing state with scanning.
    await db.collection("media_folder_campaigns").updateOne({
      _id: campaign._id,
      status: { $in: ["queued", "scanning"] },
      streaming: { $exists: false },
    }, { $set: { status: "scanning" } });
  }
  return { processed, complete };
}
