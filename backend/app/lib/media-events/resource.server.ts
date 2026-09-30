import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { type Db, GridFSBucket, ObjectId } from "mongodb";
import { z } from "zod";
import type { Auth } from "@/lib/auth/core.server.ts";
import type { Resource } from "@/lib/auth/resources.ts";
import { publishTimelineInvalidation } from "@/lib/events/publisher.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { enqueueJob } from "@/lib/jobs/queue.ts";
import {
  type MediaKnowledgeConfig,
  type MediaRecognitionProfile,
  zMediaRecognitionProfile,
} from "@myceliasdk/media.ts";
import { bindMediaConfig } from "@/lib/media/provider-settings.server.ts";
import type {
  MediaEvent,
  MediaEventLink,
  MediaEventUnderstanding,
} from "@myceliasdk/media-events.ts";
import {
  clusterMediaEventAssets,
  selectRepresentativeAssetIndexes,
} from "./clustering.ts";
import {
  analyzeWithMediaEventProvider,
  MEDIA_EVENT_PRIVACY_VERSION,
  MEDIA_EVENT_PROVIDER_FETCH_TIMEOUT_MS,
  type MediaEventProviderPreview,
  type NormalizedMediaEventAnalysis,
  type PreparedMediaEventProviderCall,
  prepareMediaEventProviderCall,
} from "./provider.server.ts";
import {
  claimMediaEventRun,
  markMediaEventRunFailed,
  markMediaEventRunOutcomeUnknown,
  markMediaEventRunProviderStarted,
  markMediaEventRunReady,
} from "./run-claim.server.ts";
import { loadTrustedMediaEventJob } from "./job-auth.server.ts";
import {
  beginGcpBudgetExecution,
  finishGcpBudget,
  type GcpBudgetExecutionClaim,
  reconcileReadyGcpBudget,
  releaseUnstartedGcpBudgetAttempt,
  reserveGcpBudget,
} from "@/lib/media/gcp-budget.server.ts";
import { mediaAssetLocation } from "@/lib/media/resource.server.ts";
export {
  fenceMediaAssetDerivedDeletion,
  invalidateMediaEventsForAsset,
} from "./invalidation.server.ts";

const PREVIEW_TTL_MS = 60 * 60 * 1_000;
const CONFIRMATION_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_AGGREGATION_CANDIDATES = 1_000;
const MAX_EVENTS_PER_CONFIRMATION = 100;
const MAX_LINK_CANDIDATES_PER_TYPE = 500;
const PROVIDER_MAX_PREVIEWS = 12;
const PERSONAL_CORPUS_OWNER = "admin";
const RETRY_ENQUEUE_RECOVERY_GRACE_MS = 30_000;
const PUBLICATION_CLAIM_LEASE_MS = 5 * 60 * 1_000;
const PROVIDER_CALL_PERMIT_LEASE_MS = MEDIA_EVENT_PROVIDER_FETCH_TIMEOUT_MS +
  3 * 60 * 1_000;

class MediaEventRequestError extends Error {}

function mediaEventBadRequest(message: string): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

const previewAggregationSchema = z.object({
  action: z.literal("previewAggregation"),
  assetIds: z.array(z.string().refine(ObjectId.isValid)).min(2)
    .max(MAX_AGGREGATION_CANDIDATES)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Media event candidate asset ids must be unique",
    }).optional(),
  profileId: z.string().trim().min(1).optional(),
  maxGapMinutes: z.number().int().min(1).max(10_080).optional(),
  maxDistanceKm: z.number().positive().max(1_000).optional(),
  limit: z.number().int().min(2).max(MAX_AGGREGATION_CANDIDATES).default(500),
});

const confirmAggregationSchema = z.object({
  action: z.literal("confirmAggregation"),
  previewId: z.string().refine(ObjectId.isValid),
  selectedGroupIndexes: z.array(z.number().int().nonnegative()).min(1)
    .max(MAX_EVENTS_PER_CONFIRMATION)
    .refine((indexes) => new Set(indexes).size === indexes.length, {
      message: "Selected media event group indexes must be unique",
    }),
  consent: z.literal(true),
  queueAnalysis: z.boolean().default(false),
});

const listSchema = z.object({
  action: z.literal("list"),
  status: z.enum([
    "clustered",
    "queued",
    "processing",
    "ready",
    "failed",
    "budget_blocked",
    "recognition_disabled",
    "stale",
  ]).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

const getSchema = z.object({
  action: z.literal("get"),
  eventId: z.string().refine(ObjectId.isValid),
});

const previewAnalysisSchema = z.object({
  action: z.literal("previewAnalysis"),
  eventId: z.string().refine(ObjectId.isValid),
  profileId: z.string().trim().min(1).optional(),
});

const retrySchema = z.object({
  action: z.literal("retry"),
  eventId: z.string().refine(ObjectId.isValid),
  previewId: z.string().refine(ObjectId.isValid),
  consent: z.literal(true),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const processEventSchema = z.object({
  action: z.literal("processEvent"),
  eventId: z.string().refine(ObjectId.isValid),
  profileSnapshot: z.record(z.string(), z.unknown()),
  consentReceiptId: z.string().min(1),
  retryNonce: z.string().min(1).optional(),
  jobId: z.string().refine(ObjectId.isValid),
});

const publishEventSchema = z.object({
  action: z.literal("publishEvent"),
  eventId: z.string().refine(ObjectId.isValid),
  analysisRunId: z.string().trim().min(1).max(512),
  confirm: z.literal(true),
  reviewedSensitiveText: z.literal(true),
});

const refreshLinksSchema = z.object({
  action: z.literal("refreshLinks"),
  eventId: z.string().refine(ObjectId.isValid),
});

export const mediaEventRequestSchema = z.discriminatedUnion("action", [
  previewAggregationSchema,
  confirmAggregationSchema,
  listSchema,
  getSchema,
  previewAnalysisSchema,
  retrySchema,
  processEventSchema,
  publishEventSchema,
  refreshLinksSchema,
]);

type MediaEventRequest = z.infer<typeof mediaEventRequestSchema>;

type EventPreviewSnapshot = {
  assetId: ObjectId;
  sha256: string;
  previewFileId: ObjectId;
  thumbnailFileId?: ObjectId;
};

type PreviewGroup = {
  stableKey: string;
  startAt: Date;
  endAt: Date;
  centroid?: { latitude: number; longitude: number };
  assetIds: ObjectId[];
  sourceHashes: string[];
  representativeAssetIds: ObjectId[];
  previewSnapshots: EventPreviewSnapshot[];
  estimatedGrossUsd: number;
};

function objectId(value: unknown): ObjectId {
  return value instanceof ObjectId ? value : new ObjectId(String(value));
}

function objectIdFromParts(...parts: string[]): ObjectId {
  return new ObjectId(
    createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24),
  );
}

function deletionGenerationClause(path: string, generation: number) {
  return generation === 0
    ? { $or: [{ [path]: 0 }, { [path]: { $exists: false } }] }
    : { [path]: generation };
}

function sameIds(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => String(value) === String(right[index]));
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (entry instanceof ObjectId) return entry.toHexString();
    if (entry instanceof Date) return entry.toISOString();
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
  ).digest("hex");
}

type ConsentReceipt = {
  id: string;
  hash: string;
  principal: string;
  groupStableKey: string;
  assetIds: ObjectId[];
  sourceHashes: string[];
  representativeAssetIds: ObjectId[];
  providerSnapshot: MediaRecognitionProfile | null;
  profileFingerprint: string | null;
  privacyVersion: typeof MEDIA_EVENT_PRIVACY_VERSION;
  costCeilingUsd: number;
  queueAnalysis: boolean;
  confirmedAt: Date;
};

export function buildConsentReceipt(
  input: Omit<ConsentReceipt, "hash">,
): ConsentReceipt {
  return { ...input, hash: sha256Hex(input) };
}

function assertConsentReceiptHash(receipt: ConsentReceipt): void {
  const { hash, ...payload } = receipt;
  if (hash !== sha256Hex(payload)) {
    throw new Error("Media event consent receipt integrity check failed");
  }
}

export async function persistImmutableConsentReceipt(
  db: Db,
  eventId: ObjectId,
  receipt: ConsentReceipt,
): Promise<void> {
  assertConsentReceiptHash(receipt);
  const document = {
    _id: receipt.id,
    owner: receipt.principal,
    eventId,
    receipt,
    createdAt: receipt.confirmedAt,
  };
  try {
    await db.collection<any>("media_event_consent_receipts").insertOne(
      document,
    );
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const existing = await db.collection<any>("media_event_consent_receipts")
      .findOne({ _id: receipt.id });
    if (
      !existing || canonicalJson(existing.receipt) !== canonicalJson(receipt)
    ) {
      throw new Error("Media event consent receipt id was reused");
    }
  }
}

async function assertDurableConsentReceipt(
  db: Db,
  event: any,
): Promise<ConsentReceipt> {
  const receipt = event.consentReceipt as ConsentReceipt | undefined;
  if (!receipt || event.consentReceiptId !== receipt.id) {
    throw new Error("Media event has no bound durable consent receipt");
  }
  assertConsentReceiptHash(receipt);
  if (
    receipt.principal !== event.owner ||
    receipt.groupStableKey !== event.stableKey ||
    !sameIds(receipt.assetIds, event.assetIds ?? []) ||
    !sameIds(receipt.sourceHashes, event.sourceHashes ?? []) ||
    !sameIds(
      receipt.representativeAssetIds,
      event.representativeAssetIds ?? [],
    ) || !receipt.queueAnalysis
  ) throw new Error("Media event no longer matches its consent receipt");
  const durable = await db.collection<any>("media_event_consent_receipts")
    .findOne({ _id: receipt.id, owner: event.owner, eventId: event._id });
  if (!durable || canonicalJson(durable.receipt) !== canonicalJson(receipt)) {
    throw new Error("Media event durable consent receipt was not found");
  }
  return receipt;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\/media-source\/?/g, "[media-source]/")
    .slice(0, 900);
}

function profileFingerprint(profile: MediaRecognitionProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex")
    .slice(0, 24);
}

function eventRunId(input: {
  eventId: ObjectId;
  profileFingerprint: string;
  sourceHashes: string[];
  consentReceiptId: string;
  retryNonce?: string;
}): string {
  return createHash("sha256").update([
    "media-event-run-v2",
    String(input.eventId),
    input.profileFingerprint,
    input.sourceHashes.join("+"),
    input.consentReceiptId,
    input.retryNonce ?? "canonical",
  ].join("\0")).digest("hex");
}

export function ephemeralMediaEventPreviewRef(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= PROVIDER_MAX_PREVIEWS) {
    throw new Error("Media event preview index is outside provider bounds");
  }
  return `preview-${String(index + 1).padStart(3, "0")}`;
}

export function resolveMediaEventEvidenceRefs(
  understanding: MediaEventUnderstanding,
  refs: ReadonlyMap<string, string>,
): MediaEventUnderstanding {
  const resolve = (ref: string) => {
    const assetId = refs.get(ref);
    if (!assetId) {
      throw new Error("Media event evidence ref could not be resolved");
    }
    return assetId;
  };
  return {
    ...understanding,
    place: {
      ...understanding.place,
      evidenceRefs: understanding.place.evidenceRefs.map(resolve),
    },
    participants: {
      ...understanding.participants,
      groups: understanding.participants.groups.map((group) => ({
        ...group,
        evidenceRefs: group.evidenceRefs.map(resolve),
      })),
    },
    keyActions: understanding.keyActions.map((action) => ({
      ...action,
      evidenceRefs: action.evidenceRefs.map(resolve),
    })),
    highlights: understanding.highlights.map((highlight) => ({
      ...highlight,
      ref: resolve(highlight.ref),
    })),
  };
}

export function mediaEventJobId(input: {
  eventId: ObjectId;
  profileFingerprint: string;
  sourceHashes: string[];
  consentReceiptId: string;
  retryNonce?: string;
}): string {
  return String(objectIdFromParts(
    "media-event-job-v2",
    String(input.eventId),
    input.profileFingerprint,
    input.sourceHashes.join("+"),
    input.consentReceiptId,
    input.retryNonce ?? "canonical",
  ));
}

async function loadConfig(): Promise<MediaKnowledgeConfig> {
  const config = await getServerConfig();
  return bindMediaConfig(config);
}

function selectProfile(
  config: MediaKnowledgeConfig,
  requestedId?: string,
): MediaRecognitionProfile {
  const id = requestedId ?? config.activeProfileId;
  const profile = config.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error("Media event provider profile was not found");
  if (profile.providerType === "openai-compatible") {
    throw new Error(
      "This profile supports individual photo analysis, not multi-photo event analysis",
    );
  }
  if (!profile.enabled) {
    throw new Error("Media event provider profile is disabled");
  }
  return profile;
}

function maybeSelectProfile(
  config: MediaKnowledgeConfig,
  requestedId?: string,
): MediaRecognitionProfile | undefined {
  if (requestedId) return selectProfile(config, requestedId);
  if (!config.enabled || !config.activeProfileId) return undefined;
  if (
    config.profiles.find((profile) => profile.id === config.activeProfileId)
      ?.providerType === "openai-compatible"
  ) return undefined;
  return selectProfile(config);
}

function estimatedEventGrossUsd(
  config: MediaKnowledgeConfig,
  profile?: MediaRecognitionProfile,
): number {
  return profile?.providerType === "google-cloud"
    ? config.eventAggregation.perEventGrossLimitUsd
    : 0;
}

async function downloadPreview(
  db: Db,
  id: ObjectId,
): Promise<Uint8Array> {
  const stream = new GridFSBucket(db, { bucketName: "media_previews" })
    .openDownloadStream(id);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function previewUrl(fileId: unknown): string | undefined {
  return fileId ? `/api/files/${fileId}?bucket=media_previews` : undefined;
}

export async function loadEventCandidateAssets(
  db: Db,
  owner: string,
  assetIds?: string[],
  limit = MAX_AGGREGATION_CANDIDATES,
): Promise<any[]> {
  const query: Record<string, unknown> = {
    owner,
    kind: "image",
    capturedAt: { $type: "date" },
    "preview.fileId": { $exists: true },
    derivedDeletionPending: { $exists: false },
  };
  if (assetIds) {
    query._id = { $in: assetIds.map(objectId) };
  } else {
    const alreadyAssigned = await db.collection("media_event_memberships")
      .distinct(
        "assetId",
        { owner, status: "active" },
      );
    // Compatibility for databases created before membership reservations were
    // introduced. Once migration backfill has run, this fallback is empty.
    const legacyAssigned = await db.collection("media_events").distinct(
      "assetIds",
      { owner, status: { $ne: "stale" } },
    );
    const assigned = [...alreadyAssigned, ...legacyAssigned];
    if (assigned.length) query._id = { $nin: assigned };
  }
  const assets = await db.collection<any>("media_assets").find(query, {
    projection: {
      _id: 1,
      owner: 1,
      fileName: 1,
      sha256: 1,
      capturedAt: 1,
      capturedAtTimeZone: 1,
      capturedAtTimeZoneSource: 1,
      location: 1,
      "metadata.location": 1,
      thumbnail: 1,
      preview: 1,
    },
  }).sort(
    assetIds ? { capturedAt: 1, _id: 1 } : {
      capturedAt: -1,
      _id: -1,
    },
  ).limit(
    assetIds?.length ?? Math.min(limit, MAX_AGGREGATION_CANDIDATES),
  ).toArray();
  const eligibleIds = await canonicalPreviewAssetIds(db, assets);
  const eligible = assets.filter((asset) => eligibleIds.has(String(asset._id)));
  if (!assetIds) return eligible;
  const byId = new Map(eligible.map((asset) => [String(asset._id), asset]));
  const ordered = assetIds.map((id) => byId.get(id));
  if (ordered.some((asset) => !asset)) {
    throw new MediaEventRequestError(
      "Every selected item must be an owned photo with a valid capture time and a canonical sanitized preview",
    );
  }
  return ordered;
}

export async function reserveEventMemberships(
  db: Db,
  owner: string,
  eventId: ObjectId,
  assets: any[],
  receiptId: string,
): Promise<void> {
  const assetIds = assets.map((asset) => objectId(asset._id));
  if (
    assets.some((asset) =>
      !asset?.sha256 || !asset?.preview?.fileId || asset.derivedDeletionPending
    )
  ) {
    throw new Error(
      "Every event member must have an unlocked canonical preview",
    );
  }
  await assertCanonicalPreviewFiles(db, assets);
  try {
    for (const expectedAsset of assets) {
      const assetId = objectId(expectedAsset._id);
      const available = await db.collection("media_assets").findOne({
        _id: assetId,
        owner,
        sha256: String(expectedAsset.sha256),
        "preview.fileId": objectId(expectedAsset.preview.fileId),
        derivedDeletionPending: { $exists: false },
      }, { projection: { _id: 1 } });
      if (!available) {
        throw new Error(
          "A media event member entered derived-media deletion before reservation",
        );
      }
      const membershipId = objectIdFromParts(
        "media-event-membership-v1",
        owner,
        String(assetId),
      );
      try {
        await db.collection("media_event_memberships").insertOne({
          _id: membershipId,
          owner,
          assetId,
          eventId,
          receiptId,
          status: "reserved",
          reservationExpiresAt: new Date(
            Date.now() + CONFIRMATION_RECOVERY_TTL_MS,
          ),
          createdAt: new Date(),
        });
      } catch (error) {
        if ((error as { code?: number })?.code !== 11000) throw error;
        let existing = await db.collection<any>("media_event_memberships")
          .findOne({ _id: membershipId, owner, assetId });
        if (existing?.status === "deleted") {
          existing = await db.collection<any>("media_event_memberships")
            .findOneAndUpdate(
              {
                _id: membershipId,
                owner,
                assetId,
                status: "deleted",
                deletionFenceId: existing.deletionFenceId,
              },
              {
                $set: {
                  eventId,
                  receiptId,
                  status: "reserved",
                  reservationExpiresAt: new Date(
                    Date.now() + CONFIRMATION_RECOVERY_TTL_MS,
                  ),
                  updatedAt: new Date(),
                },
                $unset: {
                  deletionFenceId: "",
                  invalidatedAt: "",
                  invalidationReason: "",
                },
              },
              { returnDocument: "after" },
            );
        }
        if (
          !existing || String(existing.eventId) !== String(eventId) ||
          (existing.status !== "active" &&
            !(existing.status === "reserved" &&
              existing.receiptId === receiptId))
        ) {
          throw new Error(
            "A photo was already confirmed as a member of another event",
          );
        }
      }
    }
    const stillAvailable = await db.collection("media_assets").countDocuments({
      owner,
      derivedDeletionPending: { $exists: false },
      $or: assets.map((asset) => ({
        _id: objectId(asset._id),
        sha256: String(asset.sha256),
        "preview.fileId": objectId(asset.preview.fileId),
      })),
    });
    if (stillAvailable !== assets.length) {
      throw new Error(
        "A media event member entered derived-media deletion during reservation",
      );
    }
  } catch (error) {
    await db.collection("media_event_memberships").deleteMany({
      _id: {
        $in: assetIds.map((assetId) =>
          objectIdFromParts(
            "media-event-membership-v1",
            owner,
            String(assetId),
          )
        ),
      },
      owner,
      eventId,
      receiptId,
      status: "reserved",
    }).catch(() => {});
    throw error;
  }
}

async function activateEventMemberships(
  db: Db,
  owner: string,
  eventId: ObjectId,
  assetIds: ObjectId[],
  receiptId: string,
): Promise<void> {
  const ids = assetIds.map((assetId) =>
    objectIdFromParts(
      "media-event-membership-v1",
      owner,
      String(assetId),
    )
  );
  await db.collection("media_event_memberships").updateMany(
    {
      _id: { $in: ids },
      owner,
      eventId,
      receiptId,
      status: "reserved",
    },
    {
      $set: { status: "active", activatedAt: new Date() },
      $unset: { reservationExpiresAt: "" },
    },
  );
}

async function assertEventMembershipsActive(
  db: Db,
  owner: string,
  eventId: ObjectId,
  assetIds: ObjectId[],
): Promise<void> {
  const ids = assetIds.map((assetId) =>
    objectIdFromParts(
      "media-event-membership-v1",
      owner,
      String(assetId),
    )
  );
  const count = await db.collection("media_event_memberships").countDocuments({
    _id: { $in: ids },
    owner,
    eventId,
    status: "active",
  });
  if (count !== assetIds.length) {
    throw new Error(
      "A media event member entered derived-media deletion during confirmation",
    );
  }
}

async function assertEventMembershipsBoundToReceipt(
  db: Db,
  owner: string,
  eventId: ObjectId,
  assetIds: ObjectId[],
  receiptId: string,
): Promise<void> {
  const ids = assetIds.map((assetId) =>
    objectIdFromParts(
      "media-event-membership-v1",
      owner,
      String(assetId),
    )
  );
  const count = await db.collection("media_event_memberships").countDocuments({
    _id: { $in: ids },
    owner,
    eventId,
    receiptId,
    status: { $in: ["reserved", "active"] },
  });
  if (count !== assetIds.length) {
    throw new Error(
      "Media event membership reservations no longer match this confirmation",
    );
  }
}

async function releaseEventMemberships(
  db: Db,
  owner: string,
  eventId: ObjectId,
  receiptId?: string,
): Promise<void> {
  await db.collection("media_event_memberships").deleteMany({
    owner,
    eventId,
    status: "reserved",
    ...(receiptId ? { receiptId } : {}),
  });
}

async function canonicalPreviewAssetIds(
  db: Db,
  assets: any[],
): Promise<Set<string>> {
  const references = assets.flatMap((asset) => [
    {
      asset,
      assetId: asset._id,
      fileId: asset.preview?.fileId,
      role: "preview",
    },
    ...(asset.thumbnail?.fileId
      ? [{
        asset,
        assetId: asset._id,
        fileId: asset.thumbnail.fileId,
        role: "thumbnail",
      }]
      : []),
  ]).filter((entry) => entry.fileId);
  const ids = references.map((entry) => objectId(entry.fileId));
  const files = ids.length
    ? await db.collection<any>("media_previews.files").find({
      _id: { $in: ids },
    }, { projection: { _id: 1, metadata: 1, length: 1 } }).toArray()
    : [];
  const byId = new Map(files.map((file) => [String(file._id), file]));
  const pointerAssets = new Map<string, Set<string>>();
  if (ids.length) {
    const linkedAssets = await db.collection<any>("media_assets").find({
      $or: [
        { "preview.fileId": { $in: ids } },
        { "thumbnail.fileId": { $in: ids } },
      ],
    }, { projection: { _id: 1, preview: 1, thumbnail: 1 } }).toArray();
    const wanted = new Set(ids.map(String));
    for (const linked of linkedAssets) {
      for (const fileId of [linked.preview?.fileId, linked.thumbnail?.fileId]) {
        if (!fileId || !wanted.has(String(fileId))) continue;
        const linkedIds = pointerAssets.get(String(fileId)) ??
          new Set<string>();
        linkedIds.add(String(linked._id));
        pointerAssets.set(String(fileId), linkedIds);
      }
    }
  }
  const eligible = new Set(assets.map((asset) => String(asset._id)));
  for (const reference of references) {
    const file = byId.get(String(reference.fileId));
    const metadata = file?.metadata ?? {};
    const linkedIds = pointerAssets.get(String(reference.fileId));
    const uniquelyPointedToByAsset = linkedIds?.size === 1 &&
      linkedIds.has(String(reference.assetId));
    const ownerMatches = metadata.owner === undefined ||
      metadata.owner === reference.asset.owner;
    const exactCanonicalIdentity = metadata.state === "canonical" &&
      String(metadata.assetId ?? "") === String(reference.assetId) &&
      ownerMatches;
    // Early confirmed imports left state/assetId unset. They remain safe only
    // when this owner-scoped asset is the sole document pointing at the exact
    // GridFS file and immutable import sha/role metadata still matches.
    const exactLegacyPointer = metadata.state === undefined &&
      metadata.assetId === undefined && metadata.owner === undefined &&
      metadata.importId !== undefined && uniquelyPointedToByAsset;
    const valid = Boolean(file) && Number(file.length ?? 0) > 0 &&
      metadata.role === reference.role &&
      String(metadata.sha256 ?? "") === String(reference.asset.sha256 ?? "") &&
      uniquelyPointedToByAsset &&
      (exactCanonicalIdentity || exactLegacyPointer);
    if (!valid) eligible.delete(String(reference.assetId));
  }
  return eligible;
}

async function assertCanonicalPreviewFiles(
  db: Db,
  assets: any[],
): Promise<void> {
  const eligible = await canonicalPreviewAssetIds(db, assets);
  if (eligible.size !== assets.length) {
    throw new MediaEventRequestError(
      "A sanitized preview no longer belongs to its confirmed media asset",
    );
  }
}

function previewSnapshotsForAssets(
  assets: any[],
  representativeIds: ObjectId[],
): EventPreviewSnapshot[] {
  const byId = new Map(assets.map((asset) => [String(asset._id), asset]));
  return representativeIds.map((assetId) => {
    const asset = byId.get(String(assetId));
    if (!asset?.preview?.fileId) {
      throw new Error("Representative media asset has no sanitized preview");
    }
    return {
      assetId: objectId(asset._id),
      sha256: String(asset.sha256),
      previewFileId: objectId(asset.preview.fileId),
      ...(asset.thumbnail?.fileId
        ? { thumbnailFileId: objectId(asset.thumbnail.fileId) }
        : {}),
    };
  });
}

export function mediaEventPreviewGroupResponse(
  group: PreviewGroup,
  assetsById: Map<string, any>,
) {
  const assetResponse = (assetId: ObjectId) => {
    const asset = assetsById.get(String(assetId));
    return {
      assetId,
      fileName: asset?.fileName ?? "Photo",
      capturedAt: asset?.capturedAt,
      thumbnailUrl: previewUrl(
        asset?.thumbnail?.fileId ?? asset?.preview?.fileId,
      ),
    };
  };
  return {
    stableKey: group.stableKey,
    startAt: group.startAt,
    endAt: group.endAt,
    assetCount: group.assetIds.length,
    ...(group.centroid ? { centroid: group.centroid } : {}),
    estimatedGrossUsd: group.estimatedGrossUsd,
    assets: group.assetIds.map(assetResponse),
    providerAssets: group.representativeAssetIds.map(assetResponse),
  };
}

async function prepareAggregationPreview(
  db: Db,
  auth: Auth,
  input: z.infer<typeof previewAggregationSchema>,
  config: MediaKnowledgeConfig,
) {
  await db.collection("media_event_aggregation_previews").deleteMany({
    status: "preview",
    expiresAt: { $lte: new Date() },
  });
  await db.collection("media_event_memberships").deleteMany({
    status: "reserved",
    reservationExpiresAt: { $lte: new Date() },
  });
  const profile = maybeSelectProfile(config, input.profileId);
  const assets = await loadEventCandidateAssets(
    db,
    auth.principal,
    input.assetIds,
    input.limit,
  );
  if (assets.length === 0) {
    throw new MediaEventRequestError(
      "No eligible photos with capture dates and canonical sanitized previews are available",
    );
  }
  await assertCanonicalPreviewFiles(db, assets);
  const result = clusterMediaEventAssets(
    assets.map((asset) => ({
      assetId: String(asset._id),
      capturedAt: asset.capturedAt ?? null,
      location: mediaAssetLocation(asset) ?? null,
    })),
    {
      maxGapMinutes: input.maxGapMinutes ??
        config.eventAggregation.maxGapMinutes,
      maxDistanceKm: input.maxDistanceKm ??
        config.eventAggregation.maxDistanceKm,
      maxAssetsPerEvent: config.eventAggregation.maxAssetsPerEvent,
      minAssetsPerEvent: 2,
    },
  );
  const assetsById = new Map(
    assets.map((asset) => [String(asset._id), asset]),
  );
  const estimate = estimatedEventGrossUsd(config, profile);
  const groups: PreviewGroup[] = result.clusters.map((cluster) => {
    const clusterAssets = cluster.assetIds.map((id) => assetsById.get(id));
    if (clusterAssets.some((asset) => !asset)) {
      throw new Error("Media event cluster contains an unavailable asset");
    }
    const indexes = selectRepresentativeAssetIndexes(
      cluster.assetIds.length,
      Math.min(
        config.eventAggregation.maxPreviewsPerAnalysis,
        PROVIDER_MAX_PREVIEWS,
      ),
    );
    const representativeAssetIds = indexes.map((index) =>
      objectId(cluster.assetIds[index])
    );
    return {
      stableKey: cluster.stableKey,
      startAt: cluster.startAt,
      endAt: cluster.endAt,
      ...(cluster.centroid ? { centroid: cluster.centroid } : {}),
      assetIds: cluster.assetIds.map(objectId),
      sourceHashes: clusterAssets.map((asset) => String(asset.sha256)),
      representativeAssetIds,
      previewSnapshots: previewSnapshotsForAssets(
        clusterAssets,
        representativeAssetIds,
      ),
      estimatedGrossUsd: estimate,
    };
  });
  const groupedAssetIds = new Set(
    groups.flatMap((group) => group.assetIds.map(String)),
  );
  const singletons = assets
    .filter((asset) => !groupedAssetIds.has(String(asset._id)))
    .map((asset) => ({
      assetId: asset._id,
      fileName: asset.fileName ?? "Photo",
      capturedAt: asset.capturedAt,
      thumbnailUrl: previewUrl(
        asset.thumbnail?.fileId ?? asset.preview?.fileId,
      ),
      ...(mediaAssetLocation(asset)
        ? { location: mediaAssetLocation(asset) }
        : {}),
    }));

  const previewId = new ObjectId();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await db.collection("media_event_aggregation_previews").insertOne({
    _id: previewId,
    owner: auth.principal,
    status: "preview",
    providerSnapshot: profile ?? null,
    profileFingerprint: profile ? profileFingerprint(profile) : null,
    configSnapshot: {
      ...config.eventAggregation,
      maxGapMinutes: input.maxGapMinutes ??
        config.eventAggregation.maxGapMinutes,
      maxDistanceKm: input.maxDistanceKm ??
        config.eventAggregation.maxDistanceKm,
      candidateLimit: input.limit,
    },
    groups,
    skippedAssetIds: result.skippedAssetIds.map(objectId),
    createdAt: new Date(),
    expiresAt,
  });

  return {
    previewId,
    expiresAt,
    ...(profile
      ? {
        provider: {
          profileId: profile.id,
          name: profile.name,
          providerType: profile.providerType,
        },
      }
      : {}),
    groups: groups.map((group, index) => ({
      index,
      ...mediaEventPreviewGroupResponse(group, assetsById),
    })),
    singletons,
    eligibleAssetCount: assets.length,
    groupedAssetCount: groupedAssetIds.size,
    skippedWithoutTime: result.skippedAssetIds.length,
  };
}

export async function prepareAggregationPreviewResponse(
  db: Db,
  auth: Auth,
  input: z.infer<typeof previewAggregationSchema>,
  config: MediaKnowledgeConfig,
) {
  try {
    return await prepareAggregationPreview(db, auth, input, config);
  } catch (error) {
    if (error instanceof MediaEventRequestError) {
      return mediaEventBadRequest(error.message);
    }
    throw error;
  }
}

async function validatePreviewGroup(
  db: Db,
  owner: string,
  group: PreviewGroup,
): Promise<any[]> {
  const assets = await loadEventCandidateAssets(
    db,
    owner,
    group.assetIds.map(String),
  );
  if (
    !sameIds(assets.map((asset) => asset._id), group.assetIds) ||
    assets.some((asset, index) =>
      String(asset.sha256) !== group.sourceHashes[index]
    )
  ) {
    throw new Error("Media event members changed after the preview was made");
  }
  await assertCanonicalPreviewFiles(db, assets);
  const byId = new Map(assets.map((asset) => [String(asset._id), asset]));
  for (const snapshot of group.previewSnapshots) {
    const asset = byId.get(String(snapshot.assetId));
    if (
      !asset || String(asset.sha256) !== snapshot.sha256 ||
      String(asset.preview?.fileId) !== String(snapshot.previewFileId) ||
      String(asset.thumbnail?.fileId ?? "") !==
        String(snapshot.thumbnailFileId ?? "")
    ) {
      throw new Error(
        "A representative preview changed after explicit confirmation",
      );
    }
  }
  return assets;
}

function isMatchingAggregationJob(
  job: any,
  eventId: ObjectId,
  profile: MediaRecognitionProfile,
  consentReceiptId: string,
  retryNonce?: string,
): boolean {
  return job?.type === "mediaEventAggregation" &&
    String(job?.data?.eventId ?? "") === String(eventId) &&
    JSON.stringify(job?.data?.profileSnapshot) === JSON.stringify(profile) &&
    String(job?.data?.consentReceiptId ?? "") === consentReceiptId &&
    String(job?.data?.retryNonce ?? "") === String(retryNonce ?? "");
}

async function assertReusableAggregationJob(
  db: Db,
  job: any,
  eventId: ObjectId,
  profile: MediaRecognitionProfile,
  consentReceiptId: string,
  sourceHashes: string[],
  retryNonce?: string,
): Promise<void> {
  if (
    !isMatchingAggregationJob(
      job,
      eventId,
      profile,
      consentReceiptId,
      retryNonce,
    )
  ) throw new Error("Existing media event job identity does not match");
  if (job.state === "waiting" || job.state === "active") return;
  if (job.state === "completed") {
    const runId = eventRunId({
      eventId,
      profileFingerprint: profileFingerprint(profile),
      sourceHashes,
      consentReceiptId,
      retryNonce,
    });
    const ready = await db.collection<any>("media_event_runs").findOne({
      _id: runId,
      eventId,
      state: "ready",
      consentReceiptId,
    });
    if (ready) return;
    throw new Error("Completed media event job has no verified ready run");
  }
  throw new Error(
    `Media event job is not runnable (${String(job.state ?? "unknown")})`,
  );
}

export async function enqueueMediaEvent(
  db: Db,
  eventId: ObjectId,
  profile: MediaRecognitionProfile,
  consentReceiptId: string,
  auth: Auth,
  sourceHashes: string[],
  retryNonce?: string,
): Promise<string> {
  const fingerprint = profileFingerprint(profile);
  const jobId = mediaEventJobId({
    eventId,
    profileFingerprint: fingerprint,
    sourceHashes,
    consentReceiptId,
    retryNonce,
  });
  const existing = await db.collection("jobs").findOne({
    _id: new ObjectId(jobId),
  });
  if (existing) {
    await assertReusableAggregationJob(
      db,
      existing,
      eventId,
      profile,
      consentReceiptId,
      sourceHashes,
      retryNonce,
    );
    return jobId;
  }
  try {
    const job = await enqueueJob(
      {
        type: "mediaEventAggregation",
        eventId: String(eventId),
        profileSnapshot: profile,
        consentReceiptId,
        ...(retryNonce ? { retryNonce } : {}),
        routingContext: {
          sourceId: String(eventId),
          providerProfileId: profile.id,
          providerProfileName: profile.name,
          resolvedAt: new Date().toISOString(),
        },
      },
      {
        jobId,
        trigger: {
          type: "manual",
          reason: retryNonce
            ? "media event analysis explicitly retried"
            : "media event aggregation confirmed",
        },
      },
      auth,
    );
    return String(job.id ?? jobId);
  } catch (error) {
    const raced = await db.collection("jobs").findOne({
      _id: new ObjectId(jobId),
    });
    if (raced) {
      await assertReusableAggregationJob(
        db,
        raced,
        eventId,
        profile,
        consentReceiptId,
        sourceHashes,
        retryNonce,
      );
      return jobId;
    }
    throw error;
  }
}

export async function ensureCanonicalEvent(
  db: Db,
  owner: string,
  group: PreviewGroup,
  profile: MediaRecognitionProfile | undefined,
  consentReceipt: ConsentReceipt,
): Promise<any> {
  const eventId = objectIdFromParts(
    "media-event-v1",
    owner,
    group.stableKey,
  );
  const now = new Date();
  const insert = {
    _id: eventId,
    owner,
    stableKey: group.stableKey,
    status: "clustered",
    deletionGeneration: 0,
    assetIds: group.assetIds,
    sourceHashes: group.sourceHashes,
    startAt: group.startAt,
    endAt: group.endAt,
    ...(group.centroid ? { centroid: group.centroid } : {}),
    representativeAssetIds: group.representativeAssetIds,
    previewSnapshots: group.previewSnapshots,
    consentReceiptId: consentReceipt.id,
    consentReceipt,
    ...(profile
      ? {
        providerSnapshot: profile,
        profileFingerprint: profileFingerprint(profile),
        estimatedGrossUsd: group.estimatedGrossUsd,
      }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.collection("media_events").updateOne(
      { _id: eventId },
      { $setOnInsert: insert },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  let event = await db.collection<any>("media_events").findOne({
    _id: eventId,
    owner,
  });
  if (!event) throw new Error("Canonical media event could not be created");
  if (
    event.stableKey !== group.stableKey ||
    !sameIds(event.assetIds ?? [], group.assetIds) ||
    !sameIds(event.sourceHashes ?? [], group.sourceHashes)
  ) throw new Error("Canonical media event identity does not match its group");
  if (event.status === "stale") {
    const replacement = { ...insert } as Record<string, unknown>;
    delete replacement._id;
    delete replacement.createdAt;
    delete replacement.deletionGeneration;
    event = await db.collection<any>("media_events").findOneAndUpdate(
      {
        _id: eventId,
        owner,
        status: "stale",
        stableKey: group.stableKey,
        assetIds: group.assetIds,
        sourceHashes: group.sourceHashes,
        publicationClaimId: { $exists: false },
      },
      {
        $set: replacement,
        $unset: {
          analysis: "",
          currentRunId: "",
          jobId: "",
          safeError: "",
          linkWarning: "",
          publicationLeaseExpiresAt: "",
          providerDeletionPending: "",
          ...(!profile
            ? {
              providerSnapshot: "",
              profileFingerprint: "",
              estimatedGrossUsd: "",
            }
            : {}),
        },
      },
      { returnDocument: "after" },
    );
    if (!event) {
      throw new Error(
        "Stale media event changed before its fresh confirmation was activated",
      );
    }
  }
  return event;
}

async function confirmAggregation(
  db: Db,
  auth: Auth,
  input: z.infer<typeof confirmAggregationSchema>,
  config: MediaKnowledgeConfig,
) {
  const previewId = new ObjectId(input.previewId);
  const requestedIndexes = [...input.selectedGroupIndexes].sort((a, b) =>
    a - b
  );
  const now = new Date();
  const consentReceiptId = randomUUID();
  let preview = await db.collection<any>("media_event_aggregation_previews")
    .findOneAndUpdate(
      {
        _id: previewId,
        owner: auth.principal,
        status: "preview",
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: "confirming",
          selectedGroupIndexes: requestedIndexes,
          queueAnalysis: input.queueAnalysis,
          consentReceiptId,
          confirmingAt: now,
          expiresAt: new Date(now.getTime() + CONFIRMATION_RECOVERY_TTL_MS),
        },
      },
      { returnDocument: "after" },
    );
  if (!preview) {
    preview = await db.collection<any>("media_event_aggregation_previews")
      .findOne({
        _id: previewId,
        owner: auth.principal,
        status: { $in: ["confirming", "confirmed"] },
      });
    if (!preview) {
      throw new Error(
        "Media event aggregation preview expired or was not found",
      );
    }
    if (
      !sameIds(preview.selectedGroupIndexes ?? [], requestedIndexes) ||
      preview.queueAnalysis !== input.queueAnalysis
    ) {
      throw new Error(
        "This aggregation preview is already being confirmed with a different selection",
      );
    }
    if (preview.status === "confirmed") {
      return { events: preview.confirmedEvents ?? [] };
    }
  }

  const profile = preview.providerSnapshot
    ? zMediaRecognitionProfile.parse(preview.providerSnapshot)
    : undefined;
  if (input.queueAnalysis) {
    if (!config.enabled || !profile) {
      throw new Error(
        "Media Knowledge and an enabled provider profile are required to queue event analysis",
      );
    }
    const current = selectProfile(config, profile.id);
    if (JSON.stringify(current) !== JSON.stringify(profile)) {
      throw new Error(
        "The confirmed media event provider profile changed; create a fresh preview",
      );
    }
  }

  const groups = preview.groups as PreviewGroup[];
  const results: Array<{
    eventId: ObjectId;
    jobId?: string;
    queued: boolean;
    reused?: boolean;
    error?: string;
  }> = [];
  for (const index of requestedIndexes) {
    const group = groups[index];
    if (!group) throw new Error(`Media event group ${index} was not found`);
    const validatedAssets = await validatePreviewGroup(
      db,
      auth.principal,
      group,
    );
    const eventId = objectIdFromParts(
      "media-event-v1",
      auth.principal,
      group.stableKey,
    );
    const receipt = buildConsentReceipt({
      id: sha256Hex([
        "media-event-confirmation-v1",
        preview.consentReceiptId,
        group.stableKey,
      ]),
      principal: auth.principal,
      groupStableKey: group.stableKey,
      assetIds: group.assetIds,
      sourceHashes: group.sourceHashes,
      representativeAssetIds: group.representativeAssetIds,
      providerSnapshot: profile ?? null,
      profileFingerprint: profile ? profileFingerprint(profile) : null,
      privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
      costCeilingUsd: group.estimatedGrossUsd,
      queueAnalysis: input.queueAnalysis,
      confirmedAt: asDate(preview.confirmingAt) ?? now,
    });
    await reserveEventMemberships(
      db,
      auth.principal,
      eventId,
      validatedAssets,
      receipt.id,
    );
    let event: any;
    try {
      await persistImmutableConsentReceipt(db, eventId, receipt);
      await assertEventMembershipsBoundToReceipt(
        db,
        auth.principal,
        eventId,
        group.assetIds,
        receipt.id,
      );
      event = await ensureCanonicalEvent(
        db,
        auth.principal,
        group,
        profile,
        receipt,
      );
      if (event.consentReceiptId !== receipt.id) {
        throw new Error(
          "This event was already confirmed; use Review analysis before changing its provider",
        );
      }
      await activateEventMemberships(
        db,
        auth.principal,
        eventId,
        group.assetIds,
        receipt.id,
      );
      await assertEventMembershipsActive(
        db,
        auth.principal,
        eventId,
        group.assetIds,
      );
    } catch (error) {
      await db.collection("media_events").updateOne(
        {
          _id: eventId,
          owner: auth.principal,
          status: "clustered",
          consentReceiptId: receipt.id,
        },
        {
          $set: {
            status: "stale",
            safeError:
              "Event confirmation lost a derived-media membership fence",
            updatedAt: new Date(),
          },
          $unset: { previewSnapshots: "" },
        },
      ).catch(() => {});
      await releaseEventMemberships(
        db,
        auth.principal,
        eventId,
        receipt.id,
      ).catch(() => {});
      await db.collection("media_event_memberships").updateMany(
        {
          owner: auth.principal,
          eventId,
          receiptId: receipt.id,
          status: "active",
        },
        {
          $set: {
            status: "deleted",
            invalidatedAt: new Date(),
            invalidationReason:
              "Event confirmation lost a derived-media membership fence",
            updatedAt: new Date(),
          },
        },
      ).catch(() => {});
      throw error;
    }
    await refreshLinksWithWarning(db, event, config).catch(() => {});
    let jobId: string | undefined;
    let queueError: string | undefined;
    if (input.queueAnalysis && profile) {
      const fingerprint = profileFingerprint(profile);
      const expectedRunId = eventRunId({
        eventId: event._id,
        profileFingerprint: fingerprint,
        sourceHashes: group.sourceHashes,
        consentReceiptId: receipt.id,
      });
      if (
        event.status === "ready" && event.currentRunId === expectedRunId
      ) {
        results.push({
          eventId: event._id,
          queued: false,
          reused: true,
        });
        continue;
      }
      const plannedJobId = mediaEventJobId({
        eventId: event._id,
        profileFingerprint: fingerprint,
        sourceHashes: group.sourceHashes,
        consentReceiptId: receipt.id,
      });
      let queuedEvent = await db.collection<any>("media_events")
        .findOneAndUpdate(
          {
            _id: event._id,
            owner: auth.principal,
            status: {
              $in: [
                "clustered",
                "failed",
                "budget_blocked",
                "recognition_disabled",
              ],
            },
            consentReceiptId: receipt.id,
            publicationClaimId: { $exists: false },
          },
          {
            $set: {
              status: "queued",
              providerSnapshot: profile,
              profileFingerprint: fingerprint,
              consentReceiptId: receipt.id,
              consentReceipt: receipt,
              representativeAssetIds: group.representativeAssetIds,
              previewSnapshots: group.previewSnapshots,
              estimatedGrossUsd: group.estimatedGrossUsd,
              jobId: new ObjectId(plannedJobId),
              updatedAt: new Date(),
            },
            $unset: { safeError: "" },
          },
          { returnDocument: "after" },
        );
      if (!queuedEvent) {
        queuedEvent = await db.collection<any>("media_events").findOne({
          _id: event._id,
          owner: auth.principal,
          status: "queued",
          consentReceiptId: receipt.id,
          profileFingerprint: fingerprint,
          jobId: new ObjectId(plannedJobId),
          publicationClaimId: { $exists: false },
        });
        if (!queuedEvent) {
          throw new Error(
            "Media event analysis changed or is already queued/processing",
          );
        }
      }
      try {
        jobId = await enqueueMediaEvent(
          db,
          event._id,
          profile,
          receipt.id,
          auth,
          group.sourceHashes,
        );
        await db.collection("media_events").updateOne(
          {
            _id: event._id,
            owner: auth.principal,
            status: "queued",
            consentReceiptId: receipt.id,
            profileFingerprint: fingerprint,
            jobId: new ObjectId(plannedJobId),
          },
          {
            $set: {
              jobId: new ObjectId(jobId),
              updatedAt: new Date(),
            },
          },
        );
      } catch (error) {
        queueError = `Event analysis could not be queued: ${safeError(error)}`;
        await db.collection("media_events").updateOne(
          {
            _id: event._id,
            owner: auth.principal,
            status: "queued",
            consentReceiptId: receipt.id,
            profileFingerprint: fingerprint,
            jobId: new ObjectId(plannedJobId),
          },
          {
            $set: {
              status: "failed",
              safeError: queueError,
              updatedAt: new Date(),
            },
          },
        );
      }
      event = await db.collection("media_events").findOne({ _id: event._id });
    }
    results.push({
      eventId: event!._id,
      ...(jobId ? { jobId } : {}),
      queued: Boolean(jobId),
      ...(queueError ? { error: queueError } : {}),
    });
  }

  await db.collection("media_event_aggregation_previews").updateOne(
    {
      _id: previewId,
      owner: auth.principal,
      status: "confirming",
      consentReceiptId: preview.consentReceiptId,
    },
    {
      $set: {
        status: "confirmed",
        confirmedEvents: results,
        confirmedAt: new Date(),
      },
    },
  );
  return { events: results };
}

function asDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function temporalOverlap(
  eventStart: Date,
  eventEnd: Date,
  targetStartValue: unknown,
  targetEndValue: unknown,
) {
  const targetStart = asDate(targetStartValue);
  const targetEnd = asDate(targetEndValue) ?? targetStart;
  if (!targetStart || !targetEnd) return undefined;
  const startAt = new Date(
    Math.max(eventStart.getTime(), targetStart.getTime()),
  );
  const endAt = new Date(Math.min(eventEnd.getTime(), targetEnd.getTime()));
  return {
    startAt,
    endAt: endAt < startAt ? startAt : endAt,
    seconds: Math.max(0, (endAt.getTime() - startAt.getTime()) / 1_000),
  };
}

type EventLinkCandidate = Omit<
  MediaEventLink,
  "_id" | "linkKey" | "owner" | "eventId" | "status" | "createdAt" | "updatedAt"
>;

function linkKey(
  owner: string,
  eventId: ObjectId,
  targetType: EventLinkCandidate["targetType"],
  targetId: ObjectId,
): string {
  return createHash("sha256").update([
    "media-event-link-v1",
    owner,
    String(eventId),
    targetType,
    String(targetId),
  ].join("\0")).digest("hex");
}

export async function refreshMediaEventLinks(
  db: Db,
  event: any,
  config: MediaKnowledgeConfig,
  options: { includeObjects?: boolean } = {},
): Promise<{ createdOrRefreshed: number; removedStaleSuggestions: number }> {
  const eventStart = asDate(event.startAt);
  const eventEnd = asDate(event.endAt);
  if (!eventStart || !eventEnd || eventEnd < eventStart) {
    throw new Error("Media event has an invalid temporal range");
  }
  const windowMs = config.eventAggregation.linkWindowMinutes * 60_000;
  const windowStart = new Date(eventStart.getTime() - windowMs);
  const windowEnd = new Date(eventEnd.getTime() + windowMs);
  const sourceFiles = await db.collection<any>("source_files").find({
    created_by: event.owner,
    start: { $lte: windowEnd },
    $or: [
      { end: { $gte: windowStart } },
      { end: { $exists: false } },
    ],
  }, {
    projection: { _id: 1, start: 1, end: 1 },
  }).sort({ start: 1 }).limit(MAX_LINK_CANDIDATES_PER_TYPE).toArray();
  const sourceIds = sourceFiles.map((source) => source._id);
  const transcriptions = sourceIds.length
    ? await db.collection<any>("transcriptions").find({
      original: { $in: sourceIds },
      start: { $lte: windowEnd },
      $or: [
        { end: { $gte: windowStart } },
        { end: { $exists: false } },
      ],
    }, {
      projection: { _id: 1, original: 1, start: 1, end: 1 },
    }).sort({ start: 1 }).limit(MAX_LINK_CANDIDATES_PER_TYPE).toArray()
    : [];
  const objects = options.includeObjects !== false &&
      event.owner === PERSONAL_CORPUS_OWNER
    ? await db.collection<any>("objects").find({
      isPerson: { $ne: true },
      timeRanges: {
        $elemMatch: {
          start: { $lte: windowEnd },
          $or: [
            { end: { $gte: windowStart } },
            { end: { $exists: false } },
          ],
        },
      },
      "metadata.mediaEvent.eventId": { $ne: String(event._id) },
    }, {
      projection: { _id: 1, timeRanges: 1 },
    }).limit(MAX_LINK_CANDIDATES_PER_TYPE).toArray()
    : [];

  const candidates: EventLinkCandidate[] = [];
  for (const source of sourceFiles) {
    const overlap = temporalOverlap(
      eventStart,
      eventEnd,
      source.start,
      source.end ?? source.start,
    );
    candidates.push({
      targetType: "audio_source",
      targetId: objectId(source._id),
      relation: "temporal_overlap",
      ...(overlap ? { overlap } : {}),
      confidence: overlap?.seconds ? 0.95 : 0.55,
    });
  }
  for (const transcription of transcriptions) {
    const overlap = temporalOverlap(
      eventStart,
      eventEnd,
      transcription.start,
      transcription.end ?? transcription.start,
    );
    candidates.push({
      targetType: "transcription",
      targetId: objectId(transcription._id),
      relation: "temporal_overlap",
      ...(overlap ? { overlap } : {}),
      confidence: overlap?.seconds ? 1 : 0.6,
    });
  }
  for (const object of objects) {
    const overlaps = (Array.isArray(object.timeRanges) ? object.timeRanges : [])
      .map((range: any) =>
        temporalOverlap(
          eventStart,
          eventEnd,
          range.start,
          range.end ?? range.start,
        )
      )
      .filter(Boolean)
      .sort((left: any, right: any) => right.seconds - left.seconds);
    candidates.push({
      targetType: "object",
      targetId: objectId(object._id),
      relation: "temporal_overlap",
      ...(overlaps[0] ? { overlap: overlaps[0] } : {}),
      confidence: overlaps[0]?.seconds ? 0.9 : 0.5,
    });
  }

  const now = new Date();
  const currentKeys = candidates.map((candidate) =>
    linkKey(event.owner, event._id, candidate.targetType, candidate.targetId)
  );
  if (candidates.length) {
    await db.collection("media_event_links").bulkWrite(
      candidates.map((candidate, index) => {
        const key = currentKeys[index];
        return {
          updateOne: {
            filter: { _id: objectIdFromParts("media-event-link", key) },
            update: {
              $setOnInsert: {
                _id: objectIdFromParts("media-event-link", key),
                owner: event.owner,
                eventId: event._id,
                linkKey: key,
                targetType: candidate.targetType,
                targetId: candidate.targetId,
                status: "suggested",
                createdAt: now,
              },
              $set: {
                relation: candidate.relation,
                confidence: candidate.confidence,
                ...(candidate.overlap ? { overlap: candidate.overlap } : {}),
                updatedAt: now,
              },
              ...(!candidate.overlap ? { $unset: { overlap: "" } } : {}),
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }
  const removed = await db.collection("media_event_links").deleteMany({
    owner: event.owner,
    eventId: event._id,
    status: "suggested",
    ...(currentKeys.length ? { linkKey: { $nin: currentKeys } } : {}),
  });
  return {
    createdOrRefreshed: candidates.length,
    removedStaleSuggestions: removed.deletedCount,
  };
}

async function refreshLinksWithWarning(
  db: Db,
  event: any,
  config: MediaKnowledgeConfig,
  options: { includeObjects?: boolean } = {},
) {
  try {
    const result = await refreshMediaEventLinks(db, event, config, options);
    await db.collection("media_events").updateOne(
      { _id: event._id, owner: event.owner },
      { $unset: { linkWarning: "" }, $set: { updatedAt: new Date() } },
    );
    return result;
  } catch (error) {
    const warning = safeError(error);
    await db.collection("media_events").updateOne(
      { _id: event._id, owner: event.owner },
      { $set: { linkWarning: warning, updatedAt: new Date() } },
    );
    throw error;
  }
}

function publicEvent(event: any) {
  return {
    _id: event._id,
    owner: event.owner,
    stableKey: event.stableKey,
    status: event.status,
    assetIds: event.assetIds,
    startAt: event.startAt,
    endAt: event.endAt,
    ...(event.centroid ? { centroid: event.centroid } : {}),
    representativeAssetIds: event.representativeAssetIds,
    ...(event.analysis ? { analysis: event.analysis } : {}),
    ...(event.currentRunId ? { currentRunId: event.currentRunId } : {}),
    ...(event.objectId ? { objectId: event.objectId } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    ...(event.safeError ? { safeError: event.safeError } : {}),
    ...(event.linkWarning ? { linkWarning: event.linkWarning } : {}),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

async function eventEnvelope(db: Db, event: any) {
  const [assets, links] = await Promise.all([
    db.collection<any>("media_assets").find({
      owner: event.owner,
      _id: { $in: event.assetIds ?? [] },
    }, {
      projection: {
        _id: 1,
        fileName: 1,
        capturedAt: 1,
        thumbnail: 1,
        preview: 1,
      },
    }).toArray(),
    db.collection<any>("media_event_links").find({
      owner: event.owner,
      eventId: event._id,
      status: { $in: ["suggested", "confirmed"] },
    }, {
      projection: {
        owner: 0,
        linkKey: 0,
      },
    }).sort({ confidence: -1, _id: 1 }).toArray(),
  ]);
  const assetsById = new Map(assets.map((asset) => [String(asset._id), asset]));
  const assetResponses = (event.assetIds ?? []).flatMap((assetId: ObjectId) => {
    const asset = assetsById.get(String(assetId));
    return asset
      ? [{
        assetId: asset._id,
        fileName: asset.fileName,
        capturedAt: asset.capturedAt,
        thumbnailUrl: previewUrl(
          asset.thumbnail?.fileId ?? asset.preview?.fileId,
        ),
      }]
      : [];
  });
  const linkResponse = (type: string) =>
    links.filter((link) => link.targetType === type).map((link) => ({
      id: link._id,
      targetId: link.targetId,
      status: link.status,
      relation: link.relation,
      confidence: link.confidence,
      overlap: link.overlap,
    }));
  return {
    event: publicEvent(event),
    analysis: event.analysis ?? null,
    assets: assetResponses,
    links: {
      transcriptions: linkResponse("transcription"),
      audioSources: linkResponse("audio_source"),
      objects: linkResponse("object"),
    },
  };
}

export function neutralizeMediaEventMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\b(https?|data):\/\//gi, "$1[:]//")
    .replace(/([\\`*_{}\[\]()#+\-.!|])/g, "\\$1");
}

async function activatePublishedEventObject(
  db: Db,
  publishedObjectId: ObjectId,
  event: any,
  runId: string,
): Promise<void> {
  const generation = Number(event.deletionGeneration ?? 0);
  const liveEvent = await db.collection<any>("media_events").findOne({
    _id: event._id,
    owner: event.owner,
    status: "ready",
    currentRunId: runId,
    publishedRunId: runId,
    providerDeletionPending: { $exists: false },
    ...deletionGenerationClause("deletionGeneration", generation),
  }, { projection: { _id: 1 } });
  if (!liveEvent) {
    throw new Error(
      "Media event deletion generation changed before activation",
    );
  }
  const object = await db.collection<any>("objects").findOne({
    _id: publishedObjectId,
    "metadata.mediaEvent.eventId": String(event._id),
    "metadata.mediaEvent.latestAnalysisRunId": runId,
    ...deletionGenerationClause(
      "metadata.mediaEvent.deletionGeneration",
      generation,
    ),
  });
  if (!object) throw new Error("Pending media event Object was not found");
  if (
    object.metadata?.mediaEvent?.publicationState === "live" &&
    object.isEvent === true && object.metadata?.mediaEvent?.stale !== true
  ) return;
  if (object.metadata?.mediaEvent?.publicationState !== "pending") {
    throw new Error("Invalidated media event Object cannot be activated");
  }
  const version = Number(object.version ?? 0);
  const analysis = event.analysis as MediaEventUnderstanding;
  const update = await db.collection("objects").updateOne(
    {
      _id: publishedObjectId,
      "metadata.mediaEvent.eventId": String(event._id),
      "metadata.mediaEvent.latestAnalysisRunId": runId,
      "metadata.mediaEvent.publicationState": "pending",
      ...deletionGenerationClause(
        "metadata.mediaEvent.deletionGeneration",
        generation,
      ),
      ...(object.version === undefined
        ? { version: { $exists: false } }
        : { version }),
    },
    {
      $set: {
        "metadata.mediaEvent.publicationState": "live",
        "metadata.mediaEvent.stale": false,
        isEvent: true,
        _listCategories: ["event"],
        ...(!object.isEvent
          ? {
            timeRanges: [{
              start: event.startAt,
              end: event.endAt,
              name: analysis.temporalLabel,
            }],
            ...(event.centroid ? { location: event.centroid } : {}),
          }
          : {}),
        updatedAt: new Date(),
      },
      $unset: {
        "metadata.mediaEvent.staleReason": "",
        "metadata.mediaEvent.deletionTombstoneId": "",
      },
      $inc: { version: 1 },
    },
  );
  if (update.modifiedCount !== 1) {
    throw new Error("Pending media event Object activation lost its fence");
  }
  await db.collection("object_history").insertOne({
    objectId: publishedObjectId,
    action: "update",
    timestamp: new Date(),
    userId: event.owner,
    version: version + 1,
    field: "metadata.mediaEvent.publicationState",
    oldValue: object.metadata?.mediaEvent?.publicationState,
    newValue: "live",
  }).catch(() => {});
  await db.collection<any>("object_stats").updateOne(
    { _id: "counts" },
    {
      $set: {
        stale: true,
        typeCountsStatus: "stale",
        orphanedStatus: "stale",
      },
    },
    { upsert: true },
  );
}

export async function publishCanonicalEventObject(
  db: Db,
  event: any,
  publishTimeline: typeof publishTimelineInvalidation =
    publishTimelineInvalidation,
  beforeFinalEventCas: () => Promise<void> = () => Promise.resolve(),
) {
  if (event.owner !== PERSONAL_CORPUS_OWNER) {
    throw new Error(
      "Publishing to the shared Objects timeline is restricted to the admin owner",
    );
  }
  const requestedRunId = event.currentRunId;
  const deletionGeneration = Number(event.deletionGeneration ?? 0);
  if (event.status !== "ready" || !event.analysis || !requestedRunId) {
    throw new Error("Only a ready, analyzed media event can be published");
  }
  const publishedObjectId = objectIdFromParts(
    "media-event-object-v1",
    event.owner,
    String(event._id),
  );
  const claimId = randomUUID();
  const claims = db.collection<any>("media_event_publication_claims");
  let ownsClaim = false;
  const claimNow = new Date();
  const leaseExpiresAt = new Date(
    claimNow.getTime() + PUBLICATION_CLAIM_LEASE_MS,
  );
  try {
    await claims.insertOne({
      _id: event._id,
      owner: event.owner,
      runId: requestedRunId,
      deletionGeneration,
      state: "publishing",
      claimId,
      leaseExpiresAt,
      createdAt: claimNow,
      updatedAt: claimNow,
    });
    ownsClaim = true;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    let existingClaim = await claims.findOne({
      _id: event._id,
      owner: event.owner,
    });
    if (
      existingClaim?.state === "ready" &&
      existingClaim.runId === requestedRunId &&
      Number(existingClaim.deletionGeneration ?? 0) === deletionGeneration &&
      existingClaim.objectId
    ) return objectId(existingClaim.objectId);
    const existingLease = asDate(existingClaim?.leaseExpiresAt);
    if (
      existingClaim?.state === "publishing" && existingLease &&
      existingLease.getTime() <= claimNow.getTime()
    ) {
      const [currentEvent, existingObject] = await Promise.all([
        db.collection<any>("media_events").findOne({
          _id: event._id,
          owner: event.owner,
          status: "ready",
          currentRunId: existingClaim.runId,
          ...deletionGenerationClause(
            "deletionGeneration",
            Number(existingClaim.deletionGeneration ?? 0),
          ),
          providerDeletionPending: { $exists: false },
        }),
        db.collection<any>("objects").findOne({ _id: publishedObjectId }),
      ]);
      if (
        currentEvent?.publishedRunId === existingClaim.runId &&
        currentEvent?.publicationReview?.runId === existingClaim.runId &&
        currentEvent?.publicationReview?.principal === event.owner &&
        currentEvent?.publicationReview?.reviewedSensitiveText === true &&
        String(existingObject?.metadata?.mediaEvent?.eventId ?? "") ===
          String(event._id) &&
        existingObject?.metadata?.mediaEvent?.latestAnalysisRunId ===
          existingClaim.runId &&
        Number(
            existingObject?.metadata?.mediaEvent?.deletionGeneration ?? 0,
          ) === Number(existingClaim.deletionGeneration ?? 0)
      ) {
        await activatePublishedEventObject(
          db,
          publishedObjectId,
          currentEvent,
          existingClaim.runId,
        );
        await db.collection("media_events").updateOne(
          {
            _id: event._id,
            owner: event.owner,
            currentRunId: existingClaim.runId,
            status: "ready",
            ...deletionGenerationClause(
              "deletionGeneration",
              Number(existingClaim.deletionGeneration ?? 0),
            ),
          },
          {
            $set: { objectId: publishedObjectId, updatedAt: claimNow },
            $unset: {
              publicationClaimId: "",
              publicationLeaseExpiresAt: "",
            },
          },
        );
        await claims.updateOne(
          {
            _id: event._id,
            owner: event.owner,
            state: "publishing",
            claimId: existingClaim.claimId,
          },
          {
            $set: {
              state: "ready",
              objectId: publishedObjectId,
              updatedAt: claimNow,
            },
          },
        );
        return publishedObjectId;
      }
      await Promise.all([
        claims.updateOne(
          {
            _id: event._id,
            owner: event.owner,
            state: "publishing",
            claimId: existingClaim.claimId,
            leaseExpiresAt: { $lte: claimNow },
          },
          {
            $set: {
              state: "failed",
              safeError: "Expired publication claim recovered",
              updatedAt: claimNow,
            },
          },
        ),
        db.collection("media_events").updateOne(
          {
            _id: event._id,
            owner: event.owner,
            publicationClaimId: existingClaim.claimId,
          },
          {
            $unset: {
              publicationClaimId: "",
              publicationLeaseExpiresAt: "",
            },
          },
        ),
      ]);
      existingClaim = await claims.findOne({
        _id: event._id,
        owner: event.owner,
      });
    }
    const reclaimed = await claims.findOneAndUpdate(
      {
        _id: event._id,
        owner: event.owner,
        $or: [
          { state: "failed" },
          { state: "invalidated" },
          { state: "ready", runId: { $ne: requestedRunId } },
        ],
      },
      {
        $set: {
          runId: requestedRunId,
          deletionGeneration,
          state: "publishing",
          claimId,
          leaseExpiresAt,
          updatedAt: claimNow,
        },
        $unset: { objectId: "", safeError: "" },
      },
      { returnDocument: "after" },
    );
    ownsClaim = Boolean(reclaimed);
    if (!ownsClaim) {
      throw new Error("Media event publication is already in progress");
    }
  }

  try {
    const fresh = await db.collection<any>("media_events").findOneAndUpdate(
      {
        _id: event._id,
        owner: event.owner,
        currentRunId: requestedRunId,
        status: "ready",
        providerDeletionPending: { $exists: false },
        $and: [
          deletionGenerationClause("deletionGeneration", deletionGeneration),
          {
            $or: [
              { publicationClaimId: { $exists: false } },
              { publicationClaimId: claimId },
            ],
          },
        ],
      },
      {
        $set: {
          publicationClaimId: claimId,
          publicationLeaseExpiresAt: leaseExpiresAt,
          updatedAt: claimNow,
        },
      },
      { returnDocument: "after" },
    );
    const analysis = fresh?.analysis as MediaEventUnderstanding | undefined;
    if (!fresh || !analysis) {
      throw new Error("Media event changed before publication was claimed");
    }
    if (
      fresh.publicationReview?.runId !== requestedRunId ||
      fresh.publicationReview?.principal !== event.owner ||
      fresh.publicationReview?.reviewedSensitiveText !== true
    ) {
      throw new Error(
        "Provider-generated event text must be explicitly reviewed before publication",
      );
    }
    const run = await db.collection<any>("media_event_runs").findOne({
      _id: requestedRunId,
      state: "ready",
      eventId: event._id,
      owner: event.owner,
      consentReceiptId: fresh.consentReceiptId,
      ...deletionGenerationClause(
        "deletionGeneration",
        deletionGeneration,
      ),
    });
    if (!run || canonicalJson(run.analysis) !== canonicalJson(analysis)) {
      throw new Error("Ready media event provenance could not be verified");
    }
    const existing = await db.collection<any>("objects").findOne({
      _id: publishedObjectId,
    });
    if (
      existing &&
      String(existing.metadata?.mediaEvent?.eventId ?? "") !== String(event._id)
    ) {
      throw new Error(
        "The deterministic media event object id is already used",
      );
    }
    const now = new Date();
    const details = [
      neutralizeMediaEventMarkdown(analysis.description),
      analysis.keyActions.length
        ? `\n\nКлючевые действия:\n${
          analysis.keyActions.map((action) =>
            `- ${neutralizeMediaEventMarkdown(action.text)}`
          ).join("\n")
        }`
        : "",
    ].join("");
    const generatedSnapshot: Record<string, unknown> = {
      name: analysis.title,
      details,
      timeRanges: [{
        start: fresh.startAt,
        end: fresh.endAt,
        name: analysis.temporalLabel,
      }],
      location: fresh.centroid ?? null,
    };
    const previousMediaEvent = existing?.metadata?.mediaEvent ?? {};
    const previousGenerated = previousMediaEvent.generatedSnapshot ?? {};
    const contentConflicts: string[] = [];
    const generatedSet: Record<string, unknown> = {};
    const generatedUnset: Record<string, ""> = {};
    if (existing) {
      for (const field of ["name", "details", "timeRanges", "location"]) {
        const currentValue = field === "location"
          ? existing[field] ?? null
          : existing[field];
        const previousValue = field === "location"
          ? previousGenerated[field] ?? null
          : previousGenerated[field];
        if (canonicalJson(currentValue) === canonicalJson(previousValue)) {
          if (generatedSnapshot[field] === null) generatedUnset[field] = "";
          else generatedSet[field] = generatedSnapshot[field];
        } else {
          contentConflicts.push(field);
        }
      }
    }
    const contentRunId = contentConflicts.length
      ? previousMediaEvent.contentRunId ?? previousMediaEvent.runId ??
        requestedRunId
      : requestedRunId;
    const contentProvider = contentConflicts.length
      ? previousMediaEvent.provider
      : run.provenance;
    const ownedMetadata = {
      mediaEvent: {
        schemaVersion: "mycelia.media-event-object.v1",
        eventId: String(event._id),
        owner: event.owner,
        stableKey: fresh.stableKey,
        runId: contentRunId,
        contentRunId,
        latestAnalysisRunId: requestedRunId,
        provider: contentProvider,
        latestAnalysisProvider: run.provenance,
        privacyVersion: contentConflicts.length
          ? previousMediaEvent.privacyVersion
          : run.provenance?.privacyVersion,
        contentConflicts,
        generatedSnapshot,
        deletionGeneration,
        stale: true,
        staleReason: "Publication pending fenced activation",
        publicationState: "pending",
      },
      mediaAssetIds: (fresh.assetIds ?? []).map(String),
    };
    if (!existing) {
      const document = {
        _id: publishedObjectId,
        name: analysis.title,
        details,
        icon: { text: "📷" },
        isEvent: false,
        _listCategories: [],
        metadata: ownedMetadata,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await db.collection("objects").insertOne(document);
      await db.collection("object_history").insertOne({
        objectId: publishedObjectId,
        action: "create",
        timestamp: now,
        userId: event.owner,
        version: 1,
        field: null,
        oldValue: undefined,
        newValue: document,
      }).catch((error) =>
        console.error("Failed to record media event object history", error)
      );
      await db.collection<any>("object_stats").updateOne(
        { _id: "counts" },
        {
          $set: {
            stale: true,
            typeCountsStatus: "stale",
            orphanedStatus: "stale",
          },
        },
        { upsert: true },
      );
    } else {
      const currentVersion = Number(existing.version ?? 0);
      const updated = await db.collection("objects").updateOne(
        {
          _id: publishedObjectId,
          $and: [
            deletionGenerationClause(
              "metadata.mediaEvent.deletionGeneration",
              deletionGeneration,
            ),
          ],
          ...(existing.version === undefined
            ? { version: { $exists: false } }
            : { version: currentVersion }),
        },
        {
          $set: {
            "metadata.mediaEvent": ownedMetadata.mediaEvent,
            "metadata.mediaAssetIds": ownedMetadata.mediaAssetIds,
            isEvent: false,
            _listCategories: [],
            ...generatedSet,
            updatedAt: now,
          },
          ...(Object.keys(generatedUnset).length
            ? { $unset: generatedUnset }
            : {}),
          $inc: { version: 1 },
        },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error("Published Object was concurrently modified");
      }
      await db.collection("object_history").insertOne({
        objectId: publishedObjectId,
        action: "update",
        timestamp: now,
        userId: event.owner,
        version: currentVersion + 1,
        field: "metadata",
        oldValue: existing.metadata,
        newValue: { ...existing.metadata, ...ownedMetadata },
      }).catch((error) =>
        console.error("Failed to record media event object history", error)
      );
    }
    await beforeFinalEventCas();
    const final = await db.collection("media_events").updateOne(
      {
        _id: event._id,
        owner: event.owner,
        currentRunId: requestedRunId,
        status: "ready",
        publicationClaimId: claimId,
        providerDeletionPending: { $exists: false },
        ...deletionGenerationClause(
          "deletionGeneration",
          deletionGeneration,
        ),
      },
      {
        $set: {
          objectId: publishedObjectId,
          publishedRunId: requestedRunId,
          updatedAt: now,
        },
        $unset: {
          publicationClaimId: "",
          publicationLeaseExpiresAt: "",
        },
      },
    );
    if (final.matchedCount !== 1) {
      throw new Error("Media event changed before publication completed");
    }
    await activatePublishedEventObject(
      db,
      publishedObjectId,
      fresh,
      requestedRunId,
    );
    const completed = await claims.updateOne(
      {
        _id: event._id,
        owner: event.owner,
        runId: requestedRunId,
        deletionGeneration,
        state: "publishing",
        claimId,
      },
      {
        $set: {
          state: "ready",
          objectId: publishedObjectId,
          updatedAt: now,
        },
      },
    );
    if (completed.modifiedCount !== 1) {
      throw new Error("Media event publication claim was lost");
    }
    await publishTimeline(
      asDate(fresh.startAt),
      asDate(fresh.endAt),
      "media event published",
    ).catch(() => {});
    return publishedObjectId;
  } catch (error) {
    if (ownsClaim) {
      const staleEvent = await db.collection<any>("media_events").findOne({
        _id: event._id,
        owner: event.owner,
        status: "stale",
      }, { projection: { safeError: 1 } }).catch(() => null);
      if (staleEvent) {
        const staleObject = await db.collection<any>("objects").findOne({
          _id: publishedObjectId,
          "metadata.mediaEvent.eventId": String(event._id),
        }).catch(() => null);
        if (staleObject && staleObject.metadata?.mediaEvent?.stale !== true) {
          const staleAt = new Date();
          const staleVersion = Number(staleObject.version ?? 0);
          await db.collection("objects").updateOne(
            {
              _id: publishedObjectId,
              ...(staleObject.version === undefined
                ? { version: { $exists: false } }
                : { version: staleVersion }),
            },
            {
              $set: {
                "metadata.mediaEvent.stale": true,
                "metadata.mediaEvent.staleReason": staleEvent.safeError ??
                  "Source preview was invalidated during publication",
                updatedAt: staleAt,
              },
              $inc: { version: 1 },
            },
          ).catch(() => {});
          await db.collection("object_history").insertOne({
            objectId: publishedObjectId,
            action: "update",
            timestamp: staleAt,
            userId: event.owner,
            version: staleVersion + 1,
            field: "metadata.mediaEvent.stale",
            oldValue: staleObject.metadata?.mediaEvent?.stale,
            newValue: true,
          }).catch(() => {});
        }
      }
      await db.collection("media_events").updateOne(
        {
          _id: event._id,
          owner: event.owner,
          publicationClaimId: claimId,
        },
        {
          $unset: {
            publicationClaimId: "",
            publicationLeaseExpiresAt: "",
          },
        },
      ).catch(() => {});
      await claims.updateOne(
        {
          _id: event._id,
          owner: event.owner,
          runId: requestedRunId,
          state: "publishing",
          claimId,
        },
        {
          $set: {
            state: "failed",
            safeError: safeError(error),
            updatedAt: new Date(),
          },
        },
      ).catch(() => {});
    }
    throw error;
  }
}

export async function reviewAndPublishMediaEvent(
  db: Db,
  owner: string,
  eventIdValue: ObjectId | string,
  analysisRunId: string,
) {
  const reviewedAt = new Date();
  const event = await db.collection<any>("media_events").findOneAndUpdate(
    {
      _id: objectId(eventIdValue),
      owner,
      status: "ready",
      currentRunId: analysisRunId,
    },
    {
      $set: {
        publicationReview: {
          runId: analysisRunId,
          principal: owner,
          reviewedSensitiveText: true,
          reviewedAt,
        },
        updatedAt: reviewedAt,
      },
    },
    { returnDocument: "after" },
  );
  if (!event) throw new Error("Media event not found");
  const reviewId = sha256Hex([
    "media-event-publication-review-v1",
    owner,
    String(event._id),
    analysisRunId,
  ]);
  try {
    await db.collection<any>("media_event_publication_reviews").insertOne({
      _id: reviewId,
      owner,
      eventId: event._id,
      runId: analysisRunId,
      reviewedSensitiveText: true,
      reviewedAt,
    });
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  return await publishCanonicalEventObject(db, event);
}

async function validateEventProviderInputs(db: Db, event: any) {
  const assets = await loadEventCandidateAssets(
    db,
    event.owner,
    (event.assetIds ?? []).map(String),
  );
  if (
    !sameIds(assets.map((asset) => asset._id), event.assetIds ?? []) ||
    assets.some((asset, index) =>
      String(asset.sha256) !== String(event.sourceHashes?.[index] ?? "")
    )
  ) throw new Error("Media event member hashes no longer match confirmation");
  await assertCanonicalPreviewFiles(db, assets);
  const snapshots = (event.previewSnapshots ?? []) as EventPreviewSnapshot[];
  if (
    snapshots.length < 2 || snapshots.length > PROVIDER_MAX_PREVIEWS ||
    !sameIds(
      snapshots.map((snapshot) => snapshot.assetId),
      event.representativeAssetIds ?? [],
    )
  ) throw new Error("Media event representative preview snapshot is invalid");
  const byId = new Map(assets.map((asset) => [String(asset._id), asset]));
  for (const snapshot of snapshots) {
    const asset = byId.get(String(snapshot.assetId));
    if (
      !asset || snapshot.sha256 !== String(asset.sha256) ||
      String(snapshot.previewFileId) !== String(asset.preview?.fileId) ||
      String(snapshot.thumbnailFileId ?? "") !==
        String(asset.thumbnail?.fileId ?? "")
    ) {
      throw new Error(
        "Media event representative preview changed after confirmation",
      );
    }
  }
  return { assets, snapshots, byId };
}

async function prepareEventProviderPreviews(
  db: Db,
  event: any,
  inputs: Awaited<ReturnType<typeof validateEventProviderInputs>>,
) {
  const startAt = asDate(event.startAt);
  const endAt = asDate(event.endAt);
  if (!startAt || !endAt || endAt < startAt) {
    throw new Error("Media event has an invalid provider time range");
  }
  const previews: MediaEventProviderPreview[] = [];
  const evidenceRefs = new Map<string, string>();
  for (const [index, snapshot] of inputs.snapshots.entries()) {
    const asset = inputs.byId.get(String(snapshot.assetId));
    const capturedAt = asDate(asset?.capturedAt) ?? startAt;
    const width = Number(asset?.preview?.width ?? 0);
    const height = Number(asset?.preview?.height ?? 0);
    if (width <= 0 || height <= 0) {
      throw new Error("Sanitized event preview dimensions are missing");
    }
    const ref = ephemeralMediaEventPreviewRef(index);
    evidenceRefs.set(ref, String(snapshot.assetId));
    previews.push({
      ref,
      bytes: await downloadPreview(db, snapshot.previewFileId),
      mimeType: "image/webp",
      width,
      height,
      offsetSeconds: Math.max(
        0,
        (capturedAt.getTime() - startAt.getTime()) / 1_000,
      ),
    });
  }
  return {
    previews,
    evidenceRefs,
    durationSeconds: Math.max(
      0,
      (endAt.getTime() - startAt.getTime()) / 1_000,
    ),
  };
}

export async function acquireMediaEventProviderCallPermit(
  db: Db,
  event: any,
  runId: string,
  jobId: string,
): Promise<{ id: string; leaseExpiresAt: Date }> {
  const now = new Date();
  const generation = Number(event.deletionGeneration ?? 0);
  const available = await db.collection("media_assets").countDocuments({
    _id: { $in: event.assetIds ?? [] },
    owner: event.owner,
    derivedDeletionPending: { $exists: false },
  });
  if (available !== (event.assetIds ?? []).length) {
    throw new Error("Derived-media deletion reached the provider boundary");
  }
  const id = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + PROVIDER_CALL_PERMIT_LEASE_MS,
  );
  const claimed = await db.collection<any>("media_events").findOneAndUpdate(
    {
      _id: event._id,
      owner: event.owner,
      status: "processing",
      consentReceiptId: event.consentReceiptId,
      profileFingerprint: event.profileFingerprint,
      jobId: objectId(jobId),
      providerDeletionPending: { $exists: false },
      $and: [
        deletionGenerationClause("deletionGeneration", generation),
        {
          $or: [
            { providerCallPermit: { $exists: false } },
            { "providerCallPermit.leaseExpiresAt": { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        providerCallPermit: {
          id,
          runId,
          jobId,
          deletionGeneration: generation,
          acquiredAt: now,
          leaseExpiresAt,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) {
    throw new Error(
      "Media event changed or entered deletion before provider permission",
    );
  }
  return { id, leaseExpiresAt };
}

/**
 * Revalidates the deletion fence at the last await immediately before fetch.
 * The renewed lease is longer than the provider's bounded request plus its
 * local completion margin, so deletion cannot acknowledge an in-flight call.
 */
export async function renewMediaEventProviderCallPermit(
  db: Db,
  event: any,
  permitId: string,
  runId: string,
  jobId: string,
  now = new Date(),
): Promise<{ id: string; leaseExpiresAt: Date }> {
  const generation = Number(event.deletionGeneration ?? 0);
  const available = await db.collection("media_assets").countDocuments({
    _id: { $in: event.assetIds ?? [] },
    owner: event.owner,
    derivedDeletionPending: { $exists: false },
  });
  if (available !== (event.assetIds ?? []).length) {
    throw new Error("Derived-media deletion reached the provider fetch fence");
  }
  const leaseExpiresAt = new Date(
    now.getTime() + PROVIDER_CALL_PERMIT_LEASE_MS,
  );
  const renewed = await db.collection("media_events").updateOne(
    {
      _id: event._id,
      owner: event.owner,
      status: "processing",
      consentReceiptId: event.consentReceiptId,
      profileFingerprint: event.profileFingerprint,
      jobId: objectId(jobId),
      providerDeletionPending: { $exists: false },
      "providerCallPermit.id": permitId,
      "providerCallPermit.runId": runId,
      "providerCallPermit.jobId": jobId,
      "providerCallPermit.deletionGeneration": generation,
      ...deletionGenerationClause("deletionGeneration", generation),
    },
    {
      $set: {
        "providerCallPermit.leaseExpiresAt": leaseExpiresAt,
        updatedAt: now,
      },
    },
  );
  if (renewed.modifiedCount !== 1) {
    throw new Error(
      "Media event deletion won before the provider fetch boundary",
    );
  }
  return { id: permitId, leaseExpiresAt };
}

export async function releaseMediaEventProviderCallPermit(
  db: Db,
  eventId: ObjectId,
  owner: string,
  permitId: string,
): Promise<void> {
  await db.collection("media_events").updateOne(
    {
      _id: eventId,
      owner,
      "providerCallPermit.id": permitId,
    },
    {
      $unset: { providerCallPermit: "" },
      $set: { updatedAt: new Date() },
    },
  );
}

async function activateReadyEventRun(
  db: Db,
  event: any,
  runId: string,
  readyRun: any,
) {
  if (
    readyRun.state !== "ready" ||
    String(readyRun.eventId) !== String(event._id) ||
    readyRun.owner !== event.owner ||
    readyRun.profileFingerprint !== event.profileFingerprint ||
    readyRun.consentReceiptId !== event.consentReceiptId ||
    Number(readyRun.deletionGeneration ?? 0) !==
      Number(event.deletionGeneration ?? 0) ||
    !sameIds(readyRun.sourceHashes ?? [], event.sourceHashes ?? []) ||
    !sameIds(
      readyRun.representativeAssetIds ?? [],
      event.representativeAssetIds ?? [],
    ) || !readyRun.analysis
  ) throw new Error("MEDIA_EVENT_READY_RUN_IDENTITY_MISMATCH");
  if (readyRun.providerSnapshot?.providerType === "google-cloud") {
    await reconcileReadyGcpBudget(db, readyRun.attemptId);
  }
  const result = await db.collection("media_events").updateOne(
    {
      _id: event._id,
      owner: event.owner,
      profileFingerprint: event.profileFingerprint,
      consentReceiptId: event.consentReceiptId,
      ...deletionGenerationClause(
        "deletionGeneration",
        Number(event.deletionGeneration ?? 0),
      ),
      providerDeletionPending: { $exists: false },
      status: { $ne: "stale" },
    },
    {
      $set: {
        status: "ready",
        currentRunId: runId,
        analysis: readyRun.analysis,
        updatedAt: new Date(),
      },
      $unset: { safeError: "" },
    },
  );
  if (result.matchedCount !== 1) {
    throw new Error("Media event changed before ready-run publication");
  }
}

export async function recoverPreProviderMediaEventCrash(
  db: Db,
  runId: string,
  profile: MediaRecognitionProfile,
  now = new Date(),
): Promise<boolean> {
  const run = await db.collection<any>("media_event_runs").findOne({
    _id: runId,
    state: "building",
    "executionClaim.phase": { $in: ["claimed", "started"] },
    "executionClaim.leaseExpiresAt": { $lte: now },
  });
  if (!run?.attemptId || !run.executionClaim?.id) return false;
  const runClaim = {
    runId,
    claimId: run.executionClaim.id,
    attemptId: run.attemptId,
    jobId: String(run.jobId ?? run.executionClaim.jobId),
    leaseExpiresAt: asDate(run.executionClaim.leaseExpiresAt) ?? now,
  };
  if (profile.providerType !== "google-cloud") {
    if (run.executionClaim.phase !== "claimed") return false;
    await markMediaEventRunFailed(
      db,
      runClaim,
      "Recovered a crash before the self-hosted provider call started",
      now,
    );
    return true;
  }
  if (run.executionClaim.phase === "claimed") {
    const settled = await releaseUnstartedGcpBudgetAttempt(
      db,
      run.attemptId,
      now,
    );
    if (settled && settled !== "released") {
      throw new Error(
        `Unstarted media event budget had unsafe terminal state ${settled}`,
      );
    }
    await markMediaEventRunFailed(
      db,
      runClaim,
      "Recovered a crash before the external provider call started",
      now,
    );
    return true;
  }
  const budget = await db.collection<any>("gcp_usage_events").findOne({
    attemptId: run.attemptId,
  });
  const safeWithoutProvider = run.executionClaim.phase === "claimed" ||
    budget?.state === "released" ||
    (budget?.state === "reserved" && budget?.execution?.state === "claimed");
  if (!safeWithoutProvider) return false;
  if (budget?.state === "reserved" && budget?.execution?.id) {
    const budgetClaim: GcpBudgetExecutionClaim = {
      attemptId: run.attemptId,
      executionId: budget.execution.id,
      leaseExpiresAt: asDate(budget.execution.leaseExpiresAt) ?? now,
    };
    await finishGcpBudget(db, budgetClaim, "released");
  }
  await markMediaEventRunFailed(
    db,
    runClaim,
    "Recovered a crash before the external provider call started",
    now,
  );
  return true;
}

export async function reconcileExpiredMediaEventRuns(
  db: Db,
  owner: string,
  now = new Date(),
) {
  const pendingRuns = await db.collection<any>("media_event_runs").find({
    owner,
    "settlementPending.target": {
      $in: ["committed", "released", "unknown"],
    },
  }).limit(100).toArray();
  let settlementReconciled = 0;
  let settlementPending = 0;
  for (const run of pendingRuns) {
    const target = run.settlementPending.target as
      | "committed"
      | "released"
      | "unknown";
    try {
      let finalState: string | null = null;
      if (target === "committed") {
        finalState = await reconcileReadyGcpBudget(db, run.attemptId);
      } else if (target === "released") {
        finalState = await releaseUnstartedGcpBudgetAttempt(
          db,
          run.attemptId,
          now,
        );
      } else {
        const budget = await db.collection<any>("gcp_usage_events").findOne({
          attemptId: run.attemptId,
        });
        if (budget?.state === "reserved" || budget?.state === "settling") {
          if (!budget.execution?.id) {
            throw new Error("GCP budget execution marker is missing");
          }
          finalState = await finishGcpBudget(db, {
            attemptId: run.attemptId,
            executionId: budget.execution.id,
            leaseExpiresAt: asDate(budget.execution.leaseExpiresAt) ?? now,
          }, "unknown");
        } else {
          finalState = budget?.state ?? null;
        }
        if (finalState && !["unknown", "committed"].includes(finalState)) {
          throw new Error(
            `Provider-started budget has unsafe terminal state ${finalState}`,
          );
        }
      }
      const terminalState = run.invalidatedAt && run.state === "building"
        ? (target === "unknown" ? "provider_outcome_unknown" : "failed")
        : run.state;
      const settled = await db.collection("media_event_runs").updateOne(
        {
          _id: run._id,
          owner,
          "settlementPending.target": target,
        },
        {
          $set: {
            state: terminalState,
            budgetSettlementState: finalState ?? target,
            updatedAt: now,
          },
          $unset: {
            settlementPending: "",
            ...(terminalState === "failed" ? { executionClaim: "" } : {}),
          },
        },
      );
      if (settled.modifiedCount === 1) settlementReconciled++;
    } catch (error) {
      settlementPending++;
      await db.collection("media_event_runs").updateOne(
        {
          _id: run._id,
          owner,
          "settlementPending.target": target,
        },
        {
          $set: {
            "settlementPending.lastError": safeError(error),
            "settlementPending.lastAttemptAt": now,
            updatedAt: now,
          },
          $inc: { "settlementPending.attempts": 1 },
        },
      );
    }
  }
  const runs = await db.collection<any>("media_event_runs").find({
    owner,
    state: "building",
    settlementPending: { $exists: false },
    "executionClaim.phase": { $in: ["claimed", "started"] },
    "executionClaim.leaseExpiresAt": { $lte: now },
  }).limit(100).toArray();
  let released = 0;
  let outcomeUnknown = 0;
  for (const run of runs) {
    try {
      const profile = zMediaRecognitionProfile.parse(run.providerSnapshot);
      if (
        await recoverPreProviderMediaEventCrash(db, run._id, profile, now)
      ) {
        released++;
        await db.collection("media_events").updateOne(
          {
            _id: run.eventId,
            owner,
            status: { $in: ["queued", "processing"] },
            consentReceiptId: run.consentReceiptId,
            profileFingerprint: run.profileFingerprint,
            ...(run.jobId && ObjectId.isValid(String(run.jobId))
              ? { jobId: objectId(run.jobId) }
              : {}),
            ...deletionGenerationClause(
              "deletionGeneration",
              Number(run.deletionGeneration ?? 0),
            ),
          },
          {
            $set: {
              status: "failed",
              safeError:
                "Recovered an expired analysis run before its provider call",
              updatedAt: now,
            },
          },
        );
        continue;
      }
      if (run.executionClaim?.phase !== "started") continue;
      if (profile.providerType === "google-cloud" && run.attemptId) {
        const budget = await db.collection<any>("gcp_usage_events").findOne({
          attemptId: run.attemptId,
        });
        if (budget?.state === "reserved" || budget?.state === "settling") {
          if (!budget.execution?.id) {
            throw new Error("GCP budget execution marker is missing");
          }
          await finishGcpBudget(db, {
            attemptId: run.attemptId,
            executionId: budget.execution.id,
            leaseExpiresAt: asDate(budget.execution.leaseExpiresAt) ?? now,
          }, "unknown");
        }
      }
      const transitioned = await db.collection("media_event_runs").updateOne(
        {
          _id: run._id,
          owner,
          state: "building",
          "executionClaim.id": run.executionClaim.id,
          "executionClaim.phase": "started",
          "executionClaim.leaseExpiresAt": { $lte: now },
        },
        {
          $set: {
            state: "provider_outcome_unknown",
            safeError:
              "Expired provider-started execution was conservatively settled as outcome unknown",
            "executionClaim.phase": "outcome_unknown",
            "executionClaim.outcomeUnknownAt": now,
            updatedAt: now,
          },
        },
      );
      if (transitioned.modifiedCount === 1) {
        outcomeUnknown++;
        await db.collection("media_events").updateOne(
          {
            _id: run.eventId,
            owner,
            status: { $in: ["queued", "processing"] },
            consentReceiptId: run.consentReceiptId,
            profileFingerprint: run.profileFingerprint,
            ...(run.jobId && ObjectId.isValid(String(run.jobId))
              ? { jobId: objectId(run.jobId) }
              : {}),
            ...deletionGenerationClause(
              "deletionGeneration",
              Number(run.deletionGeneration ?? 0),
            ),
          },
          {
            $set: {
              status: "failed",
              safeError:
                "A previous provider call has an unknown outcome; review before retrying",
              updatedAt: now,
            },
          },
        );
      }
    } catch (error) {
      settlementPending++;
      await db.collection("media_event_runs").updateOne(
        {
          _id: run._id,
          owner,
          state: "building",
          "executionClaim.id": run.executionClaim?.id,
        },
        {
          $set: {
            safeError: `Expired analysis settlement remains pending: ${
              safeError(error)
            }`,
            updatedAt: now,
          },
        },
      );
    }
  }
  return {
    released,
    outcomeUnknown,
    settlementReconciled,
    settlementPending,
  };
}

async function processMediaEvent(
  db: Db,
  auth: Auth,
  input: z.infer<typeof processEventSchema>,
  config: MediaKnowledgeConfig,
) {
  const trusted = await loadTrustedMediaEventJob(
    db,
    auth.principal,
    input.jobId,
    input.eventId,
  );
  const profile = zMediaRecognitionProfile.parse(trusted.profileSnapshot);
  const fingerprint = profileFingerprint(profile);
  const event = await db.collection<any>("media_events").findOne({
    _id: new ObjectId(input.eventId),
    owner: trusted.owner,
  });
  if (!event) throw new Error("Media event not found for its signed job owner");
  if (event.status === "stale") {
    throw new Error("Media event was invalidated after its previews changed");
  }
  if (
    event.profileFingerprint !== fingerprint ||
    JSON.stringify(event.providerSnapshot) !== JSON.stringify(profile) ||
    event.consentReceiptId !== trusted.consentReceiptId ||
    !Array.isArray(event.sourceHashes) || event.sourceHashes.length < 2
  ) throw new Error("Media event no longer matches its trusted job snapshot");
  const receipt = await assertDurableConsentReceipt(db, event);
  if (
    receipt.profileFingerprint !== fingerprint ||
    canonicalJson(receipt.providerSnapshot) !== canonicalJson(profile) ||
    receipt.costCeilingUsd !== Number(event.estimatedGrossUsd ?? 0) ||
    receipt.privacyVersion !== MEDIA_EVENT_PRIVACY_VERSION
  ) throw new Error("Media event provider job exceeds its consent receipt");
  const runId = eventRunId({
    eventId: event._id,
    profileFingerprint: fingerprint,
    sourceHashes: event.sourceHashes,
    consentReceiptId: trusted.consentReceiptId,
    retryNonce: trusted.retryNonce,
  });
  const existingReady = await db.collection<any>("media_event_runs").findOne({
    _id: runId,
    state: "ready",
    consentReceiptId: trusted.consentReceiptId,
    ...deletionGenerationClause(
      "deletionGeneration",
      Number(event.deletionGeneration ?? 0),
    ),
  });
  if (existingReady) {
    await activateReadyEventRun(db, event, runId, existingReady);
    return { success: true, eventId: String(event._id), runId, reused: true };
  }
  await recoverPreProviderMediaEventCrash(db, runId, profile);

  const currentProfile = config.profiles.find((entry) =>
    entry.id === profile.id
  );
  if (
    !config.enabled || !currentProfile?.enabled ||
    JSON.stringify(currentProfile) !== JSON.stringify(profile)
  ) {
    await db.collection("media_events").updateOne(
      { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
      {
        $set: {
          status: "recognition_disabled",
          safeError:
            "Event analysis stopped because Media Knowledge is disabled or its trusted provider profile changed",
          updatedAt: new Date(),
        },
      },
    );
    return { success: false, eventId: String(event._id) };
  }

  const estimatedGrossUsd = Number(event.estimatedGrossUsd ?? 0);
  if (profile.providerType === "google-cloud") {
    if (
      !Number.isFinite(estimatedGrossUsd) || estimatedGrossUsd <= 0 ||
      estimatedGrossUsd > config.eventAggregation.perEventGrossLimitUsd
    ) {
      await db.collection("media_events").updateOne(
        { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
        {
          $set: {
            status: "budget_blocked",
            safeError:
              "The confirmed Google event estimate exceeds the current per-event limit",
            updatedAt: new Date(),
          },
        },
      );
      return { success: false, eventId: String(event._id) };
    }
  } else if (estimatedGrossUsd !== 0) {
    throw new Error("Self-hosted media event analysis must have zero GCP cost");
  }

  let providerInputs: Awaited<ReturnType<typeof validateEventProviderInputs>>;
  let preparedProviderRequest: Awaited<
    ReturnType<typeof prepareEventProviderPreviews>
  >;
  let preparedProviderCall: PreparedMediaEventProviderCall;
  try {
    providerInputs = await validateEventProviderInputs(db, event);
    preparedProviderRequest = await prepareEventProviderPreviews(
      db,
      event,
      providerInputs,
    );
    preparedProviderCall = await prepareMediaEventProviderCall(profile);
  } catch (error) {
    await db.collection("media_events").updateOne(
      { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
      {
        $set: {
          status: "failed",
          safeError: safeError(error),
          updatedAt: new Date(),
        },
      },
    );
    throw error;
  }

  const claimResult = await claimMediaEventRun(db, {
    runId,
    jobId: trusted.jobId,
    initial: {
      owner: event.owner,
      eventId: event._id,
      profileId: profile.id,
      providerSnapshot: profile,
      profileFingerprint: fingerprint,
      sourceHashes: event.sourceHashes,
      representativeAssetIds: event.representativeAssetIds,
      consentReceiptId: trusted.consentReceiptId,
      deletionGeneration: Number(event.deletionGeneration ?? 0),
      ...(trusted.retryNonce ? { retryNonce: trusted.retryNonce } : {}),
      estimatedGrossUsd,
    },
  });
  if (claimResult.kind === "ready") {
    await activateReadyEventRun(db, event, runId, claimResult.run);
    return { success: true, eventId: String(event._id), runId, reused: true };
  }
  if (claimResult.kind === "busy") {
    const unknown = claimResult.reason === "provider_outcome_unknown";
    if (
      unknown && profile.providerType === "google-cloud" &&
      claimResult.run?.attemptId
    ) {
      const budget = await db.collection<any>("gcp_usage_events").findOne({
        attemptId: claimResult.run.attemptId,
        state: "reserved",
        "execution.state": "started",
      });
      if (budget?.execution?.id) {
        await finishGcpBudget(db, {
          attemptId: claimResult.run.attemptId,
          executionId: budget.execution.id,
          leaseExpiresAt: asDate(budget.execution.leaseExpiresAt) ?? new Date(),
        }, "unknown");
      }
      if (
        claimResult.run.state === "building" &&
        claimResult.run.executionClaim?.id
      ) {
        await db.collection<any>("media_event_runs").updateOne(
          {
            _id: runId,
            state: "building",
            "executionClaim.id": claimResult.run.executionClaim.id,
          },
          {
            $set: {
              state: "provider_outcome_unknown",
              safeError:
                "Expired provider-started execution was conservatively settled as outcome unknown",
              "executionClaim.phase": "outcome_unknown",
              "executionClaim.outcomeUnknownAt": new Date(),
              updatedAt: new Date(),
            },
          },
        );
      }
    }
    await db.collection("media_events").updateOne(
      {
        _id: event._id,
        owner: event.owner,
        status: { $in: ["queued", "processing"] },
        consentReceiptId: receipt.id,
        profileFingerprint: fingerprint,
        $or: [
          { jobId: new ObjectId(trusted.jobId) },
          { jobId: { $exists: false } },
        ],
      },
      {
        $set: unknown
          ? {
            status: "failed",
            safeError:
              "A previous provider call has an unknown outcome; use explicit Retry if repetition is acceptable",
            updatedAt: new Date(),
          }
          : { status: "processing", updatedAt: new Date() },
        ...(!unknown ? { $unset: { safeError: "" } } : {}),
      },
    );
    return {
      success: false,
      eventId: String(event._id),
      runId,
      inProgress: !unknown,
      reason: claimResult.reason,
      ...(!unknown && claimResult.run.executionClaim?.leaseExpiresAt
        ? {
          retryAt: asDate(claimResult.run.executionClaim.leaseExpiresAt)
            ?.toISOString(),
        }
        : {}),
    };
  }

  const runClaim = claimResult.claim;
  const processing = await db.collection("media_events").updateOne(
    {
      _id: event._id,
      owner: event.owner,
      status: { $ne: "stale" },
      consentReceiptId: receipt.id,
      profileFingerprint: fingerprint,
    },
    {
      $set: { status: "processing", updatedAt: new Date() },
      $unset: { safeError: "" },
    },
  );
  if (processing.matchedCount !== 1) {
    await markMediaEventRunFailed(
      db,
      runClaim,
      "Media event changed before provider execution",
    ).catch(() => {});
    throw new Error("Media event changed before provider execution");
  }
  let budgetClaim: GcpBudgetExecutionClaim | null = null;
  if (profile.providerType === "google-cloud") {
    try {
      budgetClaim = await reserveGcpBudget(
        db,
        event.owner,
        runClaim.attemptId,
        estimatedGrossUsd,
        config,
        profile.projectId,
      );
    } catch (error) {
      const message = safeError(error);
      await markMediaEventRunFailed(db, runClaim, message).catch(() => {});
      await db.collection("media_events").updateOne(
        { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
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

  const loadCallableState = () =>
    Promise.all([
      db.collection("jobs").findOne({
        _id: new ObjectId(trusted.jobId),
      }, { projection: { state: 1 } }),
      db.collection("media_events").findOne({
        _id: event._id,
        owner: event.owner,
        status: "processing",
        consentReceiptId: receipt.id,
        profileFingerprint: fingerprint,
      }, { projection: { _id: 1 } }),
    ]);
  const [preStartJob, preStartEvent] = await loadCallableState();
  if (!preStartJob || preStartJob.state === "cancelled" || !preStartEvent) {
    if (profile.providerType === "google-cloud") {
      await finishGcpBudget(db, budgetClaim, "released");
    }
    await markMediaEventRunFailed(
      db,
      runClaim,
      "Media event analysis was cancelled before provider start fences",
    );
    await db.collection("media_events").updateOne(
      { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
      {
        $set: {
          status: "failed",
          safeError: "Media event analysis was cancelled before it started",
          updatedAt: new Date(),
        },
      },
    );
    return { success: false, eventId: String(event._id), cancelled: true };
  }

  let analysis: NormalizedMediaEventAnalysis;
  let resolvedUnderstanding: MediaEventUnderstanding;
  let providerPermit: { id: string; leaseExpiresAt: Date };
  try {
    providerPermit = await acquireMediaEventProviderCallPermit(
      db,
      event,
      runId,
      trusted.jobId,
    );
  } catch (error) {
    const message = safeError(error);
    if (profile.providerType === "google-cloud") {
      await finishGcpBudget(db, budgetClaim, "released").catch(() => {});
    }
    await markMediaEventRunFailed(db, runClaim, message).catch(() => {});
    await db.collection("media_events").updateOne(
      {
        _id: event._id,
        owner: event.owner,
        status: "processing",
        consentReceiptId: receipt.id,
        profileFingerprint: fingerprint,
        jobId: objectId(trusted.jobId),
      },
      {
        $set: { status: "failed", safeError: message, updatedAt: new Date() },
      },
    );
    throw error;
  }

  let providerBoundaryStarted = false;
  try {
    try {
      analysis = await analyzeWithMediaEventProvider({
        profile,
        requestId: runClaim.attemptId,
        previews: preparedProviderRequest.previews,
        totalAssetCount: event.assetIds.length,
        durationSeconds: preparedProviderRequest.durationSeconds,
      }, {
        prepared: preparedProviderCall,
        assertPermission: async () => {
          const [currentJob, currentEvent] = await loadCallableState();
          if (
            !currentJob || currentJob.state === "cancelled" || !currentEvent
          ) {
            throw new Error(
              "Media event analysis was cancelled before the provider fetch boundary",
            );
          }
          providerPermit = await renewMediaEventProviderCallPermit(
            db,
            event,
            providerPermit.id,
            runId,
            trusted.jobId,
          );
          await markMediaEventRunProviderStarted(db, runClaim);
          providerBoundaryStarted = true;
          if (profile.providerType === "google-cloud") {
            await beginGcpBudgetExecution(db, budgetClaim);
          }
          // This must remain the literal final await before provider.fetch().
          // The durable start fences above may block longer than the prior
          // permit lease; a deletion that wins during that pause must prevent
          // the worker from ever starting its outbound request.
          providerPermit = await renewMediaEventProviderCallPermit(
            db,
            event,
            providerPermit.id,
            runId,
            trusted.jobId,
          );
        },
      });
      if (
        profile.providerType === "google-cloud" &&
        analysis.usage.grossListPriceUsd > estimatedGrossUsd
      ) {
        throw new Error(
          "Provider-reported event cost exceeded the conservative per-event reservation",
        );
      }
      resolvedUnderstanding = resolveMediaEventEvidenceRefs(
        analysis.understanding,
        preparedProviderRequest.evidenceRefs,
      );
      await markMediaEventRunReady(db, runClaim, {
        analysis: resolvedUnderstanding,
        provenance: analysis.provenance,
        usage: analysis.usage,
        completedAt: new Date(),
      });
    } catch (error) {
      const message = safeError(error);
      if (profile.providerType === "google-cloud") {
        await finishGcpBudget(
          db,
          budgetClaim,
          providerBoundaryStarted ? "unknown" : "released",
        ).catch(() => {});
      }
      if (providerBoundaryStarted) {
        await markMediaEventRunOutcomeUnknown(db, runClaim, message).catch(
          () => {},
        );
      } else {
        await markMediaEventRunFailed(db, runClaim, message).catch(() => {});
      }
      await db.collection("media_events").updateOne(
        { _id: event._id, owner: event.owner, status: { $ne: "stale" } },
        {
          $set: { status: "failed", safeError: message, updatedAt: new Date() },
        },
      );
      throw error;
    }
  } finally {
    await releaseMediaEventProviderCallPermit(
      db,
      event._id,
      event.owner,
      providerPermit.id,
    ).catch((error) =>
      console.error("Failed to release media event provider permit", error)
    );
  }

  await activateReadyEventRun(db, event, runId, {
    state: "ready",
    eventId: event._id,
    owner: event.owner,
    profileFingerprint: fingerprint,
    sourceHashes: event.sourceHashes,
    representativeAssetIds: event.representativeAssetIds,
    providerSnapshot: profile,
    attemptId: runClaim.attemptId,
    analysis: resolvedUnderstanding,
  });
  if (profile.providerType === "google-cloud") {
    await finishGcpBudget(db, budgetClaim, "committed");
  }
  await refreshLinksWithWarning(db, event, config, {
    includeObjects: false,
  }).catch(() => {});
  return {
    success: true,
    eventId: String(event._id),
    runId,
    usage: analysis.usage,
    provenance: analysis.provenance,
  };
}

async function prepareAnalysisPreview(
  db: Db,
  auth: Auth,
  input: z.infer<typeof previewAnalysisSchema>,
  config: MediaKnowledgeConfig,
) {
  if (!config.enabled) throw new Error("Media Knowledge is disabled");
  const event = await db.collection<any>("media_events").findOne({
    _id: new ObjectId(input.eventId),
    owner: auth.principal,
  });
  if (!event) throw new Error("Media event not found");
  if (event.status === "stale") {
    throw new Error(
      "Stale media events must be rebuilt from a fresh aggregation preview",
    );
  }
  if (event.status === "processing" || event.status === "queued") {
    throw new Error("Media event analysis is already queued or processing");
  }
  const publication = await db.collection("media_event_publication_claims")
    .findOne({ _id: event._id, owner: auth.principal, state: "publishing" });
  if (publication) throw new Error("Media event is currently being published");

  const profile = selectProfile(config, input.profileId);
  const assets = await loadEventCandidateAssets(
    db,
    auth.principal,
    event.assetIds.map(String),
  );
  if (
    !sameIds(assets.map((asset) => asset._id), event.assetIds) ||
    assets.some((asset, index) =>
      String(asset.sha256) !== String(event.sourceHashes?.[index] ?? "")
    )
  ) throw new Error("Media event members changed and cannot be analyzed");
  await assertCanonicalPreviewFiles(db, assets);
  const representativeIndexes = selectRepresentativeAssetIndexes(
    assets.length,
    Math.min(
      config.eventAggregation.maxPreviewsPerAnalysis,
      PROVIDER_MAX_PREVIEWS,
    ),
  );
  const representativeAssetIds = representativeIndexes.map((index) =>
    objectId(assets[index]._id)
  );
  const previewSnapshots = previewSnapshotsForAssets(
    assets,
    representativeAssetIds,
  );
  const previewId = new ObjectId();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  const estimate = estimatedEventGrossUsd(config, profile);
  await db.collection("media_event_analysis_previews").insertOne({
    _id: previewId,
    owner: auth.principal,
    eventId: event._id,
    status: "preview",
    stableKey: event.stableKey,
    assetIds: event.assetIds,
    sourceHashes: event.sourceHashes,
    representativeAssetIds,
    previewSnapshots,
    providerSnapshot: profile,
    profileFingerprint: profileFingerprint(profile),
    estimatedGrossUsd: estimate,
    privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
    createdAt: new Date(),
    expiresAt,
  });
  const assetsById = new Map(
    assets.map((asset) => [String(asset._id), asset]),
  );
  const providerAssets = representativeAssetIds.map((assetId) => {
    const asset = assetsById.get(String(assetId));
    return {
      assetId,
      fileName: asset?.fileName ?? "Photo",
      capturedAt: asset?.capturedAt,
      thumbnailUrl: previewUrl(
        asset?.thumbnail?.fileId ?? asset?.preview?.fileId,
      ),
    };
  });
  return {
    previewId,
    eventId: event._id,
    expiresAt,
    provider: {
      profileId: profile.id,
      name: profile.name,
      providerType: profile.providerType,
    },
    providerAssets,
    estimatedGrossUsd: estimate,
    privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
  };
}

export async function retryMediaEvent(
  db: Db,
  auth: Auth,
  input: z.infer<typeof retrySchema>,
  config: MediaKnowledgeConfig,
) {
  if (!config.enabled) throw new Error("Media Knowledge is disabled");
  const now = new Date();
  const retryNonce = sha256Hex([
    "media-event-retry-v2",
    auth.principal,
    input.eventId,
    input.idempotencyKey,
  ]);
  const receiptId = sha256Hex([
    "media-event-retry-consent-v1",
    input.previewId,
    auth.principal,
    input.eventId,
    input.idempotencyKey,
  ]);
  let preview = await db.collection<any>("media_event_analysis_previews")
    .findOneAndUpdate(
      {
        _id: new ObjectId(input.previewId),
        owner: auth.principal,
        eventId: new ObjectId(input.eventId),
        status: "preview",
        expiresAt: { $gt: now },
      },
      {
        $set: {
          status: "confirming",
          idempotencyKey: input.idempotencyKey,
          consentReceiptId: receiptId,
          confirmingAt: now,
          expiresAt: new Date(now.getTime() + CONFIRMATION_RECOVERY_TTL_MS),
        },
      },
      { returnDocument: "after" },
    );
  if (!preview) {
    preview = await db.collection<any>("media_event_analysis_previews")
      .findOne({
        _id: new ObjectId(input.previewId),
        owner: auth.principal,
        eventId: new ObjectId(input.eventId),
        status: { $in: ["confirming", "confirmed"] },
      });
    if (!preview) {
      throw new Error("Media event analysis preview expired or was not found");
    }
    if (
      preview.idempotencyKey !== input.idempotencyKey ||
      preview.consentReceiptId !== receiptId
    ) {
      throw new Error(
        "This analysis preview is already confirmed with another idempotency key",
      );
    }
    if (preview.status === "confirmed" && preview.result) {
      return { ...preview.result, reused: true };
    }
  }

  const event = await db.collection<any>("media_events").findOne({
    _id: new ObjectId(input.eventId),
    owner: auth.principal,
  });
  if (!event) throw new Error("Media event not found");
  if (event.status === "stale") {
    throw new Error(
      "Stale media events must be rebuilt from a fresh aggregation preview",
    );
  }
  const publication = await db.collection("media_event_publication_claims")
    .findOne({ _id: event._id, owner: auth.principal, state: "publishing" });
  if (publication) throw new Error("Media event is currently being published");
  const profile = zMediaRecognitionProfile.parse(preview.providerSnapshot);
  const currentProfile = selectProfile(config, profile.id);
  if (
    JSON.stringify(currentProfile) !== JSON.stringify(profile) ||
    profileFingerprint(profile) !== preview.profileFingerprint
  ) {
    throw new Error(
      "The provider profile changed; review a fresh analysis preview",
    );
  }
  const assets = await loadEventCandidateAssets(
    db,
    auth.principal,
    (
      preview.assetIds ?? []
    ).map(String),
  );
  if (
    !sameIds(assets.map((asset) => asset._id), preview.assetIds ?? []) ||
    !sameIds(event.assetIds ?? [], preview.assetIds ?? []) ||
    !sameIds(event.sourceHashes ?? [], preview.sourceHashes ?? []) ||
    event.stableKey !== preview.stableKey ||
    assets.some((asset, index) =>
      String(asset.sha256) !== String(preview.sourceHashes?.[index] ?? "")
    )
  ) throw new Error("Media event members changed and cannot be retried");
  await assertCanonicalPreviewFiles(db, assets);
  await validateEventProviderInputs(db, {
    ...event,
    representativeAssetIds: preview.representativeAssetIds,
    previewSnapshots: preview.previewSnapshots,
  });
  const fingerprint = profileFingerprint(profile);
  const estimate = Number(preview.estimatedGrossUsd);
  if (estimate !== estimatedEventGrossUsd(config, profile)) {
    throw new Error("The analysis cost ceiling changed; review it again");
  }
  const receipt = buildConsentReceipt({
    id: receiptId,
    principal: auth.principal,
    groupStableKey: event.stableKey,
    assetIds: preview.assetIds,
    sourceHashes: preview.sourceHashes,
    representativeAssetIds: preview.representativeAssetIds,
    providerSnapshot: profile,
    profileFingerprint: fingerprint,
    privacyVersion: MEDIA_EVENT_PRIVACY_VERSION,
    costCeilingUsd: estimate,
    queueAnalysis: true,
    confirmedAt: asDate(preview.confirmingAt) ?? now,
  });
  await reserveEventMemberships(
    db,
    auth.principal,
    event._id,
    assets,
    receipt.id,
  );
  await activateEventMemberships(
    db,
    auth.principal,
    event._id,
    preview.assetIds,
    receipt.id,
  );
  await assertEventMembershipsActive(
    db,
    auth.principal,
    event._id,
    preview.assetIds,
  );
  await persistImmutableConsentReceipt(db, event._id, receipt);
  const plannedJobId = mediaEventJobId({
    eventId: event._id,
    profileFingerprint: fingerprint,
    sourceHashes: preview.sourceHashes,
    consentReceiptId: receipt.id,
    retryNonce,
  });
  let claimed = await db.collection<any>("media_events").findOneAndUpdate(
    {
      _id: event._id,
      owner: auth.principal,
      status: {
        $in: [
          "clustered",
          "ready",
          "failed",
          "budget_blocked",
          "recognition_disabled",
        ],
      },
      assetIds: preview.assetIds,
      sourceHashes: preview.sourceHashes,
      publicationClaimId: { $exists: false },
    },
    {
      $set: {
        status: "queued",
        providerSnapshot: profile,
        profileFingerprint: fingerprint,
        consentReceiptId: receipt.id,
        consentReceipt: receipt,
        representativeAssetIds: preview.representativeAssetIds,
        previewSnapshots: preview.previewSnapshots,
        estimatedGrossUsd: estimate,
        jobId: new ObjectId(plannedJobId),
        updatedAt: now,
      },
      $unset: { safeError: "", analysis: "", currentRunId: "" },
    },
    { returnDocument: "after" },
  );
  if (!claimed) {
    claimed = await db.collection<any>("media_events").findOne({
      _id: event._id,
      owner: auth.principal,
      consentReceiptId: receipt.id,
      profileFingerprint: fingerprint,
      jobId: new ObjectId(plannedJobId),
      status: { $in: ["queued", "processing", "ready"] },
    });
    if (!claimed) {
      await releaseEventMemberships(
        db,
        auth.principal,
        event._id,
        receipt.id,
      ).catch(() => {});
      throw new Error(
        "Media event changed or another analysis was queued; review again",
      );
    }
  }
  try {
    const jobId = await enqueueMediaEvent(
      db,
      event._id,
      profile,
      receipt.id,
      auth,
      preview.sourceHashes,
      retryNonce,
    );
    const result = { queued: true, jobId };
    await db.collection("media_event_analysis_previews").updateOne(
      {
        _id: preview._id,
        owner: auth.principal,
        status: "confirming",
        idempotencyKey: input.idempotencyKey,
      },
      {
        $set: { status: "confirmed", confirmedAt: new Date(), result },
      },
    );
    return result;
  } catch (error) {
    await db.collection("media_events").updateOne(
      {
        _id: event._id,
        owner: auth.principal,
        status: "queued",
        consentReceiptId: receipt.id,
        profileFingerprint: fingerprint,
        jobId: new ObjectId(plannedJobId),
      },
      {
        $set: {
          status: "failed",
          safeError: `Event analysis could not be queued: ${safeError(error)}`,
          updatedAt: new Date(),
        },
      },
    );
    throw error;
  }
}

export class MediaEventsResource
  implements Resource<MediaEventRequest, unknown> {
  code = "media-events";
  description =
    "Cluster owned photo previews into events, analyze groups without identity recognition, link local memories, and explicitly publish Timeline objects.";
  schemas = { request: mediaEventRequestSchema, response: z.unknown() };

  extractActions(input: MediaEventRequest) {
    const actions = [{
      path: ["media-events", input.action],
      actions: [input.action === "processEvent" ? "process" : "use"],
    }];
    if (
      input.action === "confirmAggregation" ||
      input.action === "refreshLinks"
    ) {
      actions.push({ path: ["objects"], actions: ["read"] });
    }
    if (input.action === "publishEvent") {
      actions.push({
        path: ["objects"],
        actions: ["read", "create", "update"],
      });
    }
    return actions;
  }

  async use(input: MediaEventRequest, auth: Auth): Promise<unknown> {
    const db = await getRootDB();
    const config = await loadConfig();
    if (
      [
        "previewAggregation",
        "confirmAggregation",
        "list",
        "get",
        "previewAnalysis",
        "retry",
      ].includes(input.action)
    ) {
      await reconcileExpiredMediaEventRuns(db, auth.principal).catch(
        (error) =>
          console.error("Failed to reconcile expired media event runs", error),
      );
    }
    switch (input.action) {
      case "previewAggregation":
        return await prepareAggregationPreviewResponse(db, auth, input, config);
      case "confirmAggregation":
        return await confirmAggregation(db, auth, input, config);
      case "list": {
        const query: Record<string, unknown> = { owner: auth.principal };
        if (input.status) query.status = input.status;
        if (input.before) query.startAt = { $lt: new Date(input.before) };
        const events = await db.collection<any>("media_events").find(query)
          .sort({ startAt: -1, _id: -1 }).limit(input.limit).toArray();
        return {
          events: await Promise.all(
            events.map((event) => eventEnvelope(db, event)),
          ),
        };
      }
      case "get": {
        const event = await db.collection<any>("media_events").findOne({
          _id: new ObjectId(input.eventId),
          owner: auth.principal,
        });
        if (!event) throw new Error("Media event not found");
        return await eventEnvelope(db, event);
      }
      case "previewAnalysis":
        return await prepareAnalysisPreview(db, auth, input, config);
      case "retry":
        return await retryMediaEvent(db, auth, input, config);
      case "processEvent":
        return await processMediaEvent(db, auth, input, config);
      case "publishEvent": {
        return {
          objectId: await reviewAndPublishMediaEvent(
            db,
            auth.principal,
            input.eventId,
            input.analysisRunId,
          ),
        };
      }
      case "refreshLinks": {
        const event = await db.collection<any>("media_events").findOne({
          _id: new ObjectId(input.eventId),
          owner: auth.principal,
        });
        if (!event) throw new Error("Media event not found");
        return await refreshLinksWithWarning(db, event, config);
      }
    }
  }
}
