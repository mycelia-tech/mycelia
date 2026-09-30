import type { Job } from "bullmq";
import { z } from "zod";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import type { JobData } from "@/lib/jobs/types.ts";
import { callResource } from "@myceliasdk/resources.ts";
import { zMediaRecognitionTask } from "@myceliasdk/media.ts";

const schema = z.object({
  type: z.literal("mediaRecognition"),
  assetId: z.string().min(1),
  profileSnapshot: z.record(z.string(), z.unknown()),
  requestedTasks: z.array(zMediaRecognitionTask).min(1).max(4).optional(),
  includeGlobalPhotoAnalysis: z.boolean().optional(),
  consentReceiptId: z.string().min(1),
  recognitionBatchId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
});

const capability: JobCapability = {
  name: "mediaRecognition",
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(z.object({
    success: z.boolean(),
    runId: z.string().optional(),
    pages: z.number().optional(),
    annotations: z.number().optional(),
    visualUnderstanding: z.boolean().optional(),
    reused: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    reason: z.string().optional(),
  })),
  policies: [
    { resource: "media/processAsset", action: "process", effect: "allow" },
  ],
  maxConcurrency: 8,
  use: async (job: Job<JobData>) => {
    const jwt = Deno.env.get("MYCELIA_JWT");
    const myceliaUrl = Deno.env.get("MYCELIA_URL");
    if (!jwt || !myceliaUrl) {
      throw new Error("Media worker resource context is missing");
    }
    return await callResource("media", {
      action: "processAsset",
      assetId: String(job.data.assetId),
      profileSnapshot: job.data.profileSnapshot as Record<string, unknown>,
      requestedTasks: Array.isArray(job.data.requestedTasks)
        ? job.data.requestedTasks
        : undefined,
      includeGlobalPhotoAnalysis: job.data.includeGlobalPhotoAnalysis === true,
      consentReceiptId: String(job.data.consentReceiptId),
      jobId: job.id,
    }, { jwt, myceliaUrl }) as Record<string, unknown>;
  },
};

export default capability;
