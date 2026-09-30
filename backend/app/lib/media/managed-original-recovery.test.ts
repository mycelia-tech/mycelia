import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.15";
import { type Db, GridFSBucket, ObjectId } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import type { MediaRecognitionProfile } from "@myceliasdk/media.ts";
import {
  availableMediaOriginalStorage,
  cancelManagedOriginalDeletionPreview,
  claimMediaAssetForRecognitionProcessing,
  claimMediaAssetForRecognitionQueue,
  cleanupExpiredStagedOriginals,
  cleanupExpiredStagedPreviews,
  confirmedMediaImportJobId,
  confirmManagedOriginalDeletion,
  enqueueConfirmedAsset,
  finalizeConfirmedImportAsset,
  managedOriginalRecoveryUploadPlan,
  mediaAssetImportRelationship,
  mediaInputFailureStatus,
  restoreManagedOriginalForDuplicate,
  storageModeAfterManagedOriginalDeletion,
  storageModeAfterSourceReferenceDeletion,
} from "./resource.server.ts";
import {
  beginManagedOriginalDeletionConfirmation,
  claimMediaDeletionReservation,
  claimMediaDerivedDeletionState,
  releaseMediaDeletionReservation,
} from "@/lib/media-library/recognition-reservation-fence.server.ts";

const selfHostedProfile: MediaRecognitionProfile = {
  id: "self-hosted-media",
  name: "Self-hosted media recognition",
  providerType: "self-hosted",
  enabled: true,
  concurrency: 1,
  baseUrl: "http://media-provider:8090",
};

async function stageFile(
  db: Db,
  bucketName: "media_originals" | "media_previews",
  fileId: ObjectId,
  importId: ObjectId,
): Promise<void> {
  const stream = new GridFSBucket(db, { bucketName }).openUploadStream(
    `${importId}/${fileId}.bin`,
    {
      id: fileId,
      metadata: {
        state: "staging",
        importId,
        expiresAt: new Date("2026-08-21T13:00:00.000Z"),
      },
    },
  );
  stream.end(new TextEncoder().encode("same original bytes"));
  await new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
}

async function storeCanonicalFile(
  db: Db,
  bucketName: "media_originals" | "media_previews",
  fileId: ObjectId,
  assetId: ObjectId,
): Promise<void> {
  const stream = new GridFSBucket(db, { bucketName }).openUploadStream(
    `${assetId}/${fileId}.bin`,
    {
      id: fileId,
      metadata: { state: "canonical", assetId },
    },
  );
  stream.end(new TextEncoder().encode("canonical media bytes"));
  await new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
}

Deno.test("duplicate upload recovery stages the original and only missing previews", () => {
  assertEquals(managedOriginalRecoveryUploadPlan(undefined), {
    restoresDuplicate: false,
    stageOriginal: true,
    stageThumbnail: true,
    stagePreview: true,
  });
  assertEquals(
    managedOriginalRecoveryUploadPlan({
      thumbnail: { fileId: new ObjectId() },
    }),
    {
      restoresDuplicate: true,
      stageOriginal: true,
      stageThumbnail: false,
      stagePreview: true,
    },
  );
  assertEquals(
    managedOriginalRecoveryUploadPlan({
      managedOriginal: { fileId: new ObjectId() },
    }),
    {
      restoresDuplicate: false,
      stageOriginal: false,
      stageThumbnail: false,
      stagePreview: false,
    },
  );
});

Deno.test("storage mode remains authoritative while old source provenance is retained", () => {
  const source = { relativePath: "prior/photo.jpg" };
  const managedOriginal = { fileId: new ObjectId() };
  assertEquals(
    availableMediaOriginalStorage({
      storageMode: "managed_original",
      source,
      managedOriginal,
    }),
    "managed_original",
  );
  assertEquals(
    availableMediaOriginalStorage({
      storageMode: "preview_only",
      source,
    }),
    null,
  );
  assertEquals(
    storageModeAfterManagedOriginalDeletion({ source }),
    "external_reference",
  );
  assertEquals(
    storageModeAfterManagedOriginalDeletion({}),
    "preview_only",
  );
  assertEquals(
    storageModeAfterSourceReferenceDeletion({ managedOriginal }),
    "managed_original",
  );
  assertEquals(
    storageModeAfterSourceReferenceDeletion({}),
    "preview_only",
  );
});

Deno.test("missing originals become a recoverable source state", () => {
  assertEquals(
    mediaInputFailureStatus(
      new Deno.errors.NotFound("No such file or directory"),
    ),
    "source_missing",
  );
  assertEquals(
    mediaInputFailureStatus(
      new Error("Media asset has no available original source"),
    ),
    "source_missing",
  );
  assertEquals(
    mediaInputFailureStatus(new Error("Preview decode failed")),
    "failed",
  );
});

Deno.test(
  "active confirmation lease protects staged files until its bounded expiry",
  withFixtures(["Mongo"], async ({ db }) => {
    const importId = new ObjectId();
    const originalId = new ObjectId();
    const previewId = new ObjectId();
    await Promise.all([
      stageFile(db, "media_originals", originalId, importId),
      stageFile(db, "media_previews", previewId, importId),
    ]);
    const cleanupAt = new Date("2026-08-21T14:00:00.000Z");
    const leaseExpiresAt = new Date("2026-08-21T15:00:00.000Z");
    await db.collection("media_imports").insertOne({
      _id: importId,
      owner: "lease-owner",
      status: "confirming",
      confirmationExpiresAt: leaseExpiresAt,
      expiresAt: leaseExpiresAt,
    });

    await Promise.all([
      cleanupExpiredStagedOriginals(db, cleanupAt),
      cleanupExpiredStagedPreviews(db, cleanupAt),
    ]);
    assertEquals(
      Boolean(
        await db.collection("media_originals.files").findOne({
          _id: originalId,
        }),
      ),
      true,
    );
    assertEquals(
      Boolean(
        await db.collection("media_previews.files").findOne({
          _id: previewId,
        }),
      ),
      true,
    );

    const afterLease = new Date("2026-08-21T16:00:00.000Z");
    await Promise.all([
      cleanupExpiredStagedOriginals(db, afterLease),
      cleanupExpiredStagedPreviews(db, afterLease),
    ]);
    assertEquals(
      await db.collection("media_originals.files").findOne({ _id: originalId }),
      null,
    );
    assertEquals(
      await db.collection("media_previews.files").findOne({ _id: previewId }),
      null,
    );
  }),
);

Deno.test(
  "duplicate upload restores a managed original without losing provenance",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "managed-original-owner";
    const importId = new ObjectId();
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const existingThumbnailId = new ObjectId();
    const previewId = new ObjectId();
    const sha256 = "a".repeat(64);
    const deletionReceipt = {
      receiptId: "deletion-receipt",
      previousStorageMode: "managed_original",
      byteLength: 19,
      sha256,
      deletedAt: new Date("2026-08-20T12:00:00.000Z"),
    };
    const source = {
      sourceRootId: "default",
      relativePath: "prior/photo.jpg",
    };
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      sha256,
      storageMode: "preview_only",
      source,
      originalDeletionReceipt: deletionReceipt,
      thumbnail: { fileId: existingThumbnailId },
      status: "ready",
      currentRunId: "prior-analysis-run",
    });
    await Promise.all([
      stageFile(db, "media_originals", originalId, importId),
      stageFile(db, "media_previews", previewId, importId),
    ]);

    const restored = await restoreManagedOriginalForDuplicate(
      db,
      owner,
      importId,
      assetId,
      {
        sha256,
        managedOriginal: { fileId: originalId },
        preview: { fileId: previewId },
      },
      new Date("2026-08-21T12:00:00.000Z"),
    );
    assertEquals(restored, true);

    const asset = await db.collection("media_assets").findOne({
      _id: assetId,
    });
    assertEquals(asset?.storageMode, "managed_original");
    assertEquals(asset?.managedOriginal?.fileId, originalId);
    assertEquals(asset?.thumbnail?.fileId, existingThumbnailId);
    assertEquals(asset?.preview?.fileId, previewId);
    assertEquals(asset?.source, source);
    assertEquals(asset?.originalDeletionReceipt, deletionReceipt);
    assertEquals(asset?.status, "ready");
    assertEquals(asset?.currentRunId, "prior-analysis-run");
    assertEquals(asset?.managedOriginalRecovery, undefined);

    for (
      const [bucketName, fileId] of [
        ["media_originals", originalId],
        ["media_previews", previewId],
      ] as const
    ) {
      const file = await db.collection(`${bucketName}.files`).findOne({
        _id: fileId,
      });
      assertEquals(file?.metadata?.state, "canonical");
      assertEquals(file?.metadata?.assetId, assetId);
      assertEquals(file?.metadata?.owner, owner);
      assertEquals(file?.metadata?.expiresAt, undefined);
      assertEquals(file?.metadata?.recoveryLeaseId, undefined);
    }

    const racedOriginalId = new ObjectId();
    await stageFile(db, "media_originals", racedOriginalId, importId);
    assertEquals(
      await restoreManagedOriginalForDuplicate(
        db,
        owner,
        importId,
        assetId,
        {
          sha256,
          managedOriginal: { fileId: racedOriginalId },
        },
      ),
      false,
    );
    assertEquals(
      await db.collection("media_originals.files").findOne({
        _id: racedOriginalId,
      }),
      null,
    );
  }),
);

Deno.test(
  "confirmation resumes partially promoted same-import assets idempotently",
  withFixtures(["Mongo"], async ({ db }) => {
    const importId = new ObjectId();
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const thumbnailId = new ObjectId();
    const previewId = new ObjectId();
    const now = new Date("2026-08-21T12:00:00.000Z");
    const item = {
      sha256: "c".repeat(64),
      managedOriginal: { fileId: originalId },
      thumbnail: { fileId: thumbnailId },
      preview: { fileId: previewId },
      capturedAt: new Date("2026-08-21T08:00:00.000Z"),
      capturedAtTimeZone: "+04:00",
      capturedAtTimeZoneSource: "exif_offset",
      metadata: {
        camera: "resume-fixture",
        location: { latitude: 40.18, longitude: 44.51 },
      },
    };
    await Promise.all([
      stageFile(db, "media_originals", originalId, importId),
      stageFile(db, "media_previews", thumbnailId, importId),
      stageFile(db, "media_previews", previewId, importId),
    ]);
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner: "resume-owner",
      sha256: item.sha256,
      createdByImportId: importId,
      managedOriginal: item.managedOriginal,
      thumbnail: item.thumbnail,
      preview: item.preview,
      status: "staged",
    });

    // Model a process crash after the original was promoted but before either
    // preview, metadata, or queue finalization ran.
    await db.collection("media_originals.files").updateOne(
      { _id: originalId },
      {
        $set: {
          "metadata.state": "canonical",
          "metadata.assetId": assetId,
        },
      },
    );

    assertEquals(
      mediaAssetImportRelationship(
        await db.collection("media_assets").findOne({ _id: assetId }),
        importId,
        item,
      ),
      "created",
    );
    assertEquals(
      mediaAssetImportRelationship(
        await db.collection("media_assets").findOne({ _id: assetId }),
        importId,
        {
          ...item,
          managedOriginal: { fileId: new ObjectId() },
          thumbnail: { fileId: new ObjectId() },
          preview: { fileId: new ObjectId() },
        },
      ),
      null,
    );
    await finalizeConfirmedImportAsset(
      db,
      importId,
      assetId,
      item,
      true,
      now,
    );
    await finalizeConfirmedImportAsset(
      db,
      importId,
      assetId,
      item,
      true,
      now,
    );

    for (
      const [bucketName, fileId] of [
        ["media_originals", originalId],
        ["media_previews", thumbnailId],
        ["media_previews", previewId],
      ] as const
    ) {
      const file = await db.collection(`${bucketName}.files`).findOne({
        _id: fileId,
      });
      assertEquals(file?.metadata?.state, "canonical");
      assertEquals(file?.metadata?.assetId, assetId);
      assertEquals(file?.metadata?.owner, "resume-owner");
      assertEquals(file?.metadata?.expiresAt, undefined);
    }
    assertEquals(
      await db.collection("media_metadata_versions").countDocuments({
        assetId,
        version: 1,
      }),
      1,
    );
    const finalizedAsset = await db.collection("media_assets").findOne({
      _id: assetId,
    });
    assertEquals(finalizedAsset?.capturedAt, item.capturedAt);
    assertEquals(finalizedAsset?.capturedAtTimeZone, "+04:00");
    assertEquals(finalizedAsset?.capturedAtTimeZoneSource, "exif_offset");
    assertEquals(finalizedAsset?.location, {
      latitude: 40.18,
      longitude: 44.51,
    });
    assertEquals(
      confirmedMediaImportJobId(importId, assetId),
      confirmedMediaImportJobId(importId, assetId),
    );
    assertEquals(
      confirmedMediaImportJobId(importId, assetId) ===
        confirmedMediaImportJobId(importId, new ObjectId()),
      false,
    );
  }),
);

Deno.test(
  "confirmation reuses its deterministic persisted job instead of enqueueing twice",
  withFixtures(["Mongo"], async ({ db }) => {
    const importId = new ObjectId();
    const assetId = new ObjectId();
    const recognitionBatchId = new ObjectId().toString();
    const jobId = confirmedMediaImportJobId(importId, assetId);
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner: "queue-owner",
      status: "queued",
    });
    await db.collection("jobs").insertOne({
      _id: new ObjectId(jobId),
      type: "mediaRecognition",
      state: "waiting",
      attempts: 0,
      data: {
        type: "mediaRecognition",
        assetId: assetId.toString(),
        profileSnapshot: selfHostedProfile,
        requestedTasks: ["visual-understanding"],
        consentReceiptId: "stable-consent",
      },
    });
    let enqueueCalls = 0;
    const result = await enqueueConfirmedAsset(
      db,
      assetId,
      selfHostedProfile,
      ["visual-understanding"],
      "stable-consent",
      new Auth({ principal: "queue-owner" }),
      () => {
        enqueueCalls += 1;
        return Promise.resolve({ id: new ObjectId().toString() });
      },
      jobId,
      true,
      recognitionBatchId,
    );
    assertEquals(result, jobId);
    assertEquals(enqueueCalls, 0);
  }),
);

Deno.test(
  "confirmation does not enqueue after the profile is disabled",
  withFixtures(["Mongo"], async ({ db }) => {
    const assetId = new ObjectId();
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner: "disabled-owner",
      status: "queued",
    });
    let enqueueCalls = 0;
    const result = await enqueueConfirmedAsset(
      db,
      assetId,
      selfHostedProfile,
      ["visual-understanding"],
      "disabled-consent",
      new Auth({ principal: "disabled-owner" }),
      () => {
        enqueueCalls += 1;
        return Promise.resolve({ id: new ObjectId().toString() });
      },
      new ObjectId().toString(),
      false,
    );
    assertEquals(result, null);
    assertEquals(enqueueCalls, 0);
    const asset = await db.collection("media_assets").findOne({ _id: assetId });
    assertEquals(asset?.status, "failed");
    assertEquals(
      asset?.safeError,
      "Recognition was not queued because media recognition or its profile is now disabled",
    );
  }),
);

Deno.test(
  "batch confirmation forwards its durable batch link to the child job",
  withFixtures(["Mongo"], async ({ db }) => {
    const assetId = new ObjectId();
    const recognitionBatchId = new ObjectId().toString();
    const expectedJobId = new ObjectId().toString();
    let receivedBatchId: string | undefined;

    const result = await enqueueConfirmedAsset(
      db,
      assetId,
      selfHostedProfile,
      ["visual-understanding"],
      "batch-linked-consent",
      new Auth({ principal: "batch-linked-owner" }),
      (
        _assetId,
        _profile,
        _tasks,
        _consent,
        _auth,
        _jobId,
        childBatchId,
      ) => {
        receivedBatchId = childBatchId;
        return Promise.resolve({ id: expectedJobId });
      },
      undefined,
      true,
      recognitionBatchId,
    );

    assertEquals(result, expectedJobId);
    assertEquals(receivedBatchId, recognitionBatchId);
  }),
);

Deno.test(
  "confirmed imports remain failed and retryable when queueing fails",
  withFixtures(["Mongo"], async ({ db }) => {
    const assetId = new ObjectId();
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner: "queue-owner",
      status: "queued",
    });
    const jobId = await enqueueConfirmedAsset(
      db,
      assetId,
      selfHostedProfile,
      ["visual-understanding"],
      "queue-consent",
      new Auth({ principal: "queue-owner" }),
      () => Promise.reject(new Error("Redis unavailable")),
    );
    assertEquals(jobId, null);
    const asset = await db.collection("media_assets").findOne({ _id: assetId });
    assertEquals(asset?.status, "failed");
    assertEquals(
      asset?.safeError,
      "Recognition could not be queued: Redis unavailable",
    );
  }),
);

Deno.test(
  "managed-original deletion resumes after the file and preview TTL record are gone",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "deletion-resume-owner";
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const previewFileId = new ObjectId();
    const deletionPreviewId = new ObjectId();
    const runId = "deletion-resume-ready-run";
    const sha256 = "d".repeat(64);
    const startedAt = new Date("2026-08-21T12:00:00.000Z");
    await storeCanonicalFile(
      db,
      "media_previews",
      previewFileId,
      assetId,
    );
    await db.collection("media_analysis_runs").insertOne({
      _id: runId,
      assetId,
      state: "ready",
    });
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      storageMode: "managed_original",
      sha256,
      managedOriginal: { bucket: "media_originals", fileId: originalId },
      preview: { fileId: previewFileId },
      currentRunId: runId,
      originalDeletionPending: {
        previewId: deletionPreviewId,
        expectedFileId: originalId,
        expectedPreviewFileId: previewFileId,
        expectedRunId: runId,
        expectedSha256: sha256,
        previousStorageMode: "managed_original",
        byteLength: 23,
        receiptId: "stable-deletion-receipt",
        startedAt,
      },
    });

    const result = await confirmManagedOriginalDeletion(
      db,
      owner,
      deletionPreviewId,
      new Date("2026-08-29T12:00:00.000Z"),
    );
    assertEquals(result.success, true);
    assertEquals(result.receiptId, "stable-deletion-receipt");
    const asset = await db.collection("media_assets").findOne({ _id: assetId });
    assertEquals(asset?.storageMode, "preview_only");
    assertEquals(asset?.managedOriginal, undefined);
    assertEquals(asset?.originalDeletionPending, undefined);
    assertEquals(
      String(asset?.originalDeletionReceipt?.previewId),
      String(deletionPreviewId),
    );
  }),
);

Deno.test(
  "a competing deletion preview cannot replace the durable winner",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "deletion-race-owner";
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const previewFileId = new ObjectId();
    const winnerPreviewId = new ObjectId();
    const loserPreviewId = new ObjectId();
    const runId = "deletion-race-ready-run";
    const sha256 = "e".repeat(64);
    const now = new Date("2026-08-21T12:00:00.000Z");
    await Promise.all([
      storeCanonicalFile(db, "media_originals", originalId, assetId),
      storeCanonicalFile(db, "media_previews", previewFileId, assetId),
      db.collection("media_analysis_runs").insertOne({
        _id: runId,
        assetId,
        state: "ready",
      }),
    ]);
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      storageMode: "managed_original",
      sha256,
      managedOriginal: { bucket: "media_originals", fileId: originalId },
      preview: { fileId: previewFileId },
      currentRunId: runId,
      originalDeletionPending: {
        previewId: winnerPreviewId,
        expectedFileId: originalId,
        expectedPreviewFileId: previewFileId,
        expectedRunId: runId,
        expectedSha256: sha256,
        previousStorageMode: "managed_original",
        byteLength: 23,
        receiptId: "winner-receipt",
        startedAt: now,
      },
    });
    const expiresAt = new Date("2026-08-21T13:00:00.000Z");
    for (const deletionPreviewId of [winnerPreviewId, loserPreviewId]) {
      await db.collection("media_original_deletion_previews").insertOne({
        _id: deletionPreviewId,
        owner,
        assetId,
        expectedFileId: originalId,
        expectedSha256: sha256,
        expectedStorageMode: "managed_original",
        expectedPreviewFileId: previewFileId,
        expectedRunId: runId,
        byteLength: 23,
        expiresAt,
      });
    }

    await assertRejects(
      () => confirmManagedOriginalDeletion(db, owner, loserPreviewId, now),
      Error,
      "Another original deletion is already in progress",
    );
    assertEquals(
      Boolean(
        await db.collection("media_originals.files").findOne({
          _id: originalId,
        }),
      ),
      true,
    );

    const winner = await confirmManagedOriginalDeletion(
      db,
      owner,
      winnerPreviewId,
      now,
    );
    assertEquals(winner.receiptId, "winner-receipt");
    assertEquals(
      await db.collection("media_originals.files").findOne({
        _id: originalId,
      }),
      null,
    );
  }),
);

Deno.test(
  "original deletion rechecks retained preview and analysis before deleting",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "deletion-safety-owner";
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const missingPreviewId = new ObjectId();
    const deletionPreviewId = new ObjectId();
    const runId = "deletion-safety-ready-run";
    const sha256 = "f".repeat(64);
    const now = new Date("2026-08-21T12:00:00.000Z");
    await storeCanonicalFile(db, "media_originals", originalId, assetId);
    await db.collection("media_analysis_runs").insertOne({
      _id: runId,
      assetId,
      state: "ready",
    });
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      storageMode: "managed_original",
      sha256,
      managedOriginal: { bucket: "media_originals", fileId: originalId },
      preview: { fileId: missingPreviewId },
      currentRunId: runId,
    });
    await db.collection("media_original_deletion_previews").insertOne({
      _id: deletionPreviewId,
      owner,
      assetId,
      expectedFileId: originalId,
      expectedSha256: sha256,
      expectedStorageMode: "managed_original",
      expectedPreviewFileId: missingPreviewId,
      expectedRunId: runId,
      byteLength: 23,
      expiresAt: new Date("2026-08-21T13:00:00.000Z"),
    });

    await assertRejects(
      () => confirmManagedOriginalDeletion(db, owner, deletionPreviewId, now),
      Error,
      "Original deletion preview is stale",
    );
    assertEquals(
      Boolean(
        await db.collection("media_originals.files").findOne({
          _id: originalId,
        }),
      ),
      true,
    );
    const asset = await db.collection("media_assets").findOne({ _id: assetId });
    assertEquals(asset?.originalDeletionPending, undefined);
  }),
);

Deno.test(
  "managed-original deletion preview cancel is owner-scoped, idempotent, and loses to confirmation",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "original-preview-cancel-owner";
    const otherOwner = "original-preview-cancel-other";
    const assetId = new ObjectId();
    const deletionPreviewId = new ObjectId();
    const claimId = `managed-original:${deletionPreviewId}`;
    await db.collection("media_original_deletion_previews").insertOne({
      _id: deletionPreviewId,
      owner,
      assetId,
      reservationClaimId: claimId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await claimMediaDeletionReservation(db, {
      owner,
      assetId,
      target: "managed_original",
      claimId,
      deletionPreviewId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    assertEquals(
      await cancelManagedOriginalDeletionPreview(
        db,
        otherOwner,
        deletionPreviewId,
      ),
      { success: true },
    );
    assertEquals(
      await db.collection("media_original_deletion_previews").countDocuments({
        _id: deletionPreviewId,
        owner,
      }),
      1,
    );
    assertEquals(
      await cancelManagedOriginalDeletionPreview(
        db,
        owner,
        deletionPreviewId,
      ),
      { success: true },
    );
    assertEquals(
      await db.collection("media_original_deletion_previews").countDocuments({
        _id: deletionPreviewId,
      }),
      0,
    );
    assertEquals(
      await db.collection("media_recognition_asset_reservations")
        .countDocuments({ owner, assetId }),
      0,
    );
    assertEquals(
      await cancelManagedOriginalDeletionPreview(
        db,
        owner,
        deletionPreviewId,
      ),
      { success: true },
    );

    const confirmingPreviewId = new ObjectId();
    const confirmingClaimId = `managed-original:${confirmingPreviewId}`;
    await db.collection("media_original_deletion_previews").insertOne({
      _id: confirmingPreviewId,
      owner,
      assetId,
      reservationClaimId: confirmingClaimId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await claimMediaDeletionReservation(db, {
      owner,
      assetId,
      target: "managed_original",
      claimId: confirmingClaimId,
      deletionPreviewId: confirmingPreviewId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await beginManagedOriginalDeletionConfirmation(db, {
      owner,
      assetId,
      claimId: confirmingClaimId,
      deletionPreviewId: confirmingPreviewId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await assertRejects(
      () =>
        cancelManagedOriginalDeletionPreview(db, owner, confirmingPreviewId),
      Error,
      "confirmation already started",
    );
    assertEquals(
      await db.collection("media_original_deletion_previews").countDocuments({
        _id: confirmingPreviewId,
        owner,
      }),
      1,
    );

    const recoveredPreviewId = new ObjectId();
    const recoveredAssetId = new ObjectId();
    await Promise.all([
      db.collection("media_original_deletion_previews").insertOne({
        _id: recoveredPreviewId,
        owner,
        assetId: recoveredAssetId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      db.collection("media_assets").insertOne({
        _id: recoveredAssetId,
        owner,
        originalDeletionPending: { previewId: recoveredPreviewId },
      }),
    ]);
    await assertRejects(
      () => cancelManagedOriginalDeletionPreview(db, owner, recoveredPreviewId),
      Error,
      "confirmation already started",
    );
    assertEquals(
      await db.collection("media_original_deletion_previews").countDocuments({
        _id: recoveredPreviewId,
        owner,
      }),
      1,
    );
  }),
);

Deno.test(
  "missing-reservation original confirm and cancel still linearize",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "missing-reservation-confirm-cancel-owner";
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const previewFileId = new ObjectId();
    const deletionPreviewId = new ObjectId();
    const runId = "missing-reservation-confirm-cancel-run";
    const sha256 = "c".repeat(64);
    const now = new Date();
    await Promise.all([
      storeCanonicalFile(db, "media_originals", originalId, assetId),
      storeCanonicalFile(db, "media_previews", previewFileId, assetId),
      db.collection("media_analysis_runs").insertOne({
        _id: runId,
        assetId,
        state: "ready",
      }),
    ]);
    await db.collection("media_assets").insertOne({
      _id: assetId,
      owner,
      kind: "image",
      status: "staged",
      storageMode: "managed_original",
      sha256,
      byteLength: 23,
      managedOriginal: { bucket: "media_originals", fileId: originalId },
      preview: { fileId: previewFileId },
      currentRunId: runId,
    });
    const claimId = `managed-original:${deletionPreviewId}`;
    await db.collection("media_original_deletion_previews").insertOne({
      _id: deletionPreviewId,
      owner,
      assetId,
      expectedFileId: originalId,
      expectedSha256: sha256,
      expectedStorageMode: "managed_original",
      expectedPreviewFileId: previewFileId,
      expectedRunId: runId,
      reservationClaimId: claimId,
      byteLength: 23,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    const [confirmation, cancellation] = await Promise.allSettled([
      confirmManagedOriginalDeletion(db, owner, deletionPreviewId, now),
      cancelManagedOriginalDeletionPreview(db, owner, deletionPreviewId),
    ]);
    assertEquals(
      (confirmation.status === "fulfilled") !==
        (cancellation.status === "fulfilled"),
      true,
    );
    const originalExists = Boolean(
      await db.collection("media_originals.files").findOne({
        _id: originalId,
      }),
    );
    if (confirmation.status === "fulfilled") {
      assertEquals(originalExists, false);
      assertEquals(
        (await db.collection("media_assets").findOne({ _id: assetId }))
          ?.storageMode,
        "preview_only",
      );
    } else {
      assertEquals(originalExists, true);
      assertEquals(
        await db.collection("media_original_deletion_previews")
          .countDocuments({ _id: deletionPreviewId, owner }),
        0,
      );
    }
  }),
);

Deno.test(
  "legacy recognition queue requires exact owner, retryable state, preview, and original",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "legacy-retry-eligibility-owner";
    const asset = {
      _id: new ObjectId(),
      owner,
      kind: "image",
      sha256: "b".repeat(64),
      status: "staged",
      storageMode: "preview_only",
      preview: { fileId: new ObjectId() },
    };
    await db.collection("media_assets").insertOne(asset);
    assertEquals(
      await claimMediaAssetForRecognitionQueue(db, owner, asset),
      null,
    );
    await db.collection("media_assets").updateOne(
      { _id: asset._id },
      {
        $set: {
          storageMode: "managed_original",
          managedOriginal: { fileId: new ObjectId() },
        },
      },
    );
    assertEquals(
      await claimMediaAssetForRecognitionQueue(db, "another-owner", asset),
      null,
    );
    const queued = await claimMediaAssetForRecognitionQueue(db, owner, asset);
    assertEquals(queued?.status, "queued");
    assertEquals(
      await claimMediaAssetForRecognitionQueue(db, owner, asset),
      null,
    );

    const missingPreview = {
      ...asset,
      _id: new ObjectId(),
      status: "failed",
      storageMode: "external_reference",
      source: { relativePath: "missing-preview.jpg" },
      preview: undefined,
    };
    await db.collection("media_assets").insertOne(missingPreview);
    assertEquals(
      await claimMediaAssetForRecognitionQueue(db, owner, missingPreview),
      null,
    );
  }),
);

Deno.test(
  "legacy recognition queue and derived deletion claims are mutually exclusive",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "legacy-retry-derived-race-owner";
    for (let index = 0; index < 20; index += 1) {
      const assetId = new ObjectId();
      const asset = {
        _id: assetId,
        owner,
        kind: "image",
        sha256: String(index).padStart(64, "0"),
        status: "staged",
        storageMode: "managed_original",
        managedOriginal: { fileId: new ObjectId() },
        preview: { fileId: new ObjectId() },
      };
      await db.collection("media_assets").insertOne(asset);
      const deletionClaimId = `derived-race-${index}`;
      const deletionExpiresAt = new Date(Date.now() + 60_000);
      await claimMediaDeletionReservation(db, {
        owner,
        assetId,
        target: "previews",
        claimId: deletionClaimId,
        expiresAt: deletionExpiresAt,
      });
      const [queued, deleting] = await Promise.all([
        claimMediaAssetForRecognitionQueue(db, owner, asset),
        claimMediaDerivedDeletionState(db, {
          owner,
          assetId,
          target: "previews",
          claimId: deletionClaimId,
          expiresAt: deletionExpiresAt,
        }),
      ]);
      assertEquals(Boolean(queued) !== Boolean(deleting), true);
      if (queued) {
        assertEquals(queued.status, "queued");
        assertEquals(
          await claimMediaDerivedDeletionState(db, {
            owner,
            assetId,
            target: "previews",
            claimId: deletionClaimId,
            expiresAt: deletionExpiresAt,
          }),
          null,
        );
        assertEquals(
          (await claimMediaAssetForRecognitionProcessing(
            db,
            owner,
            queued,
          ))?.status,
          "processing",
        );
      } else {
        assertEquals(
          await claimMediaAssetForRecognitionProcessing(db, owner, asset),
          null,
        );
      }
      await releaseMediaDeletionReservation(db, {
        owner,
        assetId,
        target: "previews",
        claimId: deletionClaimId,
        states: ["deleting"],
      });
    }
  }),
);

Deno.test(
  "legacy recognition queue and managed-original confirmation choose one asset state",
  withFixtures(["Mongo"], async ({ db }) => {
    const owner = "legacy-retry-original-race-owner";
    const assetId = new ObjectId();
    const originalId = new ObjectId();
    const previewFileId = new ObjectId();
    const deletionPreviewId = new ObjectId();
    const runId = "legacy-retry-original-race-run";
    const sha256 = "a".repeat(64);
    const now = new Date();
    await Promise.all([
      storeCanonicalFile(db, "media_originals", originalId, assetId),
      storeCanonicalFile(db, "media_previews", previewFileId, assetId),
      db.collection("media_analysis_runs").insertOne({
        _id: runId,
        assetId,
        state: "ready",
      }),
    ]);
    const asset = {
      _id: assetId,
      owner,
      kind: "image",
      status: "staged",
      storageMode: "managed_original",
      sha256,
      byteLength: 23,
      managedOriginal: { bucket: "media_originals", fileId: originalId },
      preview: { fileId: previewFileId },
      currentRunId: runId,
    };
    await db.collection("media_assets").insertOne(asset);
    const claimId = `managed-original:${deletionPreviewId}`;
    await db.collection("media_original_deletion_previews").insertOne({
      _id: deletionPreviewId,
      owner,
      assetId,
      expectedFileId: originalId,
      expectedSha256: sha256,
      expectedStorageMode: "managed_original",
      expectedPreviewFileId: previewFileId,
      expectedRunId: runId,
      reservationClaimId: claimId,
      byteLength: 23,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await claimMediaDeletionReservation(db, {
      owner,
      assetId,
      target: "managed_original",
      claimId,
      deletionPreviewId,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    const [confirmation, queued] = await Promise.allSettled([
      confirmManagedOriginalDeletion(db, owner, deletionPreviewId, now),
      claimMediaAssetForRecognitionQueue(db, owner, asset),
    ]);
    const confirmationWon = confirmation.status === "fulfilled";
    const queueWon = queued.status === "fulfilled" && Boolean(queued.value);
    assertEquals(confirmationWon !== queueWon, true);
    const durable = await db.collection("media_assets").findOne({
      _id: assetId,
    });
    if (confirmationWon) {
      assertEquals(durable?.storageMode, "preview_only");
      assertEquals(durable?.managedOriginal, undefined);
    } else {
      assertEquals(durable?.status, "queued");
      assertEquals(
        Boolean(
          await db.collection("media_originals.files").findOne({
            _id: originalId,
          }),
        ),
        true,
      );
    }
  }),
);
