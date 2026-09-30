import { z } from "zod";
import { zMediaAnalysisStatus, zMediaRecognitionTask } from "./media.ts";
import { zDateOrString, zObjectId } from "./zod-json-schema.ts";

export const zMediaFolderCampaignStatus = z.enum([
  "queued",
  "scanning",
  "preview_ready",
  "importing",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);

export const zMediaRecognitionBatchStatus = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "completed_with_errors",
  "cancelled",
]);

export const zMediaInventoryFilter = z.enum([
  "all",
  "unprocessed",
  "processing",
  "ready",
  "needs_attention",
  "ignored",
]);

export const zMediaPlacementFilter = z.enum([
  "all",
  "missing_time",
  "missing_location",
]);

const zMediaAssetIdString = z.string().regex(
  /^[a-f\d]{24}$/i,
  "Invalid media asset ID",
);

export const zMediaRecognitionSelection = z.object({
  reanalyze: z.boolean().optional(),
  providerProfileId: z.string().trim().min(1).optional(),
  importCampaignId: z.string().refine((value) => /^[a-f0-9]{24}$/i.test(value))
    .optional(),
  mode: z.enum(["all_matching", "explicit"]),
  inventoryFilter: zMediaInventoryFilter.default("unprocessed"),
  placement: zMediaPlacementFilter.default("all"),
  query: z.string().trim().min(1).max(200).optional(),
  capturedFrom: z.string().datetime().optional(),
  capturedTo: z.string().datetime().optional(),
  assetIds: z.array(zMediaAssetIdString).max(20_000).optional(),
}).superRefine((selection, context) => {
  const assetIds = selection.assetIds ?? [];
  const uniqueIds = new Set(assetIds.map((id) => id.toLowerCase()));
  if (uniqueIds.size !== assetIds.length) {
    context.addIssue({
      code: "custom",
      path: ["assetIds"],
      message: "Media asset IDs must be unique",
    });
  }
  if (selection.mode === "explicit" && assetIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assetIds"],
      message: "Explicit selection requires at least one media asset ID",
    });
  }
  if (selection.mode === "all_matching" && assetIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["assetIds"],
      message: "All-matching selection does not accept explicit asset IDs",
    });
  }
  if (
    selection.capturedFrom && selection.capturedTo &&
    new Date(selection.capturedFrom) > new Date(selection.capturedTo)
  ) {
    context.addIssue({
      code: "custom",
      path: ["capturedTo"],
      message: "Capture range end must not be before its start",
    });
  }
});

export const zMediaBatchCounts = z.object({
  total: z.number().int().nonnegative().default(0),
  pending: z.number().int().nonnegative().default(0),
  queued: z.number().int().nonnegative().default(0),
  processing: z.number().int().nonnegative().default(0),
  ready: z.number().int().nonnegative().default(0),
  imported: z.number().int().nonnegative().default(0),
  duplicate: z.number().int().nonnegative().default(0),
  unsupported: z.number().int().nonnegative().default(0),
  changed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  cancelled: z.number().int().nonnegative().default(0),
}).partial().default({});

export const zMediaFolderCampaignProgress = z.object({
  stage: z.enum([
    "inventory",
    "metadata_scan",
    "awaiting_confirmation",
    "creating_previews",
    "streaming",
    "completed",
    "failed",
    "cancelled",
  ]),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
  filesPerSecond: z.number().nonnegative().optional(),
  etaSeconds: z.number().int().nonnegative().optional(),
  waitingForRecovery: z.boolean().optional(),
  totalKnown: z.boolean().optional(),
  currentPath: z.string().optional(),
  chunkSize: z.number().int().positive(),
  message: z.string().min(1),
  nextStep: z.string().min(1),
  startedAt: zDateOrString().optional(),
  lastProgressAt: zDateOrString().optional(),
});

export const zMediaSourceFolderListing = z.object({
  currentPath: z.string().min(1),
  parentPath: z.string().min(1).optional(),
  scanUnavailableReason: z.string().optional(),
  folders: z.array(z.object({
    name: z.string().min(1),
    relativePath: z.string().min(1),
    unavailableReason: z.string().optional(),
  })),
});

export const zMediaFolderCampaign = z.object({
  _id: zObjectId(),
  owner: z.string().min(1),
  relativePath: z.string().min(1),
  status: zMediaFolderCampaignStatus,
  counts: zMediaBatchCounts,
  progress: zMediaFolderCampaignProgress.optional(),
  streaming: z.object({
    state: z.enum(["running", "paused", "budget_exhausted", "completed"]),
    counts: zMediaBatchCounts,
    profileName: z.string(),
    batchSize: z.number().int().positive(),
    authorizedGrossUsd: z.number().nonnegative(),
    allocatedGrossUsd: z.number().nonnegative(),
    lastBatchId: zObjectId().optional(),
    safeError: z.string().nullable().optional(),
    nextCheckAt: zDateOrString().optional(),
    batches: z.array(
      z.object({
        _id: zObjectId(),
        status: z.string(),
        counts: zMediaBatchCounts,
      }),
    ).optional(),
  }).optional(),
  safeError: z.string().optional(),
  createdAt: zDateOrString(),
  updatedAt: zDateOrString(),
  completedAt: zDateOrString().optional(),
});

export const zMediaRecognitionBatch = z.object({
  _id: zObjectId(),
  owner: z.string().min(1),
  status: zMediaRecognitionBatchStatus,
  profileId: z.string().min(1),
  profileName: z.string().min(1),
  requestedTasks: z.array(zMediaRecognitionTask).min(1),
  selection: zMediaRecognitionSelection.optional(),
  authorizedGrossUsd: z.number().nonnegative(),
  counts: zMediaBatchCounts,
  cancelRequestedAt: zDateOrString().optional(),
  createdAt: zDateOrString(),
  updatedAt: zDateOrString(),
  completedAt: zDateOrString().optional(),
});

export const zMediaTimelineItem = z.object({
  assetId: zObjectId(),
  capturedAt: zDateOrString(),
  fileName: z.string(),
  status: zMediaAnalysisStatus,
  thumbnailUrl: z.string().optional(),
  shortCaption: z.string().optional(),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
});

export const zMediaMapItem = z.object({
  assetId: zObjectId(),
  fileName: z.string(),
  status: zMediaAnalysisStatus,
  latitude: z.number(),
  longitude: z.number(),
  capturedAt: zDateOrString().optional(),
  thumbnailUrl: z.string().optional(),
  shortCaption: z.string().optional(),
});

export type MediaFolderCampaign = z.infer<typeof zMediaFolderCampaign>;
export type MediaFolderCampaignProgress = z.infer<
  typeof zMediaFolderCampaignProgress
>;
export type MediaSourceFolderListing = z.infer<
  typeof zMediaSourceFolderListing
>;
export type MediaRecognitionBatch = z.infer<typeof zMediaRecognitionBatch>;
export type MediaInventoryFilter = z.infer<typeof zMediaInventoryFilter>;
export type MediaPlacementFilter = z.infer<typeof zMediaPlacementFilter>;
export type MediaRecognitionSelection = z.infer<
  typeof zMediaRecognitionSelection
>;
export type MediaTimelineItem = z.infer<typeof zMediaTimelineItem>;
export type MediaMapItem = z.infer<typeof zMediaMapItem>;
