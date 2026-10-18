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
  recoveryWaiting: boolean;
  lastProgressAt: Date | null;
  error: string | null;
}

export interface IdentitySourceReservationRecoveryPlan {
  clearCurrentJobId: boolean;
  clearQueuedJobId: boolean;
  adoptJobId: string | null;
  adoptAs: "current" | "queued" | null;
  hasLiveReservation: boolean;
}

const IDENTITY_SOURCE_TERMINAL_JOB_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
]);
const IDENTITY_SOURCE_QUEUED_JOB_STATES = new Set(["waiting", "delayed"]);
const IDENTITY_SOURCE_JOB_TYPE = "speakerIdentitySourceIndex";

export const IDENTITY_SOURCE_QUEUE_RESERVATION_GRACE_MS = 2 * 60_000;

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

export function identitySourceIndexView(
  doc: any,
  now = new Date(),
): IdentitySourceIndexView {
  const status = doc?.status === "ready"
    ? "ready"
    : doc?.status === "blocked"
    ? "blocked"
    : "counting";
  const currentJobId = typeof doc?.currentJobId === "string"
    ? doc.currentJobId
    : typeof doc?.queuedJobId === "string"
    ? doc.queuedJobId
    : null;
  const lastProgressAt = validDate(
    doc?.activeBuild?.lastBatchAt ?? doc?.activeBuild?.startedAt ??
      doc?.queuedAt ?? doc?.updatedAt,
  );
  return {
    status,
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
    currentJobId,
    recoveryWaiting: Boolean(
      status === "counting" && currentJobId && lastProgressAt &&
        now.getTime() - lastProgressAt.getTime() > 90_000,
    ),
    lastProgressAt,
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

/**
 * Decide whether the singleton index row still points at real queued work.
 *
 * A completed batch intentionally leaves currentJobId behind while the generic
 * continuation is being enqueued. If the backend restarts inside that window,
 * the terminal job must no longer fence the watchdog from resuming the build.
 * Unknown non-terminal states are treated as live to avoid duplicate jobs.
 */
export function planIdentitySourceIndexReservationRecovery(
  state: any,
  jobsById: ReadonlyMap<string, any>,
  now = new Date(),
  queuedReservationGraceMs = IDENTITY_SOURCE_QUEUE_RESERVATION_GRACE_MS,
): IdentitySourceReservationRecoveryPlan {
  const currentJobId = typeof state?.currentJobId === "string"
    ? state.currentJobId
    : null;
  const queuedJobId = typeof state?.queuedJobId === "string"
    ? state.queuedJobId
    : null;

  const currentJob = currentJobId ? jobsById.get(currentJobId) : null;
  const queuedJob = queuedJobId ? jobsById.get(queuedJobId) : null;
  const currentIsLive = Boolean(currentJob) &&
    !IDENTITY_SOURCE_TERMINAL_JOB_STATES.has(String(currentJob.state ?? ""));
  const queuedJobIsLive = Boolean(queuedJob) &&
    !IDENTITY_SOURCE_TERMINAL_JOB_STATES.has(String(queuedJob.state ?? ""));
  const queuedAt = validDate(state?.queuedAt);
  const queuedReservationIsFresh = Boolean(
    queuedJobId && !queuedJob && queuedAt &&
      now.getTime() - queuedAt.getTime() < queuedReservationGraceMs,
  );
  const hasReferencedLiveReservation = currentIsLive || queuedJobIsLive ||
    queuedReservationIsFresh;
  // The generic hasMore hook persists the continuation job before it links
  // that job back to the completed batch. Adopt work from that narrow crash
  // window instead of starting a duplicate batch.
  const unreferencedLiveJob = hasReferencedLiveReservation
    ? null
    : [...jobsById.entries()]
      .filter(([id, job]) =>
        id !== currentJobId && id !== queuedJobId &&
        job?.type === IDENTITY_SOURCE_JOB_TYPE &&
        (job?.state === "active" ||
          IDENTITY_SOURCE_QUEUED_JOB_STATES.has(String(job?.state ?? "")))
      )
      .sort(([, left], [, right]) =>
        Number(right?.state === "active") - Number(left?.state === "active")
      )[0] ?? null;
  const adoptJobId = unreferencedLiveJob?.[0] ?? null;
  const adoptAs = !unreferencedLiveJob
    ? null
    : unreferencedLiveJob[1]?.state === "active"
    ? "current"
    : "queued";

  return {
    clearCurrentJobId: Boolean(currentJobId) && !currentIsLive,
    clearQueuedJobId: Boolean(queuedJobId) &&
      !queuedJobIsLive && !queuedReservationIsFresh,
    adoptJobId,
    adoptAs,
    hasLiveReservation: hasReferencedLiveReservation || Boolean(adoptJobId),
  };
}

/**
 * Clear only stale reservations still owned by the state snapshot we read.
 * The compare-and-set predicate makes this safe when a continuation starts or
 * a new reservation is created while reconciliation is inspecting the jobs.
 */
export async function reconcileIdentitySourceIndexReservations(
  mongo: (request: any) => Promise<any>,
  state: any,
  now = new Date(),
): Promise<any> {
  if (state?.status !== "counting") return state;
  const ids = [state?.currentJobId, state?.queuedJobId]
    .filter((value): value is string =>
      typeof value === "string" && ObjectId.isValid(value)
    );
  const [referencedJobs, otherLiveJobs] = await Promise.all([
    ids.length
      ? mongo({
        action: "find",
        collection: "jobs",
        query: {
          _id: { $in: [...new Set(ids)].map((id) => new ObjectId(id)) },
        },
        options: {
          projection: { type: 1, state: 1, result: 1, createdAt: 1 },
          limit: 2,
        },
      }) as Promise<any[]>
      : Promise.resolve([]),
    mongo({
      action: "find",
      collection: "jobs",
      query: {
        type: IDENTITY_SOURCE_JOB_TYPE,
        state: { $in: ["active", "waiting", "delayed"] },
      },
      options: {
        projection: { type: 1, state: 1, createdAt: 1 },
        sort: { createdAt: -1 },
        limit: 5,
      },
    }) as Promise<any[]>,
  ]);
  const jobsById = new Map(
    [...referencedJobs, ...otherLiveJobs].map((job) =>
      [String(job._id), job] as const
    ),
  );
  const plan = planIdentitySourceIndexReservationRecovery(
    state,
    jobsById,
    now,
  );
  if (
    !plan.clearCurrentJobId && !plan.clearQueuedJobId && !plan.adoptJobId
  ) return state;

  const query: Record<string, unknown> = {
    _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
    status: "counting",
    currentJobId: state?.currentJobId ?? { $exists: false },
    queuedJobId: state?.queuedJobId ?? { $exists: false },
  };
  const unset: Record<string, string> = {};
  const set: Record<string, unknown> = {
    reservationRecoveredAt: now,
    updatedAt: now,
  };
  if (plan.clearCurrentJobId) {
    unset.currentJobId = "";
  }
  if (plan.clearQueuedJobId) {
    unset.queuedJobId = "";
    unset.queuedAt = "";
  }
  if (plan.adoptJobId && plan.adoptAs === "current") {
    set.currentJobId = plan.adoptJobId;
    delete unset.currentJobId;
  } else if (plan.adoptJobId && plan.adoptAs === "queued") {
    set.queuedJobId = plan.adoptJobId;
    set.queuedAt = now;
    delete unset.queuedJobId;
    delete unset.queuedAt;
  }
  await mongo({
    action: "updateOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query,
    update: {
      $set: set,
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  });
  return await mongo({
    action: "findOne",
    collection: SPEAKER_IDENTITY_SOURCE_INDEX,
    query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
  });
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
