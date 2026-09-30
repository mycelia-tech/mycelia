import { type Db, ObjectId } from "mongodb";

/** Scope legacy results/import memberships without rewriting originals or runs. */
export async function mediaInventoryScope(
  db: Db,
  owner: string,
  filters: { providerProfileId?: string; importCampaignId?: string },
) {
  const conditions: Record<string, unknown>[] = [];
  if (filters.providerProfileId) {
    const runs = await db.collection("media_analysis_runs").find({
      "providerSnapshot.id": filters.providerProfileId,
      state: "ready",
    }, { projection: { _id: 1 } }).toArray();
    conditions.push({ currentRunId: { $in: runs.map((run) => run._id) } });
  }
  if (filters.importCampaignId) {
    const campaignId = new ObjectId(filters.importCampaignId);
    const campaign = await db.collection("media_folder_campaigns").findOne({
      _id: campaignId,
      owner,
    }, { projection: { _id: 1 } });
    const items = campaign
      ? await db.collection("media_folder_items").find({
        campaignId,
        state: { $in: ["imported", "duplicate"] },
      }, { projection: { assetId: 1, duplicateAssetId: 1 } }).toArray()
      : [];
    conditions.push({
      _id: {
        $in: items.flatMap((item) =>
          item.assetId || item.duplicateAssetId
            ? [item.assetId ?? item.duplicateAssetId]
            : []
        ),
      },
    });
  }
  return conditions;
}
