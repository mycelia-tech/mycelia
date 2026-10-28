import type { Job } from "bullmq";
import { z } from "zod";
import { ObjectId } from "bson";
import { env } from "#/env.ts";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import type { JobData, JobResult } from "@/lib/jobs/types.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import {
  drainConversationProjectionPending,
  LOCATION_CONVERSATION_PENDING,
  rebuildLocationConversationProjection,
} from "@/lib/location/conversation-map.server.ts";
import { rebuildLocationRouteProjection } from "@/lib/location/route-projection.server.ts";
import { backfillLocationImports } from "@/lib/location/import.server.ts";
import { getServerAuth } from "@/lib/auth/core.server.ts";

export const name = "locationMapProjection";

export const schema = z.object({
  type: z.literal(name),
  mode: z.enum(["incremental", "conversations", "routes", "all"]).default(
    "incremental",
  ),
  reparseOriginals: z.boolean().default(false),
}).strict();

function mongoAllowedHosts(mongoUrl: string | undefined): string[] {
  const afterScheme = (mongoUrl ?? "").split("://", 2)[1] ?? "";
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1
    ? afterScheme
    : afterScheme.slice(0, authorityEnd);
  const hosts = authority.split("@").at(-1) ?? "";
  return hosts.split(",").map((host) => host.trim()).filter(Boolean);
}

export async function use(job: Job<JobData>): Promise<JobResult> {
  const input = schema.parse({
    type: job.data.type,
    mode: job.data.mode,
    reparseOriginals: job.data.reparseOriginals,
  });
  const db = await getRootDB();
  let processed = 0;
  let conversationRevision: number | undefined;
  let routeRevision: number | undefined;
  if (input.reparseOriginals) {
    await job.updateProgress({ stage: "reparsing-source-files" });
    const auth = await getServerAuth();
    const reparsed = await backfillLocationImports(auth, 500);
    if (reparsed.failed.length > 0) {
      await db.collection("location_tracks").updateMany(
        {
          "sourceRefs.importId": {
            $in: reparsed.failed.filter((failure) =>
              ObjectId.isValid(failure.importId)
            ).map((failure) => new ObjectId(failure.importId)),
          },
        },
        { $set: { routeBoundaryCompleteness: "incomplete" } },
      );
      await job.log(
        `${reparsed.failed.length} source file(s) could not be reparsed; existing geometry remains available`,
      );
    }
  }
  if (input.mode === "incremental") {
    await job.updateProgress({ stage: "updating-conversations" });
    const result = await drainConversationProjectionPending(db);
    processed += result.processed;
    const routeState = await db.collection<any>(
      "location_route_projection_state",
    )
      .findOne({ _id: "current", dirty: true, ready: true });
    if (routeState) {
      await job.updateProgress({ stage: "rebuilding-routes" });
      const routeResult = await rebuildLocationRouteProjection(db, {
        onProgress: (progress) =>
          job.updateProgress({ stage: "rebuilding-routes", ...progress }),
      });
      processed += routeResult.processed;
      routeRevision = routeResult.revision;
    }
  } else if (input.mode === "conversations" || input.mode === "all") {
    await job.updateProgress({ stage: "rebuilding-conversations" });
    const result = await rebuildLocationConversationProjection(db, {
      onProgress: (progress) =>
        job.updateProgress({ stage: "rebuilding-conversations", ...progress }),
    });
    processed += result.processed;
    conversationRevision = result.revision;
  }
  if (input.mode === "routes" || input.mode === "all") {
    await job.updateProgress({ stage: "rebuilding-routes" });
    const result = await rebuildLocationRouteProjection(db, {
      onProgress: (progress) =>
        job.updateProgress({ stage: "rebuilding-routes", ...progress }),
    });
    processed += result.processed;
    routeRevision = result.revision;
  }
  await job.updateProgress({ stage: "ready", processed });
  return {
    success: true,
    processed,
    hasMore: false,
    ...(conversationRevision !== undefined ? { conversationRevision } : {}),
    ...(routeRevision !== undefined ? { routeRevision } : {}),
  };
}

const capability: JobCapability = {
  name,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(z.object({
    success: z.boolean(),
    processed: z.number(),
    hasMore: z.boolean(),
    conversationRevision: z.number().optional(),
    routeRevision: z.number().optional(),
  })),
  policies: [],
  allowedHosts: mongoAllowedHosts(env.MONGO_URL),
  maxConcurrency: 1,
  triggers: {
    sources: [
      { channel: "mycelia:mongo:objects", name: "conversation_changed" },
      { channel: "mycelia:mongo:location_segments", name: "location_changed" },
      { channel: "mycelia:mongo:location_tracks", name: "route_changed" },
      {
        channel: "mycelia:mongo:location_track_geometry",
        name: "route_geometry_changed",
      },
    ],
    debounceMs: 3_000,
    interval: 300,
  },
  hasPendingWork: async ({ mongo }) => {
    const [pending, conversationState, routeState] = await Promise.all([
      mongo({
        action: "findOne",
        collection: LOCATION_CONVERSATION_PENDING,
        query: {},
        options: { projection: { _id: 1 } },
      }),
      mongo({
        action: "findOne",
        collection: "location_conversation_projection_state",
        query: { _id: "current" },
        options: { projection: { ready: 1 } },
      }),
      mongo({
        action: "findOne",
        collection: "location_route_projection_state",
        query: { _id: "current", dirty: true, ready: true },
        options: { projection: { _id: 1 } },
      }),
    ]);
    return pending && conversationState?.ready || routeState ? 1 : 0;
  },
  getTriggerJobData: () => ({ type: name, mode: "incremental" }),
  use,
};

export default capability;
