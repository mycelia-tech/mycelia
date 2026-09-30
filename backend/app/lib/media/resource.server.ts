import { z } from "zod";
import { type Db, GridFSBucket, ObjectId } from "mongodb";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Resource } from "@/lib/auth/resources.ts";
import type { Auth } from "@/lib/auth/core.server.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { enqueueJob } from "@/lib/jobs/queue.ts";
import { inspectGoogleAdc } from "@/lib/gcp/auth.server.ts";
import { mediaInventoryScope } from "./inventory-scope.server.ts";
import {
  bindMediaConfig,
  photoSettingsDto,
  photoSettingsSchema,
  savePhotoProfile,
  savePhotoProfileSchema,
  testPhotoProfile,
  testPhotoProfileSchema,
} from "./provider-settings.server.ts";
import {
  createWebpPreview,
  inspectLocalMedia,
  mediaLocationFromMetadata,
  mediaSourceConfigured,
  normalizeMediaLocation,
  prepareUploadedMedia,
  resolveMediaSourcePath,
  scanMediaSource,
} from "./local.server.ts";
import {
  analyzeWithMediaProvider,
  embedMediaQuery,
  type NormalizedMediaAnalysis,
  testSelfHostedProfile,
} from "./providers.server.ts";
import {
  assertMediaItemsWithinPerImportBudget,
  assertMediaPerImportBudget,
  estimateGoogleConnectorTestGrossUsd,
  estimateMediaGrossUsd,
  gcpUsageLedgerId,
  GOOGLE_DOCUMENT_AI_SMOKE_GROSS_USD,
  GOOGLE_QUERY_EMBEDDING_GROSS_USD,
  GOOGLE_VERTEX_VISUAL_SMOKE_GROSS_USD,
  GOOGLE_VISION_OCR_SMOKE_GROSS_USD,
  summarizeGcpUsage,
} from "./costs.ts";
import { inspectPromoGuard } from "./promo-guard.ts";
import {
  beginGcpBudgetExecution,
  finishGcpBudget,
  type GcpBudgetExecutionClaim,
  reconcileReadyGcpBudget,
  reserveGcpBudget,
} from "./gcp-budget.server.ts";
import {
  claimMediaAnalysisRun,
  markMediaRunFailed,
  markMediaRunOutcomeUnknown,
  markMediaRunProviderStarted,
  markMediaRunReady,
} from "./media-run-claim.server.ts";
import { loadTrustedMediaRecognitionJob } from "./job-auth.server.ts";
import {
  fenceMediaAssetDerivedDeletion,
  invalidateMediaEventsForAsset,
} from "@/lib/media-events/invalidation.server.ts";
import {
  activateSingleMediaRecognitionReservation,
  beginManagedOriginalDeletionCancellation,
  beginManagedOriginalDeletionConfirmation,
  claimMediaDeletionReservation,
  claimMediaDerivedDeletionState,
  claimSingleMediaRecognitionReservation,
  loadManagedOriginalDeletionReservationByPreview,
  loadMediaDeletionReservation,
  loadMediaRecognitionReservationSummary,
  releaseMediaDeletionReservation,
  releaseSingleMediaRecognitionReservation,
  touchSingleMediaRecognitionReservation,
} from "@/lib/media-library/recognition-reservation-fence.server.ts";
import {
  type MediaKnowledgeConfig,
  type MediaRecognitionProfile,
  type MediaRecognitionTask,
  zMediaKnowledgeConfig,
  zMediaRecognitionProfile,
  zMediaRecognitionTask,
} from "@myceliasdk/media.ts";

const requestedTasksSchema = z.array(zMediaRecognitionTask).min(1).max(4)
  .optional();

const statusSchema = z.object({ action: z.literal("status") });
const analyzeSourceSchema = z.object({
  action: z.literal("analyzeSource"),
  relativePath: z.string().min(1).default("."),
  profileId: z.string().min(1).optional(),
  requestedTasks: requestedTasksSchema,
  includeGlobalPhotoAnalysis: z.boolean().optional(),
});
const confirmImportSchema = z.object({
  action: z.literal("confirmImport"),
  importId: z.string().refine(ObjectId.isValid),
  consent: z.literal(true),
  queueRecognition: z.boolean().default(false),
});
const listAssetsSchema = z.object({
  providerProfileId: z.string().trim().min(1).optional(),
  importCampaignId: z.string().refine(ObjectId.isValid).optional(),
  action: z.literal("listAssets"),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  before: z.string().datetime().optional(),
  cursor: z.string().max(200).optional(),
  kind: z.enum(["all", "image", "pdf"]).default("all"),
  query: z.string().trim().min(1).max(200).optional(),
  capturedFrom: z.string().datetime().optional(),
  capturedTo: z.string().datetime().optional(),
  inventoryFilter: z.enum([
    "all",
    "unprocessed",
    "processing",
    "ready",
    "needs_attention",
    "ignored",
  ]).default("all"),
  placement: z.enum(["all", "missing_time", "missing_location"]).default(
    "all",
  ),
  sortBy: z.enum([
    "capturedAt",
    "createdAt",
    "fileName",
    "status",
    "byteLength",
    "updatedAt",
  ]).default("createdAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});
const getAssetSchema = z.object({
  action: z.literal("getAsset"),
  assetId: z.string().refine(ObjectId.isValid),
});
export const mediaSearchQuerySchema = z.string().trim().min(1).max(512);

const searchSchema = z.object({
  action: z.literal("search"),
  // Keep the fixed semantic-search reservation conservative even when the
  // provider tokenizer expands punctuation or non-Latin text aggressively.
  query: mediaSearchQuerySchema,
  limit: z.number().int().min(1).max(50).default(20),
});
const retrySchema = z.object({
  action: z.literal("retry"),
  assetId: z.string().refine(ObjectId.isValid),
  profileId: z.string().min(1).optional(),
  requestedTasks: requestedTasksSchema,
  includeGlobalPhotoAnalysis: z.boolean().optional(),
});
const processAssetSchema = z.object({
  action: z.literal("processAsset"),
  assetId: z.string().refine(ObjectId.isValid),
  profileSnapshot: z.record(z.string(), z.unknown()),
  requestedTasks: requestedTasksSchema,
  includeGlobalPhotoAnalysis: z.boolean().optional(),
  consentReceiptId: z.string().min(1),
  jobId: z.string().refine(ObjectId.isValid),
});
const testConnectorSchema = z.object({
  action: z.literal("testConnector"),
  profileId: z.string().min(1),
  includeDocumentAi: z.boolean().default(true),
});
const deleteDerivedSchema = z.object({
  action: z.literal("deleteDerived"),
  assetId: z.string().refine(ObjectId.isValid),
  target: z.enum([
    "previews",
    "analysis",
    "source_reference",
    "asset_record",
  ]),
  confirm: z.literal(true),
});
const previewOriginalDeletionSchema = z.object({
  action: z.literal("previewOriginalDeletion"),
  assetId: z.string().refine(ObjectId.isValid),
});
const confirmOriginalDeletionSchema = z.object({
  action: z.literal("confirmOriginalDeletion"),
  deletionPreviewId: z.string().refine(ObjectId.isValid),
  confirm: z.literal(true),
});
const cancelOriginalDeletionPreviewSchema = z.object({
  action: z.literal("cancelOriginalDeletionPreview"),
  deletionPreviewId: z.string().refine(ObjectId.isValid),
});

const mediaRequestSchema = z.discriminatedUnion("action", [
  photoSettingsSchema,
  savePhotoProfileSchema,
  testPhotoProfileSchema,
  z.object({
    action: z.literal("getAnalysisRun"),
    assetId: z.string().refine(ObjectId.isValid),
    runId: z.string().min(1),
  }),
  statusSchema,
  analyzeSourceSchema,
  confirmImportSchema,
  listAssetsSchema,
  getAssetSchema,
  searchSchema,
  retrySchema,
  processAssetSchema,
  testConnectorSchema,
  deleteDerivedSchema,
  previewOriginalDeletionSchema,
  confirmOriginalDeletionSchema,
  cancelOriginalDeletionPreviewSchema,
]);

type MediaRequest = z.infer<typeof mediaRequestSchema>;

function objectId(value: unknown): ObjectId {
  return value instanceof ObjectId ? value : new ObjectId(String(value));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\/media-source\/?/g, "[media-source]/")
    .slice(0, 700);
}

function normalizeRequestedTasks(input: {
  requestedTasks?: MediaRecognitionTask[];
  includeGlobalPhotoAnalysis?: boolean;
}): MediaRecognitionTask[] {
  const tasks = input.requestedTasks ??
    (input.includeGlobalPhotoAnalysis
      ? ["visual-understanding", "ocr", "labels", "objects"]
      : ["visual-understanding"]);
  return ([
    "visual-understanding",
    "ocr",
    "labels",
    "objects",
  ] as MediaRecognitionTask[]).filter(
    (task) => tasks.includes(task),
  );
}

function assertTasksAllowed(
  profile: MediaRecognitionProfile,
  tasks: MediaRecognitionTask[],
): void {
  if (tasks.length === 0) {
    throw new Error("Select at least one recognition task");
  }
  if (
    profile.providerType === "google-cloud" &&
    tasks.some((task) => task === "labels" || task === "objects") &&
    !profile.allowGlobalPhotoAnalysis
  ) {
    throw new Error(
      "Global labels/objects are not enabled for this Google profile",
    );
  }
}

async function loadMediaConfig(): Promise<MediaKnowledgeConfig> {
  const config = await getServerConfig();
  return bindMediaConfig(config);
}

function selectProfile(
  config: MediaKnowledgeConfig,
  requestedId?: string,
): MediaRecognitionProfile {
  const id = requestedId ?? config.activeProfileId;
  const profile = config.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error("Media recognition profile was not found");
  if (!profile.enabled) {
    throw new Error("Media recognition profile is disabled");
  }
  return profile;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function uploadGridFs(
  db: Db,
  bucketName: string,
  filename: string,
  data: Uint8Array,
  metadata: Record<string, unknown>,
): Promise<ObjectId> {
  const bucket = new GridFSBucket(db, { bucketName });
  const id = new ObjectId();
  const stream = bucket.openUploadStream(filename, { id, metadata });
  stream.end(Buffer.from(data));
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  return id;
}

async function downloadGridFs(
  db: Db,
  bucketName: string,
  id: ObjectId,
): Promise<Uint8Array> {
  const stream = new GridFSBucket(db, { bucketName }).openDownloadStream(id);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

async function deleteGridFs(
  db: Db,
  bucketName: string,
  id: unknown,
): Promise<void> {
  if (!id) return;
  await new GridFSBucket(db, { bucketName }).delete(objectId(id)).catch(
    () => {},
  );
}

async function deleteGridFsStrict(
  db: Db,
  bucketName: string,
  id: unknown,
): Promise<void> {
  if (!id) throw new Error("GridFS file id is required");
  await new GridFSBucket(db, { bucketName }).delete(objectId(id));
}

function previewResponse(item: any) {
  return {
    ...item,
    realPath: undefined,
    metadata: undefined,
    thumbnailUrl: item.thumbnail?.fileId
      ? `/api/files/${item.thumbnail.fileId}?bucket=media_previews`
      : undefined,
  };
}

export function mediaAssetLocation(asset: any) {
  return normalizeMediaLocation(asset.location) ??
    mediaLocationFromMetadata(asset.metadata);
}

function mediaAssetResponse(asset: any) {
  const location = mediaAssetLocation(asset);
  return {
    ...asset,
    ...(location ? { location } : {}),
    thumbnailUrl: asset.thumbnail?.fileId
      ? `/api/files/${asset.thumbnail.fileId}?bucket=media_previews`
      : undefined,
    previewUrl: asset.preview?.fileId
      ? `/api/files/${asset.preview.fileId}?bucket=media_previews`
      : undefined,
  };
}

function mediaAssetCursor(input: {
  offset: number;
  sortBy: z.infer<typeof listAssetsSchema>["sortBy"];
  sortDirection: z.infer<typeof listAssetsSchema>["sortDirection"];
}): string {
  return btoa(JSON.stringify({ v: 2, ...input }));
}

function decodeMediaAssetCursor(value: string): {
  offset?: number;
  sortBy?: z.infer<typeof listAssetsSchema>["sortBy"];
  sortDirection?: z.infer<typeof listAssetsSchema>["sortDirection"];
  createdAt?: Date;
  id?: ObjectId;
} {
  try {
    const decoded = atob(value);
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded);
      const sorts = [
        "capturedAt",
        "createdAt",
        "fileName",
        "status",
        "byteLength",
        "updatedAt",
      ];
      if (
        parsed?.v !== 2 || !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0 || !sorts.includes(parsed.sortBy) ||
        !["asc", "desc"].includes(parsed.sortDirection)
      ) throw new Error("invalid cursor");
      return parsed;
    }
    const [date, id] = decoded.split("|");
    const createdAt = new Date(date);
    if (!Number.isFinite(createdAt.getTime()) || !ObjectId.isValid(id)) {
      throw new Error("invalid cursor");
    }
    return { createdAt, id: new ObjectId(id) };
  } catch {
    throw new Error("Invalid Media Library cursor");
  }
}

function mediaInventoryFilterQuery(
  filter: z.infer<typeof listAssetsSchema>["inventoryFilter"],
): Record<string, unknown> {
  if (filter === "ready") return { currentRunId: { $type: "string" } };
  if (filter === "processing") {
    return { status: { $in: ["queued", "processing"] } };
  }
  if (filter === "needs_attention") {
    return {
      recognitionIgnoredAt: { $exists: false },
      status: {
        $in: [
          "failed",
          "budget_blocked",
          "recognition_disabled",
          "source_missing",
          "source_changed",
        ],
      },
    };
  }
  if (filter === "unprocessed") {
    return {
      currentRunId: { $exists: false },
      recognitionIgnoredAt: { $exists: false },
      status: { $nin: ["ready", "queued", "processing"] },
    };
  }
  if (filter === "ignored") {
    return { recognitionIgnoredAt: { $type: "date" } };
  }
  return {};
}

export function mediaPlacementFilterQuery(
  placement: z.infer<typeof listAssetsSchema>["placement"],
): Record<string, unknown> {
  if (placement === "missing_time") {
    return { $nor: [{ capturedAt: { $type: "date" } }] };
  }
  if (placement === "missing_location") {
    return { $nor: [{ "geo.type": "Point" }] };
  }
  return {};
}

function escapeMongoRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mediaAssetListFilterQuery(
  owner: string,
  input: Pick<
    z.infer<typeof listAssetsSchema>,
    | "inventoryFilter"
    | "placement"
    | "kind"
    | "query"
    | "capturedFrom"
    | "capturedTo"
  >,
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    owner,
    ...mediaInventoryFilterQuery(input.inventoryFilter),
    ...mediaPlacementFilterQuery(input.placement),
  };
  if (input.kind !== "all") query.kind = input.kind;
  if (input.query) {
    const pattern = escapeMongoRegex(input.query);
    query.$or = [
      { fileName: { $regex: pattern, $options: "i" } },
      { "source.relativePath": { $regex: pattern, $options: "i" } },
    ];
  }
  if (input.capturedFrom || input.capturedTo) {
    const range: Record<string, Date> = {};
    if (input.capturedFrom) range.$gte = new Date(input.capturedFrom);
    if (input.capturedTo) range.$lte = new Date(input.capturedTo);
    if (range.$gte && range.$lte && range.$gte > range.$lte) {
      throw new Error("Capture date start must not be after the end");
    }
    query.capturedAt = range;
  }
  return query;
}

export function mediaAssetSortSpec(
  sortBy: z.infer<typeof listAssetsSchema>["sortBy"],
  sortDirection: z.infer<typeof listAssetsSchema>["sortDirection"],
) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return { [sortBy]: direction, _id: direction } as Record<string, 1 | -1>;
}

const STAGED_ORIGINAL_TTL_MS = 60 * 60 * 1000;
const CONFIRMING_IMPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_DERIVED_DELETION_LEASE_MS = 15 * 60 * 1000;
const MEDIA_SINGLE_RECOGNITION_PREPARE_TTL_MS = 15 * 60 * 1000;

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "application/pdf") return "pdf";
  return "bin";
}

async function cleanupExpiredStagedFiles(
  db: Db,
  bucketName: "media_originals" | "media_previews",
  limit: number,
  now = new Date(),
): Promise<void> {
  const expired = await db.collection(`${bucketName}.files`).find({
    "metadata.state": "staging",
    "metadata.expiresAt": { $lte: now },
  }, { projection: { _id: 1, "metadata.importId": 1 } }).limit(limit)
    .toArray();
  const importIds = [...new Map(
    expired.flatMap((file) => {
      try {
        const id = objectId(file.metadata?.importId);
        return [[String(id), id] as const];
      } catch {
        return [];
      }
    }),
  ).values()];
  const protectedImportIds = importIds.length === 0
    ? new Set<string>()
    : new Set(
      (await db.collection("media_imports").find({
        _id: { $in: importIds },
        status: "confirming",
        confirmationExpiresAt: { $gt: now },
      }, { projection: { _id: 1 } }).toArray()).map((record) =>
        String(record._id)
      ),
    );
  await Promise.all(
    expired.filter((file) =>
      !protectedImportIds.has(String(file.metadata?.importId ?? ""))
    ).map((file) => deleteGridFs(db, bucketName, file._id)),
  );
}

export async function cleanupExpiredStagedOriginals(
  db: Db,
  now = new Date(),
): Promise<void> {
  await cleanupExpiredStagedFiles(db, "media_originals", 500, now);
}

export async function cleanupExpiredStagedPreviews(
  db: Db,
  now = new Date(),
): Promise<void> {
  await cleanupExpiredStagedFiles(
    db,
    "media_previews",
    1_000,
    now,
  );
}

type ManagedOriginalRecoveryItem = {
  sha256: string;
  managedOriginal?: { fileId?: unknown };
  thumbnail?: { fileId?: unknown };
  preview?: { fileId?: unknown };
};

type ManagedOriginalRecoveryRef = {
  bucketName: "media_originals" | "media_previews";
  fileId: ObjectId;
  assetField: "managedOriginal" | "thumbnail" | "preview";
};

export function managedOriginalRecoveryUploadPlan(
  duplicate?: {
    managedOriginal?: { fileId?: unknown };
    thumbnail?: { fileId?: unknown };
    preview?: { fileId?: unknown };
  } | null,
): {
  restoresDuplicate: boolean;
  stageOriginal: boolean;
  stageThumbnail: boolean;
  stagePreview: boolean;
} {
  if (!duplicate) {
    return {
      restoresDuplicate: false,
      stageOriginal: true,
      stageThumbnail: true,
      stagePreview: true,
    };
  }
  const restoresDuplicate = !duplicate.managedOriginal?.fileId;
  return {
    restoresDuplicate,
    stageOriginal: restoresDuplicate,
    stageThumbnail: restoresDuplicate && !duplicate.thumbnail?.fileId,
    stagePreview: restoresDuplicate && !duplicate.preview?.fileId,
  };
}

export function availableMediaOriginalStorage(
  value: unknown,
): "managed_original" | "external_reference" | null {
  const asset = value as {
    storageMode?: unknown;
    source?: { relativePath?: unknown };
    managedOriginal?: { fileId?: unknown };
  };
  if (
    asset.storageMode === "managed_original" && asset.managedOriginal?.fileId
  ) {
    return "managed_original";
  }
  if (
    asset.storageMode === "external_reference" && asset.source?.relativePath
  ) {
    return "external_reference";
  }
  return null;
}

const MEDIA_RECOGNITION_RETRYABLE_STATUSES = [
  "staged",
  "failed",
  "budget_blocked",
  "recognition_disabled",
] as const;

function mediaRecognitionAssetClaimQuery(
  owner: string,
  asset: {
    _id: ObjectId;
    kind?: unknown;
    sha256?: unknown;
    status?: unknown;
  },
  allowedStatuses: readonly string[],
) {
  if (
    !["image", "pdf"].includes(String(asset.kind)) ||
    !allowedStatuses.includes(String(asset.status))
  ) return null;
  return {
    _id: asset._id,
    owner,
    kind: asset.kind,
    sha256: asset.sha256,
    status: asset.status,
    derivedDeletionPending: { $exists: false },
    originalDeletionPending: { $exists: false },
    ...(asset.kind === "image"
      ? { "preview.fileId": { $type: "objectId" } }
      : {}),
    $or: [
      {
        storageMode: "managed_original",
        "managedOriginal.fileId": { $type: "objectId" },
      },
      {
        storageMode: "external_reference",
        "source.relativePath": { $type: "string" },
      },
    ],
  };
}

export async function claimMediaAssetForRecognitionQueue(
  db: Db,
  owner: string,
  asset: {
    _id: ObjectId;
    kind?: unknown;
    sha256?: unknown;
    status?: unknown;
  },
) {
  const query = mediaRecognitionAssetClaimQuery(
    owner,
    asset,
    MEDIA_RECOGNITION_RETRYABLE_STATUSES,
  );
  if (!query) return null;
  return await db.collection<any>("media_assets").findOneAndUpdate(
    query,
    {
      $set: { status: "queued", safeError: null, updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
}

export async function claimMediaAssetForRecognitionProcessing(
  db: Db,
  owner: string,
  asset: {
    _id: ObjectId;
    kind?: unknown;
    sha256?: unknown;
    status?: unknown;
  },
  singleReservation?: { jobId: ObjectId | string; claimId: string },
) {
  if (
    singleReservation &&
    !await touchSingleMediaRecognitionReservation(db, {
      owner,
      assetId: asset._id,
      jobId: singleReservation.jobId,
      claimId: singleReservation.claimId,
    })
  ) return null;
  const query = mediaRecognitionAssetClaimQuery(
    owner,
    asset,
    ["queued", "processing"],
  );
  if (!query) return null;
  return await db.collection<any>("media_assets").findOneAndUpdate(
    {
      ...query,
      // A duplicate execution of the same durable job may have loaded its
      // asset while it was still queued, after which the owning execution
      // moved it to processing. The reservation above proves exact job
      // ownership; accept either live state without weakening the remaining
      // immutable/source/deletion fences in `query`.
      status: { $in: ["queued", "processing"] },
    },
    {
      $set: { status: "processing", safeError: null, updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
}

export function storageModeAfterManagedOriginalDeletion(
  value: unknown,
): "external_reference" | "preview_only" {
  const asset = value as { source?: { relativePath?: unknown } };
  return asset.source?.relativePath ? "external_reference" : "preview_only";
}

export function storageModeAfterSourceReferenceDeletion(
  value: unknown,
): "managed_original" | "preview_only" {
  const asset = value as { managedOriginal?: { fileId?: unknown } };
  return asset.managedOriginal?.fileId ? "managed_original" : "preview_only";
}

async function deleteManagedOriginalIfPresent(
  db: Db,
  fileId: ObjectId,
): Promise<void> {
  const files = db.collection("media_originals.files");
  if (!await files.findOne({ _id: fileId }, { projection: { _id: 1 } })) {
    return;
  }
  try {
    await deleteGridFsStrict(db, "media_originals", fileId);
  } catch (error) {
    // A crash or competing retry may have completed the exact pending delete
    // after our existence check. Missing is success only for this helper's
    // already-claimed deletion; any remaining file preserves the real error.
    if (await files.findOne({ _id: fileId }, { projection: { _id: 1 } })) {
      throw error;
    }
  }
}

export async function confirmManagedOriginalDeletion(
  db: Db,
  owner: string,
  previewId: ObjectId,
  now = new Date(),
) {
  const previews = db.collection<any>("media_original_deletion_previews");
  let deletion = await previews.findOne({
    _id: previewId,
    owner,
    confirmedAt: { $exists: false },
  });
  const assets = db.collection<any>("media_assets");
  let asset = deletion
    ? await assets.findOne({ _id: objectId(deletion.assetId), owner })
    : await assets.findOne({
      owner,
      $or: [
        { "originalDeletionPending.previewId": previewId },
        { "originalDeletionReceipt.previewId": previewId },
      ],
    });
  if (!asset) {
    throw new Error("Original deletion preview is stale; review again");
  }
  if (["queued", "processing"].includes(String(asset.status))) {
    throw new Error(
      "Media analysis is active. Wait for it to finish or stop it before deleting the managed original.",
    );
  }
  const existingDeletionReservation =
    await loadManagedOriginalDeletionReservationByPreview(
      db,
      owner,
      previewId,
    );
  const managedDeletionClaimId = String(
    deletion?.reservationClaimId ??
      asset.originalDeletionPending?.reservationClaimId ??
      existingDeletionReservation?.deletionClaimId ??
      `managed-original:${previewId}`,
  );

  const returnFinalized = async (finalized: any) => {
    const receipt = finalized.originalDeletionReceipt;
    await previews.updateOne(
      { _id: previewId, owner },
      {
        $set: {
          confirmedAt: receipt.deletedAt,
          receiptId: receipt.receiptId,
        },
        $unset: { expiresAt: "" },
      },
    );
    await releaseMediaDeletionReservation(db, {
      owner,
      assetId: finalized._id,
      target: "managed_original",
      claimId: managedDeletionClaimId,
      states: ["confirming"],
    });
    return {
      success: true,
      assetId: finalized._id,
      storageMode: finalized.storageMode,
      receiptId: receipt.receiptId,
      deletedAt: receipt.deletedAt,
      retained: ["WebP previews", "metadata", "analysis", "search index"],
    };
  };

  if (
    String(asset.originalDeletionReceipt?.previewId ?? "") ===
      String(previewId) && !asset.managedOriginal?.fileId
  ) {
    return await returnFinalized(asset);
  }

  if (!deletion) {
    const pending = asset.originalDeletionPending;
    if (String(pending?.previewId ?? "") !== String(previewId)) {
      throw new Error("Original deletion preview is missing or expired");
    }
    deletion = {
      _id: previewId,
      owner,
      assetId: asset._id,
      expectedFileId: pending.expectedFileId,
      expectedSha256: pending.expectedSha256,
      expectedStorageMode: pending.previousStorageMode,
      expectedPreviewFileId: pending.expectedPreviewFileId,
      expectedRunId: pending.expectedRunId,
      byteLength: pending.byteLength,
      reservationClaimId: pending.reservationClaimId,
      confirmationStartedAt: pending.startedAt,
    };
  }

  const expectedFileId = objectId(deletion.expectedFileId);
  const expectedPreviewFileId = objectId(
    deletion.expectedPreviewFileId ??
      asset.preview?.fileId ?? asset.thumbnail?.fileId,
  );
  const expectedRunId = String(deletion.expectedRunId ?? asset.currentRunId);
  const pendingMatches = (candidate: any) =>
    String(candidate?.originalDeletionPending?.previewId ?? "") ===
      String(previewId) &&
    String(candidate?.originalDeletionPending?.expectedFileId ?? "") ===
      String(expectedFileId);
  const exactPending = pendingMatches(asset);
  const unexpired = new Date(deletion.expiresAt).getTime() > now.getTime();
  if (!unexpired && !exactPending) {
    throw new Error("Original deletion preview is missing or expired");
  }
  if (
    !exactPending &&
    (asset.storageMode !== deletion.expectedStorageMode ||
      asset.sha256 !== deletion.expectedSha256 ||
      String(asset.managedOriginal?.fileId ?? "") !== String(expectedFileId) ||
      String(asset.preview?.fileId ?? asset.thumbnail?.fileId ?? "") !==
        String(expectedPreviewFileId) ||
      String(asset.currentRunId ?? "") !== expectedRunId)
  ) {
    throw new Error("Original deletion preview is stale; review again");
  }
  await claimMediaDeletionReservation(db, {
    owner,
    assetId: asset._id,
    target: "managed_original",
    claimId: managedDeletionClaimId,
    deletionPreviewId: previewId,
    expiresAt: new Date(now.getTime() + CONFIRMING_IMPORT_TTL_MS),
  });
  await beginManagedOriginalDeletionConfirmation(db, {
    owner,
    assetId: asset._id,
    claimId: managedDeletionClaimId,
    deletionPreviewId: previewId,
    expiresAt: new Date(now.getTime() + CONFIRMING_IMPORT_TTL_MS),
  });

  if (!exactPending) {
    const [original, preview, run] = await Promise.all([
      db.collection("media_originals.files").findOne({
        _id: expectedFileId,
        "metadata.state": "canonical",
      }, { projection: { _id: 1 } }),
      db.collection("media_previews.files").findOne({
        _id: expectedPreviewFileId,
      }, { projection: { _id: 1 } }),
      db.collection<any>("media_analysis_runs").findOne({
        _id: expectedRunId,
        assetId: asset._id,
        state: "ready",
      }, { projection: { _id: 1 } }),
    ]);
    if (!original || !preview || !run) {
      await releaseMediaDeletionReservation(db, {
        owner,
        assetId: asset._id,
        target: "managed_original",
        claimId: managedDeletionClaimId,
        states: ["confirming"],
      });
      throw new Error("Original deletion preview is stale; review again");
    }
    const recoveryLeaseExpiresAt = new Date(
      now.getTime() + CONFIRMING_IMPORT_TTL_MS,
    );
    const renewed = await previews.updateOne(
      {
        _id: previewId,
        owner,
        expiresAt: { $gt: now },
        confirmedAt: { $exists: false },
      },
      {
        $set: {
          confirmationStartedAt: now,
          recoveryLeaseExpiresAt,
          expiresAt: recoveryLeaseExpiresAt,
        },
      },
    );
    if (renewed.modifiedCount !== 1) {
      await releaseMediaDeletionReservation(db, {
        owner,
        assetId: asset._id,
        target: "managed_original",
        claimId: managedDeletionClaimId,
        states: ["confirming"],
      });
      throw new Error("Original deletion preview is missing or expired");
    }
    const receiptId = randomUUID();
    const claimed = await assets.findOneAndUpdate(
      {
        _id: asset._id,
        owner,
        storageMode: "managed_original",
        sha256: deletion.expectedSha256,
        status: { $nin: ["queued", "processing"] },
        "managedOriginal.fileId": expectedFileId,
        currentRunId: expectedRunId,
        $or: [
          { "preview.fileId": expectedPreviewFileId },
          { "thumbnail.fileId": expectedPreviewFileId },
        ],
        originalDeletionPending: { $exists: false },
        derivedDeletionPending: { $exists: false },
      },
      {
        $set: {
          originalDeletionPending: {
            previewId,
            expectedFileId,
            expectedPreviewFileId,
            expectedRunId,
            expectedSha256: deletion.expectedSha256,
            previousStorageMode: deletion.expectedStorageMode,
            byteLength: deletion.byteLength,
            reservationClaimId: managedDeletionClaimId,
            receiptId,
            startedAt: now,
          },
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    asset = claimed ?? await assets.findOne({ _id: asset._id, owner });
    if (
      String(asset?.originalDeletionReceipt?.previewId ?? "") ===
        String(previewId) && !asset?.managedOriginal?.fileId
    ) {
      return await returnFinalized(asset);
    }
    if (!asset || !pendingMatches(asset)) {
      await releaseMediaDeletionReservation(db, {
        owner,
        assetId: deletion.assetId,
        target: "managed_original",
        claimId: managedDeletionClaimId,
        states: ["confirming"],
      });
      throw new Error(
        "Another original deletion is already in progress; review again",
      );
    }
  }

  const pending = asset.originalDeletionPending;
  const [previewStillReady, runStillReady] = await Promise.all([
    db.collection("media_previews.files").findOne({
      _id: expectedPreviewFileId,
    }, { projection: { _id: 1 } }),
    db.collection<any>("media_analysis_runs").findOne({
      _id: expectedRunId,
      assetId: asset._id,
      state: "ready",
    }, { projection: { _id: 1 } }),
  ]);
  if (!previewStillReady || !runStillReady) {
    const originalStillPresent = await db.collection("media_originals.files")
      .findOne({ _id: expectedFileId }, { projection: { _id: 1 } });
    if (originalStillPresent) {
      await assets.updateOne(
        {
          _id: asset._id,
          owner,
          "originalDeletionPending.previewId": previewId,
          "originalDeletionPending.receiptId": pending.receiptId,
        },
        { $unset: { originalDeletionPending: "" } },
      );
      await releaseMediaDeletionReservation(db, {
        owner,
        assetId: asset._id,
        target: "managed_original",
        claimId: managedDeletionClaimId,
        states: ["confirming"],
      });
      throw new Error("Original deletion preview is stale; review again");
    }
  }
  await deleteManagedOriginalIfPresent(db, expectedFileId);
  const deletedAt = new Date();
  const storageMode = storageModeAfterManagedOriginalDeletion(asset);
  const result = await assets.updateOne(
    {
      _id: asset._id,
      owner,
      "managedOriginal.fileId": expectedFileId,
      "originalDeletionPending.previewId": previewId,
      "originalDeletionPending.expectedFileId": expectedFileId,
      "originalDeletionPending.receiptId": pending.receiptId,
    },
    {
      $set: {
        storageMode,
        originalDeletedAt: deletedAt,
        originalDeletionReceipt: {
          receiptId: pending.receiptId,
          previewId,
          previousStorageMode: "managed_original",
          byteLength: deletion.byteLength,
          sha256: deletion.expectedSha256,
          reservationClaimId: managedDeletionClaimId,
          deletedAt,
        },
        updatedAt: deletedAt,
      },
      $unset: { managedOriginal: "", originalDeletionPending: "" },
    },
  );
  if (result.modifiedCount !== 1) {
    const finalized = await assets.findOne({ _id: asset._id, owner });
    if (
      String(finalized?.originalDeletionReceipt?.previewId ?? "") ===
        String(previewId) && !finalized?.managedOriginal?.fileId
    ) {
      return await returnFinalized(finalized);
    }
    throw new Error("Original was deleted but the asset state requires repair");
  }

  const finalized = await assets.findOne({ _id: asset._id, owner });
  if (!finalized) {
    throw new Error("Original was deleted but the asset state requires repair");
  }
  return await returnFinalized(finalized);
}

export async function cancelManagedOriginalDeletionPreview(
  db: Db,
  owner: string,
  deletionPreviewId: ObjectId,
) {
  const [preview, existingReservation, pendingAsset] = await Promise.all([
    db.collection<any>("media_original_deletion_previews").findOne({
      _id: deletionPreviewId,
      owner,
      confirmedAt: { $exists: false },
    }, { projection: { assetId: 1, reservationClaimId: 1 } }),
    loadManagedOriginalDeletionReservationByPreview(
      db,
      owner,
      deletionPreviewId,
    ),
    db.collection("media_assets").findOne({
      owner,
      "originalDeletionPending.previewId": deletionPreviewId,
    }, { projection: { _id: 1 } }),
  ]);
  if (pendingAsset) {
    throw new Error("Original deletion confirmation already started");
  }
  if (!preview && !existingReservation) return { success: true };
  let reservation = existingReservation;
  if (!reservation && preview) {
    const assetId = objectId(preview.assetId);
    const claimId = String(
      preview.reservationClaimId ?? `managed-original:${deletionPreviewId}`,
    );
    reservation = await claimMediaDeletionReservation(db, {
      owner,
      assetId,
      target: "managed_original",
      claimId,
      deletionPreviewId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  }
  if (reservation) {
    await beginManagedOriginalDeletionCancellation(db, {
      owner,
      assetId: reservation.assetId,
      claimId: reservation.deletionClaimId,
      deletionPreviewId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  }
  await db.collection("media_original_deletion_previews").deleteOne({
    _id: deletionPreviewId,
    owner,
    confirmedAt: { $exists: false },
  });
  if (reservation) {
    await releaseMediaDeletionReservation(db, {
      owner,
      assetId: reservation.assetId,
      target: "managed_original",
      claimId: reservation.deletionClaimId,
      states: ["cancelling"],
    });
  }
  return { success: true };
}

export function mediaInputFailureStatus(
  error: unknown,
): "source_missing" | "failed" {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Deno.errors.NotFound ||
      /no such file|not found|does not exist|no available original source/i
        .test(
          message,
        )
    ? "source_missing"
    : "failed";
}

function managedOriginalRecoveryRefs(
  item: ManagedOriginalRecoveryItem,
): ManagedOriginalRecoveryRef[] {
  const refs: ManagedOriginalRecoveryRef[] = [];
  if (item.managedOriginal?.fileId) {
    refs.push({
      bucketName: "media_originals",
      fileId: objectId(item.managedOriginal.fileId),
      assetField: "managedOriginal",
    });
  }
  if (item.thumbnail?.fileId) {
    refs.push({
      bucketName: "media_previews",
      fileId: objectId(item.thumbnail.fileId),
      assetField: "thumbnail",
    });
  }
  if (item.preview?.fileId) {
    refs.push({
      bucketName: "media_previews",
      fileId: objectId(item.preview.fileId),
      assetField: "preview",
    });
  }
  return refs;
}

async function promoteRecoveryRef(
  db: Db,
  ref: ManagedOriginalRecoveryRef,
  importId: ObjectId,
  assetId: ObjectId,
  owner: string,
  leaseId: string,
  now: Date,
): Promise<void> {
  const result = await db.collection(`${ref.bucketName}.files`).updateOne(
    {
      _id: ref.fileId,
      "metadata.state": "staging",
      "metadata.importId": importId,
    },
    {
      $set: {
        "metadata.state": "canonical",
        "metadata.assetId": assetId,
        "metadata.owner": owner,
        "metadata.confirmedAt": now,
        "metadata.recoveryLeaseId": leaseId,
      },
    },
  );
  if (result.matchedCount !== 1) {
    throw new Error("Managed-original recovery file could not be finalized");
  }
}

async function finalizeRecoveryRef(
  db: Db,
  ref: ManagedOriginalRecoveryRef,
  assetId: ObjectId,
  leaseId: string,
): Promise<void> {
  const result = await db.collection(`${ref.bucketName}.files`).updateOne(
    {
      _id: ref.fileId,
      "metadata.state": "canonical",
      "metadata.assetId": assetId,
      "metadata.recoveryLeaseId": leaseId,
    },
    {
      $unset: {
        "metadata.expiresAt": "",
        "metadata.recoveryLeaseId": "",
      },
    },
  );
  if (result.matchedCount === 1) return;
  const canonical = await db.collection(`${ref.bucketName}.files`).findOne({
    _id: ref.fileId,
    "metadata.state": "canonical",
    "metadata.assetId": assetId,
    "metadata.recoveryLeaseId": { $exists: false },
  }, { projection: { _id: 1 } });
  if (!canonical) {
    throw new Error("Managed-original recovery file was not committed");
  }
}

async function cleanupRecoveryRef(
  db: Db,
  ref: ManagedOriginalRecoveryRef,
  importId: ObjectId,
  leaseId: string,
  assetId?: ObjectId,
): Promise<void> {
  const recoverableStates: Record<string, unknown>[] = [
    {
      "metadata.state": "staging",
      "metadata.importId": importId,
    },
    { "metadata.recoveryLeaseId": leaseId },
  ];
  if (assetId) {
    recoverableStates.push({
      "metadata.state": "canonical",
      "metadata.assetId": assetId,
    });
  }
  const file = await db.collection(`${ref.bucketName}.files`).findOne({
    _id: ref.fileId,
    $or: recoverableStates,
  }, { projection: { _id: 1 } });
  if (file) await deleteGridFs(db, ref.bucketName, file._id);
}

async function cleanupExpiredManagedOriginalRecoveries(db: Db): Promise<void> {
  const expired = await db.collection<any>("media_assets").find({
    "managedOriginalRecovery.expiresAt": { $lte: new Date() },
  }, {
    projection: {
      owner: 1,
      managedOriginal: 1,
      thumbnail: 1,
      preview: 1,
      managedOriginalRecovery: 1,
    },
  }).limit(500).toArray();

  for (const asset of expired) {
    const recovery = asset.managedOriginalRecovery;
    if (!recovery?.leaseId || !recovery?.importId) continue;
    const importId = objectId(recovery.importId);
    const item: ManagedOriginalRecoveryItem = {
      sha256: "",
      managedOriginal: recovery.originalFileId
        ? { fileId: recovery.originalFileId }
        : undefined,
      thumbnail: recovery.thumbnailFileId
        ? { fileId: recovery.thumbnailFileId }
        : undefined,
      preview: recovery.previewFileId
        ? { fileId: recovery.previewFileId }
        : undefined,
    };
    let linkedRefsFinalized = true;
    for (const ref of managedOriginalRecoveryRefs(item)) {
      const linked = String(asset[ref.assetField]?.fileId ?? "") ===
        String(ref.fileId);
      if (linked) {
        try {
          await finalizeRecoveryRef(
            db,
            ref,
            asset._id,
            recovery.leaseId,
          );
        } catch {
          linkedRefsFinalized = false;
        }
      } else {
        await cleanupRecoveryRef(
          db,
          ref,
          importId,
          recovery.leaseId,
          asset._id,
        );
      }
    }
    if (linkedRefsFinalized) {
      await db.collection("media_assets").updateOne(
        {
          _id: asset._id,
          "managedOriginalRecovery.leaseId": recovery.leaseId,
        },
        { $unset: { managedOriginalRecovery: "" } },
      );
    }
  }
}

export async function restoreManagedOriginalForDuplicate(
  db: Db,
  owner: string,
  importId: ObjectId,
  assetId: ObjectId,
  item: ManagedOriginalRecoveryItem,
  now = new Date(),
): Promise<boolean> {
  if (!item.managedOriginal?.fileId) {
    throw new Error("Uploaded original is missing from recovery staging");
  }
  const refs = managedOriginalRecoveryRefs(item);
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + STAGED_ORIGINAL_TTL_MS);
  const existing = await db.collection<any>("media_assets").findOne({
    _id: assetId,
    owner,
    sha256: item.sha256,
  }, {
    projection: {
      storageMode: 1,
      managedOriginal: 1,
      managedOriginalRecovery: 1,
    },
  });
  if (!existing) throw new Error("Duplicate media asset was not found");
  if (existing.managedOriginal?.fileId) {
    await Promise.all(
      refs.map((ref) => cleanupRecoveryRef(db, ref, importId, leaseId)),
    );
    return false;
  }

  const recovery = {
    leaseId,
    importId,
    originalFileId: objectId(item.managedOriginal.fileId),
    thumbnailFileId: item.thumbnail?.fileId
      ? objectId(item.thumbnail.fileId)
      : undefined,
    previewFileId: item.preview?.fileId
      ? objectId(item.preview.fileId)
      : undefined,
    previousStorageMode: existing.storageMode ?? "preview_only",
    startedAt: now,
    expiresAt: leaseExpiresAt,
  };
  const claimed = await db.collection("media_assets").updateOne(
    {
      _id: assetId,
      owner,
      sha256: item.sha256,
      "managedOriginal.fileId": { $exists: false },
      managedOriginalRecovery: { $exists: false },
    },
    { $set: { managedOriginalRecovery: recovery } },
  );
  if (claimed.modifiedCount !== 1) {
    const current = await db.collection<any>("media_assets").findOne({
      _id: assetId,
      owner,
    }, { projection: { managedOriginal: 1, managedOriginalRecovery: 1 } });
    const sameConfirmation =
      String(current?.managedOriginalRecovery?.importId ?? "") ===
        String(importId) &&
      String(current?.managedOriginalRecovery?.originalFileId ?? "") ===
        String(item.managedOriginal.fileId);
    if (sameConfirmation) {
      throw new Error("Import confirmation is already in progress");
    }
    if (
      String(current?.managedOriginal?.fileId ?? "") !==
        String(item.managedOriginal.fileId)
    ) {
      await Promise.all(
        refs.map((ref) => cleanupRecoveryRef(db, ref, importId, leaseId)),
      );
    }
    return false;
  }

  let attached = false;
  try {
    for (const ref of refs) {
      await promoteRecoveryRef(
        db,
        ref,
        importId,
        assetId,
        owner,
        leaseId,
        now,
      );
    }
    const attachFilter: Record<string, unknown> = {
      _id: assetId,
      owner,
      sha256: item.sha256,
      "managedOriginal.fileId": { $exists: false },
      "managedOriginalRecovery.leaseId": leaseId,
    };
    const set: Record<string, unknown> = {
      storageMode: "managed_original",
      managedOriginal: item.managedOriginal,
      lastManagedOriginalRecoveryImportId: importId,
      updatedAt: now,
    };
    if (item.thumbnail?.fileId) {
      attachFilter["thumbnail.fileId"] = { $exists: false };
      set.thumbnail = item.thumbnail;
    }
    if (item.preview?.fileId) {
      attachFilter["preview.fileId"] = { $exists: false };
      set.preview = item.preview;
    }
    const attachedResult = await db.collection("media_assets").updateOne(
      attachFilter,
      { $set: set },
    );
    if (attachedResult.modifiedCount !== 1) {
      throw new Error(
        "Duplicate asset changed while its original was restored",
      );
    }
    attached = true;
    for (const ref of refs) {
      await finalizeRecoveryRef(db, ref, assetId, leaseId);
    }
    await db.collection("media_assets").updateOne(
      { _id: assetId, "managedOriginalRecovery.leaseId": leaseId },
      { $unset: { managedOriginalRecovery: "" } },
    );
    return true;
  } catch (error) {
    if (attached) {
      const rollbackFilter: Record<string, unknown> = {
        _id: assetId,
        "managedOriginal.fileId": objectId(item.managedOriginal.fileId),
        "managedOriginalRecovery.leaseId": leaseId,
      };
      const unset: Record<string, ""> = {
        managedOriginal: "",
        managedOriginalRecovery: "",
        lastManagedOriginalRecoveryImportId: "",
      };
      if (item.thumbnail?.fileId) {
        rollbackFilter["thumbnail.fileId"] = objectId(item.thumbnail.fileId);
        unset.thumbnail = "";
      }
      if (item.preview?.fileId) {
        rollbackFilter["preview.fileId"] = objectId(item.preview.fileId);
        unset.preview = "";
      }
      const rolledBack = await db.collection("media_assets").updateOne(
        rollbackFilter,
        {
          $set: {
            storageMode: recovery.previousStorageMode,
            updatedAt: new Date(),
          },
          $unset: unset,
        },
      );
      if (rolledBack.modifiedCount !== 1) {
        throw new Error(
          "Managed original was restored but its recovery state requires repair",
          { cause: error },
        );
      }
    } else {
      await db.collection("media_assets").updateOne(
        { _id: assetId, "managedOriginalRecovery.leaseId": leaseId },
        { $unset: { managedOriginalRecovery: "" } },
      );
    }
    await Promise.all(
      refs.map((ref) =>
        cleanupRecoveryRef(db, ref, importId, leaseId, assetId)
      ),
    );
    throw error;
  }
}

async function deleteStagedOriginal(
  db: Db,
  id: unknown,
  importId: ObjectId,
): Promise<void> {
  if (!id) return;
  const file = await db.collection("media_originals.files").findOne({
    _id: objectId(id),
    "metadata.state": "staging",
    "metadata.importId": importId,
  }, { projection: { _id: 1 } });
  if (file) await deleteGridFs(db, "media_originals", file._id);
}

async function deleteStagedPreview(
  db: Db,
  id: unknown,
  importId: ObjectId,
): Promise<void> {
  if (!id) return;
  const file = await db.collection("media_previews.files").findOne({
    _id: objectId(id),
    "metadata.state": "staging",
    "metadata.importId": importId,
  }, { projection: { _id: 1 } });
  if (file) await deleteGridFs(db, "media_previews", file._id);
}

async function promoteStagedPreviews(
  db: Db,
  importId: ObjectId,
  assetId: ObjectId,
  owner: string,
  item: any,
  now = new Date(),
): Promise<void> {
  const ids = [item.thumbnail?.fileId, item.preview?.fileId].filter(Boolean);
  for (const id of ids) {
    const promoted = await db.collection("media_previews.files").updateOne(
      {
        _id: objectId(id),
        $or: [
          {
            "metadata.state": "staging",
            "metadata.importId": importId,
          },
          {
            "metadata.state": "canonical",
            "metadata.assetId": assetId,
          },
        ],
      },
      {
        $set: {
          "metadata.state": "canonical",
          "metadata.assetId": assetId,
          "metadata.owner": owner,
          "metadata.confirmedAt": now,
        },
        $unset: { "metadata.expiresAt": "" },
      },
    );
    if (promoted.matchedCount !== 1) {
      throw new Error("Media preview could not be finalized");
    }
  }
}

type ConfirmImportItem = {
  sha256?: string;
  relativePath?: string;
  managedOriginal?: { fileId?: unknown };
  thumbnail?: { fileId?: unknown };
  preview?: { fileId?: unknown };
  metadata?: Record<string, unknown>;
  capturedAt?: unknown;
  capturedAtTimeZone?: unknown;
  capturedAtTimeZoneSource?: unknown;
  location?: unknown;
};

export function mediaImportTemporalSpatialFields(item: ConfirmImportItem) {
  const location = normalizeMediaLocation(item.location) ??
    mediaLocationFromMetadata(item.metadata);
  const spatial = location
    ? {
      location,
      geo: {
        type: "Point" as const,
        coordinates: [location.longitude, location.latitude] as [
          number,
          number,
        ],
      },
      locationSource: "exif" as const,
    }
    : {};
  if (!item.capturedAt) return spatial;

  const capturedAtTimeZone = typeof item.capturedAtTimeZone === "string" &&
      item.capturedAtTimeZone.trim()
    ? item.capturedAtTimeZone.trim()
    : undefined;
  const capturedAtTimeZoneSource = capturedAtTimeZone &&
      (item.capturedAtTimeZoneSource === "embedded" ||
        item.capturedAtTimeZoneSource === "exif_offset")
    ? item.capturedAtTimeZoneSource
    : "unknown";
  return {
    capturedAt: item.capturedAt,
    capturedAtSource: "exif" as const,
    ...(capturedAtTimeZone ? { capturedAtTimeZone } : {}),
    capturedAtTimeZoneSource,
    ...spatial,
  };
}

export function confirmedMediaImportJobId(
  importId: ObjectId,
  assetId: ObjectId,
): string {
  return createHash("sha256")
    .update(`media-import:${importId}:asset:${assetId}`)
    .digest("hex")
    .slice(0, 24);
}

export function mediaAssetImportRelationship(
  asset: any,
  importId: ObjectId,
  item: ConfirmImportItem,
): "created" | "recovered" | null {
  const refs = [
    [asset?.managedOriginal?.fileId, item.managedOriginal?.fileId],
    [asset?.thumbnail?.fileId, item.thumbnail?.fileId],
    [asset?.preview?.fileId, item.preview?.fileId],
  ].filter(([, itemId]) => Boolean(itemId));
  const exactItemIdentity = (
    refs.length > 0 &&
    refs.every(([assetId, itemId]) => String(assetId ?? "") === String(itemId))
  ) || (
    refs.length === 0 && Boolean(item.relativePath) &&
    String(asset?.source?.relativePath ?? "") === String(item.relativePath)
  );
  if (!exactItemIdentity) return null;

  if (String(asset?.createdByImportId ?? "") === String(importId)) {
    return "created";
  }
  if (
    String(asset?.lastManagedOriginalRecoveryImportId ?? "") ===
      String(importId)
  ) {
    return "recovered";
  }

  // Assets written by the pre-resume implementation did not carry an import
  // marker. Exact ownership of every staged/canonical GridFS reference is a
  // safe compatibility signal: a normal duplicate has different references.
  if (refs.length > 0) return "created";
  return null;
}

export async function finalizeConfirmedImportAsset(
  db: Db,
  importId: ObjectId,
  assetId: ObjectId,
  item: ConfirmImportItem,
  isManagedUpload: boolean,
  now = new Date(),
): Promise<void> {
  const asset = await db.collection<any>("media_assets").findOne(
    { _id: assetId },
    { projection: { owner: 1 } },
  );
  if (!asset || typeof asset.owner !== "string" || !asset.owner) {
    throw new Error("Confirmed media asset owner could not be established");
  }
  if (isManagedUpload) {
    if (!item.managedOriginal?.fileId) {
      throw new Error("Uploaded original is missing from staging");
    }
    const promoted = await db.collection("media_originals.files").updateOne(
      {
        _id: objectId(item.managedOriginal.fileId),
        $or: [
          {
            "metadata.state": "staging",
            "metadata.importId": importId,
          },
          {
            "metadata.state": "canonical",
            "metadata.assetId": assetId,
          },
        ],
      },
      {
        $set: {
          "metadata.state": "canonical",
          "metadata.assetId": assetId,
          "metadata.owner": asset.owner,
          "metadata.confirmedAt": now,
        },
        $unset: { "metadata.expiresAt": "" },
      },
    );
    if (promoted.matchedCount !== 1) {
      throw new Error("Uploaded original could not be finalized");
    }
  }

  await promoteStagedPreviews(db, importId, assetId, asset.owner, item, now);
  const existingMetadataVersion = await db.collection(
    "media_metadata_versions",
  ).findOne({ assetId, version: 1 }, { projection: { _id: 1 } });
  if (!existingMetadataVersion) {
    // Version 1 uses the asset ID as its deterministic upsert key. This keeps
    // two concurrent resume attempts from creating duplicate metadata rows.
    await db.collection("media_metadata_versions").updateOne(
      { _id: assetId },
      {
        $setOnInsert: {
          assetId,
          version: 1,
          extractor: "ffprobe/pdf-lib",
          metadata: item.metadata ?? {},
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
  await db.collection("media_assets").updateOne(
    { _id: assetId },
    {
      $set: {
        importFinalizedAt: now,
        updatedAt: now,
        ...mediaImportTemporalSpatialFields(item),
      },
    },
  );
}

async function renewConfirmingImportStagingLease(
  db: Db,
  importId: ObjectId,
  items: ConfirmImportItem[],
  expiresAt: Date,
): Promise<void> {
  const originalIds = items.flatMap((item) =>
    item.managedOriginal?.fileId ? [objectId(item.managedOriginal.fileId)] : []
  );
  const previewIds = items.flatMap((item) =>
    [item.thumbnail?.fileId, item.preview?.fileId]
      .filter(Boolean)
      .map(objectId)
  );
  await Promise.all([
    originalIds.length > 0
      ? db.collection("media_originals.files").updateMany(
        {
          _id: { $in: originalIds },
          "metadata.state": "staging",
          "metadata.importId": importId,
        },
        { $set: { "metadata.expiresAt": expiresAt } },
      )
      : Promise.resolve(),
    previewIds.length > 0
      ? db.collection("media_previews.files").updateMany(
        {
          _id: { $in: previewIds },
          "metadata.state": "staging",
          "metadata.importId": importId,
        },
        { $set: { "metadata.expiresAt": expiresAt } },
      )
      : Promise.resolve(),
  ]);
}

export type MediaUploadInput = {
  fileName: string;
  declaredMimeType?: string;
  bytes?: Uint8Array;
  readBytes?: () => Promise<Uint8Array>;
};

export async function analyzeMediaUploads(
  auth: Auth,
  files: MediaUploadInput[],
  options: {
    profileId?: string;
    requestedTasks?: MediaRecognitionTask[];
  } = {},
): Promise<unknown> {
  const db = await getRootDB();
  const config = await loadMediaConfig();
  if (files.length === 0) {
    throw new Error("At least one media file is required");
  }
  if (files.length > config.limits.maxFilesPerImport) {
    throw new Error(
      `Import has ${files.length} files; maximum is ${config.limits.maxFilesPerImport}`,
    );
  }
  await cleanupExpiredManagedOriginalRecoveries(db);
  await Promise.all([
    cleanupExpiredStagedOriginals(db),
    cleanupExpiredStagedPreviews(db),
  ]);

  const profile = config.enabled && options.profileId
    ? selectProfile(config, options.profileId)
    : undefined;
  const requestedTasks = profile
    ? normalizeRequestedTasks({ requestedTasks: options.requestedTasks })
    : [];
  if (profile) assertTasksAllowed(profile, requestedTasks);

  const importId = new ObjectId();
  const expiresAt = new Date(Date.now() + STAGED_ORIGINAL_TTL_MS);
  const items: any[] = [];
  const stagedFileIds: ObjectId[] = [];
  const previewFileIds: ObjectId[] = [];
  let grossEstimateUsd = 0;

  try {
    for (const file of files) {
      let originalId: ObjectId | undefined;
      let thumbnailId: ObjectId | undefined;
      let previewId: ObjectId | undefined;
      try {
        const fileBytes = file.bytes ?? await file.readBytes?.();
        if (!fileBytes) throw new Error("Uploaded media bytes are missing");
        const prepared = await prepareUploadedMedia(
          fileBytes,
          file.fileName,
          config.limits,
        );
        const inspected = prepared.inspection;
        const duplicate = await db.collection<any>("media_assets").findOne({
          owner: auth.principal,
          sha256: inspected.sha256,
        }, {
          projection: {
            _id: 1,
            status: 1,
            storageMode: 1,
            managedOriginal: 1,
            thumbnail: 1,
            preview: 1,
          },
        });
        const uploadPlan = managedOriginalRecoveryUploadPlan(duplicate);
        const estimate = profile
          ? estimateMediaGrossUsd(
            inspected.kind,
            inspected.pageCount,
            requestedTasks,
            profile,
          )
          : 0;
        grossEstimateUsd += estimate;

        const item: any = {
          fileName: inspected.fileName,
          kind: inspected.kind,
          mimeType: inspected.mimeType,
          declaredMimeType: file.declaredMimeType,
          byteLength: inspected.byteLength,
          sha256: inspected.sha256,
          pageCount: inspected.pageCount,
          width: inspected.width,
          height: inspected.height,
          capturedAt: inspected.capturedAt,
          capturedAtTimeZone: inspected.capturedAtTimeZone,
          capturedAtTimeZoneSource: inspected.capturedAtTimeZoneSource,
          location: inspected.location,
          metadata: inspected.metadata,
          duplicateAssetId: duplicate?._id,
          duplicateStatus: duplicate?.status,
          restoresManagedOriginal: uploadPlan.restoresDuplicate,
          estimatedGrossUsd: estimate,
        };

        if (uploadPlan.stageOriginal) {
          originalId = await uploadGridFs(
            db,
            "media_originals",
            `${importId}/${inspected.sha256}/original.${
              extensionForMime(inspected.mimeType)
            }`,
            fileBytes,
            {
              state: "staging",
              importId,
              owner: auth.principal,
              sha256: inspected.sha256,
              mimeType: inspected.mimeType,
              originalName: inspected.fileName,
              extension: extensionForMime(inspected.mimeType),
              createdAt: new Date(),
              expiresAt,
            },
          );
          stagedFileIds.push(originalId);
          item.managedOriginal = {
            bucket: "media_originals",
            fileId: originalId,
          };
          if (prepared.thumbnail && prepared.preview) {
            if (uploadPlan.stageThumbnail) {
              thumbnailId = await uploadGridFs(
                db,
                "media_previews",
                `${importId}/${inspected.sha256}/thumbnail_256.webp`,
                prepared.thumbnail.data,
                {
                  state: "staging",
                  importId,
                  sha256: inspected.sha256,
                  role: "thumbnail",
                  expiresAt,
                },
              );
              previewFileIds.push(thumbnailId);
              item.thumbnail = {
                bucket: "media_previews",
                fileId: thumbnailId,
                mimeType: "image/webp",
                width: prepared.thumbnail.width,
                height: prepared.thumbnail.height,
                byteLength: prepared.thumbnail.data.byteLength,
              };
            }
            if (uploadPlan.stagePreview) {
              previewId = await uploadGridFs(
                db,
                "media_previews",
                `${importId}/${inspected.sha256}/preview_1280.webp`,
                prepared.preview.data,
                {
                  state: "staging",
                  importId,
                  sha256: inspected.sha256,
                  role: "preview",
                  expiresAt,
                },
              );
              previewFileIds.push(previewId);
              item.preview = {
                bucket: "media_previews",
                fileId: previewId,
                mimeType: "image/webp",
                width: prepared.preview.width,
                height: prepared.preview.height,
                byteLength: prepared.preview.data.byteLength,
              };
            }
          }
        }
        items.push(item);
      } catch (error) {
        await Promise.all([
          deleteGridFs(db, "media_originals", originalId),
          deleteGridFs(db, "media_previews", thumbnailId),
          deleteGridFs(db, "media_previews", previewId),
        ]);
        items.push({ fileName: file.fileName, error: safeError(error) });
      }
    }
    if (!items.some((item) => !item.error)) {
      throw new Error("No supported media files could be prepared");
    }
    await db.collection("media_imports").insertOne({
      _id: importId,
      owner: auth.principal,
      status: "preview",
      source: { type: "upload" },
      profileSnapshot: profile ?? null,
      requestedTasks,
      grossEstimateUsd,
      items,
      createdAt: new Date(),
      expiresAt,
    });
  } catch (error) {
    await Promise.all([
      ...stagedFileIds.map((id) => deleteGridFs(db, "media_originals", id)),
      ...previewFileIds.map((id) => deleteGridFs(db, "media_previews", id)),
    ]);
    throw error;
  }

  return {
    importId,
    expiresAt,
    storageMode: "managed_original",
    grossEstimateUsd,
    provider: profile
      ? {
        id: profile.id,
        name: profile.name,
        providerType: profile.providerType,
      }
      : { id: null, name: "Metadata only", providerType: "none" },
    requestedTasks,
    items: items.map(previewResponse),
  };
}

export async function stageAnalysis(
  db: Db,
  asset: any,
  runId: string,
  analysis: NormalizedMediaAnalysis,
) {
  if (
    analysis.visualUnderstanding && analysis.searchText
  ) {
    await db.collection<any>("media_visual_descriptions").updateOne(
      { _id: runId },
      {
        $set: {
          runId,
          assetId: asset._id,
          visualUnderstanding: analysis.visualUnderstanding,
          searchText: analysis.searchText,
          ...(analysis.embedding ? { embedding: analysis.embedding } : {}),
          active: false,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
  if (analysis.pages.length > 0) {
    await db.collection<any>("media_ocr_pages").bulkWrite(
      analysis.pages.map((page) => ({
        updateOne: {
          filter: { _id: `${runId}:p${page.pageNumber}` },
          update: {
            $set: {
              runId,
              assetId: asset._id,
              pageNumber: page.pageNumber,
              text: page.text,
              blocks: page.blocks,
              languages: page.languages,
              width: page.width,
              height: page.height,
              active: false,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }
  if (analysis.annotations.length > 0) {
    await db.collection<any>("media_annotations").bulkWrite(
      analysis.annotations.map((annotation, index) => ({
        updateOne: {
          filter: { _id: `${runId}:a${index + 1}` },
          update: {
            $set: {
              runId,
              assetId: asset._id,
              ...annotation,
              active: false,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }
}

/**
 * Publishes a ready projection without creating a window where the previous
 * accepted run is unavailable. New rows become active first, then the asset
 * pointer switches, and only then are old rows retired. Every step is safe to
 * repeat from the ready-run recovery path.
 */
export async function activateMediaAnalysis(
  db: Db,
  assetId: ObjectId,
  runId: string,
) {
  await db.collection("media_ocr_pages").updateMany(
    { assetId, runId },
    { $set: { active: true } },
  );
  await db.collection("media_annotations").updateMany(
    { assetId, runId },
    { $set: { active: true } },
  );
  await db.collection("media_visual_descriptions").updateMany(
    { assetId, runId },
    { $set: { active: true } },
  );
  await db.collection("media_assets").updateOne(
    { _id: assetId },
    {
      $set: {
        status: "ready",
        currentRunId: runId,
        safeError: null,
        updatedAt: new Date(),
      },
    },
  );
  await db.collection("media_ocr_pages").updateMany(
    { assetId, runId: { $ne: runId } },
    { $set: { active: false } },
  );
  await db.collection("media_annotations").updateMany(
    { assetId, runId: { $ne: runId } },
    { $set: { active: false } },
  );
  await db.collection("media_visual_descriptions").updateMany(
    { assetId, runId: { $ne: runId } },
    { $set: { active: false } },
  );
}

export async function loadMediaAssetDetailProjections(
  db: Db,
  asset: { _id: ObjectId; currentRunId?: unknown },
) {
  const currentProjectionFilter = {
    assetId: asset._id,
    active: true,
    ...(asset.currentRunId ? { runId: asset.currentRunId } : {}),
  };
  const [pages, annotations, visual, runs] = await Promise.all([
    db.collection("media_ocr_pages").find(currentProjectionFilter)
      .sort({ pageNumber: 1 }).toArray(),
    db.collection("media_annotations").find(currentProjectionFilter)
      .sort({ confidence: -1 }).toArray(),
    db.collection("media_visual_descriptions").findOne(
      currentProjectionFilter,
      { projection: { embedding: 0 } },
    ),
    db.collection("media_analysis_runs").find({ assetId: asset._id })
      .sort({ createdAt: -1 }).limit(20).toArray(),
  ]);
  return { pages, annotations, visual, runs };
}

async function enqueueAsset(
  assetId: ObjectId,
  profile: MediaRecognitionProfile,
  requestedTasks: MediaRecognitionTask[],
  consentReceiptId: string,
  auth: Auth,
  jobId?: string,
  recognitionBatchId?: string,
) {
  return await enqueueJob(
    {
      type: "mediaRecognition",
      assetId: assetId.toString(),
      profileSnapshot: profile,
      requestedTasks,
      consentReceiptId,
      ...(recognitionBatchId ? { recognitionBatchId } : {}),
      routingContext: {
        sourceId: assetId.toString(),
        providerProfileId: profile.id,
        providerProfileName: profile.name,
        resolvedAt: new Date().toISOString(),
      },
    },
    {
      trigger: { type: "manual", reason: "media import confirmed" },
      ...(jobId ? { jobId } : {}),
    },
    auth,
  );
}

type EnqueueAsset = (
  assetId: ObjectId,
  profile: MediaRecognitionProfile,
  requestedTasks: MediaRecognitionTask[],
  consentReceiptId: string,
  auth: Auth,
  jobId?: string,
  recognitionBatchId?: string,
) => Promise<{ id?: string }>;

function isMatchingImportRecognitionJob(
  job: any,
  assetId: ObjectId,
  profile: MediaRecognitionProfile,
  consentReceiptId: string,
  recognitionBatchId?: string,
): boolean {
  return job?.type === "mediaRecognition" &&
    String(job?.data?.assetId ?? "") === String(assetId) &&
    String(job?.data?.profileSnapshot?.id ?? "") === String(profile.id) &&
    String(job?.data?.consentReceiptId ?? "") === consentReceiptId &&
    (!recognitionBatchId ||
      !job?.data?.recognitionBatchId ||
      String(job?.data?.recognitionBatchId ?? "") === recognitionBatchId);
}

export async function enqueueConfirmedAsset(
  db: Db,
  assetId: ObjectId,
  profile: MediaRecognitionProfile,
  requestedTasks: MediaRecognitionTask[],
  consentReceiptId: string,
  auth: Auth,
  enqueue: EnqueueAsset = enqueueAsset,
  jobId?: string,
  allowEnqueue = true,
  recognitionBatchId?: string,
): Promise<string | null> {
  if (jobId) {
    const existingJob = await db.collection("jobs").findOne({
      _id: objectId(jobId),
    });
    if (existingJob) {
      if (
        isMatchingImportRecognitionJob(
          existingJob,
          assetId,
          profile,
          consentReceiptId,
          recognitionBatchId,
        )
      ) {
        const definitelyUnqueued = existingJob.state === "failed" &&
          Number(existingJob.attempts ?? 0) === 0 &&
          /^queue_(?:enqueue_failed|reservation_aborted):/.test(
            String(existingJob.failedReason ?? ""),
          );
        if (!definitelyUnqueued) return jobId;
        await db.collection("media_assets").updateOne(
          { _id: assetId },
          {
            $set: {
              status: "failed",
              safeError: `Recognition was not queued: ${
                safeError(existingJob.failedReason)
              }`,
              updatedAt: new Date(),
            },
          },
        );
        return null;
      }
      throw new Error("Deterministic media recognition job ID is in use");
    }
  }
  if (!allowEnqueue) {
    await db.collection("media_assets").updateOne(
      { _id: assetId },
      {
        $set: {
          status: "failed",
          safeError:
            "Recognition was not queued because media recognition or its profile is now disabled",
          updatedAt: new Date(),
        },
      },
    );
    return null;
  }
  try {
    const job = await enqueue(
      assetId,
      profile,
      requestedTasks,
      consentReceiptId,
      auth,
      jobId,
      recognitionBatchId,
    );
    return job.id ?? null;
  } catch (error) {
    if (jobId) {
      const racedJob = await db.collection("jobs").findOne({
        _id: objectId(jobId),
      });
      if (
        racedJob &&
        isMatchingImportRecognitionJob(
          racedJob,
          assetId,
          profile,
          consentReceiptId,
          recognitionBatchId,
        ) &&
        !(
          racedJob.state === "failed" &&
          Number(racedJob.attempts ?? 0) === 0 &&
          /^queue_(?:enqueue_failed|reservation_aborted):/.test(
            String(racedJob.failedReason ?? ""),
          )
        )
      ) {
        return jobId;
      }
    }
    await db.collection("media_assets").updateOne(
      { _id: assetId },
      {
        $set: {
          status: "failed",
          safeError: `Recognition could not be queued: ${safeError(error)}`,
          updatedAt: new Date(),
        },
      },
    );
    return null;
  }
}

export async function beginRecognitionBatchProviderCall(
  db: Db,
  recognitionBatchId: unknown,
  jobId: unknown,
): Promise<boolean> {
  if (recognitionBatchId === undefined) return true;
  if (typeof recognitionBatchId !== "string") {
    throw new Error("Trusted recognition batch id is invalid");
  }
  if (!ObjectId.isValid(recognitionBatchId)) {
    throw new Error("Trusted recognition batch id is invalid");
  }
  if (typeof jobId !== "string" || !ObjectId.isValid(jobId)) {
    throw new Error("Trusted recognition job id is invalid");
  }
  const now = new Date();
  return Boolean(
    await db.collection("media_recognition_batches").findOneAndUpdate(
      {
        _id: new ObjectId(recognitionBatchId),
        status: { $in: ["queued", "running"] },
        cancelRequestedAt: { $exists: false },
      },
      {
        // This update is the provider-start linearization point. Cancellation
        // updates the same batch document, so either this fence wins and the
        // already-started call may finish, or cancelRequestedAt wins and no
        // provider call is allowed to begin.
        $set: {
          lastProviderStartFence: {
            jobId: new ObjectId(jobId),
            acceptedAt: now,
          },
          updatedAt: now,
        },
      },
      { returnDocument: "after", projection: { _id: 1 } },
    ),
  );
}

export class MediaResource implements Resource<MediaRequest, unknown> {
  code = "media";
  description =
    "Import, recognize, browse, and search local photos and PDFs with explicit provider provenance.";
  schemas = { request: mediaRequestSchema, response: z.unknown() };

  extractActions(input: MediaRequest) {
    const actions: { path: string[]; actions: string[] }[] = [{
      path: ["media", input.action],
      actions: [input.action === "processAsset" ? "process" : "use"],
    }];
    if (["savePhotoProfile", "testPhotoProfile"].includes(input.action)) {
      actions.push({ path: ["config", "write"], actions: ["write"] });
    }
    if (
      input.action === "deleteDerived" &&
      ["previews", "analysis", "asset_record"].includes(input.target)
    ) {
      actions.push({ path: ["objects"], actions: ["update"] });
    }
    return actions;
  }

  async use(input: MediaRequest, auth: Auth): Promise<unknown> {
    const db = await getRootDB();
    const config = await loadMediaConfig();

    switch (input.action) {
      case "photoSettings":
        return {
          ...photoSettingsDto(await getServerConfig()),
          importBatches: await db.collection("media_folder_campaigns").find({
            owner: auth.principal,
          }, { projection: { _id: 1, relativePath: 1, createdAt: 1 } }).sort({
            createdAt: -1,
          }).limit(500).toArray(),
        };
      case "savePhotoProfile":
        return await savePhotoProfile(input, auth);
      case "testPhotoProfile":
        return await testPhotoProfile(input.profileId);
      case "getAnalysisRun": {
        const assetId = new ObjectId(input.assetId);
        const asset = await db.collection("media_assets").findOne({
          _id: assetId,
          owner: auth.principal,
        });
        if (!asset) throw new Error("Media asset not found");
        const run = await db.collection("media_analysis_runs").findOne(
          { _id: input.runId, assetId } as any,
        );
        if (!run) throw new Error("Analysis run not found");
        const filter = { assetId, runId: input.runId };
        const [visual, pages, annotations] = await Promise.all([
          db.collection("media_visual_descriptions").findOne(filter, {
            projection: { embedding: 0 },
          }),
          db.collection("media_ocr_pages").find(filter).sort({ pageNumber: 1 })
            .toArray(),
          db.collection("media_annotations").find(filter).toArray(),
        ]);
        return { run, visual, pages, annotations };
      }
      case "status": {
        const googleProfiles = config.profiles.filter((
          profile,
        ): profile is Extract<
          MediaRecognitionProfile,
          { providerType: "google-cloud" }
        > => profile.providerType === "google-cloud");
        const googleProfile =
          googleProfiles.find((profile) =>
            profile.id === config.activeProfileId
          ) ?? googleProfiles[0];
        const adc = googleProfile
          ? await inspectGoogleAdc()
          : { configured: false, credentialPathConfigured: false };
        const now = Date.now();
        const nowDate = new Date(now);
        const month = nowDate.toISOString().slice(0, 7);
        const usageDocument = googleProfile
          ? await db.collection<any>("gcp_usage_months").findOne({
            _id: gcpUsageLedgerId(googleProfile.projectId, month),
          })
          : null;
        const promoReadiness = googleProfile
          ? inspectPromoGuard(config, googleProfile.projectId, 0.000001, now)
          : { ready: false };
        return {
          enabled: config.enabled,
          googleEnabled:
            (await getServerConfig()).externalServices?.google?.enabled ===
              true,
          sourceConfigured: mediaSourceConfigured(),
          sourceRootLabel: mediaSourceConfigured()
            ? "Mounted media source"
            : null,
          adc,
          profiles: config.profiles.map((profile) => ({
            ...profile,
            credentialConfigured: profile.providerType === "google-cloud"
              ? adc.configured
              : Boolean(Deno.env.get("MEDIA_SELF_HOSTED_API_KEY")),
          })),
          activeProfileId: config.activeProfileId,
          eventAggregation: config.eventAggregation,
          promoGuard: {
            ...config.promoGuard,
            creditVerificationFresh: promoReadiness.ready,
            paidUsageAllowed: config.promoGuard.verifiedBillingAccountType ===
                "paid_with_promo" && promoReadiness.ready,
            creditVerificationError: "code" in promoReadiness
              ? promoReadiness.code
              : undefined,
          },
          usage: summarizeGcpUsage(usageDocument, config, nowDate),
          connectorTestEstimateUsd: {
            vertexAndVision: estimateGoogleConnectorTestGrossUsd(false),
            withDocumentAi: estimateGoogleConnectorTestGrossUsd(true),
          },
        };
      }

      case "analyzeSource": {
        await cleanupExpiredStagedPreviews(db);
        let profile: MediaRecognitionProfile | undefined;
        let requestedTasks: MediaRecognitionTask[] = [];
        let paths: string[];
        try {
          profile = config.enabled && input.profileId
            ? selectProfile(config, input.profileId)
            : undefined;
          requestedTasks = profile ? normalizeRequestedTasks(input) : [];
          if (profile) assertTasksAllowed(profile, requestedTasks);
          paths = await scanMediaSource(
            input.relativePath,
            config.limits.maxFilesPerImport,
          );
        } catch (error) {
          return Response.json({ success: false, error: safeError(error) }, {
            status: 400,
          });
        }
        if (paths.length === 0) {
          return Response.json({
            success: false,
            error:
              "No supported JPG, PNG, WebP, or PDF files were found under that mounted path",
          }, { status: 400 });
        }

        const importId = new ObjectId();
        const expiresAt = new Date(Date.now() + STAGED_ORIGINAL_TTL_MS);
        const items: any[] = [];
        const previewSourcePaths: Array<string | undefined> = [];
        let grossEstimateUsd = 0;
        for (const path of paths) {
          try {
            const inspected = await inspectLocalMedia(path, config.limits);
            const duplicate = await db.collection("media_assets").findOne({
              owner: auth.principal,
              sha256: inspected.sha256,
            }, { projection: { _id: 1, status: 1 } });
            const estimate = profile
              ? estimateMediaGrossUsd(
                inspected.kind,
                inspected.pageCount,
                requestedTasks,
                profile,
              )
              : 0;
            grossEstimateUsd += estimate;
            items.push({
              relativePath: inspected.relativePath,
              fileName: inspected.fileName,
              kind: inspected.kind,
              mimeType: inspected.mimeType,
              byteLength: inspected.byteLength,
              sha256: inspected.sha256,
              pageCount: inspected.pageCount,
              width: inspected.width,
              height: inspected.height,
              capturedAt: inspected.capturedAt,
              capturedAtTimeZone: inspected.capturedAtTimeZone,
              capturedAtTimeZoneSource: inspected.capturedAtTimeZoneSource,
              location: inspected.location,
              metadata: inspected.metadata,
              duplicateAssetId: duplicate?._id,
              duplicateStatus: duplicate?.status,
              estimatedGrossUsd: estimate,
            });
            previewSourcePaths.push(
              inspected.kind === "image" && !duplicate
                ? inspected.realPath
                : undefined,
            );
          } catch (error) {
            items.push({ relativePath: path, error: safeError(error) });
            previewSourcePaths.push(undefined);
          }
        }
        for (const [index, realPath] of previewSourcePaths.entries()) {
          if (!realPath) continue;
          const item = items[index];
          let thumbId: ObjectId | undefined;
          let previewId: ObjectId | undefined;
          try {
            const thumb = await createWebpPreview(realPath, 256, 70);
            const large = await createWebpPreview(realPath, 1280, 80);
            thumbId = await uploadGridFs(
              db,
              "media_previews",
              `${importId}/${item.sha256}/thumbnail_256.webp`,
              thumb.data,
              {
                state: "staging",
                importId,
                sha256: item.sha256,
                role: "thumbnail",
                expiresAt,
              },
            );
            previewId = await uploadGridFs(
              db,
              "media_previews",
              `${importId}/${item.sha256}/preview_1280.webp`,
              large.data,
              {
                state: "staging",
                importId,
                sha256: item.sha256,
                role: "preview",
                expiresAt,
              },
            );
            item.thumbnail = {
              bucket: "media_previews",
              fileId: thumbId,
              mimeType: "image/webp",
              width: thumb.width,
              height: thumb.height,
              byteLength: thumb.data.byteLength,
            };
            item.preview = {
              bucket: "media_previews",
              fileId: previewId,
              mimeType: "image/webp",
              width: large.width,
              height: large.height,
              byteLength: large.data.byteLength,
            };
          } catch (error) {
            await Promise.all([
              deleteGridFs(db, "media_previews", thumbId),
              deleteGridFs(db, "media_previews", previewId),
            ]);
            items[index] = {
              relativePath: item.relativePath,
              error: safeError(error),
            };
          }
        }
        if (!items.some((item) => !item.error)) {
          return Response.json({
            success: false,
            error:
              "The media import could not be prepared. No assets were imported.",
          }, { status: 400 });
        }
        await db.collection("media_imports").insertOne({
          _id: importId,
          owner: auth.principal,
          status: "preview",
          source: { type: "mounted_folder", relativePath: input.relativePath },
          profileSnapshot: profile ?? null,
          requestedTasks,
          grossEstimateUsd,
          items,
          createdAt: new Date(),
          expiresAt,
        });
        return {
          importId,
          expiresAt,
          storageMode: "external_reference",
          grossEstimateUsd,
          provider: profile
            ? {
              id: profile.id,
              name: profile.name,
              providerType: profile.providerType,
            }
            : { id: null, name: "Metadata only", providerType: "none" },
          requestedTasks,
          items: items.map(previewResponse),
        };
      }

      case "confirmImport": {
        await cleanupExpiredManagedOriginalRecoveries(db);
        const importId = new ObjectId(input.importId);
        const confirmationNow = new Date();
        let record = await db.collection("media_imports").findOne({
          _id: importId,
          owner: auth.principal,
          $or: [
            { status: "preview", expiresAt: { $gt: confirmationNow } },
            {
              status: "confirming",
              $or: [
                { confirmationExpiresAt: { $gt: confirmationNow } },
                { confirmationExpiresAt: { $exists: false } },
              ],
            },
          ],
        });
        if (!record) {
          throw new Error(
            "Import preview is missing, expired, or already confirmed",
          );
        }
        const isConfirmationResume = record.status === "confirming";
        const recognitionRequested = isConfirmationResume
          ? record.consentReceipt?.recognitionRequested === true
          : input.queueRecognition;
        if (!isConfirmationResume && recognitionRequested && !config.enabled) {
          throw new Error("Media recognition is disabled in server settings");
        }
        const profile = recognitionRequested
          ? zMediaRecognitionProfile.parse(record.profileSnapshot)
          : null;
        const currentProfileEnabled = profile
          ? config.profiles.some((entry) =>
            entry.id === profile.id && entry.enabled
          )
          : false;
        if (
          !isConfirmationResume && profile && !currentProfileEnabled
        ) {
          throw new Error("The import recognition profile is now disabled");
        }
        const recognitionCanQueue = Boolean(
          profile && config.enabled && currentProfileEnabled,
        );
        const requestedTasks = profile
          ? normalizeRequestedTasks({
            requestedTasks: Array.isArray(record.requestedTasks)
              ? record.requestedTasks as MediaRecognitionTask[]
              : undefined,
            includeGlobalPhotoAnalysis:
              record.includeGlobalPhotoAnalysis === true,
          })
          : [];
        if (profile && !isConfirmationResume) {
          assertMediaItemsWithinPerImportBudget(
            config,
            (record.items ?? [])
              .filter((item: any) => !item.error)
              .map((item: any) => Number(item.estimatedGrossUsd ?? 0)),
          );
        }
        const proposedConsentReceiptId = String(
          record.consentReceipt?.id ?? randomUUID(),
        );
        const confirmationExpiresAt = new Date(
          confirmationNow.getTime() + CONFIRMING_IMPORT_TTL_MS,
        );
        await db.collection("media_imports").updateOne(
          {
            _id: importId,
            owner: auth.principal,
            $or: [
              { status: "preview", expiresAt: { $gt: confirmationNow } },
              {
                status: "confirming",
                "consentReceipt.id": { $exists: false },
              },
            ],
          },
          {
            $set: {
              status: "confirming",
              confirmationStartedAt: record.confirmationStartedAt ??
                confirmationNow,
              confirmationExpiresAt,
              expiresAt: confirmationExpiresAt,
              consentReceipt: {
                id: proposedConsentReceiptId,
                principal: auth.principal,
                providerProfileId: profile?.id ?? null,
                recognitionRequested,
                recognitionQueued: false,
                requestedTasks,
              },
            },
          },
        );
        record = await db.collection("media_imports").findOne({
          _id: importId,
          owner: auth.principal,
          status: "confirming",
        });
        if (!record?.consentReceipt?.id) {
          throw new Error("Import confirmation state could not be claimed");
        }
        if (
          record.consentReceipt.recognitionRequested !== recognitionRequested ||
          String(record.consentReceipt.providerProfileId ?? "") !==
            String(profile?.id ?? "")
        ) {
          throw new Error(
            "Resume this import with the same recognition choice used when confirmation started",
          );
        }
        const consentReceiptId = String(record.consentReceipt.id);
        await db.collection("media_imports").updateOne(
          {
            _id: importId,
            owner: auth.principal,
            status: "confirming",
            "consentReceipt.id": consentReceiptId,
          },
          {
            $set: {
              confirmationExpiresAt,
              expiresAt: confirmationExpiresAt,
            },
          },
        );
        await renewConfirmingImportStagingLease(
          db,
          importId,
          (record.items ?? []).filter((item: any) => !item.error),
          confirmationExpiresAt,
        );
        const created: any[] = [];
        const duplicates: any[] = [];
        const recovered: any[] = [];
        const isManagedUpload = record.source?.type === "upload";
        for (const item of record.items ?? []) {
          if (item.error) continue;
          const cleanupStagedItem = async () => {
            await Promise.all([
              deleteStagedOriginal(
                db,
                item.managedOriginal?.fileId,
                importId,
              ),
              deleteStagedPreview(db, item.thumbnail?.fileId, importId),
              deleteStagedPreview(db, item.preview?.fileId, importId),
            ]);
          };
          const enqueueForImport = async (assetId: ObjectId) => {
            if (!profile) return null;
            return await enqueueConfirmedAsset(
              db,
              assetId,
              profile,
              requestedTasks,
              consentReceiptId,
              auth,
              enqueueAsset,
              confirmedMediaImportJobId(importId, assetId),
              recognitionCanQueue,
            );
          };
          const finalizeCreated = async (assetId: ObjectId) => {
            await finalizeConfirmedImportAsset(
              db,
              importId,
              assetId,
              item,
              isManagedUpload,
            );
            created.push({ assetId, jobId: await enqueueForImport(assetId) });
          };
          const existing = await db.collection("media_assets").findOne({
            owner: auth.principal,
            sha256: item.sha256,
          });
          if (existing) {
            const relationship = mediaAssetImportRelationship(
              existing,
              importId,
              item,
            );
            if (relationship === "created") {
              await finalizeCreated(existing._id);
              continue;
            }
            if (relationship === "recovered") {
              recovered.push({
                assetId: existing._id,
                jobId: await enqueueForImport(existing._id),
              });
              continue;
            }
            duplicates.push(existing._id);
            if (
              isManagedUpload && !existing.managedOriginal?.fileId &&
              item.managedOriginal?.fileId
            ) {
              const restored = await restoreManagedOriginalForDuplicate(
                db,
                auth.principal,
                importId,
                existing._id,
                item,
              );
              if (restored) {
                let jobId: string | null = null;
                if (profile) {
                  if (recognitionCanQueue) {
                    await db.collection("media_assets").updateOne(
                      { _id: existing._id, owner: auth.principal },
                      {
                        $set: {
                          status: "queued",
                          safeError: null,
                          updatedAt: new Date(),
                        },
                      },
                    );
                  }
                  jobId = await enqueueForImport(existing._id);
                }
                recovered.push({ assetId: existing._id, jobId });
              }
              continue;
            }
            await cleanupStagedItem();
            continue;
          }
          const assetId = new ObjectId();
          const now = new Date();
          if (isManagedUpload && !item.managedOriginal?.fileId) {
            throw new Error("Uploaded original is missing from staging");
          }
          const asset = {
            _id: assetId,
            owner: auth.principal,
            kind: item.kind,
            storageMode: isManagedUpload
              ? "managed_original"
              : "external_reference",
            fileName: item.fileName,
            mimeType: item.mimeType,
            byteLength: item.byteLength,
            sha256: item.sha256,
            ...(isManagedUpload ? { managedOriginal: item.managedOriginal } : {
              source: {
                sourceRootId: "default",
                relativePath: item.relativePath,
              },
            }),
            pageCount: item.pageCount,
            width: item.width,
            height: item.height,
            thumbnail: item.thumbnail,
            preview: item.preview,
            metadata: item.metadata ?? {},
            createdByImportId: importId,
            ...mediaImportTemporalSpatialFields(item),
            placementRevision: 0,
            status: profile ? "queued" : "staged",
            createdAt: now,
            updatedAt: now,
          };
          try {
            await db.collection("media_assets").insertOne(asset);
          } catch (error) {
            if ((error as any)?.code === 11000) {
              const raced = await db.collection("media_assets").findOne({
                owner: auth.principal,
                sha256: item.sha256,
              });
              if (
                raced &&
                mediaAssetImportRelationship(raced, importId, item) ===
                  "created"
              ) {
                await finalizeCreated(raced._id);
              } else {
                if (raced) duplicates.push(raced._id);
                await cleanupStagedItem();
              }
              continue;
            }
            throw error;
          }
          await finalizeCreated(assetId);
        }
        await db.collection("media_imports").updateOne(
          { _id: importId, status: "confirming" },
          {
            $set: {
              status: "confirmed",
              confirmedAt: new Date(),
              consentReceipt: {
                id: consentReceiptId,
                principal: auth.principal,
                providerProfileId: profile?.id ?? null,
                recognitionRequested,
                recognitionQueued: [...created, ...recovered].some((entry) =>
                  Boolean(entry.jobId)
                ),
                requestedTasks,
              },
              createdAssetIds: created.map((entry) => entry.assetId),
              recoveredAssetIds: recovered.map((entry) => entry.assetId),
              duplicateAssetIds: duplicates,
            },
            $unset: { expiresAt: "", confirmationExpiresAt: "" },
          },
        );
        return { success: true, created, recovered, duplicates };
      }

      case "listAssets": {
        const baseQuery: any = mediaAssetListFilterQuery(
          auth.principal,
          input,
        );
        if (input.status) baseQuery.status = input.status;
        const scope = await mediaInventoryScope(db, auth.principal, input);
        if (scope.length) baseQuery.$and = scope;
        const pageConditions: Record<string, unknown>[] = [...scope];
        let offset = 0;
        if (input.before) {
          pageConditions.push({ createdAt: { $lt: new Date(input.before) } });
        }
        if (input.cursor) {
          const cursor = decodeMediaAssetCursor(input.cursor);
          if (cursor.offset != null) {
            if (
              cursor.sortBy !== input.sortBy ||
              cursor.sortDirection !== input.sortDirection
            ) throw new Error("Media Library cursor does not match sorting");
            offset = cursor.offset;
          } else {
            if (
              input.sortBy !== "createdAt" || input.sortDirection !== "desc"
            ) {
              throw new Error(
                "Legacy Media Library cursor requires default sorting",
              );
            }
            pageConditions.push({
              $or: [
                { createdAt: { $lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
              ],
            });
          }
        }
        const query = pageConditions.length > 0
          ? { ...baseQuery, $and: pageConditions }
          : baseQuery;
        const [assets, total] = await Promise.all([
          db.collection<any>("media_assets").find(query)
            .sort(mediaAssetSortSpec(input.sortBy, input.sortDirection))
            .skip(offset).limit(input.limit + 1).toArray(),
          db.collection("media_assets").countDocuments(baseQuery),
        ]);
        const pageAssets = assets.slice(0, input.limit);
        const assetIds = pageAssets.map((asset) => asset._id);
        const runIds = pageAssets.flatMap((asset) =>
          asset.currentRunId ? [asset.currentRunId] : []
        );
        const [memberships, runs, pages, annotations, visuals] = assetIds.length
          ? await Promise.all([
            db.collection("media_event_memberships").find({
              owner: auth.principal,
              assetId: { $in: assetIds },
              status: "active",
            }, { projection: { assetId: 1, eventId: 1 } }).toArray(),
            runIds.length
              ? db.collection("media_analysis_runs").find({
                _id: { $in: runIds },
              }, {
                projection: {
                  _id: 1,
                  state: 1,
                  providerSnapshot: 1,
                  provenance: 1,
                  usage: 1,
                },
              }).toArray()
              : [],
            db.collection("media_ocr_pages").find({
              assetId: { $in: assetIds },
              active: true,
            }, { projection: { assetId: 1, runId: 1, text: 1 } }).toArray(),
            db.collection("media_annotations").find({
              assetId: { $in: assetIds },
              active: true,
            }, { projection: { assetId: 1, runId: 1 } }).toArray(),
            db.collection("media_visual_descriptions").find({
              assetId: { $in: assetIds },
              active: true,
            }, {
              projection: {
                assetId: 1,
                runId: 1,
                "visualUnderstanding.shortCaption": 1,
              },
            }).toArray(),
          ])
          : [[], [], [], [], []];
        const membershipByAsset = new Map(
          memberships.map((entry) => [String(entry.assetId), entry]),
        );
        const runById = new Map(runs.map((run) => [String(run._id), run]));
        const assetById = new Map(
          pageAssets.map((asset) => [String(asset._id), asset]),
        );
        const pagesByAsset = new Map<
          string,
          { count: number; textLength: number }
        >();
        for (const page of pages) {
          const asset = assetById.get(String(page.assetId));
          if (!asset || String(asset.currentRunId) !== String(page.runId)) {
            continue;
          }
          const current = pagesByAsset.get(String(page.assetId)) ?? {
            count: 0,
            textLength: 0,
          };
          current.count += 1;
          current.textLength += String(page.text ?? "").length;
          pagesByAsset.set(String(page.assetId), current);
        }
        const annotationsByAsset = new Map<string, number>();
        for (const annotation of annotations) {
          const asset = assetById.get(String(annotation.assetId));
          if (
            !asset || String(asset.currentRunId) !== String(annotation.runId)
          ) continue;
          const key = String(annotation.assetId);
          annotationsByAsset.set(key, (annotationsByAsset.get(key) ?? 0) + 1);
        }
        const visualByAsset = new Map(
          visuals.flatMap((visual) => {
            const asset = assetById.get(String(visual.assetId));
            return asset && String(asset.currentRunId) === String(visual.runId)
              ? [[String(visual.assetId), visual] as const]
              : [];
          }),
        );
        return {
          total,
          nextCursor: assets.length > input.limit && pageAssets.length > 0
            ? mediaAssetCursor({
              offset: offset + pageAssets.length,
              sortBy: input.sortBy,
              sortDirection: input.sortDirection,
            })
            : undefined,
          assets: pageAssets.map((asset) => {
            const assetId = String(asset._id);
            const run = asset.currentRunId
              ? runById.get(String(asset.currentRunId))
              : undefined;
            const membership = membershipByAsset.get(assetId);
            return {
              ...mediaAssetResponse(asset),
              inventory: {
                processed: Boolean(asset.currentRunId),
                ...(membership ? { eventId: membership.eventId } : {}),
                ...(run
                  ? {
                    run: {
                      state: run.state,
                      providerName: run.providerSnapshot?.name,
                      providerType: run.providerSnapshot?.providerType,
                      service: run.provenance?.service,
                      location: run.provenance?.location,
                      modelVersion: run.provenance?.modelVersion,
                      grossListPriceUsd: run.usage?.grossListPriceUsd,
                    },
                  }
                  : {}),
                ocrPageCount: pagesByAsset.get(assetId)?.count ?? 0,
                ocrTextLength: pagesByAsset.get(assetId)?.textLength ?? 0,
                annotationCount: annotationsByAsset.get(assetId) ?? 0,
                shortCaption: visualByAsset.get(assetId)
                  ?.visualUnderstanding?.shortCaption,
              },
            };
          }),
        };
      }

      case "getAsset": {
        const asset = await db.collection("media_assets").findOne({
          _id: new ObjectId(input.assetId),
          owner: auth.principal,
        });
        if (!asset) throw new Error("Media asset not found");
        const [{ pages, annotations, visual, runs }, recognitionReservation] =
          await Promise.all([
            loadMediaAssetDetailProjections(db, asset),
            loadMediaRecognitionReservationSummary(
              db,
              auth.principal,
              asset._id,
            ),
          ]);
        return {
          asset: mediaAssetResponse(asset),
          pages,
          annotations,
          visual,
          runs,
          recognitionReservation,
        };
      }

      case "search": {
        const semanticAssets = await db.collection<any>("media_assets").find(
          { owner: auth.principal },
          {
            projection: {
              _id: 1,
              currentRunId: 1,
              fileName: 1,
              thumbnail: 1,
              updatedAt: 1,
            },
          },
        ).sort({ updatedAt: -1, _id: -1 }).limit(1_000).toArray();
        const semanticAssetIds = semanticAssets.map((asset) => asset._id);
        const visualDocs = await db.collection<any>(
          "media_visual_descriptions",
        ).find({ active: true, assetId: { $in: semanticAssetIds } }, {
          projection: {
            assetId: 1,
            runId: 1,
            visualUnderstanding: 1,
            "embedding.model": 1,
            "embedding.dimensions": 1,
            "embedding.values": 1,
          },
        }).limit(1_000).toArray();
        let semanticHits: Array<any & { semanticScore: number }> = [];
        let semanticUsage: Record<string, unknown> | null = null;
        let semanticWarning: string | null = null;
        if (visualDocs.length > 0 && config.enabled && config.activeProfileId) {
          let profile: MediaRecognitionProfile | undefined;
          try {
            profile = selectProfile(config);
          } catch (error) {
            semanticWarning = `Semantic matching was skipped: ${
              safeError(error)
            }. Local OCR and label search still ran.`;
          }
          if (
            profile?.providerType === "google-cloud" &&
            !(await inspectGoogleAdc()).configured
          ) {
            semanticWarning =
              "Semantic matching was skipped because Google ADC is unavailable. Local OCR and label search still ran.";
            profile = undefined;
          }
          if (profile) {
            const attemptId = `media-search:${randomUUID()}`;
            const reservedUsd = profile.providerType === "google-cloud"
              ? GOOGLE_QUERY_EMBEDDING_GROSS_USD
              : 0;
            let budgetClaim: GcpBudgetExecutionClaim | null = null;
            let providerStarted = false;
            try {
              if (profile.providerType === "google-cloud") {
                budgetClaim = await reserveGcpBudget(
                  db,
                  auth.principal,
                  attemptId,
                  reservedUsd,
                  config,
                  profile.projectId,
                );
                await beginGcpBudgetExecution(db, budgetClaim);
                providerStarted = true;
              }
              const queryEmbedding = await embedMediaQuery(
                profile,
                input.query,
              );
              semanticHits = visualDocs.filter((item) =>
                item?.embedding?.model === queryEmbedding.model &&
                Number(item?.embedding?.dimensions) ===
                  queryEmbedding.dimensions
              ).map((item) => ({
                ...item,
                semanticScore: cosineSimilarity(
                  queryEmbedding.values,
                  Array.isArray(item?.embedding?.values)
                    ? item.embedding.values.map(Number)
                    : [],
                ),
              })).filter((item) => item.semanticScore >= 0)
                .sort((left, right) => right.semanticScore - left.semanticScore)
                .slice(0, input.limit);
              semanticUsage = {
                providerProfileId: profile.id,
                model: queryEmbedding.model,
                tokenCount: queryEmbedding.tokenCount ?? 0,
                grossListPriceUsd: queryEmbedding.grossListPriceUsd,
              };
              if (profile.providerType === "google-cloud") {
                await finishGcpBudget(db, budgetClaim, "committed");
              }
            } catch (error) {
              if (profile.providerType === "google-cloud" && budgetClaim) {
                try {
                  await finishGcpBudget(
                    db,
                    budgetClaim,
                    providerStarted ? "unknown" : "released",
                  );
                } catch {
                  // Keep the reservation fail-closed for later reconciliation.
                }
              }
              semanticWarning = `Semantic matching was skipped: ${
                safeError(error)
              }. Local OCR and label search still ran.`;
            }
          }
        }
        const pageHits = await db.collection<any>("media_ocr_pages").aggregate([
          {
            $match: {
              active: true,
              $text: { $search: input.query },
            },
          },
          {
            $project: {
              score: { $meta: "textScore" },
              text: 1,
              pageNumber: 1,
              assetId: 1,
              runId: 1,
            },
          },
          { $sort: { score: -1 } },
          {
            $lookup: {
              from: "media_assets",
              localField: "assetId",
              foreignField: "_id",
              as: "ownedAsset",
            },
          },
          { $unwind: "$ownedAsset" },
          { $match: { "ownedAsset.owner": auth.principal } },
          { $limit: input.limit },
        ]).toArray();
        const labelHits = await db.collection<any>("media_annotations")
          .aggregate([
            {
              $match: {
                active: true,
                label: {
                  $regex: input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                  $options: "i",
                },
              },
            },
            {
              $lookup: {
                from: "media_assets",
                localField: "assetId",
                foreignField: "_id",
                as: "ownedAsset",
              },
            },
            { $unwind: "$ownedAsset" },
            { $match: { "ownedAsset.owner": auth.principal } },
            { $limit: input.limit },
          ]).toArray();
        const descriptionHits = await db.collection<any>(
          "media_visual_descriptions",
        ).aggregate([
          {
            $match: {
              active: true,
              searchText: {
                $regex: escapeMongoRegex(input.query),
                $options: "i",
              },
            },
          },
          {
            $lookup: {
              from: "media_assets",
              localField: "assetId",
              foreignField: "_id",
              as: "ownedAsset",
            },
          },
          { $unwind: "$ownedAsset" },
          {
            $match: {
              "ownedAsset.owner": auth.principal,
              $expr: { $eq: ["$runId", "$ownedAsset.currentRunId"] },
            },
          },
          { $project: { embedding: 0 } },
          { $limit: input.limit },
        ]).toArray();
        const byId = new Map(
          [
            ...semanticAssets,
            ...descriptionHits.map((hit) => hit.ownedAsset),
            ...pageHits.map((hit) => hit.ownedAsset),
            ...labelHits.map((hit) => hit.ownedAsset),
          ].map((asset) => [String(asset._id), asset]),
        );
        const semanticResults: any[] = [
          ...descriptionHits,
          ...semanticHits.filter((hit) =>
            !descriptionHits.some((local) =>
              String(local.assetId) === String(hit.assetId)
            )
          ),
        ].flatMap((hit) => {
          const asset = byId.get(String(hit.assetId));
          if (!asset || String(asset.currentRunId) !== String(hit.runId)) {
            return [];
          }
          const visual = hit.visualUnderstanding ?? {};
          return [{
            type: hit.semanticScore === undefined ? "description" : "semantic",
            assetId: asset._id,
            fileName: asset.fileName,
            shortCaption: visual.shortCaption,
            description: visual.description,
            scene: visual.scene,
            keywords: visual.keywords ?? [],
            semanticScore: hit.semanticScore,
            thumbnailUrl: asset.thumbnail?.fileId
              ? `/api/files/${asset.thumbnail.fileId}?bucket=media_previews`
              : undefined,
          }];
        });
        const pageResults: any[] = pageHits.flatMap((hit) => {
          const asset = byId.get(String(hit.assetId));
          if (!asset || String(asset.currentRunId) !== String(hit.runId)) {
            return [];
          }
          const text = String(hit.text ?? "");
          const index = text.toLowerCase().indexOf(input.query.toLowerCase());
          const start = Math.max(0, index < 0 ? 0 : index - 180);
          return [{
            type: "ocr",
            assetId: asset._id,
            fileName: asset.fileName,
            pageNumber: hit.pageNumber,
            snippet: text.slice(start, start + 500),
            score: hit.score,
            thumbnailUrl: asset.thumbnail?.fileId
              ? `/api/files/${asset.thumbnail.fileId}?bucket=media_previews`
              : undefined,
          }];
        });
        const labelResults: any[] = labelHits.flatMap((hit) => {
          const asset = byId.get(String(hit.assetId));
          if (!asset || String(asset.currentRunId) !== String(hit.runId)) {
            return [];
          }
          return [{
            type: hit.type,
            assetId: asset._id,
            fileName: asset.fileName,
            label: hit.label,
            confidence: hit.confidence,
            dataBoundary: hit.dataBoundary,
            thumbnailUrl: asset.thumbnail?.fileId
              ? `/api/files/${asset.thumbnail.fileId}?bucket=media_previews`
              : undefined,
          }];
        });
        return {
          results: [...semanticResults, ...pageResults, ...labelResults].slice(
            0,
            input.limit,
          ),
          semanticUsage,
          semanticWarning,
        };
      }

      case "retry": {
        if (!config.enabled) {
          throw new Error("Media Knowledge recognition is disabled");
        }
        const asset = await db.collection("media_assets").findOne({
          _id: new ObjectId(input.assetId),
          owner: auth.principal,
        });
        if (!asset) throw new Error("Media asset not found");
        if (asset.currentRunId) {
          throw new Error(
            "This photo already has a result; use an explicit reanalysis batch to create a new version",
          );
        }
        const profile = selectProfile(config, input.profileId);
        const requestedTasks = normalizeRequestedTasks(input);
        assertTasksAllowed(profile, requestedTasks);
        if (
          asset.kind === "pdf" &&
          requestedTasks.some((task) => task !== "ocr")
        ) throw new Error("PDF assets currently support only the OCR task");
        assertMediaPerImportBudget(
          config,
          estimateMediaGrossUsd(
            asset.kind,
            Number(asset.pageCount ?? 1),
            requestedTasks,
            profile,
          ),
        );
        const consentReceiptId = randomUUID();
        const jobId = new ObjectId();
        const singleRecognitionClaimId = `single-recognition:${jobId}`;
        await claimSingleMediaRecognitionReservation(db, {
          owner: auth.principal,
          assetId: asset._id,
          sha256: String(asset.sha256),
          jobId,
          claimId: singleRecognitionClaimId,
          expiresAt: new Date(
            Date.now() + MEDIA_SINGLE_RECOGNITION_PREPARE_TTL_MS,
          ),
        });
        let reservationHandedToJob = false;
        try {
          const queuedAsset = await claimMediaAssetForRecognitionQueue(
            db,
            auth.principal,
            asset,
          );
          if (!queuedAsset) {
            throw new Error(
              "Media asset changed or is no longer eligible for recognition; refresh and retry",
            );
          }
          const queuedJobId = await enqueueConfirmedAsset(
            db,
            asset._id,
            profile,
            requestedTasks,
            consentReceiptId,
            auth,
            undefined,
            String(jobId),
          );
          reservationHandedToJob = Boolean(queuedJobId);
          return {
            success: Boolean(queuedJobId),
            queued: Boolean(queuedJobId),
            jobId: queuedJobId,
            consentReceiptId,
          };
        } finally {
          if (!reservationHandedToJob) {
            await releaseSingleMediaRecognitionReservation(db, {
              owner: auth.principal,
              assetId: asset._id,
              jobId,
              claimId: singleRecognitionClaimId,
            });
          }
        }
      }

      case "processAsset": {
        const trustedJob = await loadTrustedMediaRecognitionJob(
          db,
          auth.principal,
          input.jobId,
          input.assetId,
        );
        const singleReservation = trustedJob.recognitionBatchId ? null : {
          jobId: trustedJob.jobId,
          claimId: `single-recognition:${trustedJob.jobId}`,
        };
        let keepSingleReservation = false;
        try {
          const snapshotProfile = zMediaRecognitionProfile.parse(
            trustedJob.profileSnapshot,
          );
          const requestedTasks = normalizeRequestedTasks({
            requestedTasks: trustedJob.requestedTasks,
          });
          const profile = snapshotProfile;
          const currentProfile = config.profiles.find((entry) =>
            entry.id === snapshotProfile.id
          );
          const profileMatches = currentProfile &&
            JSON.stringify(currentProfile) === JSON.stringify(snapshotProfile);
          const asset = await db.collection("media_assets").findOne({
            _id: new ObjectId(input.assetId),
            owner: trustedJob.owner,
          });
          if (!asset) {
            throw new Error("Media asset not found for its job owner");
          }
          if (singleReservation) {
            await claimSingleMediaRecognitionReservation(db, {
              owner: trustedJob.owner,
              assetId: asset._id,
              sha256: String(asset.sha256),
              jobId: singleReservation.jobId,
              claimId: singleReservation.claimId,
              expiresAt: new Date(
                Date.now() + MEDIA_SINGLE_RECOGNITION_PREPARE_TTL_MS,
              ),
            });
            await activateSingleMediaRecognitionReservation(db, {
              owner: trustedJob.owner,
              assetId: asset._id,
              jobId: singleReservation.jobId,
              claimId: singleReservation.claimId,
            });
          }
          const profileFingerprint = createHash("sha256")
            .update(JSON.stringify(profile)).digest("hex").slice(0, 16);
          const receiptBatch = trustedJob.recognitionBatchId
            ? await db.collection("media_recognition_batches").findOne({
              _id: new ObjectId(trustedJob.recognitionBatchId),
              owner: trustedJob.owner,
            }, { projection: { selection: 1 } })
            : null;
          const runId = createHash("sha256").update([
            String(asset._id),
            asset.sha256,
            profileFingerprint,
            requestedTasks.join("+"),
            ...(receiptBatch?.selection?.reanalyze ||
                profile.providerType === "openai-compatible"
              ? [trustedJob.consentReceiptId]
              : []),
          ].join(":"))
            .digest("hex");
          const recoverReadyRun = async (readyRun: any) => {
            if (
              String(readyRun.assetId) !== String(asset._id) ||
              readyRun.sourceHash !== asset.sha256 ||
              readyRun.profileFingerprint !== profileFingerprint ||
              JSON.stringify(readyRun.requestedTasks) !==
                JSON.stringify(requestedTasks)
            ) {
              throw new Error("MEDIA_READY_RUN_IDENTITY_MISMATCH");
            }
            if (profile.providerType === "google-cloud") {
              await reconcileReadyGcpBudget(db, readyRun.attemptId);
            }
            await activateMediaAnalysis(db, asset._id, runId);
            return { success: true, reused: true, runId };
          };

          // A durable ready run needs only local publication and ledger
          // reconciliation. Recover it before mutable kill switches, source
          // availability, or current cost limits can block crash recovery.
          const existingReadyRun = await db.collection<any>(
            "media_analysis_runs",
          ).findOne({ _id: runId, state: "ready" });
          if (existingReadyRun) {
            return await recoverReadyRun(existingReadyRun);
          }
          if (!config.enabled || !currentProfile?.enabled || !profileMatches) {
            await db.collection("media_assets").updateOne(
              { _id: asset._id },
              {
                $set: {
                  status: "recognition_disabled",
                  safeError:
                    "Recognition stopped because Media Knowledge is disabled or its trusted provider profile changed",
                  updatedAt: new Date(),
                },
              },
            );
            return { success: false };
          }
          assertTasksAllowed(profile, requestedTasks);
          let requestBytes: Uint8Array;
          let explicitInputFailureStatus:
            | "source_changed"
            | undefined;
          try {
            const originalStorage = availableMediaOriginalStorage(asset);
            if (!originalStorage) {
              throw new Error("Media asset has no available original source");
            }

            let original: Uint8Array;
            if (originalStorage === "external_reference") {
              const resolved = await resolveMediaSourcePath(
                asset.source.relativePath,
              );
              const current = await inspectLocalMedia(
                asset.source.relativePath,
                config.limits,
              );
              if (current.sha256 !== asset.sha256) {
                explicitInputFailureStatus = "source_changed";
                throw new Error("Referenced original changed since import");
              }
              original = await Deno.readFile(resolved.realPath);
            } else {
              original = await downloadGridFs(
                db,
                "media_originals",
                objectId(asset.managedOriginal.fileId),
              );
            }

            requestBytes = original;
            if (asset.kind === "image") {
              if (!asset.preview?.fileId) {
                throw new Error(
                  "A sanitized preview is required before photo recognition",
                );
              }
              requestBytes = await downloadGridFs(
                db,
                "media_previews",
                objectId(asset.preview.fileId),
              );
            }
          } catch (error) {
            const message = safeError(error);
            await db.collection("media_assets").updateOne(
              { _id: asset._id },
              {
                $set: {
                  status: explicitInputFailureStatus ??
                    mediaInputFailureStatus(error),
                  safeError: message,
                  updatedAt: new Date(),
                },
              },
            );
            throw error;
          }
          const estimatedGrossUsd = estimateMediaGrossUsd(
            asset.kind,
            Number(asset.pageCount ?? 1),
            requestedTasks,
            profile,
          );
          assertMediaPerImportBudget(config, estimatedGrossUsd);
          const runClaimResult = await claimMediaAnalysisRun(db, {
            runId,
            jobId: trustedJob.jobId,
            initial: {
              assetId: asset._id,
              sourceHash: asset.sha256,
              providerSnapshot: profile,
              profileFingerprint,
              requestedTasks,
              consentReceiptId: trustedJob.consentReceiptId,
            },
          });
          if (runClaimResult.kind === "ready") {
            return await recoverReadyRun(runClaimResult.run);
          }
          if (runClaimResult.kind === "busy") {
            // A busy run may still have a live execution of this same durable
            // job. Both executions share the exact reservation row, so this
            // observer must never release it—even if the idempotent asset CAS
            // below observes a concurrent state change or throws.
            keepSingleReservation = Boolean(singleReservation);
            const providerOutcomeUnknown =
              runClaimResult.reason === "provider_outcome_unknown";
            if (!providerOutcomeUnknown) {
              const processingAsset =
                await claimMediaAssetForRecognitionProcessing(
                  db,
                  trustedJob.owner,
                  asset,
                  singleReservation ?? undefined,
                );
              if (!processingAsset) {
                throw new Error(
                  "Media asset changed or is no longer safely queued for recognition",
                );
              }
              Object.assign(asset, processingAsset);
            }
            await db.collection("media_assets").updateOne(
              { _id: asset._id },
              {
                $set: {
                  status: providerOutcomeUnknown ? "failed" : "processing",
                  safeError: providerOutcomeUnknown
                    ? "A previous provider call has an unknown outcome; automatic repetition is blocked to avoid duplicate processing or billing"
                    : null,
                  updatedAt: new Date(),
                },
              },
            );
            return {
              success: false,
              runId,
              inProgress: !providerOutcomeUnknown,
              reason: runClaimResult.reason,
            };
          }

          const runClaim = runClaimResult.claim;
          const attemptId = runClaim.attemptId;
          const processingAsset = await claimMediaAssetForRecognitionProcessing(
            db,
            trustedJob.owner,
            asset,
            singleReservation ?? undefined,
          );
          if (!processingAsset) {
            const message =
              "Media asset changed or is no longer safely queued for recognition";
            await markMediaRunFailed(db, runClaim, message).catch(() => {});
            throw new Error(message);
          }
          Object.assign(asset, processingAsset);
          let budgetClaim: GcpBudgetExecutionClaim | null = null;
          if (profile.providerType === "google-cloud") {
            try {
              budgetClaim = await reserveGcpBudget(
                db,
                asset.owner,
                attemptId,
                estimatedGrossUsd,
                config,
                profile.projectId,
              );
            } catch (error) {
              const message = safeError(error);
              await markMediaRunFailed(db, runClaim, message).catch(() => {});
              await db.collection("media_assets").updateOne(
                { _id: asset._id },
                {
                  $set: {
                    status: "budget_blocked",
                    safeError: message,
                    updatedAt: new Date(),
                  },
                },
              );
              throw error;
            }
          }

          if (
            !(await beginRecognitionBatchProviderCall(
              db,
              trustedJob.recognitionBatchId,
              trustedJob.jobId,
            ))
          ) {
            const cancellationReason =
              "Recognition batch was cancelled before the provider call started";
            await markMediaRunFailed(
              db,
              runClaim,
              cancellationReason,
            ).catch(() => {});
            await db.collection("media_assets").updateOne(
              { _id: asset._id, owner: asset.owner, status: "processing" },
              {
                $set: {
                  status: asset.currentRunId ? "ready" : "staged",
                  updatedAt: new Date(),
                },
                $unset: { safeError: "" },
              },
            );
            if (profile.providerType === "google-cloud") {
              // Publish the durable local cancellation first. If the process
              // stops before this conservative reservation is released, budget
              // reconciliation can safely finish it from the unstarted run.
              await finishGcpBudget(db, budgetClaim, "released").catch(
                () => {},
              );
            }
            return {
              success: false,
              cancelled: true,
              reason: "batch_cancelled_before_provider",
              runId,
            };
          }

          try {
            await markMediaRunProviderStarted(db, runClaim);
            if (profile.providerType === "google-cloud") {
              await beginGcpBudgetExecution(db, budgetClaim);
            }
          } catch (error) {
            const message = safeError(error);
            if (profile.providerType === "google-cloud") {
              await finishGcpBudget(db, budgetClaim, "released").catch(
                () => {},
              );
            }
            await markMediaRunFailed(db, runClaim, message).catch(() => {});
            await db.collection("media_assets").updateOne(
              { _id: asset._id },
              {
                $set: {
                  status: "failed",
                  safeError: message,
                  updatedAt: new Date(),
                },
              },
            );
            throw error;
          }

          let analysis: NormalizedMediaAnalysis;
          try {
            analysis = await analyzeWithMediaProvider({
              beforeDispatch: async () => {
                if (
                  !await beginRecognitionBatchProviderCall(
                    db,
                    trustedJob.recognitionBatchId,
                    trustedJob.jobId,
                  )
                ) {
                  throw new Error(
                    "Recognition batch cancelled before dispatch",
                  );
                }
              },
              profile,
              bytes: requestBytes,
              mimeType: asset.kind === "image" ? "image/webp" : asset.mimeType,
              pageCount: Number(asset.pageCount ?? 1),
              requestedTasks,
              requestId: attemptId,
            });
            if (
              requestedTasks.includes("ocr") &&
              analysis.pages.length !== Number(asset.pageCount ?? 1)
            ) {
              throw new Error(
                `Provider returned ${analysis.pages.length} pages; expected ${
                  asset.pageCount ?? 1
                }`,
              );
            }
            if (
              requestedTasks.includes("visual-understanding") &&
              (!analysis.visualUnderstanding ||
                (profile.providerType !== "openai-compatible" &&
                  !analysis.embedding))
            ) {
              throw new Error(
                "Provider did not return visual understanding and semantic embedding",
              );
            }
            await stageAnalysis(db, asset, runId, analysis);
            await markMediaRunReady(db, runClaim, {
              provenance: analysis.provenance,
              usage: analysis.usage,
              pageCount: analysis.pages.length,
              textLength: analysis.pages.reduce(
                (sum, page) => sum + page.text.length,
                0,
              ),
              completedAt: new Date(),
            });
          } catch (error) {
            const message = safeError(error);
            if (profile.providerType === "google-cloud") {
              // A provider error can arrive after one of several billable calls
              // succeeded. Keep the whole reservation conservative.
              await finishGcpBudget(db, budgetClaim, "unknown").catch(() => {});
            }
            await markMediaRunOutcomeUnknown(db, runClaim, message).catch(
              () => {},
            );
            await db.collection("media_assets").updateOne(
              { _id: asset._id },
              {
                $set: {
                  status: "failed",
                  safeError: message,
                  updatedAt: new Date(),
                },
              },
            );
            throw error;
          }

          await activateMediaAnalysis(db, asset._id, runId);
          if (profile.providerType === "google-cloud") {
            // Keep the accepted run ready if settlement fails. A retry will use
            // the ready-run reconciliation path instead of repeating Google.
            await finishGcpBudget(db, budgetClaim, "committed");
          }
          return {
            success: true,
            runId,
            pages: analysis.pages.length,
            annotations: analysis.annotations.length,
            visualUnderstanding: Boolean(analysis.visualUnderstanding),
            usage: analysis.usage,
          };
        } finally {
          if (singleReservation && !keepSingleReservation) {
            await releaseSingleMediaRecognitionReservation(db, {
              owner: trustedJob.owner,
              assetId: input.assetId,
              jobId: singleReservation.jobId,
              claimId: singleReservation.claimId,
            });
          }
        }
      }

      case "testConnector": {
        const profile = selectProfile(config, input.profileId);
        if (profile.providerType === "openai-compatible") {
          throw new Error("Use Test image in Photo analysis settings");
        }
        if (profile.providerType === "self-hosted") {
          return await testSelfHostedProfile(profile);
        }
        const adc = await inspectGoogleAdc();
        if (!adc.configured) {
          throw new Error(`GOOGLE_ADC_UNAVAILABLE: ${adc.error ?? "unknown"}`);
        }
        const png = new Uint8Array(Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ));
        const started = performance.now();
        const runMetered = async <T>(
          service: "vertex-ai" | "cloud-vision" | "document-ai",
          amount: number,
          call: (attemptId: string) => Promise<T>,
        ): Promise<T> => {
          const attemptId = `connector:${service}:${randomUUID()}`;
          const budgetClaim = await reserveGcpBudget(
            db,
            auth.principal,
            attemptId,
            amount,
            config,
            profile.projectId,
          );
          let providerStarted = false;
          try {
            await beginGcpBudgetExecution(db, budgetClaim);
            providerStarted = true;
            const result = await call(attemptId);
            await finishGcpBudget(db, budgetClaim, "committed");
            return result;
          } catch (error) {
            try {
              await finishGcpBudget(
                db,
                budgetClaim,
                providerStarted ? "unknown" : "released",
              );
            } catch {
              // Keep the reservation fail-closed if settlement is unavailable.
            }
            throw error;
          }
        };
        const visual = await runMetered(
          "vertex-ai",
          GOOGLE_VERTEX_VISUAL_SMOKE_GROSS_USD,
          (requestId) =>
            analyzeWithMediaProvider({
              profile,
              bytes: png,
              mimeType: "image/png",
              pageCount: 1,
              requestedTasks: ["visual-understanding"],
              requestId,
            }),
        );
        const vision = await runMetered(
          "cloud-vision",
          GOOGLE_VISION_OCR_SMOKE_GROSS_USD,
          (requestId) =>
            analyzeWithMediaProvider({
              profile,
              bytes: png,
              mimeType: "image/png",
              pageCount: 1,
              requestedTasks: ["ocr"],
              requestId,
            }),
        );
        let documentAi: unknown = null;
        if (input.includeDocumentAi && profile.documentAiProcessorId) {
          const pdf = await PDFDocument.create();
          const page = pdf.addPage([200, 200]);
          const font = await pdf.embedFont(StandardFonts.Helvetica);
          page.drawText("Mycelia connector test", { x: 20, y: 100, font });
          documentAi = await runMetered(
            "document-ai",
            GOOGLE_DOCUMENT_AI_SMOKE_GROSS_USD,
            async (requestId) =>
              analyzeWithMediaProvider({
                profile,
                bytes: await pdf.save(),
                mimeType: "application/pdf",
                pageCount: 1,
                requestedTasks: ["ocr"],
                requestId,
              }),
          );
        }
        return {
          ok: true,
          latencyMs: Math.round(performance.now() - started),
          visual: {
            provenance: visual.provenance,
            shortCaption: visual.visualUnderstanding?.shortCaption,
            usage: visual.usage,
          },
          vision: {
            provenance: vision.provenance,
            pages: vision.pages.length,
            textLength: vision.pages.reduce(
              (total, page) => total + page.text.length,
              0,
            ),
          },
          documentAi: (documentAi as any)?.provenance ?? null,
        };
      }

      case "deleteDerived": {
        let asset: any = await db.collection("media_assets").findOne({
          _id: new ObjectId(input.assetId),
          owner: auth.principal,
        });
        if (!asset) throw new Error("Media asset not found");
        if (["queued", "processing"].includes(String(asset.status))) {
          throw new Error(
            "Media analysis is active. Wait for it to finish or stop it before deleting media data.",
          );
        }
        if (
          input.target === "asset_record" &&
          asset.storageMode === "managed_original" &&
          asset.managedOriginal?.fileId
        ) {
          throw new Error(
            "Delete the Mycelia-managed original first, then remove this library item",
          );
        }
        const deletionClaimId = randomUUID();
        const deletionExpiresAt = new Date(
          Date.now() + MEDIA_DERIVED_DELETION_LEASE_MS,
        );
        await claimMediaDeletionReservation(db, {
          owner: auth.principal,
          assetId: asset._id,
          target: input.target,
          claimId: deletionClaimId,
          expiresAt: deletionExpiresAt,
        });
        const locked = await claimMediaDerivedDeletionState(db, {
          owner: auth.principal,
          assetId: asset._id,
          target: input.target,
          claimId: deletionClaimId,
          expiresAt: deletionExpiresAt,
        });
        if (!locked) {
          await releaseMediaDeletionReservation(db, {
            owner: auth.principal,
            assetId: asset._id,
            target: input.target,
            claimId: deletionClaimId,
            states: ["deleting"],
          });
          const current = await db.collection<any>("media_assets").findOne({
            _id: asset._id,
            owner: auth.principal,
          }, { projection: { status: 1 } });
          if (["queued", "processing"].includes(String(current?.status))) {
            throw new Error(
              "Media analysis is active. Wait for it to finish or stop it before deleting media data.",
            );
          }
          throw new Error(
            "Another media deletion is already in progress; retry after it finishes",
          );
        }
        asset = locked;
        if (["previews", "analysis", "asset_record"].includes(input.target)) {
          try {
            await fenceMediaAssetDerivedDeletion(
              db,
              auth.principal,
              asset._id,
            );
            await invalidateMediaEventsForAsset(
              db,
              auth.principal,
              asset._id,
            );
          } catch (error) {
            await db.collection("media_assets").updateOne(
              {
                _id: asset._id,
                owner: auth.principal,
                "derivedDeletionPending.claimId": deletionClaimId,
              },
              { $unset: { derivedDeletionPending: "" } },
            );
            await releaseMediaDeletionReservation(db, {
              owner: auth.principal,
              assetId: asset._id,
              target: input.target,
              claimId: deletionClaimId,
              states: ["deleting"],
            });
            throw error;
          }
        }
        if (input.target === "asset_record") {
          const removedAt = new Date();
          await Promise.all([
            deleteGridFs(db, "media_previews", asset.thumbnail?.fileId),
            deleteGridFs(db, "media_previews", asset.preview?.fileId),
            db.collection("media_visual_descriptions").deleteMany({
              assetId: asset._id,
            }),
            db.collection("media_ocr_pages").deleteMany({ assetId: asset._id }),
            db.collection("media_annotations").deleteMany({
              assetId: asset._id,
            }),
            db.collection("media_metadata_versions").deleteMany({
              assetId: asset._id,
            }),
            db.collection("media_asset_placement_history").deleteMany({
              assetId: asset._id,
              owner: auth.principal,
            }),
            db.collection<any>("media_analysis_runs").updateMany(
              { assetId: asset._id },
              { $set: { state: "deleted", deletedAt: removedAt } },
            ),
          ]);
          await db.collection("media_asset_deletion_receipts").insertOne({
            _id: new ObjectId(),
            owner: auth.principal,
            assetId: asset._id,
            sha256: asset.sha256,
            fileName: asset.fileName,
            storageMode: asset.storageMode,
            source: asset.source,
            externalOriginalPreserved: asset.storageMode ===
              "external_reference",
            removedAt,
          });
          const deleted = await db.collection("media_assets").deleteOne({
            _id: asset._id,
            owner: auth.principal,
            "derivedDeletionPending.claimId": deletionClaimId,
          });
          if (deleted.deletedCount !== 1) {
            throw new Error("Media library item changed during deletion");
          }
        } else if (input.target === "previews") {
          await Promise.all([
            deleteGridFs(db, "media_previews", asset.thumbnail?.fileId),
            deleteGridFs(db, "media_previews", asset.preview?.fileId),
          ]);
          await db.collection("media_assets").updateOne(
            {
              _id: asset._id,
              "derivedDeletionPending.claimId": deletionClaimId,
            },
            {
              $unset: {
                thumbnail: "",
                preview: "",
                derivedDeletionPending: "",
              },
              $set: { updatedAt: new Date() },
            },
          );
        } else if (input.target === "analysis") {
          await db.collection("media_visual_descriptions").deleteMany({
            assetId: asset._id,
          });
          await db.collection("media_ocr_pages").deleteMany({
            assetId: asset._id,
          });
          await db.collection("media_annotations").deleteMany({
            assetId: asset._id,
          });
          await db.collection<any>("media_analysis_runs").updateMany(
            { assetId: asset._id },
            { $set: { state: "deleted", deletedAt: new Date() } },
          );
          await db.collection("media_assets").updateOne(
            {
              _id: asset._id,
              "derivedDeletionPending.claimId": deletionClaimId,
            },
            {
              $unset: {
                currentRunId: "",
                derivedDeletionPending: "",
              },
              $set: { status: "staged", updatedAt: new Date() },
            },
          );
        } else {
          if (!asset.source?.relativePath) {
            await db.collection("media_assets").updateOne(
              {
                _id: asset._id,
                "derivedDeletionPending.claimId": deletionClaimId,
              },
              { $unset: { derivedDeletionPending: "" } },
            );
            await releaseMediaDeletionReservation(db, {
              owner: auth.principal,
              assetId: asset._id,
              target: input.target,
              claimId: deletionClaimId,
              states: ["deleting"],
            });
            return { success: true };
          }
          await db.collection("media_assets").updateOne(
            {
              _id: asset._id,
              "derivedDeletionPending.claimId": deletionClaimId,
            },
            {
              $unset: { source: "", derivedDeletionPending: "" },
              $set: {
                storageMode: storageModeAfterSourceReferenceDeletion(asset),
                sourceReferenceForgottenAt: new Date(),
                updatedAt: new Date(),
              },
            },
          );
        }
        await releaseMediaDeletionReservation(db, {
          owner: auth.principal,
          assetId: asset._id,
          target: input.target,
          claimId: deletionClaimId,
          states: ["deleting"],
        });
        return { success: true };
      }

      case "previewOriginalDeletion": {
        const asset = await db.collection("media_assets").findOne({
          _id: new ObjectId(input.assetId),
          owner: auth.principal,
        });
        if (!asset) throw new Error("Media asset not found");
        if (["queued", "processing"].includes(String(asset.status))) {
          throw new Error(
            "Media analysis is active. Wait for it to finish or stop it before deleting the managed original.",
          );
        }
        if (
          asset.storageMode !== "managed_original" ||
          !asset.managedOriginal?.fileId
        ) {
          throw new Error("This asset has no managed original to delete");
        }
        if (asset.originalDeletionPending) {
          throw new Error(
            "Another original deletion is already in progress; review again",
          );
        }
        const now = new Date();
        const priorDeletionReservation = await loadMediaDeletionReservation(
          db,
          auth.principal,
          asset._id,
        );
        if (
          priorDeletionReservation?.deletionTarget === "managed_original" &&
          priorDeletionReservation.state !== "deleting"
        ) {
          throw new Error(
            "Another original deletion is already in progress; review again",
          );
        }
        const reusableDeletionReservation =
          priorDeletionReservation?.deletionTarget === "managed_original" &&
            priorDeletionReservation.state === "deleting" &&
            priorDeletionReservation.deletionPreviewId &&
            priorDeletionReservation.expiresAt &&
            new Date(priorDeletionReservation.expiresAt).getTime() >
              now.getTime()
            ? priorDeletionReservation
            : null;
        const requestedDeletionPreviewId =
          reusableDeletionReservation?.deletionPreviewId
            ? objectId(reusableDeletionReservation.deletionPreviewId)
            : new ObjectId();
        const deletionClaimId = reusableDeletionReservation
          ? reusableDeletionReservation.deletionClaimId
          : `managed-original:${requestedDeletionPreviewId}`;
        const requestedExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
        const deletionReservation = await claimMediaDeletionReservation(db, {
          owner: auth.principal,
          assetId: asset._id,
          target: "managed_original",
          claimId: deletionClaimId,
          deletionPreviewId: requestedDeletionPreviewId,
          expiresAt: requestedExpiresAt,
        });
        if (deletionReservation.state !== "deleting") {
          throw new Error(
            "Another original deletion is already in progress; review again",
          );
        }
        const deletionStillSafe = await db.collection("media_assets").findOne({
          _id: asset._id,
          owner: auth.principal,
          status: { $nin: ["queued", "processing"] },
          originalDeletionPending: { $exists: false },
        }, { projection: { _id: 1 } });
        if (!deletionStillSafe) {
          await releaseMediaDeletionReservation(db, {
            owner: auth.principal,
            assetId: asset._id,
            target: "managed_original",
            claimId: deletionClaimId,
            states: ["deleting"],
          });
          throw new Error(
            "Media analysis is active. Wait for it to finish or stop it before deleting the managed original.",
          );
        }
        const deletionPreviewId = deletionReservation.deletionPreviewId ??
          requestedDeletionPreviewId;
        const existingPreview = await db.collection<any>(
          "media_original_deletion_previews",
        ).findOne({
          _id: deletionPreviewId,
          owner: auth.principal,
          assetId: asset._id,
          confirmedAt: { $exists: false },
          expiresAt: { $gt: now },
        });
        if (existingPreview) {
          return {
            canDelete: true,
            deletionPreviewId,
            expiresAt: existingPreview.expiresAt,
            assetId: asset._id,
            storageMode: asset.storageMode,
            byteLength: Number(existingPreview.byteLength ?? asset.byteLength),
            previewReady: true,
            analysisReady: true,
            retained: [
              "WebP previews",
              "metadata",
              "analysis",
              "search index",
            ],
          };
        }
        const [original, previewFile, readyRun] = await Promise.all([
          db.collection("media_originals.files").findOne({
            _id: objectId(asset.managedOriginal.fileId),
            "metadata.state": "canonical",
          }, { projection: { _id: 1, length: 1 } }),
          asset.preview?.fileId || asset.thumbnail?.fileId
            ? db.collection("media_previews.files").findOne({
              _id: objectId(asset.preview?.fileId ?? asset.thumbnail.fileId),
            }, { projection: { _id: 1 } })
            : null,
          asset.currentRunId
            ? db.collection("media_analysis_runs").findOne({
              _id: asset.currentRunId,
              state: "ready",
            }, { projection: { _id: 1 } })
            : null,
        ]);
        const blockers = [
          !original ? "Managed original is missing" : null,
          !previewFile ? "A stored preview is required" : null,
          !readyRun ? "A completed analysis is required" : null,
        ].filter(Boolean);
        if (blockers.length > 0) {
          await releaseMediaDeletionReservation(db, {
            owner: auth.principal,
            assetId: asset._id,
            target: "managed_original",
            claimId: deletionClaimId,
            states: ["deleting"],
          });
          return {
            canDelete: false,
            assetId: asset._id,
            storageMode: asset.storageMode,
            byteLength: Number(original?.length ?? asset.byteLength),
            previewReady: Boolean(previewFile),
            analysisReady: Boolean(readyRun),
            blockers,
          };
        }
        const expiresAt = requestedExpiresAt;
        await db.collection("media_original_deletion_previews").updateOne(
          {
            _id: deletionPreviewId,
            owner: auth.principal,
            confirmedAt: { $exists: false },
          },
          {
            $set: {
              assetId: asset._id,
              expectedFileId: objectId(asset.managedOriginal.fileId),
              expectedSha256: asset.sha256,
              expectedStorageMode: "managed_original",
              expectedPreviewFileId: objectId(
                asset.preview?.fileId ?? asset.thumbnail.fileId,
              ),
              expectedRunId: asset.currentRunId,
              reservationClaimId: deletionClaimId,
              byteLength: Number(original?.length ?? asset.byteLength),
              previewReady: true,
              analysisReady: true,
              expiresAt,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true },
        );
        return {
          canDelete: true,
          deletionPreviewId,
          expiresAt,
          assetId: asset._id,
          storageMode: asset.storageMode,
          byteLength: Number(original?.length ?? asset.byteLength),
          previewReady: true,
          analysisReady: true,
          retained: ["WebP previews", "metadata", "analysis", "search index"],
        };
      }

      case "confirmOriginalDeletion": {
        const previewId = new ObjectId(input.deletionPreviewId);
        return await confirmManagedOriginalDeletion(
          db,
          auth.principal,
          previewId,
        );
      }

      case "cancelOriginalDeletionPreview": {
        return await cancelManagedOriginalDeletionPreview(
          db,
          auth.principal,
          new ObjectId(input.deletionPreviewId),
        );
      }
    }
  }
}
