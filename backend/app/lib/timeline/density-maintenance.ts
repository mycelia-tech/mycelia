import type { Db } from "mongodb";

export const TIMELINE_DENSITY_PENDING = "timeline_density_pending";
export const TIMELINE_DENSITY_WRITES = "timeline_density_writes";
export const TIMELINE_DENSITY_RECEIPTS = "timeline_density_receipts";
export const TIMELINE_DENSITY_STATE = "timeline_density_state";
export const DENSITY_DAY_MS = 86_400_000;
export const DENSITY_WRITE_TIMEOUT_MS = 5 * 60_000;
const QUIET_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;

export type DensityMongo = (input: any) => Promise<any>;
export type DensityCounts = { audio_chunks: number; transcriptions: number };
export type DensityDay = {
  _id: string;
  start: Date;
  revision: string;
  firstQueuedAt: Date;
  changedAt: Date;
  notBefore: Date;
  attempts?: number;
  retryAt?: Date;
  lastError?: string;
};
export type DensityReceipt = {
  _id: string;
  start: Date;
  counts: DensityCounts;
  verifiedAt: Date;
  revision: string;
};

/** Small adapter also lets job subprocesses use their scoped Mongo resource. */
export function densityMongo(db: Db): DensityMongo {
  return async (input) => {
    const collection = db.collection(input.collection);
    const options = input.options ?? {};
    switch (input.action) {
      case "find":
        return await collection.find(input.query, options).toArray();
      case "findOne":
        return await collection.findOne(input.query, options);
      case "insertOne":
        return await collection.insertOne(input.doc, options);
      case "updateOne":
        return await collection.updateOne(input.query, input.update, options);
      case "deleteOne":
        return await collection.deleteOne(input.query, options);
      case "bulkWrite":
        return await collection.bulkWrite(input.operations, options);
      case "count":
        return await collection.countDocuments(input.query, options);
      default:
        throw new Error(`Unsupported density operation: ${input.action}`);
    }
  };
}

export function normalizeDensityDays(days: Date[]): Date[] {
  return [
    ...new Set(days.map((day) => {
      const time = new Date(day).getTime();
      if (!Number.isFinite(time)) {
        throw new Error("Invalid Timeline density date");
      }
      return Math.floor(time / DENSITY_DAY_MS) * DENSITY_DAY_MS;
    })),
  ].sort((a, b) => a - b).map((day) => new Date(day));
}

export async function queueTimelineDensityDays(
  mongo: DensityMongo,
  days: Date[],
  now = new Date(),
): Promise<void> {
  const normalized = normalizeDensityDays(days);
  for (let offset = 0; offset < normalized.length; offset += 100) {
    await mongo({
      action: "bulkWrite",
      collection: TIMELINE_DENSITY_PENDING,
      operations: normalized.slice(offset, offset + 100).map((start) => ({
        updateOne: {
          filter: { _id: start.toISOString() },
          update: {
            $set: {
              start,
              revision: crypto.randomUUID(),
              changedAt: now,
              notBefore: new Date(now.getTime() + QUIET_MS),
            },
            $setOnInsert: { firstQueuedAt: now, attempts: 0 },
          },
          upsert: true,
        },
      })),
      options: { ordered: true, maxTimeMS: 10_000, touchUpdatedAt: false },
    });
  }
}

export type DensityWriteIntent = { id: string; days: Date[]; expiresAt?: Date };

/** Write ahead of the source mutation so a process crash cannot lose work. */
export async function beginTimelineDensityWrite(
  db: Db,
  days: Date[],
): Promise<DensityWriteIntent> {
  const mongo = densityMongo(db);
  const now = new Date();
  const intent = {
    id: crypto.randomUUID(),
    days: normalizeDensityDays(days),
    expiresAt: new Date(now.getTime() + DENSITY_WRITE_TIMEOUT_MS),
  };
  await mongo({
    action: "insertOne",
    collection: TIMELINE_DENSITY_WRITES,
    doc: {
      _id: intent.id,
      days: intent.days.map((day) => day.toISOString()),
      createdAt: now,
      expiresAt: intent.expiresAt,
    },
    options: { maxTimeMS: 10_000 },
  });
  await queueTimelineDensityDays(mongo, intent.days, now);
  return intent;
}

export async function finishTimelineDensityWrite(
  db: Db,
  intent: DensityWriteIntent,
): Promise<void> {
  const mongo = densityMongo(db);
  // Always enqueue again, even if recovery already consumed an expired intent.
  // This also covers partial unordered bulk writes and late acknowledgements.
  await queueTimelineDensityDays(mongo, intent.days);
  await mongo({
    action: "deleteOne",
    collection: TIMELINE_DENSITY_WRITES,
    query: { _id: intent.id },
    options: { maxTimeMS: 10_000 },
  });
}

export async function extendTimelineDensityWrite(
  db: Db,
  intent: DensityWriteIntent,
  days: Date[],
): Promise<void> {
  intent.days = normalizeDensityDays(days);
  const mongo = densityMongo(db);
  await mongo({
    action: "updateOne",
    collection: TIMELINE_DENSITY_WRITES,
    query: { _id: intent.id },
    update: { $set: { days: intent.days.map((day) => day.toISOString()) } },
    options: { maxTimeMS: 10_000 },
  });
  await queueTimelineDensityDays(mongo, intent.days);
  // Preimage reads and a large pending-day batch consume time. Renew only an
  // unexpired intent after that work, before the bounded source command starts.
  // If recovery already took ownership, this attempt must not mutate sources.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DENSITY_WRITE_TIMEOUT_MS);
  const renewed = await mongo({
    action: "updateOne",
    collection: TIMELINE_DENSITY_WRITES,
    query: { _id: intent.id, expiresAt: { $gt: now } },
    update: { $set: { expiresAt } },
    options: { maxTimeMS: 10_000 },
  });
  if (renewed.matchedCount !== 1) {
    throw new Error(
      "Timeline density write intent expired before source mutation; retry the write",
    );
  }
  intent.expiresAt = expiresAt;
}

export async function recoverTimelineDensityWrites(
  mongo: DensityMongo,
  now = new Date(),
): Promise<number> {
  const expired = await mongo({
    action: "find",
    collection: TIMELINE_DENSITY_WRITES,
    query: { expiresAt: { $lte: now } },
    options: { sort: { expiresAt: 1 }, limit: 100, maxTimeMS: 5_000 },
  }) as Array<{ _id: string; days: string[] }>;
  for (const intent of expired) {
    await queueTimelineDensityDays(
      mongo,
      intent.days.map((day) => new Date(day)),
      now,
    );
    await mongo({
      action: "deleteOne",
      collection: TIMELINE_DENSITY_WRITES,
      query: { _id: intent._id, expiresAt: { $lte: now } },
    });
  }
  return expired.length;
}

function readyQuery(now: Date) {
  return {
    $and: [
      { $or: [{ retryAt: { $exists: false } }, { retryAt: { $lte: now } }] },
      {
        $or: [
          { notBefore: { $lte: now } },
          { firstQueuedAt: { $lte: new Date(now.getTime() - MAX_WAIT_MS) } },
        ],
      },
    ],
  };
}

export async function pickTimelineDensityDay(
  mongo: DensityMongo,
  now = new Date(),
  start?: Date,
): Promise<DensityDay | null> {
  // The barrier starts before query preimages are read. A broad mutation may
  // also affect a concurrent insert whose day wasn't in that preimage; its own
  // queued day must remain pending until every in-flight source write settles.
  if (
    await mongo({
      action: "findOne",
      collection: TIMELINE_DENSITY_WRITES,
      query: { expiresAt: { $gt: now } },
      options: { projection: { _id: 1 }, maxTimeMS: 5_000 },
    })
  ) return null;
  const candidates = await mongo({
    action: "find",
    collection: TIMELINE_DENSITY_PENDING,
    query: {
      ...readyQuery(now),
      ...(start ? { _id: normalizeDensityDays([start])[0].toISOString() } : {}),
    },
    options: { sort: { firstQueuedAt: 1 }, limit: 32, maxTimeMS: 5_000 },
  }) as DensityDay[];
  return candidates[0] ?? null;
}

export async function completeTimelineDensityDay(
  mongo: DensityMongo,
  day: DensityDay,
  counts: DensityCounts,
  now = new Date(),
): Promise<boolean> {
  // Receipt first: crashing before acknowledgement merely repeats this day.
  await mongo({
    action: "updateOne",
    collection: TIMELINE_DENSITY_RECEIPTS,
    query: { _id: day._id },
    update: {
      $set: {
        start: day.start,
        counts,
        verifiedAt: now,
        revision: day.revision,
      },
    },
    options: { upsert: true, touchUpdatedAt: false },
  });
  const writing = await mongo({
    action: "findOne",
    collection: TIMELINE_DENSITY_WRITES,
    query: { expiresAt: { $gt: now } },
    options: { projection: { _id: 1 }, maxTimeMS: 5_000 },
  });
  if (writing) return false;
  const result = await mongo({
    action: "deleteOne",
    collection: TIMELINE_DENSITY_PENDING,
    query: { _id: day._id, revision: day.revision },
  });
  if (result.deletedCount !== 1) return false;
  await mongo({
    action: "updateOne",
    collection: TIMELINE_DENSITY_STATE,
    query: { _id: "current" },
    update: { $set: { lastCompletedAt: now } },
    options: { upsert: true, touchUpdatedAt: false },
  });
  return true;
}

export async function failTimelineDensityDay(
  mongo: DensityMongo,
  day: DensityDay,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const attempts = (day.attempts ?? 0) + 1;
  await mongo({
    action: "updateOne",
    collection: TIMELINE_DENSITY_PENDING,
    query: { _id: day._id },
    update: {
      $inc: { attempts: 1 },
      $set: {
        lastError: error instanceof Error ? error.message : String(error),
        retryAt: new Date(
          now.getTime() +
            Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), 300_000),
        ),
      },
    },
    options: { touchUpdatedAt: false },
  });
}

export async function getTimelineDensityMaintenance(mongo: DensityMongo) {
  const [pendingDays, oldest, failed, state] = await Promise.all([
    mongo({
      action: "count",
      collection: TIMELINE_DENSITY_PENDING,
      query: {},
      options: { maxTimeMS: 5_000 },
    }),
    mongo({
      action: "findOne",
      collection: TIMELINE_DENSITY_PENDING,
      query: {},
      options: { sort: { firstQueuedAt: 1 }, maxTimeMS: 5_000 },
    }),
    mongo({
      action: "findOne",
      collection: TIMELINE_DENSITY_PENDING,
      query: { attempts: { $gt: 0 } },
      options: { sort: { attempts: -1 }, maxTimeMS: 5_000 },
    }),
    mongo({
      action: "findOne",
      collection: TIMELINE_DENSITY_STATE,
      query: { _id: "current" },
      options: { maxTimeMS: 5_000 },
    }),
  ]);
  const iso = (value: unknown) =>
    value ? new Date(value as string).toISOString() : null;
  return {
    state:
      (pendingDays === 0
        ? "idle"
        : failed?.attempts >= 5
        ? "failed"
        : failed
        ? "retrying"
        : "updating") as "idle" | "updating" | "retrying" | "failed",
    pendingDays: Number(pendingDays),
    lastCompletedAt: iso(state?.lastCompletedAt),
    oldestPendingAt: iso(oldest?.firstQueuedAt),
    lastError: failed?.lastError ?? null,
    retryAt: iso(failed?.retryAt),
  };
}
