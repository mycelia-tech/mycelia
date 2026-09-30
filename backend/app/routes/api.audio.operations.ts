import type { Request, Response } from "express";
import { EJSON } from "bson";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { getQueue } from "@/lib/jobs/queue.ts";
import {
  audioOperationsRevision,
  readAudioOperations,
} from "@/lib/audio-operations.ts";

// Cache per authorization scope, coalescing tabs. Failures also have a short TTL.
const cache = new Map<string, { until: number; value: Promise<unknown> }>();

async function hostHealth() {
  const base = Deno.env.get("INGESTION_WORKER_URL") ||
    "http://host.docker.internal:8001";
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data.status !== "string") {
      throw new Error("Invalid ingestion health response");
    }
    return { reachable: true, ...data };
  } catch (error) {
    return { reachable: false, status: "unavailable", error: String(error) };
  }
}

export async function apiAudioOperationsHandler(req: Request, res: Response) {
  const auth = await authenticateOr401(req, res);
  const key = JSON.stringify([
    auth.principal,
    auth.policies,
    audioOperationsRevision,
  ]);
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) {
    res.json(await existing.value);
    return;
  }
  for (const [id, item] of cache) {
    if (item.until <= Date.now()) cache.delete(id);
  }
  const value = (async () => {
    const [host, stored, queues] = await Promise.all([
      hostHealth(),
      readAudioOperations(getMongoResource(auth)),
      Promise.all(["ingestion", "vad", "transcription"].map(async (type) => {
        try {
          const counts = await getQueue(type).getJobCounts(
            "active",
            "waiting",
            "delayed",
            "paused",
          );
          return [type, { available: true, ...counts }];
        } catch {
          return [type, { available: false }];
        }
      })),
    ]);
    return EJSON.serialize({
      checkedAt: new Date(),
      host,
      ...stored,
      queues: Object.fromEntries(queues),
    });
  })();
  cache.set(key, { until: Date.now() + 15_000, value });
  try {
    res.json(await value);
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
