import { ObjectId } from "bson";

export const SPEAKER_IDENTITY_SOURCE_INDEX_ID = "active";
export const SPEAKER_IDENTITY_SOURCE_INDEX = "speaker_identity_source_index";
export const SPEAKER_IDENTITY_SOURCE_PARTITIONS =
  "speaker_identity_source_partitions";
export const SPEAKER_IDENTITY_SOURCE_BATCHES =
  "speaker_identity_source_batches";

export type IdentitySourceIndexStatus = "counting" | "ready" | "blocked";

export interface IdentitySourcePartitionSummary {
  runId: string;
  embeddingSpaceId: string;
  sourceSegments: number;
  start: Date;
  end: Date;
  maxSegmentId: ObjectId;
}

export interface IdentitySourceIndexSnapshot {
  buildId: string;
  revision: number;
  membershipRevision: number;
  builtAt: Date;
  maxSegmentId: string | null;
}

export interface IdentitySourceIndexView {
  status: IdentitySourceIndexStatus;
  buildId: string | null;
  revision: number;
  membershipRevision: number;
  dirtyEpoch: number;
  builtAt: Date | null;
  sourceSegments: number;
  scannedSegments: number;
  batchCount: number;
  currentJobId: string | null;
  error: string | null;
}

type SourceSegment = {
  _id: ObjectId;
  runId?: unknown;
  embeddingSpaceId?: unknown;
  start?: unknown;
  end?: unknown;
};

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function summarizeIdentitySourceBatch(
  rows: SourceSegment[],
): IdentitySourcePartitionSummary[] {
  const summaries = new Map<string, IdentitySourcePartitionSummary>();
  for (const row of rows) {
    const runId = String(row.runId ?? "").trim();
    const embeddingSpaceId = String(row.embeddingSpaceId ?? "").trim();
    const start = validDate(row.start);
    const end = validDate(row.end);
    if (!runId || !embeddingSpaceId || !start || !end || !row._id) continue;
    const key = `${runId}\u0000${embeddingSpaceId}`;
    const current = summaries.get(key);
    if (!current) {
      summaries.set(key, {
        runId,
        embeddingSpaceId,
        sourceSegments: 1,
        start,
        end,
        maxSegmentId: row._id,
      });
      continue;
    }
    current.sourceSegments += 1;
    if (start < current.start) current.start = start;
    if (end > current.end) current.end = end;
    if (row._id.toHexString() > current.maxSegmentId.toHexString()) {
      current.maxSegmentId = row._id;
    }
  }
  return [...summaries.values()].sort((left, right) =>
    left.start.getTime() - right.start.getTime() ||
    left.runId.localeCompare(right.runId) ||
    left.embeddingSpaceId.localeCompare(right.embeddingSpaceId)
  );
}

export function identitySourceBatchKey(cursor: ObjectId | null): string {
  return cursor?.toHexString() ?? "beginning";
}

export function identitySourceIndexView(doc: any): IdentitySourceIndexView {
  return {
    status: doc?.status === "ready"
      ? "ready"
      : doc?.status === "blocked"
      ? "blocked"
      : "counting",
    buildId: typeof doc?.publishedBuildId === "string"
      ? doc.publishedBuildId
      : null,
    revision: Number(doc?.publishedRevision ?? 0),
    membershipRevision: Number(doc?.membershipRevision ?? 0),
    dirtyEpoch: Number(doc?.dirtyEpoch ?? 0),
    builtAt: validDate(doc?.publishedAt),
    sourceSegments: Number(doc?.publishedSourceSegments ?? 0),
    scannedSegments: Number(doc?.activeBuild?.scannedSegments ?? 0),
    batchCount: Number(doc?.activeBuild?.batchCount ?? 0),
    currentJobId: typeof doc?.currentJobId === "string"
      ? doc.currentJobId
      : typeof doc?.queuedJobId === "string"
      ? doc.queuedJobId
      : null,
    error: typeof doc?.failureReason === "string" ? doc.failureReason : null,
  };
}

export function identitySourceIndexSnapshot(
  doc: any,
): IdentitySourceIndexSnapshot | null {
  const view = identitySourceIndexView(doc);
  if (view.status !== "ready" || !view.buildId || !view.builtAt) return null;
  return {
    buildId: view.buildId,
    revision: view.revision,
    membershipRevision: view.membershipRevision,
    builtAt: view.builtAt,
    maxSegmentId: doc?.publishedMaxSegmentId
      ? String(doc.publishedMaxSegmentId)
      : null,
  };
}

export function identitySourceBuildOwnsEpoch(
  state: any,
  buildId: string,
  dirtyEpoch: number,
): boolean {
  return state?.status === "counting" &&
    state?.activeBuild?.buildId === buildId &&
    Number(state?.activeBuild?.dirtyEpoch ?? -1) === dirtyEpoch &&
    Number(state?.dirtyEpoch ?? 0) === dirtyEpoch;
}

export function identitySourceSnapshotMatches(
  expected: IdentitySourceIndexSnapshot,
  actual: any,
): boolean {
  return Number(actual?.membershipRevision ?? -1) ===
    expected.membershipRevision;
}

export function identityPublishedSourceSnapshotMatches(
  expected: IdentitySourceIndexSnapshot,
  actual: any,
): boolean {
  return actual?.status === "ready" &&
    actual?.publishedBuildId === expected.buildId &&
    Number(actual?.publishedRevision ?? -1) === expected.revision &&
    Number(actual?.membershipRevision ?? -1) ===
      expected.membershipRevision;
}

export function identitySourcePartitionMatches(
  expected: {
    runId: string;
    embeddingSpaceId: string;
    sourceSegments: number;
    indexedSourceSegments?: number;
    sourceRevision?: number;
    sourceBuildId?: string;
    maxSegmentId?: unknown;
  },
  actual: any,
): boolean {
  return actual?.runId === expected.runId &&
    actual?.embeddingSpaceId === expected.embeddingSpaceId &&
    Number(actual?.sourceSegments ?? -1) ===
      (expected.indexedSourceSegments ?? expected.sourceSegments) &&
    (expected.sourceRevision === undefined ||
      Number(actual?.sourceRevision ?? -1) === expected.sourceRevision) &&
    (expected.sourceBuildId === undefined ||
      actual?.buildId === expected.sourceBuildId) &&
    (expected.maxSegmentId === undefined ||
      String(actual?.maxSegmentId ?? "") === String(expected.maxSegmentId));
}

export async function markIdentitySourceIndexCounting(
  mongo: (request: any) => Promise<any>,
  reason: string,
  options: { membershipChanged?: boolean } = {},
): Promise<void> {
  const now = new Date();
  await mongo({
    action: "updateOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
    update: {
      $set: {
        status: "counting",
        dirtyReason: reason,
        dirtyAt: now,
        updatedAt: now,
      },
      $inc: {
        dirtyEpoch: 1,
        ...(options.membershipChanged ? { membershipRevision: 1 } : {}),
      },
      $unset: { failureReason: "" },
      $setOnInsert: {
        publishedRevision: 0,
        ...(!options.membershipChanged ? { membershipRevision: 0 } : {}),
        createdAt: now,
      },
    },
    options: { upsert: true },
  });
}
