import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { z } from "zod";
import { callResource } from "@myceliasdk/resources.ts";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import type { JobData, JobResult } from "@/lib/jobs/types.ts";
import { parseTrackFile } from "@/lib/location/parse.server.ts";
import {
  HOUR_MS,
  planReittiSync,
  readReittiExport,
} from "@/lib/location/reitti-sync.ts";

const name = "reitti_sync";
const schema = z.object({ type: z.literal("reitti_sync") });
const sourceUrl = Deno.env.get("REITTI_URL") ?? "";
const device = Deno.env.get("REITTI_DEVICE_ID") ?? "1";
const start = Deno.env.get("REITTI_START_DATE") ?? "";
const enabled = () =>
  Boolean(sourceUrl && start && Deno.env.get("REITTI_API_TOKEN"));
const digest = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const sourceId = `reitti:${
  digest(`${sourceUrl}|${device}|${start}`).slice(0, 24)
}`;

async function use(job: Job<JobData>): Promise<JobResult> {
  schema.parse(job.data);
  if (!enabled()) {
    throw new Error(
      "Configure REITTI_URL, REITTI_API_TOKEN and REITTI_START_DATE first",
    );
  }
  const jwt = Deno.env.get("MYCELIA_JWT")!;
  const myceliaUrl = Deno.env.get("MYCELIA_URL")!;
  const mongo = (input: any): Promise<any> =>
    callResource("mongo", input, { jwt, myceliaUrl });
  const state = await mongo({
    action: "findOne",
    collection: "location_sync_state",
    query: { _id: sourceId },
  }) ?? {};
  const now = new Date();
  const plan = planReittiSync(start, state, now);
  const pending: Array<
    {
      day: string;
      hash: string;
      points: number;
      bytes: Uint8Array;
      filename: string;
    }
  > = [];
  const checked: Array<{ day: string; hash: string; points: number }> = [];
  try {
    for (const day of plan.days) {
      await job.updateProgress({
        stage: "fetching",
        day,
        days: plan.days.length,
      });
      const bytes = await readReittiExport(
        sourceUrl,
        Deno.env.get("REITTI_API_TOKEN")!,
        device,
        day,
      );
      const hash = digest(bytes);
      const previous = await mongo({
        action: "findOne",
        collection: "location_sync_days",
        query: { _id: `${sourceId}:${day}` },
      });
      if (previous?.hash === hash) continue;
      const parsed = parseTrackFile("gpx", bytes);
      if (
        parsed.invalidCoordinates || parsed.invalidTimestamps || parsed.skipped
      ) {
        throw new Error(
          `Invalid points in Reitti export for ${day}; checkpoint unchanged`,
        );
      }
      const entry = { day, hash, points: parsed.points.length };
      checked.push(entry);
      if (entry.points) {
        pending.push({
          ...entry,
          bytes,
          filename: `reitti-device-${device}-${day}.gpx`,
        });
      }
    }
    let imported = 0;
    if (pending.length) {
      await job.updateProgress({ stage: "importing", files: pending.length });
      const form = new FormData();
      for (const file of pending) {
        form.append(
          "files",
          new Blob([new Uint8Array(file.bytes)], {
            type: "application/gpx+xml",
          }),
          file.filename,
        );
      }
      const response = await fetch(`${myceliaUrl}/api/location/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
        body: form,
        signal: AbortSignal.timeout(600_000),
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`Mycelia location import HTTP ${response.status}`);
      }
      const result = await response.json();
      if (
        !result.success || result.failed ||
        result.results?.length !== pending.length ||
        result.results.some((r: any) => r.error)
      ) {
        throw new Error(
          "Mycelia did not commit every Reitti file; batch will retry idempotently",
        );
      }
      imported = result.results.reduce(
        (n: number, r: any) => n + (r.pointsImported ?? 0),
        0,
      );
    }
    // Never advance hashes/cursors before every nonempty file has a commit receipt.
    for (const entry of checked) {
      await mongo({
        action: "updateOne",
        collection: "location_sync_days",
        query: { _id: `${sourceId}:${entry.day}` },
        update: { $set: { ...entry, sourceId, checkedAt: now } },
        options: { upsert: true },
      });
    }
    const { days: _days, hasMore, ...checkpoint } = plan;
    await mongo({
      action: "updateOne",
      collection: "location_sync_state",
      query: { _id: sourceId },
      update: {
        $set: {
          ...checkpoint,
          sourceUrl,
          device,
          start,
          lastSuccessAt: now,
          lastImportedPoints: imported,
          historyComplete: !hasMore,
          lastError: null,
        },
        $inc: { importedPoints: imported },
      },
      options: { upsert: true },
    });
    return { success: true, processed: plan.days.length, imported, hasMore };
  } catch (error) {
    // Avoid persisting upstream response bodies, tokens or precise locations.
    await mongo({
      action: "updateOne",
      collection: "location_sync_state",
      query: { _id: sourceId },
      update: {
        $set: {
          lastError: "Reitti sync failed; see job status and retry",
          lastFailureAt: new Date(),
        },
      },
      options: { upsert: true },
    });
    throw error;
  }
}

const capability: JobCapability = {
  name,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(
    z.object({
      success: z.boolean(),
      processed: z.number(),
      imported: z.number(),
      hasMore: z.boolean(),
    }),
  ),
  policies: [
    { resource: "db/location_*", action: "*", effect: "allow" },
    { resource: "fs/location_files", action: "*", effect: "allow" },
  ],
  allowedHosts: sourceUrl ? [new URL(sourceUrl).host] : [],
  maxConcurrency: 1,
  triggers: { sources: [], interval: 60, debounceMs: 1000 },
  hasPendingWork: async ({ mongo }) => {
    if (!enabled()) return 0;
    const state = await mongo({
      action: "findOne",
      collection: "location_sync_state",
      query: { _id: sourceId },
    });
    return !state?.historyComplete || !state?.recentAt ||
        Date.now() - Date.parse(state.recentAt) >= HOUR_MS
      ? 1
      : 0;
  },
  getTriggerJobData: () => ({ type: name }),
  use,
};
export default capability;
