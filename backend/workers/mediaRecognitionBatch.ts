import type { Job } from "bullmq";
import { z } from "zod";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import type { JobData } from "@/lib/jobs/types.ts";
import { callResource } from "@myceliasdk/resources.ts";

const schema = z.object({
  type: z.literal("mediaRecognitionBatch"),
  batchId: z.string().optional(),
});

const output = z.object({
  success: z.boolean(),
  idle: z.boolean().optional(),
  batchId: z.string().optional(),
  processed: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  counts: z.record(z.string(), z.number()).optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
});

export const RECOGNITION_BATCH_POLL_MS = 5_000;
export const RECOGNITION_COORDINATOR_TRIGGER_CLAIM_MS = 60_000;

type RecognitionCoordinatorJob = Pick<
  Job<JobData>,
  "data" | "id" | "updateProgress"
>;

type RecognitionCoordinatorDependencies = {
  processBatch: () => Promise<Record<string, any>>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export async function runRecognitionBatchCoordinator(
  job: RecognitionCoordinatorJob,
  dependencies: RecognitionCoordinatorDependencies,
): Promise<Record<string, unknown>> {
  const sleep = dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let totalProcessed = 0;

  while (true) {
    const result = await dependencies.processBatch();
    const processed = Number(result.processed ?? 0);
    if (Number.isFinite(processed) && processed > 0) {
      totalProcessed += processed;
    }
    if (result.progress && typeof result.progress === "object") {
      await job.updateProgress(result.progress);
    }
    if (result.hasMore !== true) {
      return { ...result, processed: totalProcessed, hasMore: false };
    }
    await sleep(RECOGNITION_BATCH_POLL_MS);
  }
}

type MongoCall = (input: Record<string, unknown>) => Promise<unknown>;

async function oldestOpenRecognitionBatch(mongo: MongoCall) {
  const now = new Date();
  const rows = await mongo({
    action: "find",
    collection: "media_recognition_batches",
    query: {
      status: { $in: ["queued", "running"] },
      $or: [
        { coordinatorEnqueueClaim: { $exists: false } },
        { "coordinatorEnqueueClaim.expiresAt": { $lte: now } },
      ],
    },
    options: {
      projection: { _id: 1 },
      sort: { createdAt: 1, _id: 1 },
      limit: 1,
    },
  });
  return Array.isArray(rows) ? rows[0] : undefined;
}

async function hasRunnableFolderStream(mongo: MongoCall) {
  const rows = await mongo({
    action: "find",
    collection: "media_folder_campaigns",
    query: {
      "streaming.state": "running",
      $or: [
        { "streaming.nextCheckAt": { $exists: false } },
        { "streaming.nextCheckAt": { $lte: new Date() } },
      ],
    },
    options: { projection: { _id: 1 }, limit: 1 },
  });
  return Array.isArray(rows) && rows.length > 0;
}

async function claimOpenRecognitionBatch(mongo: MongoCall) {
  const batch = await oldestOpenRecognitionBatch(mongo);
  if (!batch?._id) return undefined;
  const now = new Date();
  return await mongo({
    action: "findOneAndUpdate",
    collection: "media_recognition_batches",
    query: {
      _id: batch._id,
      status: { $in: ["queued", "running"] },
      $or: [
        { coordinatorEnqueueClaim: { $exists: false } },
        { "coordinatorEnqueueClaim.expiresAt": { $lte: now } },
      ],
    },
    update: {
      $set: {
        coordinatorEnqueueClaim: {
          id: `watchdog:${crypto.randomUUID()}`,
          expiresAt: new Date(
            now.getTime() + RECOGNITION_COORDINATOR_TRIGGER_CLAIM_MS,
          ),
        },
      },
    },
    options: { returnDocument: "after" },
  }) as { _id?: unknown } | undefined;
}

const capability: JobCapability = {
  name: "mediaRecognitionBatch",
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(output),
  policies: [
    {
      resource: "media-library/processRecognitionBatch",
      action: "process",
      effect: "allow",
    },
  ],
  maxConcurrency: 1,
  triggers: {
    sources: [],
    debounceMs: 1_000,
    interval: 30,
  },
  hasPendingWork: async ({ mongo }) => {
    return await oldestOpenRecognitionBatch(mongo) ||
        await hasRunnableFolderStream(mongo)
      ? 1
      : 0;
  },
  getTriggerJobData: async (_payload, _reason, { mongo }) => {
    const batch = await claimOpenRecognitionBatch(mongo);
    if (!batch?._id) {
      if (await hasRunnableFolderStream(mongo)) {
        return { type: "mediaRecognitionBatch" };
      }
      throw new Error("Recognition batch coordinator enqueue was claimed");
    }
    return {
      type: "mediaRecognitionBatch",
      batchId: String(batch._id),
    };
  },
  use: async (job: Job<JobData>) => {
    const jwt = Deno.env.get("MYCELIA_JWT");
    const myceliaUrl = Deno.env.get("MYCELIA_URL");
    if (!jwt || !myceliaUrl) {
      throw new Error("Media batch worker resource context is missing");
    }
    return await runRecognitionBatchCoordinator(job, {
      processBatch: async () =>
        await callResource("media-library", {
          action: "processRecognitionBatch",
          ...(typeof job.data.batchId === "string"
            ? { batchId: job.data.batchId }
            : {}),
          jobId: job.id,
        }, { jwt, myceliaUrl }) as Record<string, any>,
    });
  },
};

export default capability;
