import { type Db, ObjectId } from "mongodb";

export const USD_MICROS = 1_000_000;
export const usdMicros = (usd: number) => Math.round(usd * USD_MICROS);

export function runnableFolderStreams(now = new Date()) {
  return {
    "streaming.state": "running",
    $or: [
      { "streaming.nextCheckAt": { $exists: false } },
      { "streaming.nextCheckAt": { $lte: now } },
    ],
  };
}

export async function authorizeFolderStream(
  db: Db,
  owner: string,
  previewId: ObjectId,
) {
  const previews = db.collection<any>("media_folder_stream_previews");
  const preview = await previews.findOne({ _id: previewId, owner });
  if (!preview) throw new Error("Stream authorization preview was not found");
  const campaigns = db.collection<any>("media_folder_campaigns");
  const campaign = await campaigns.findOne({ _id: preview.campaignId, owner });
  if (!campaign) throw new Error("Folder campaign was not found");
  if (
    campaign.streaming?.authorizationIds?.some((id: unknown) =>
      String(id) === String(previewId)
    )
  ) {
    return campaign;
  }
  if (new Date(preview.expiresAt).getTime() <= Date.now()) {
    throw new Error("Stream authorization preview expired");
  }
  const previous = campaign.streaming;
  if (previous && previous.state === "running") {
    throw new Error("Pause new batches before changing the stream ceiling");
  }
  if (
    previous &&
    JSON.stringify(previous.profileSnapshot) !==
      JSON.stringify(preview.profileSnapshot)
  ) {
    throw new Error(
      "An existing stream cannot change provider; start a new campaign",
    );
  }
  if (preview.authorizedMicros < (previous?.allocatedMicros ?? 0)) {
    throw new Error(
      "The ceiling cannot be lower than already allocated batches",
    );
  }
  const now = new Date();
  const streaming = {
    ...previous,
    state: "running",
    profileSnapshot: preview.profileSnapshot,
    requestedTasks: preview.requestedTasks,
    perAssetMicros: preview.perAssetMicros,
    sourceRealPath: preview.sourceRealPath,
    authorizedMicros: preview.authorizedMicros,
    allocatedMicros: previous?.allocatedMicros ?? 0,
    batchSize: preview.batchSize,
    authorizationIds: [...(previous?.authorizationIds ?? []), previewId],
    authorizations: [...(previous?.authorizations ?? []), {
      id: previewId,
      owner,
      relativePath: preview.relativePath,
      sourceRealPath: preview.sourceRealPath,
      profileSnapshot: preview.profileSnapshot,
      requestedTasks: preview.requestedTasks,
      perAssetMicros: preview.perAssetMicros,
      authorizedMicros: preview.authorizedMicros,
      batchSize: preview.batchSize,
      confirmedAt: now,
    }],
    receiptId: String(previewId),
    confirmedAt: now,
    nextCheckAt: now,
    safeError: null,
  };
  const result = await campaigns.findOneAndUpdate({
    _id: campaign._id,
    owner,
    ...(previous
      ? {
        "streaming.receiptId": previous.receiptId,
        "streaming.state": previous.state,
        "streaming.allocatedMicros": previous.allocatedMicros,
      }
      : { streaming: { $exists: false } }),
  }, {
    $set: {
      streaming,
      ...(["completed", "completed_with_errors"].includes(campaign.status)
        ? {}
        : {
          status: "importing",
          importStartedAt: campaign.importStartedAt ?? now,
        }),
      confirmationReceipt: campaign.confirmationReceipt ?? {
        id: String(previewId),
        principal: owner,
        relativePath: campaign.relativePath,
        mode: "streaming",
        confirmedAt: now,
      },
      updatedAt: now,
    },
  }, { returnDocument: "after" });
  if (!result) {
    const current = await campaigns.findOne({ _id: campaign._id, owner });
    if (
      current?.streaming?.authorizationIds?.some((id: unknown) =>
        String(id) === String(previewId)
      )
    ) return current;
    throw new Error("Stream authorization changed; refresh and retry");
  }
  // Confirmed receipts are retained as audit history, not expired previews.
  await previews.updateOne({ _id: previewId, owner }, {
    $set: { confirmedAt: now },
    $unset: { expiresAt: "" },
  });
  return result;
}

type StreamDependencies = {
  validate?: (campaign: any) => Promise<void>;
  eligibleQuery: (owner: string) => Record<string, unknown>;
  capacity: (
    campaign: any,
  ) => Promise<{ photos: number; retryAt?: Date; reason?: string }>;
  prepare: (campaign: any, assetIds: string[]) => Promise<any>;
  confirm: (campaign: any, previewId: string) => Promise<any>;
};

/** One bounded wave. Parent allocation and exact preview are committed together
 * before dispatch; recovery replays that preview, never generates a new charge. */
export async function dispatchFolderStream(
  db: Db,
  campaignId: ObjectId,
  deps: StreamDependencies,
) {
  const campaigns = db.collection<any>("media_folder_campaigns");
  let campaign = await campaigns.findOne({
    _id: campaignId,
    ...runnableFolderStreams(),
  });
  if (!campaign) return;
  const stream = campaign.streaming;
  await campaigns.updateOne({ _id: campaignId, "streaming.state": "running" }, {
    $set: { "streaming.lastCheckedAt": new Date() },
  });
  const items = db.collection<any>("media_folder_items");
  const batches = db.collection<any>("media_recognition_batches");
  const assignments = db.collection<any>("media_folder_stream_assets");
  const pause = async (reason: string) =>
    await campaigns.updateOne({
      _id: campaignId,
      "streaming.receiptId": stream.receiptId,
      "streaming.state": "running",
    }, {
      $set: { "streaming.state": "paused", "streaming.safeError": reason },
    });
  try {
    await deps.validate?.(campaign);
    if (!stream.pendingWave) {
      if (stream.lastBatchId) {
        const previous = await batches.findOne({
          _id: stream.lastBatchId,
          owner: campaign.owner,
        });
        if (!previous) {
          throw new Error(
            "The previous batch receipt is missing; review before resuming",
          );
        }
        if (["queued", "running"].includes(previous.status)) return;
        if (previous.status === "paused") {
          await pause(
            "The current photo batch needs attention; review it before resuming",
          );
          return;
        }
      }
      const waiting = await items.find({
        campaignId,
        owner: campaign.owner,
        state: { $in: ["imported", "duplicate"] },
        streamHandled: { $ne: true },
      }).sort({ relativePath: 1 }).limit(stream.batchSize).toArray();
      if (!waiting.length) {
        if (["completed", "completed_with_errors"].includes(campaign.status)) {
          await campaigns.updateOne({
            _id: campaignId,
            "streaming.state": "running",
          }, {
            $set: {
              "streaming.state": "completed",
              "streaming.completedAt": new Date(),
            },
          });
        }
        return;
      }
      const ids = [...new Map(waiting.flatMap((item: any) => {
        const id = item.assetId ?? item.duplicateAssetId;
        return id ? [[String(id), id] as const] : [];
      })).values()];
      const assigned = await assignments.find({
        campaignId,
        assetId: { $in: ids },
      }).toArray();
      const assets = await db.collection("media_assets").find({
        $and: [{
          _id: { $in: ids, $nin: assigned.map((entry) => entry.assetId) },
        }, deps.eligibleQuery(campaign.owner)],
      }, { projection: { _id: 1 } }).toArray();
      const eligible = new Set(assets.map((asset) => String(asset._id)));
      const skippedIds = waiting.filter((item: any) =>
        !eligible.has(String(item.assetId ?? item.duplicateAssetId))
      )
        .map((item: any) => item._id);
      if (skippedIds.length) {
        await items.updateMany({ _id: { $in: skippedIds }, campaignId }, {
          $set: { streamHandled: true, streamSkipped: true },
        });
      }
      if (!assets.length) return;
      if (
        assets.length < stream.batchSize &&
        !["completed", "completed_with_errors"].includes(campaign.status) &&
        Date.now() -
              new Date(stream.lastWaveAt ?? stream.confirmedAt).getTime() <
          30_000
      ) return;
      const remaining = Math.floor(
        (stream.authorizedMicros - stream.allocatedMicros) /
          stream.perAssetMicros,
      );
      if (remaining <= 0) {
        await campaigns.updateOne({
          _id: campaignId,
          "streaming.state": "running",
        }, {
          $set: {
            "streaming.state": "budget_exhausted",
            "streaming.safeError":
              "Campaign ceiling allocated; confirm a higher total ceiling to continue",
          },
        });
        return;
      }
      const capacity = await deps.capacity(campaign);
      if (capacity.photos < 1) {
        await campaigns.updateOne({
          _id: campaignId,
          "streaming.state": "running",
        }, {
          $set: {
            "streaming.nextCheckAt": capacity.retryAt ??
              new Date(Date.now() + 60_000),
            "streaming.safeError": capacity.reason ??
              "Waiting for Google budget",
          },
        });
        return;
      }
      const requestedIds = assets.slice(
        0,
        Math.min(remaining, capacity.photos, stream.batchSize),
      ).map((a) => String(a._id));
      const prepared = await deps.prepare(campaign, requestedIds);
      if (prepared.missingOriginalCount) {
        throw new Error(
          "Originals unavailable; reconnect the source disk and resume",
        );
      }
      const preview = await db.collection<any>(
        "media_recognition_batch_previews",
      ).findOne({
        _id: new ObjectId(String(prepared.previewId)),
        owner: campaign.owner,
      });
      if (!preview || !preview.assetRefs.length) return;
      const amount = usdMicros(preview.authorizedGrossUsd);
      if (
        amount !== preview.assetRefs.length * stream.perAssetMicros ||
        JSON.stringify(preview.profileSnapshot) !==
          JSON.stringify(stream.profileSnapshot)
      ) {
        throw new Error(
          "Stream profile or price changed; review the authorization",
        );
      }
      const pendingWave = {
        preview,
        amountMicros: amount,
        receiptId: stream.receiptId,
      };
      campaign = await campaigns.findOneAndUpdate({
        _id: campaignId,
        "streaming.state": "running",
        "streaming.receiptId": stream.receiptId,
        "streaming.allocatedMicros": stream.allocatedMicros,
        "streaming.pendingWave": { $exists: false },
        "streaming.authorizedMicros": { $gte: stream.allocatedMicros + amount },
      }, {
        $inc: { "streaming.allocatedMicros": amount },
        $set: {
          "streaming.pendingWave": pendingWave,
          "streaming.safeError": null,
        },
      }, { returnDocument: "after" });
      if (!campaign) return;
    }
    const wave = campaign.streaming.pendingWave;
    // A durable authorization survives a preview TTL / crash. Only its exact
    // stored SHA receipt can be rehydrated, and only while this stream runs.
    const active = await campaigns.findOne({
      _id: campaignId,
      "streaming.state": "running",
      "streaming.pendingWave.preview._id": wave.preview._id,
    });
    if (!active) return;
    const {
      expiresAt: _expiresAt,
      folderCampaignId: _folder,
      folderStreamReceiptId: _stream,
      ...receipt
    } = wave.preview;
    // One assignment per photo survives late duplicates, failures and restarts.
    // Retrying Google failures requires a separate explicit authorization.
    await assignments.bulkWrite(
      receipt.assetRefs.map((ref: any) => ({
        updateOne: {
          filter: { campaignId, assetId: ref.assetId },
          update: {
            $setOnInsert: {
              campaignId,
              owner: campaign.owner,
              assetId: ref.assetId,
              previewId: receipt._id,
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    await db.collection("media_recognition_batch_previews").updateOne({
      _id: receipt._id,
      owner: campaign.owner,
    }, {
      $setOnInsert: receipt,
      $set: {
        expiresAt: new Date(Date.now() + 60 * 60_000),
        folderCampaignId: campaignId,
        folderStreamReceiptId: wave.receiptId,
      },
    }, { upsert: true });
    const result = await deps.confirm(campaign, String(receipt._id));
    const batch = result.batch;
    if (!batch?._id) {
      throw new Error("Stream batch confirmation did not return a receipt");
    }
    const assetIds = receipt.assetRefs.map((ref: any) => ref.assetId);
    await items.updateMany({
      campaignId,
      owner: campaign.owner,
      $or: [
        { assetId: { $in: assetIds } },
        { duplicateAssetId: { $in: assetIds } },
      ],
    }, { $set: { streamHandled: true, streamBatchId: batch._id } });
    await campaigns.updateOne({
      _id: campaignId,
      "streaming.pendingWave.preview._id": receipt._id,
    }, {
      $set: {
        "streaming.lastBatchId": batch._id,
        "streaming.lastWaveAt": new Date(),
        "streaming.safeError": null,
      },
      $unset: { "streaming.pendingWave": "", "streaming.nextCheckAt": "" },
    });
  } catch (error) {
    await pause(
      String(error instanceof Error ? error.message : error).slice(0, 500),
    );
  }
}
