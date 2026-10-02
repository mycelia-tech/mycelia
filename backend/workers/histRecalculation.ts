import type { Job } from "bullmq";
import { z } from "zod";
import type { JobData, JobResult } from "@/lib/jobs/types.ts";
import { env } from "#/env.ts";
import { callResource } from "@myceliasdk/resources.ts";
import { zDateOrString } from "@myceliasdk/zod-json-schema.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import type { Auth } from "@/lib/auth/core.server.ts";
import type { Resolution } from "@/types/resolution.ts";
import {
  LOWEST_RESOLUTION,
  RESOLUTION_ORDER,
  RESOLUTION_TO_MS,
} from "@/types/resolution.ts";

import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import {
  completeTimelineDensityDay,
  failTimelineDensityDay,
  pickTimelineDensityDay,
} from "@/lib/timeline/density-maintenance.ts";
import { rebuildTimelineDensityDay } from "@/lib/timeline/density-rebuild.ts";

type AggregationOperation = {
  $sum?: any;
  $avg?: any;
  $min?: any;
  $max?: any;
};

type AggregationConfig = {
  count: boolean;
  aggregations?: Array<{
    key: string;
    operation: AggregationOperation;
  }>;
};

const TARGET_COLLECTIONS: Record<string, AggregationConfig> = {
  audio_chunks: {
    count: true,
    aggregations: [
      { key: "speech_probability_max", operation: { $max: "$vad.prob" } },
      { key: "speech_probability_avg", operation: { $avg: "$vad.prob" } },
      {
        key: "has_speech",
        operation: {
          $sum: { $cond: [{ $eq: ["$vad.has_speech", true] }, 1, 0] },
        },
      },
    ],
  },
  transcriptions: {
    count: true,
  },
};

const day = 1000 * 60 * 60 * 24;

type HistogramUpdateOptions = {
  /** Limit raw source reads; parent rollups still consume whole target bins. */
  rawBatchMs?: number;
};

/**
 * Mark histogram buckets as stale for a given time range.
 * Uses optimal tiling: largest buckets in the middle, smaller at edges.
 * This minimizes the number of buckets marked stale.
 */
export async function markHistogramStale(
  auth: Auth,
  start: Date,
  end: Date,
): Promise<{ total: number; byResolution: Record<string, number> }> {
  const mongo = await getMongoResource(auth);
  const byResolution: Record<string, number> = {};
  let total = 0;

  // Work from highest to lowest resolution
  const resolutionsHighToLow = [...RESOLUTION_ORDER].reverse();

  // Ranges still needing coverage: [{start, end}, ...]
  let remainingRanges: Array<{ start: Date; end: Date }> = [
    { start: new Date(start), end: new Date(end) },
  ];

  for (const resolution of resolutionsHighToLow) {
    const binSize = RESOLUTION_TO_MS[resolution];
    const newRemainingRanges: Array<{ start: Date; end: Date }> = [];

    for (const range of remainingRanges) {
      // Find the largest aligned range within this range for this resolution
      const alignedStart = new Date(
        Math.ceil(range.start.getTime() / binSize) * binSize,
      );
      const alignedEnd = new Date(
        Math.floor(range.end.getTime() / binSize) * binSize,
      );

      // If we can fit at least one bucket of this resolution
      if (alignedStart.getTime() < alignedEnd.getTime()) {
        // Mark these buckets as stale
        const result = await mongo({
          action: "updateMany",
          collection: `histogram_${resolution}`,
          query: { start: { $gte: alignedStart, $lt: alignedEnd } },
          update: { $set: { stale: true } },
        });

        const count = result.modifiedCount || 0;
        byResolution[resolution] = (byResolution[resolution] || 0) + count;
        total += count;

        // Left edge: range.start to alignedStart (needs smaller buckets)
        if (range.start.getTime() < alignedStart.getTime()) {
          newRemainingRanges.push({
            start: range.start,
            end: alignedStart,
          });
        }

        // Right edge: alignedEnd to range.end (needs smaller buckets)
        if (alignedEnd.getTime() < range.end.getTime()) {
          newRemainingRanges.push({
            start: alignedEnd,
            end: range.end,
          });
        }
      } else {
        // Can't fit any buckets of this resolution, pass to next smaller
        newRemainingRanges.push(range);
      }
    }

    remainingRanges = newRemainingRanges;

    // If nothing left to cover, we're done
    if (remainingRanges.length === 0) {
      break;
    }
  }

  console.log(
    `[histRecalculation] Marked ${total} buckets stale: ${
      Object.entries(byResolution)
        .map(([r, c]) => `${r}=${c}`)
        .join(", ")
    }`,
  );

  return { total, byResolution };
}

/**
 * Mark higher resolution buckets as stale based on processed lower resolution range.
 */
async function markHigherResolutionStale(
  auth: Auth,
  start: Date,
  end: Date,
  processedResolution: Resolution,
): Promise<void> {
  const currentIndex = RESOLUTION_ORDER.indexOf(processedResolution);
  if (currentIndex >= RESOLUTION_ORDER.length - 1) {
    return; // Already at highest resolution
  }

  const higherResolution = RESOLUTION_ORDER[currentIndex + 1];
  const higherBinSize = RESOLUTION_TO_MS[higherResolution];

  // Align to higher resolution boundaries
  const alignedStart = new Date(
    Math.floor(start.getTime() / higherBinSize) * higherBinSize,
  );
  const alignedEnd = new Date(
    Math.ceil(end.getTime() / higherBinSize) * higherBinSize,
  );

  const mongo = await getMongoResource(auth);
  await mongo({
    action: "updateMany",
    collection: `histogram_${higherResolution}`,
    query: { start: { $gte: alignedStart, $lt: alignedEnd } },
    update: { $set: { stale: true } },
  });
}

export async function updateHistogram(
  auth: Auth,
  start: Date,
  end: Date,
  resolution: Resolution,
  { rawBatchMs = day }: HistogramUpdateOptions = {},
): Promise<void> {
  if (!Number.isFinite(rawBatchMs) || rawBatchMs <= 0) {
    throw new Error("Histogram raw batch size must be positive and finite");
  }
  const mongo = await getMongoResource(auth);
  const binSize = RESOLUTION_TO_MS[resolution];

  start = new Date(Math.floor(start.getTime() / binSize) * binSize);
  end = new Date(Math.ceil(end.getTime() / binSize) * binSize);

  console.log("Updating histogram", start, end, resolution);

  // A source bin must remain inside one batch so a later write cannot replace
  // it with a partial count. Manual callers retain the one-day default.
  const BATCH_SIZE = Math.max(
    binSize,
    Math.floor(rawBatchMs / binSize) * binSize,
  );
  if (end.getTime() - start.getTime() > BATCH_SIZE) {
    const steps = Math.ceil(
      (end.getTime() - start.getTime() + 0.0) / Number(BATCH_SIZE),
    );
    for (let i = 0; i < steps; i++) {
      await updateHistogramOptimized(
        auth,
        new Date(start.getTime() + i * BATCH_SIZE),
        new Date(
          Math.min(start.getTime() + (i + 1) * BATCH_SIZE, end.getTime()),
        ),
        resolution,
        { rawBatchMs },
      );
    }
    return;
  }

  for (
    const [sourceCollectionName, collectionConfig] of Object.entries(
      TARGET_COLLECTIONS,
    )
  ) {
    const pipeline = [
      {
        $match: {
          start: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: {
            $toDate: {
              $subtract: [
                { $toLong: "$start" },
                { $mod: [{ $toLong: "$start" }, binSize] },
              ],
            },
          },
          ...(collectionConfig.count && { count: { $sum: 1 } }),
          ...(collectionConfig.aggregations &&
            collectionConfig.aggregations.reduce((acc, { key, operation }) => ({
              ...acc,
              [key]: operation,
            }), {})),
        },
      },
    ];

    const results = await mongo({
      action: "aggregate",
      collection: sourceCollectionName,
      pipeline,
    });

    const ops = results.map(({ _id: binStart, ...aggr }: any) => ({
      updateOne: {
        filter: { start: binStart },
        update: {
          $set: {
            updated_at: new Date(),
            stale: false,
            ...(Object.keys(aggr).length > 0 && {
              [`totals.${sourceCollectionName}`]: aggr,
            }),
          },
        },
        upsert: true,
      },
    }));

    for (let i = 0; i < ops.length; i += 500) {
      await mongo({
        action: "bulkWrite",
        collection: `histogram_${resolution}`,
        operations: ops.slice(i, i + 500),
        options: { ordered: false },
      });
    }
  }
}

async function updateHistogramOptimized(
  auth: Auth,
  start: Date,
  end: Date,
  resolution: Resolution,
  options: HistogramUpdateOptions = {},
): Promise<void> {
  if (resolution === LOWEST_RESOLUTION) {
    return updateHistogram(auth, start, end, resolution, options);
  }

  const mongo = await getMongoResource(auth);
  const binSize = RESOLUTION_TO_MS[resolution];

  // Floor start and ceil end to nearest resolution point
  start = new Date(Math.floor(start.getTime() / binSize) * binSize);
  end = new Date(Math.ceil(end.getTime() / binSize) * binSize);

  const totalBins = Math.ceil((end.getTime() - start.getTime()) / binSize);
  console.log(
    `   ├─ Querying lower resolution data (expected ~${totalBins} bins)...`,
  );

  // Get the next lower resolution
  const currentIndex = RESOLUTION_ORDER.indexOf(resolution);
  const lowerResolution = RESOLUTION_ORDER[currentIndex - 1];
  const lowerBinSize = RESOLUTION_TO_MS[lowerResolution];

  // Batch to stay under 1000 lower-resolution bins per query
  // e.g., for 1hour: 1000 * 5min = 5000 min = ~83 hours per batch
  const MAX_LOWER_BINS = 900; // Stay safely under 1000 limit
  // Keep every target bin inside a single batch: splitting a day at noon
  // would let the next batch overwrite it using only its second half.
  const BATCH_SIZE = Math.floor(MAX_LOWER_BINS * lowerBinSize / binSize) *
    binSize;

  if (end.getTime() - start.getTime() > BATCH_SIZE) {
    const steps = Math.ceil((end.getTime() - start.getTime()) / BATCH_SIZE);
    console.log(
      `   ├─ Splitting into ${steps} batches (max ${MAX_LOWER_BINS} source bins each)...`,
    );
    for (let i = 0; i < steps; i++) {
      const batchStart = new Date(start.getTime() + i * BATCH_SIZE);
      const batchEnd = new Date(
        Math.min(start.getTime() + (i + 1) * BATCH_SIZE, end.getTime()),
      );
      console.log(
        `   ├─ Batch ${
          i + 1
        }/${steps}: ${batchStart.toISOString()} to ${batchEnd.toISOString()}`,
      );
      await updateHistogramOptimizedBatch(
        auth,
        batchStart,
        batchEnd,
        resolution,
      );
    }
    return;
  }

  await updateHistogramOptimizedBatch(auth, start, end, resolution);
}

async function updateHistogramOptimizedBatch(
  auth: Auth,
  start: Date,
  end: Date,
  resolution: Resolution,
): Promise<void> {
  const mongo = await getMongoResource(auth);
  const binSize = RESOLUTION_TO_MS[resolution];

  const totalBins = Math.ceil((end.getTime() - start.getTime()) / binSize);

  // Get the next lower resolution
  const currentIndex = RESOLUTION_ORDER.indexOf(resolution);
  const lowerResolution = RESOLUTION_ORDER[currentIndex - 1];

  // Query the lower resolution data
  const lowerData = await mongo({
    action: "find",
    collection: `histogram_${lowerResolution}`,
    query: { start: { $gte: start, $lt: end } },
  });

  console.log(
    `   │  Processing ${lowerData.length} source bins into ${totalBins} target bins...`,
  );

  // Aggregate the lower resolution data into the current resolution
  const aggregatedData = new Map<
    string,
    Record<string, Record<string, number>>
  >();

  for (const doc of lowerData) {
    const binStart = new Date(
      Math.floor(doc.start.getTime() / binSize) * binSize,
    );
    const binKey = binStart.toISOString();

    if (!aggregatedData.has(binKey)) {
      aggregatedData.set(binKey, {});
    }

    const totals = aggregatedData.get(binKey)!;
    for (
      const [collection, data] of Object.entries(doc.totals || {}) as [
        string,
        Record<string, number>,
      ][]
    ) {
      if (!totals[collection]) {
        totals[collection] = {};
      }

      const collectionConfig = TARGET_COLLECTIONS[collection];
      if (!collectionConfig) continue;

      if (collectionConfig.count && data.count) {
        totals[collection].count = (totals[collection].count || 0) + data.count;
      }

      if (collectionConfig.aggregations) {
        for (const { key, operation } of collectionConfig.aggregations) {
          if (!(key in data)) continue;

          if (operation.$sum) {
            totals[collection][key] = (totals[collection][key] || 0) +
              data[key];
          } else if (operation.$max) {
            totals[collection][key] = Math.max(
              totals[collection][key] || -Infinity,
              data[key],
            );
          } else if (operation.$min) {
            totals[collection][key] = Math.min(
              totals[collection][key] || Infinity,
              data[key],
            );
          } else if (operation.$avg) {
            // For averages, we need to track both sum and count
            const sumKey = `${key}_sum`;
            const countKey = `${key}_count`;
            if (!totals[collection][sumKey]) {
              totals[collection][sumKey] = 0;
              totals[collection][countKey] = 0;
            }
            totals[collection][sumKey] += data[key] * data.count;
            totals[collection][countKey] += data.count;
          }
        }
      }
    }
  }

  // Calculate final averages and prepare update operations
  const ops = Array.from(aggregatedData.entries()).map(([binKey, totals]) => {
    // Calculate final averages
    for (const [collection, data] of Object.entries(totals)) {
      const collectionConfig = TARGET_COLLECTIONS[collection];
      if (!collectionConfig?.aggregations) continue;

      for (const { key, operation } of collectionConfig.aggregations) {
        if (operation.$avg) {
          const sumKey = `${key}_sum`;
          const countKey = `${key}_count`;
          if (sumKey in data && countKey in data) {
            const count = data[countKey];
            if (count > 0) {
              data[key] = data[sumKey] / count;
            }
            // Clean up temporary fields
            delete data[sumKey];
            delete data[countKey];
          }
        }
      }
    }

    return {
      updateOne: {
        filter: { start: new Date(binKey) },
        update: {
          $set: {
            stale: false,
            updated_at: new Date(),
            totals,
          },
        },
        upsert: true,
      },
    };
  });

  const batchSize = 1000;
  const totalBatches = Math.ceil(ops.length / batchSize);
  console.log(`   ├─ Writing ${ops.length} bins in ${totalBatches} batches...`);

  for (let i = 0; i < ops.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    await mongo({
      action: "bulkWrite",
      collection: `histogram_${resolution}`,
      operations: ops.slice(i, i + batchSize),
    });
    if (totalBatches > 1) {
      console.log(
        `   │  └─ Batch ${batchNum}/${totalBatches} written (${
          Math.round(batchNum / totalBatches * 100)
        }%)`,
      );
    }
  }

  console.log(`   └─ ✓ Completed writing ${ops.length} bins`);
}

export async function updateAllHistogram(
  auth: Auth,
  start?: Date,
  end?: Date,
  onResolution?: (resolution: Resolution, index: number) => Promise<void>,
  options: HistogramUpdateOptions = {},
): Promise<void> {
  const mongo = await getMongoResource(auth);

  let earliestStart: Date | null = null;
  let latestStart: Date | null = null;

  if (!start || !end) {
    console.log("[Timeline] Scanning collections for data range...");
    for (const collectionName of Object.keys(TARGET_COLLECTIONS)) {
      const firstDoc = await mongo({
        action: "find",
        collection: collectionName,
        query: {},
        options: { sort: { start: 1 }, limit: 1 },
      });
      if (
        firstDoc.length > 0 &&
        (!earliestStart || firstDoc[0].start < earliestStart)
      ) {
        earliestStart = firstDoc[0].start;
      }

      const lastDoc = await mongo({
        action: "find",
        collection: collectionName,
        query: {},
        options: { sort: { start: -1 }, limit: 1 },
      });
      if (
        lastDoc.length > 0 && (!latestStart || lastDoc[0].start > latestStart)
      ) {
        latestStart = lastDoc[0].start;
      }
    }

    if (!earliestStart || !latestStart) {
      throw new Error("No data found in target collections");
    }

    if (!start) {
      start = earliestStart;
    }
    if (!end) {
      end = latestStart;
    }
  }

  const totalDays = Math.ceil((end.getTime() - start.getTime()) / day);
  console.log(
    `[Timeline] Recalculating histograms from ${start.toISOString()} to ${end.toISOString()} (~${totalDays} days)`,
  );
  console.log(
    `[Timeline] Processing ${RESOLUTION_ORDER.length} resolutions: ${
      RESOLUTION_ORDER.join(", ")
    }`,
  );
  console.log(`[Timeline] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const startTime = Date.now();
  const resolutionTimes: number[] = [];

  for (let i = 0; i < RESOLUTION_ORDER.length; i++) {
    const resolution = RESOLUTION_ORDER[i];
    await onResolution?.(resolution, i);
    const progress = Math.round((i / RESOLUTION_ORDER.length) * 100);

    console.log(
      `\n[Timeline] [${
        i + 1
      }/${RESOLUTION_ORDER.length}] ${resolution.toUpperCase()} (${progress}% complete)`,
    );
    console.log(
      `[Timeline] ┌─────────────────────────────────────────────────────`,
    );

    const resStart = Date.now();
    await updateHistogramOptimized(auth, start, end, resolution, options);
    const resDuration = (Date.now() - resStart) / 1000;
    resolutionTimes.push(resDuration);

    const elapsed = (Date.now() - startTime) / 1000;
    const avgTimePerResolution = resolutionTimes.reduce((a, b) => a + b, 0) /
      resolutionTimes.length;
    const remainingResolutions = RESOLUTION_ORDER.length - (i + 1);
    const etaSeconds = avgTimePerResolution * remainingResolutions;

    let etaStr = "";
    if (etaSeconds < 60) {
      etaStr = `~${Math.round(etaSeconds)}s remaining`;
    } else if (etaSeconds < 3600) {
      etaStr = `~${Math.round(etaSeconds / 60)}m remaining`;
    } else {
      const hours = Math.floor(etaSeconds / 3600);
      const mins = Math.round((etaSeconds % 3600) / 60);
      etaStr = `~${hours}h ${mins}m remaining`;
    }

    const completePct = Math.round(((i + 1) / RESOLUTION_ORDER.length) * 100);
    console.log(
      `[Timeline] └─────────────────────────────────────────────────────`,
    );
    console.log(
      `[Timeline] ✓ ${resolution} completed in ${
        resDuration.toFixed(1)
      }s | ${completePct}% complete | ${etaStr}`,
    );
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n[Timeline] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  );
  console.log(
    `[Timeline] ✅ All histograms updated successfully in ${totalTime}s`,
  );
}

export async function replaceHistogramRange(
  auth: Auth,
  start: Date,
  end: Date,
): Promise<void> {
  const mongo = await getMongoResource(auth);
  for (const resolution of RESOLUTION_ORDER) {
    const binSize = RESOLUTION_TO_MS[resolution];
    const alignedStart = new Date(
      Math.floor(start.getTime() / binSize) * binSize,
    );
    const alignedEnd = new Date(
      Math.ceil(end.getTime() / binSize) * binSize,
    );
    await mongo({
      action: "deleteMany",
      collection: `histogram_${resolution}`,
      query: { start: { $gte: alignedStart, $lt: alignedEnd } },
    });
  }
}

export function alignTimelineCampaignStart(start: Date): Date {
  const largestBin = RESOLUTION_TO_MS["1week"];
  return new Date(Math.floor(start.getTime() / largestBin) * largestBin);
}

/**
 * Process stale buckets at a single resolution level.
 * After processing, marks the next higher resolution as stale.
 * Returns true if there are more stale buckets at this resolution.
 */
async function processStaleResolution(
  auth: Auth,
  resolution: Resolution,
  limit: number = 500,
): Promise<{ processed: number; hasMore: boolean }> {
  const mongo = await getMongoResource(auth);
  const binSize = RESOLUTION_TO_MS[resolution];

  // Find stale buckets at this resolution (up to limit + 1 to check hasMore)
  const staleBuckets = await mongo({
    action: "find",
    collection: `histogram_${resolution}`,
    query: { stale: true },
    options: { sort: { start: 1 }, limit: limit + 1 },
  });

  if (staleBuckets.length === 0) {
    return { processed: 0, hasMore: false };
  }

  const hasMore = staleBuckets.length > limit;
  const bucketsToProcess = staleBuckets.slice(0, limit);

  const start = bucketsToProcess[0].start;
  const end = new Date(
    bucketsToProcess[bucketsToProcess.length - 1].start.getTime() + binSize,
  );

  console.log(
    `[histRecalculation] Processing ${bucketsToProcess.length} stale ${resolution} buckets from ${start.toISOString()} to ${end.toISOString()}`,
  );

  // Process this resolution
  if (resolution === LOWEST_RESOLUTION) {
    await updateHistogram(auth, start, end, resolution);
  } else {
    await updateHistogramOptimized(auth, start, end, resolution);
  }

  return { processed: bucketsToProcess.length, hasMore };
}

/**
 * Process all stale buckets across all resolutions.
 * Processes one resolution at a time, bottom-up.
 * Always finishes the finest resolution before climbing to higher ones.
 */
export async function processStaleHistograms(
  auth: Auth,
  limit: number = 500,
): Promise<{ processed: number; hasMore: boolean }> {
  let totalProcessed = 0;
  let hasMoreAtAnyLevel = false;

  for (const resolution of RESOLUTION_ORDER) {
    const { processed, hasMore } = await processStaleResolution(
      auth,
      resolution,
      limit,
    );
    totalProcessed += processed;

    if (hasMore) {
      hasMoreAtAnyLevel = true;
      // Don't process higher resolutions if current resolution has more work
      console.log(
        `[histRecalculation] More stale ${resolution} buckets remain, stopping here`,
      );
      break;
    }
  }

  return { processed: totalProcessed, hasMore: hasMoreAtAnyLevel };
}

/** Job type name */
export const name = "histRecalculation";

/** Schema for histogram recalculation job data */
export const schema = z.object({
  type: z.literal("histRecalculation"),
  /** Reconcile one durable dirty day; automatic work owns its verification. */
  automaticDensity: z.boolean().optional(),
  start: zDateOrString().optional(),
  end: zDateOrString().optional(),
  /** Process only stale buckets (default: true) */
  staleOnly: z.boolean().default(true),
  /** Mark range as stale without processing (for manual invalidation) */
  markStale: z.boolean().default(false),
  /** Shared metadata for a multi-job rebuild launched from Pipeline health. */
  timelineRebuildCampaignId: z.string().min(1).optional(),
  timelineRebuildBatchIndex: z.number().int().min(0).optional(),
  timelineRebuildBatchCount: z.number().int().min(1).optional(),
  timelineRebuildCreatedAt: zDateOrString().optional(),
  timelineRebuildEnd: zDateOrString().optional(),
  timelineRebuildBatchDays: z.number().int().min(1).max(62).optional(),
});

export type HistRecalculationJobData = z.infer<typeof schema>;

/** Process the histogram recalculation job */
export async function use(job: Job<JobData>): Promise<JobResult> {
  const jobData = job.data as HistRecalculationJobData;

  const jwt = Deno.env.get("MYCELIA_JWT")!;
  const myceliaUrl = env.MYCELIA_URL;

  const auth = {
    getResource: (code: string) => (input: any) =>
      callResource(code, input, { jwt, myceliaUrl }),
  } as any;

  const start = jobData.start ? new Date(jobData.start) : undefined;
  const end = jobData.end ? new Date(jobData.end) : undefined;

  if (jobData.automaticDensity) {
    if (!start) throw new Error("Automatic Timeline density requires a day");
    const mongo = await getMongoResource(auth);
    const day = await pickTimelineDensityDay(mongo, new Date(), start);
    if (!day) return { success: true, processed: 0, hasMore: false };
    try {
      await job.updateProgress({
        stage: "automatic_density",
        start: day.start.toISOString(),
      });
      const counts = await rebuildTimelineDensityDay(auth, day.start);
      const caughtUp = await completeTimelineDensityDay(mongo, day, counts);
      await job.updateProgress({
        stage: caughtUp ? "density_verified" : "density_changed_during_rebuild",
        start: day.start.toISOString(),
        counts,
      });
      return { success: true, processed: 1, hasMore: false };
    } catch (error) {
      await failTimelineDensityDay(mongo, day, error);
      throw error;
    }
  }

  // Mode 1: Mark range as stale (for manual invalidation)
  if (jobData.markStale) {
    if (!start || !end) {
      return {
        success: false,
        message: "Start and end required for markStale",
      };
    }
    const { total, byResolution } = await markHistogramStale(auth, start, end);
    return { success: true, marked: total, byResolution, hasMore: false };
  }

  // Mode 2: Process specific range (legacy mode, processes everything in range)
  if (start && end && !jobData.staleOnly) {
    console.log(
      `[histRecalculation] Processing full range ${start.toISOString()} to ${end.toISOString()}`,
    );
    if (jobData.timelineRebuildCampaignId) {
      // A campaign is a true reconciliation, not just an upsert. Remove old
      // buckets first so deleted source rows and formerly-populated empty bins
      // cannot survive a rebuild as ghost counts. Rewind every batch to the
      // week boundary: otherwise adjacent 31-day jobs would each overwrite a
      // shared daily/weekly bucket using only their side of the boundary.
      const rebuildStart = alignTimelineCampaignStart(start);
      const batchIndex = jobData.timelineRebuildBatchIndex ?? 0;
      const batchCount = jobData.timelineRebuildBatchCount ?? 1;
      const updateCampaignProgress = async (
        phase: "delete" | Resolution,
        phaseIndex: number,
      ) => {
        const batchPercent = Math.round(phaseIndex / 5 * 100);
        const overallPercent = Math.min(
          100,
          Math.round((batchIndex + phaseIndex / 5) / batchCount * 100),
        );
        await job.updateProgress({
          stage: phase,
          phase,
          batchIndex,
          batchNumber: batchIndex + 1,
          batchCount,
          batchPercent,
          overallPercent,
          start: start.toISOString(),
          end: end.toISOString(),
        });
      };
      await updateCampaignProgress("delete", 0);
      await replaceHistogramRange(auth, rebuildStart, end);
      await updateAllHistogram(
        auth,
        rebuildStart,
        end,
        (resolution, index) => updateCampaignProgress(resolution, index + 1),
      );
      await job.updateProgress({
        stage: "batch_complete",
        phase: "batch_complete",
        batchIndex,
        batchNumber: batchIndex + 1,
        batchCount,
        batchPercent: 100,
        overallPercent: Math.round((batchIndex + 1) / batchCount * 100),
        start: start.toISOString(),
        end: end.toISOString(),
      });
    } else {
      await updateAllHistogram(auth, start, end);
    }
    const campaignEnd = jobData.timelineRebuildEnd
      ? new Date(jobData.timelineRebuildEnd)
      : end;
    const hasMore = Boolean(
      jobData.timelineRebuildCampaignId && end < campaignEnd,
    );
    const nextStart = end;
    const nextEnd = new Date(
      Math.min(
        nextStart.getTime() +
          (jobData.timelineRebuildBatchDays ?? 31) * day,
        campaignEnd.getTime(),
      ),
    );
    return {
      success: true,
      processed: 1,
      hasMore,
      ...(jobData.timelineRebuildCampaignId
        ? {
          timelineRebuildCampaignId: jobData.timelineRebuildCampaignId,
          timelineRebuildBatchIndex: (jobData.timelineRebuildBatchIndex ?? 0) +
            (hasMore ? 1 : 0),
          timelineRebuildBatchCount: jobData.timelineRebuildBatchCount,
          ...(hasMore
            ? {
              nextStart: nextStart.toISOString(),
              nextEnd: nextEnd.toISOString(),
            }
            : {}),
        }
        : {}),
    };
  }

  // Mode 3: Process stale buckets only (default)
  console.log(`[histRecalculation] Processing stale buckets`);
  const { processed, hasMore } = await processStaleHistograms(auth);

  if (processed === 0) {
    console.log(`[histRecalculation] No stale buckets to process`);
  } else {
    console.log(
      `[histRecalculation] Processed ${processed} buckets, hasMore: ${hasMore}`,
    );
  }

  return { success: true, processed, hasMore };
}

const capability: JobCapability = {
  name,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(
    z.object({
      success: z.boolean(),
      processed: z.number().optional(),
      marked: z.number().optional(),
      hasMore: z.boolean(),
      timelineRebuildCampaignId: z.string().optional(),
      timelineRebuildBatchIndex: z.number().optional(),
      timelineRebuildBatchCount: z.number().optional(),
      nextStart: z.string().optional(),
      nextEnd: z.string().optional(),
    }),
  ),
  policies: [
    { resource: "db/audio_chunks", action: "*", effect: "allow" },
    { resource: "db/transcriptions", action: "*", effect: "allow" },
    { resource: "db/histogram_*", action: "*", effect: "allow" },
    { resource: "db/timeline_density_*", action: "*", effect: "allow" },
    { resource: "db/configs", action: "read", effect: "allow" },
  ],
  use,
};

export default capability;
