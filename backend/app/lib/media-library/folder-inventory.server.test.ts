import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.15";
import { type Db, ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { up as createIndexes } from "../../../migrations/0083_media_folder_directory_inventory.ts";
import { processMediaFolderInventory } from "./folder-inventory.server.ts";
import type { MediaDirectoryEntry } from "@/lib/media/local.server.ts";

Deno.test(
  "a stale inventory request cannot reset an authorized stream to scanning",
  withFixtures(["Mongo"], async ({ db }) => {
    const campaign = {
      _id: new ObjectId(),
      owner: "owner",
      relativePath: "archive",
    };
    await db.collection("media_folder_campaigns").insertOne({
      ...campaign,
      status: "importing",
      streaming: { state: "running" },
    });
    await processMediaFolderInventory(
      db,
      campaign,
      () => Promise.resolve({ entries: [] }),
      25,
    );
    assertEquals(
      (await db.collection("media_folder_campaigns").findOne({
        _id: campaign._id,
      }))?.status,
      "importing",
    );
  }),
);

Deno.test(
  "large inventory resumes after a committed page and isolates owners",
  withFixtures(["Mongo"], async ({ db }: { db: Db }) => {
    await createIndexes(db);
    await db.collection("media_folder_items").createIndex({
      campaignId: 1,
      relativePath: 1,
    }, { unique: true });
    const campaign = {
      _id: new ObjectId(),
      owner: "library-owner",
      relativePath: ".",
    };
    await db.collection("media_folder_campaigns").insertOne({
      ...campaign,
      status: "queued",
    });
    const reader = async (path: string, afterName = "", limit = 1_000) => {
      const entries: MediaDirectoryEntry[] = path === "."
        ? Array.from({ length: 21 }, (_, index) => ({
          name: String(index).padStart(2, "0"),
          relativePath: String(index).padStart(2, "0"),
          kind: "directory" as const,
        }))
        : Array.from({ length: 1_002 }, (_, index) => ({
          name: String(index).padStart(4, "0"),
          relativePath: `${path}/${String(index).padStart(4, "0")}`,
          kind: index === 1_001 ? "unsupported" as const : "image" as const,
        }));
      const remaining = entries.filter((entry) => entry.name > afterName);
      return {
        entries: remaining.slice(0, limit),
        ...(remaining.length > limit
          ? { nextAfterName: remaining[limit - 1].name }
          : {}),
      };
    };
    await processMediaFolderInventory(db, campaign, reader);
    // Simulate losing the response/crashing after file upserts but before the
    // directory cursor commit. Production must safely replay exactly that page.
    const interruptedDb = {
      collection(name: string) {
        const collection = db.collection(name);
        if (name !== "media_folder_directories") return collection;
        return new Proxy(collection, {
          get(target, property) {
            if (property === "updateOne") {
              return (query: any, update: any, options: any) => {
                if (query._id) {
                  throw new Error("simulated inventory interruption");
                }
                return target.updateOne(query, update, options);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Db;
    await assertRejects(
      () => processMediaFolderInventory(interruptedDb, campaign, reader),
      Error,
      "simulated inventory interruption",
    );
    assertEquals(
      await db.collection("media_folder_items").countDocuments({
        campaignId: campaign._id,
      }),
      1_000,
    );
    // A prior inspected state must survive page replay, including older campaigns.
    await db.collection("media_folder_items").updateOne({
      campaignId: campaign._id,
      relativePath: "00/0000",
    }, { $set: { state: "ready", sha256: "a".repeat(64) } });
    let completed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await processMediaFolderInventory(db, campaign, reader);
      if (result.complete) {
        completed = true;
        break;
      }
    }
    assertEquals(completed, true);
    assertEquals(
      await db.collection("media_folder_items").countDocuments({
        campaignId: campaign._id,
      }),
      21_042,
    );
    assertEquals(
      await db.collection("media_folder_items").countDocuments({
        campaignId: campaign._id,
        state: "unsupported",
      }),
      21,
    );
    assertEquals(
      (await db.collection("media_folder_items").findOne({
        campaignId: campaign._id,
        relativePath: "00/0000",
      }))?.state,
      "ready",
    );
    assertEquals(
      (await db.collection("media_folder_campaigns").findOne({
        _id: campaign._id,
      }))?.inventoryInitialized,
      true,
    );
    const otherCampaign = {
      ...campaign,
      _id: new ObjectId(),
      owner: "another-owner",
    };
    await db.collection("media_folder_campaigns").insertOne({
      ...otherCampaign,
      status: "queued",
    });
    await processMediaFolderInventory(db, otherCampaign, reader);
    await processMediaFolderInventory(db, otherCampaign, reader);
    assertEquals(
      await db.collection("media_folder_items").countDocuments({
        campaignId: otherCampaign._id,
        owner: "another-owner",
      }),
      1_000,
    );
    assertEquals(
      await db.collection("media_folder_items").countDocuments({
        campaignId: campaign._id,
        owner: "another-owner",
      }),
      0,
    );
  }),
);
