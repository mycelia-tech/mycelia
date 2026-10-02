import type { Auth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { RESOLUTION_TO_MS } from "@/types/resolution.ts";

const DAY_MS = RESOLUTION_TO_MS["1day"];
const MAX_TIME_MS = 30_000;
const SOURCES = ["audio_chunks", "transcriptions"] as const;
export type TimelineDensityCounts = Record<typeof SOURCES[number], number>;
type MongoCall = ReturnType<typeof getMongoResource>;

function boundedMongo(mongo: MongoCall): MongoCall {
  return (input) =>
    mongo(
      input.action === "find" || input.action === "aggregate"
        ? {
          ...input,
          options: {
            ...input.options,
            hint: { start: 1 },
            maxTimeMS: MAX_TIME_MS,
          },
        }
        : input,
    );
}

async function histogramCounts(
  mongo: MongoCall,
  resolution: string,
  start: Date,
  end: Date,
): Promise<TimelineDensityCounts> {
  const rows = await mongo({
    action: "aggregate",
    collection: `histogram_${resolution}`,
    pipeline: [
      { $match: { start: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: null,
          audio_chunks: {
            $sum: { $ifNull: ["$totals.audio_chunks.count", 0] },
          },
          transcriptions: {
            $sum: { $ifNull: ["$totals.transcriptions.count", 0] },
          },
        },
      },
    ],
  }) as TimelineDensityCounts[];
  return {
    audio_chunks: Number(rows[0]?.audio_chunks ?? 0),
    transcriptions: Number(rows[0]?.transcriptions ?? 0),
  };
}

function verifyCounts(
  label: string,
  actual: TimelineDensityCounts,
  expected: TimelineDensityCounts,
) {
  for (const source of SOURCES) {
    if (actual[source] !== expected[source]) {
      throw new Error(
        `Timeline density verification failed: ${label} ${source} ` +
          `has ${actual[source]}, expected ${expected[source]}`,
      );
    }
  }
}

/**
 * Reconcile one UTC day, then rebuild its whole parent week from persisted
 * daily buckets. The caller retains dirty work until its revision is unchanged
 * after this verification, so source writes during the rebuild are retried.
 */
export async function rebuildTimelineDensityDay(
  auth: Auth,
  start: Date,
): Promise<TimelineDensityCounts> {
  const timestamp = start.getTime();
  if (!Number.isFinite(timestamp) || timestamp % DAY_MS !== 0) {
    throw new Error(
      "Timeline density rebuild start must be a UTC day boundary",
    );
  }
  const end = new Date(timestamp + DAY_MS);
  const weekMs = RESOLUTION_TO_MS["1week"];
  const weekStart = new Date(Math.floor(timestamp / weekMs) * weekMs);
  const weekEnd = new Date(weekStart.getTime() + weekMs);
  const mongo = boundedMongo(await getMongoResource(auth));
  const boundedAuth = Object.create(auth) as Auth;
  boundedAuth.getResource =
    ((code: string) =>
      code === "mongo" ? mongo : auth.getResource(code)) as Auth["getResource"];

  // Imported here because histRecalculation also calls this helper. Its
  // existing aggregation implementation remains the single rebuild path.
  const { replaceHistogramRange, updateAllHistogram } = await import(
    "#/workers/histRecalculation.ts"
  );
  await replaceHistogramRange(boundedAuth, start, end);
  // Raw VAD aggregation fetches audio documents, so a busy day can exceed its
  // query deadline. Finish smaller reads before rolling up the complete day.
  await updateAllHistogram(boundedAuth, start, end, undefined, {
    rawBatchMs: RESOLUTION_TO_MS["1hour"],
  });

  const [sourceCounts, fineCounts, dailyWeek, parentWeek] = await Promise.all([
    Promise.all(SOURCES.map(async (collection) => {
      const rows = await mongo({
        action: "aggregate",
        collection,
        pipeline: [
          { $match: { start: { $gte: start, $lt: end } } },
          { $count: "count" },
        ],
      }) as Array<{ count: number }>;
      return [collection, Number(rows[0]?.count ?? 0)] as const;
    })),
    Promise.all(["5min", "1hour", "1day"].map(async (resolution) => ({
      resolution,
      counts: await histogramCounts(mongo, resolution, start, end),
    }))),
    histogramCounts(mongo, "1day", weekStart, weekEnd),
    histogramCounts(mongo, "1week", weekStart, weekEnd),
  ]);
  const expected = Object.fromEntries(sourceCounts) as TimelineDensityCounts;
  for (const { resolution, counts } of fineCounts) {
    verifyCounts(`${start.toISOString()} ${resolution}`, counts, expected);
  }
  verifyCounts(`${weekStart.toISOString()} 1week`, parentWeek, dailyWeek);
  return expected;
}
