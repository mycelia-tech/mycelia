import { z } from "zod";
import { zDateOrString, zObjectId } from "./zod-json-schema.ts";

export const zMediaKind = z.enum(["image", "pdf"]);
export const zMediaStorageMode = z.enum([
  "external_reference",
  "managed_original",
  "preview_only",
]);
export const zMediaAnalysisStatus = z.enum([
  "staged",
  "queued",
  "processing",
  "ready",
  "failed",
  "budget_blocked",
  "recognition_disabled",
  "source_missing",
  "source_changed",
]);
export const zMediaRecognitionTask = z.enum([
  "visual-understanding",
  "ocr",
  "labels",
  "objects",
]);

export const zMediaVisualUnderstanding = z.object({
  shortCaption: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(4_000),
  scene: z.object({
    summary: z.string().trim().min(1).max(600),
    environment: z.enum(["indoor", "outdoor", "mixed", "unknown"]),
    placeType: z.string().trim().max(160),
    timeOfDay: z.enum(["day", "night", "dawn_dusk", "unknown"]),
    confidence: z.number().min(0).max(1),
  }),
  objects: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    count: z.number().int().min(1).max(1_000).optional(),
    attributes: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    confidence: z.number().min(0).max(1),
  })).max(100).default([]),
  activities: z.array(z.object({
    description: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
  })).max(50).default([]),
  peopleCount: z.number().int().min(0).max(10_000),
  keywords: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
  possibleEvent: z.string().trim().max(240).nullable(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
});

export const zMediaSourceLocator = z.object({
  sourceRootId: z.string().min(1),
  relativePath: z.string().min(1),
});

export const zMediaPreviewRef = z.object({
  bucket: z.literal("media_previews"),
  fileId: zObjectId(),
  mimeType: z.literal("image/webp"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().nonnegative(),
});

export const zMediaLocation = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitudeMeters: z.number().finite().optional(),
});

export const zMediaGeoPoint = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ]),
});

export const zMediaAsset = z.object({
  _id: zObjectId(),
  owner: z.string(),
  kind: zMediaKind,
  storageMode: zMediaStorageMode,
  fileName: z.string(),
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  source: zMediaSourceLocator.optional(),
  managedOriginal: z.object({
    bucket: z.literal("media_originals"),
    fileId: zObjectId(),
  }).optional(),
  originalDeletedAt: zDateOrString().optional(),
  originalDeletionReceipt: z.object({
    receiptId: z.string().min(1),
    previewId: zObjectId().optional(),
    previousStorageMode: z.literal("managed_original"),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    deletedAt: zDateOrString(),
  }).optional(),
  thumbnail: zMediaPreviewRef.optional(),
  preview: zMediaPreviewRef.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  capturedAt: zDateOrString().optional(),
  capturedAtSource: z.enum(["exif", "gps", "manual"]).optional(),
  capturedAtTimeZone: z.string().trim().min(1).optional(),
  capturedAtTimeZoneSource: z.enum([
    "embedded",
    "exif_offset",
    "unknown",
    "manual",
  ]).optional(),
  location: zMediaLocation.optional(),
  geo: zMediaGeoPoint.optional(),
  locationSource: z.enum(["exif", "manual"]).optional(),
  placementRevision: z.number().int().nonnegative().default(0),
  status: zMediaAnalysisStatus,
  currentRunId: z.string().optional(),
  safeError: z.string().optional(),
  recognitionIgnoredAt: zDateOrString().optional(),
  recognitionIgnoreReason: z.string().optional(),
  createdAt: zDateOrString(),
  updatedAt: zDateOrString(),
});

export const zMediaRecognitionProfile = z.discriminatedUnion("providerType", [
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    providerType: z.literal("google-cloud"),
    enabled: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(4).default(1),
    projectId: z.string().trim().regex(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
      "Invalid Google Cloud project ID",
    ),
    location: z.literal("eu").default("eu"),
    vertexModel: z.literal("gemini-3.5-flash-lite").default(
      "gemini-3.5-flash-lite",
    ),
    embeddingModel: z.literal("gemini-embedding-001").default(
      "gemini-embedding-001",
    ),
    embeddingLocation: z.literal("europe-west4").default("europe-west4"),
    documentAiProcessorId: z.string().trim().regex(
      /^[a-z0-9][a-z0-9-]{0,62}$/,
      "Invalid Document AI processor ID",
    ).optional(),
    documentAiProcessorVersion: z.literal(
      "pretrained-ocr-v2.1-2024-08-07",
    ).default("pretrained-ocr-v2.1-2024-08-07"),
    allowGlobalPhotoAnalysis: z.boolean().default(false),
  }),
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    providerType: z.literal("self-hosted"),
    enabled: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(4).default(1),
    baseUrl: z.string().url().superRefine((value, context) => {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Self-hosted media URL must use http or https",
        });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: "custom",
          message:
            "Self-hosted media URL must not contain credentials, query parameters, or a fragment",
        });
      }
    }),
  }),
]);

export const zMediaKnowledgeConfig = z.object({
  enabled: z.boolean().default(false),
  activeProfileId: z.string().trim().min(1).optional(),
  profiles: z.array(zMediaRecognitionProfile).max(8).default([]),
  promoGuard: z.object({
    mode: z.literal("promo_guarded").default("promo_guarded"),
    promotionExpiresAt: z.string().datetime().optional(),
    stopBeforeHours: z.number().int().min(1).max(168).default(72),
    monthlyGrossLimitUsd: z.number().positive().max(300).default(1),
    // Only an explicit null disables the daily stop; missing values stay guarded.
    dailyGrossLimitUsd: z.number().positive().max(50).nullable().default(0.1),
    perImportGrossLimitUsd: z.number().positive().max(10).default(0.01),
    creditVerifiedAt: z.string().datetime().optional(),
    creditVerifiedProjectId: z.string().trim().min(1).optional(),
    verifiedRemainingUsd: z.number().positive().max(300).optional(),
    verifiedBillingAccountType: z.enum([
      "not_verified",
      "free_trial",
      "paid_with_promo",
    ]).optional(),
    creditVerifiedBillingAccountType: z.enum([
      "not_verified",
      "free_trial",
      "paid_with_promo",
    ]).optional(),
    creditVerifiedPromotionExpiresAt: z.string().datetime().optional(),
  }).default({
    mode: "promo_guarded",
    stopBeforeHours: 72,
    monthlyGrossLimitUsd: 1,
    dailyGrossLimitUsd: 0.1,
    perImportGrossLimitUsd: 0.01,
  }),
  eventAggregation: z.object({
    maxGapMinutes: z.number().int().min(1).max(10_080).default(240),
    maxDistanceKm: z.number().positive().max(1_000).default(25),
    linkWindowMinutes: z.number().int().min(1).max(10_080).default(90),
    maxAssetsPerEvent: z.number().int().min(2).max(500).default(50),
    maxPreviewsPerAnalysis: z.number().int().min(2).max(12).default(8),
    perEventGrossLimitUsd: z.number().positive().max(10).default(0.02),
  }).default({
    maxGapMinutes: 240,
    maxDistanceKm: 25,
    linkWindowMinutes: 90,
    maxAssetsPerEvent: 50,
    maxPreviewsPerAnalysis: 8,
    perEventGrossLimitUsd: 0.02,
  }),
  limits: z.object({
    maxFilesPerImport: z.number().int().min(1).max(500).default(200),
    maxImageBytes: z.number().int().positive().default(20_000_000),
    maxPdfBytes: z.number().int().positive().default(32_000_000),
    maxPdfPages: z.number().int().min(1).max(30).default(15),
  }).default({
    maxFilesPerImport: 200,
    maxImageBytes: 20_000_000,
    maxPdfBytes: 32_000_000,
    maxPdfPages: 15,
  }),
}).default({
  enabled: false,
  profiles: [],
  promoGuard: {
    mode: "promo_guarded",
    stopBeforeHours: 72,
    monthlyGrossLimitUsd: 1,
    dailyGrossLimitUsd: 0.1,
    perImportGrossLimitUsd: 0.01,
  },
  eventAggregation: {
    maxGapMinutes: 240,
    maxDistanceKm: 25,
    linkWindowMinutes: 90,
    maxAssetsPerEvent: 50,
    maxPreviewsPerAnalysis: 8,
    perEventGrossLimitUsd: 0.02,
  },
  limits: {
    maxFilesPerImport: 200,
    maxImageBytes: 20_000_000,
    maxPdfBytes: 32_000_000,
    maxPdfPages: 15,
  },
});

export type MediaAsset = z.infer<typeof zMediaAsset>;
export type MediaKnowledgeConfig = z.infer<typeof zMediaKnowledgeConfig>;
export type MediaRecognitionProfile = z.infer<
  typeof zMediaRecognitionProfile
>;
export type MediaRecognitionTask = z.infer<typeof zMediaRecognitionTask>;
export type MediaVisualUnderstanding = z.infer<
  typeof zMediaVisualUnderstanding
>;
