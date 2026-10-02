import { z } from "zod";
import { NetworkJobCapability } from "./python.ts";

/** Schema for ingestion job data */
export const schema = z.object({
  type: z.literal("ingestion"),
  sourceFolder: z.string().trim().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

// Ingestion must run on the host because source_files paths refer to macOS
// files that are intentionally not mounted into the Docker Python worker.
const INGESTION_WORKER_URL = Deno.env.get("INGESTION_WORKER_URL") ||
  "http://host.docker.internal:8001";

export default new NetworkJobCapability({
  name: "ingestion",
  schema,
  url: `${INGESTION_WORKER_URL}/jobs/ingestion`,
  policies: [
    { resource: "db/host_ingestion_config", action: "read", effect: "allow" },
    { resource: "db/source_files", action: "*", effect: "allow" },
    { resource: "db/audio_chunks", action: "*", effect: "allow" },
  ],
  maxConcurrency: 1,
  allowedHosts: [new URL(INGESTION_WORKER_URL).host],
});
