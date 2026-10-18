import type { Job } from "bullmq";
import { ObjectId } from "bson";
import { z } from "zod";
import { env } from "#/env.ts";
import type { JobCapability } from "@/lib/jobs/job-registry.ts";
import { getTriggerTiming } from "@/lib/jobs/trigger-config.ts";
import type { JobData, JobResult } from "@/lib/jobs/types.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import {
  identitySourceBatchKey,
  identitySourceBuildOwnsEpoch,
  markIdentitySourceIndexCounting,
  SPEAKER_IDENTITY_SOURCE_BATCHES,
  SPEAKER_IDENTITY_SOURCE_INDEX,
  SPEAKER_IDENTITY_SOURCE_INDEX_ID,
  SPEAKER_IDENTITY_SOURCE_PARTITIONS,
  summarizeIdentitySourceBatch,
} from "@/lib/speakers/identity-source-index.ts";

export const name = "speakerIdentitySourceIndex";

export const schema = z.object({
  type: z.literal(name),
  batchSize: z.number().int().min(100).max(25_000).default(10_000),
  force: z.boolean().default(false),
  cursor: z.string().optional(),
}).strict();

type SourceIndexInput = z.infer<typeof schema>;

class SourceIndexMembershipChanged extends Error {
  constructor() {
    super("Speaker identity source membership changed during indexing");
    this.name = "SourceIndexMembershipChanged";
  }
}

function mongoAllowedHosts(mongoUrl: string | undefined): string[] {
  const afterScheme = (mongoUrl ?? "").split("://", 2)[1] ?? "";
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1
    ? afterScheme
    : afterScheme.slice(0, authorityEnd);
  const hosts = authority.split("@").at(-1) ?? "";
  return hosts.split(",").map((host) => host.trim()).filter(Boolean);
}

function parseInput(data: JobData): SourceIndexInput {
  return schema.parse({
    type: data.type,
    batchSize: data.batchSize,
    force: data.force,
    cursor: data.cursor,
  });
}

async function beginBuild(
  job: Job<JobData>,
  force: boolean,
): Promise<any> {
  const db = await getRootDB();
  const collection = db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX);
  let state = await collection.findOne({
    _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
  });
  if (state?.status === "ready" && !force) return state;
  if (state?.status === "blocked" && !force) return state;

  const dirtyEpoch = Number(state?.dirtyEpoch ?? 0);
  if (
    state?.activeBuild &&
    Number(state.activeBuild.dirtyEpoch ?? -1) !== dirtyEpoch
  ) {
    const staleBuildId = String(state.activeBuild.buildId ?? "");
    await collection.updateOne(
      {
        _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
        "activeBuild.buildId": staleBuildId,
        dirtyEpoch,
      },
      {
        $unset: { activeBuild: "", currentJobId: "" },
        $set: { status: "counting", updatedAt: new Date() },
      },
    );
    if (staleBuildId) {
      const cleanupAt = new Date(Date.now() + 7 * 86_400_000);
      await Promise.all([
        db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).updateMany(
          { buildId: staleBuildId },
          { $set: { cleanupAt } },
        ),
        db.collection(SPEAKER_IDENTITY_SOURCE_PARTITIONS).updateMany(
          { buildId: staleBuildId },
          { $set: { cleanupAt } },
        ),
      ]);
    }
    state = await collection.findOne({ _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID });
  }

  if (!state?.activeBuild || force) {
    const now = new Date();
    const buildId = crypto.randomUUID();
    await collection.updateOne(
      { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
      {
        $set: {
          status: "counting",
          activeBuild: {
            buildId,
            cursor: null,
            scannedSegments: 0,
            batchCount: 0,
            dirtyEpoch: Number(state?.dirtyEpoch ?? 0),
            membershipRevision: Number(state?.membershipRevision ?? 0),
            startedAt: now,
          },
          currentJobId: String(job.id ?? ""),
          updatedAt: now,
        },
        $unset: {
          failureReason: "",
          blockedAt: "",
          queuedJobId: "",
          queuedAt: "",
        },
        $setOnInsert: {
          membershipRevision: 0,
          dirtyEpoch: 0,
          publishedRevision: 0,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    state = await collection.findOne({ _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID });
  } else {
    await collection.updateOne(
      {
        _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
        "activeBuild.buildId": state.activeBuild.buildId,
      },
      {
        $set: {
          status: "counting",
          currentJobId: String(job.id ?? ""),
          updatedAt: new Date(),
        },
        $unset: { queuedJobId: "", queuedAt: "" },
      },
    );
    state = await collection.findOne({ _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID });
  }
  return state;
}

async function publishBuild(
  buildId: string,
  dirtyEpoch: number,
  jobId: string,
): Promise<number> {
  const db = await getRootDB();
  const stateCollection = db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX);
  const state = await stateCollection.findOne({
    _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
    "activeBuild.buildId": buildId,
    "activeBuild.dirtyEpoch": dirtyEpoch,
    dirtyEpoch,
  });
  if (!state || !identitySourceBuildOwnsEpoch(state, buildId, dirtyEpoch)) {
    throw new SourceIndexMembershipChanged();
  }
  const nextRevision = Number(state.publishedRevision ?? 0) + 1;
  const rows = await db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).aggregate<{
    _id: { runId: string; embeddingSpaceId: string };
    sourceSegments: number;
    start: Date;
    end: Date;
    maxSegmentId: ObjectId;
  }>([
    { $match: { buildId } },
    { $unwind: "$partitions" },
    {
      $group: {
        _id: {
          runId: "$partitions.runId",
          embeddingSpaceId: "$partitions.embeddingSpaceId",
        },
        sourceSegments: { $sum: "$partitions.sourceSegments" },
        start: { $min: "$partitions.start" },
        end: { $max: "$partitions.end" },
        maxSegmentId: { $max: "$partitions.maxSegmentId" },
      },
    },
  ]).toArray();

  if (rows.length > 0) {
    await db.collection(SPEAKER_IDENTITY_SOURCE_PARTITIONS).bulkWrite(
      rows.map((row) => ({
        updateOne: {
          filter: {
            buildId,
            runId: row._id.runId,
            embeddingSpaceId: row._id.embeddingSpaceId,
          },
          update: {
            $set: {
              buildId,
              sourceRevision: nextRevision,
              runId: row._id.runId,
              embeddingSpaceId: row._id.embeddingSpaceId,
              sourceSegments: row.sourceSegments,
              start: row.start,
              end: row.end,
              maxSegmentId: row.maxSegmentId,
              status: "ready",
              updatedAt: new Date(),
            },
            $unset: { cleanupAt: "" },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const completedAt = new Date();
  const publishedSourceSegments = rows.reduce(
    (total, row) => total + Number(row.sourceSegments ?? 0),
    0,
  );
  // Use the scan cursor rather than a partition max. Malformed legacy rows are
  // intentionally excluded from partitions, but they must not make every
  // readiness check look like a newly inserted segment forever.
  const publishedMaxSegmentId = state.activeBuild?.cursor
    ? new ObjectId(state.activeBuild.cursor)
    : null;
  const published = await stateCollection.updateOne(
    {
      _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
      "activeBuild.buildId": buildId,
      "activeBuild.dirtyEpoch": dirtyEpoch,
      dirtyEpoch,
      currentJobId: jobId,
    },
    {
      $set: {
        status: "ready",
        publishedBuildId: buildId,
        publishedRevision: nextRevision,
        publishedMembershipRevision: Number(state.membershipRevision ?? 0),
        publishedSourceSegments,
        publishedMaxSegmentId,
        publishedAt: completedAt,
        partitionCount: rows.length,
        updatedAt: completedAt,
      },
      $unset: {
        activeBuild: "",
        currentJobId: "",
        dirtyAt: "",
        dirtyReason: "",
        failureReason: "",
      },
    },
  );
  if (published.matchedCount !== 1) {
    const cleanupAt = new Date(completedAt.getTime() + 7 * 86_400_000);
    await Promise.all([
      db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).updateMany(
        { buildId },
        { $set: { cleanupAt } },
      ),
      db.collection(SPEAKER_IDENTITY_SOURCE_PARTITIONS).updateMany(
        { buildId },
        { $set: { cleanupAt } },
      ),
    ]);
    throw new SourceIndexMembershipChanged();
  }
  await db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).updateMany(
    { buildId },
    { $set: { cleanupAt: new Date(completedAt.getTime() + 7 * 86_400_000) } },
  );
  await db.collection(SPEAKER_IDENTITY_SOURCE_PARTITIONS).updateMany(
    { buildId: { $ne: buildId }, cleanupAt: { $exists: false } },
    { $set: { cleanupAt: new Date(completedAt.getTime() + 7 * 86_400_000) } },
  );
  return rows.length;
}

export async function use(job: Job<JobData>): Promise<JobResult> {
  const input = parseInput(job.data);
  const db = await getRootDB();
  let state: any;
  let activeBuildId: string | null = null;
  let activeDirtyEpoch: number | null = null;
  try {
    state = await beginBuild(job, input.force);
    if (state?.status === "ready" && !input.force) {
      return { success: true, processed: 0, hasMore: false, status: "ready" };
    }
    if (state?.status === "blocked" && !input.force) {
      return {
        success: false,
        processed: 0,
        hasMore: false,
        status: "blocked",
        message: state.failureReason ?? "Source index is blocked",
      };
    }
    state = await db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX).findOne({
      _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
    });
    const build = state?.activeBuild;
    if (!build?.buildId) {
      throw new Error("Source index build was not initialized");
    }
    activeBuildId = String(build.buildId);
    activeDirtyEpoch = Number(build.dirtyEpoch ?? 0);
    const cursor = build.cursor ? new ObjectId(build.cursor) : null;
    const query: Record<string, unknown> = {
      lifecycleStatus: "active",
      embedding: { $exists: true },
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    };
    const rows = await db.collection("diarizations").find(query, {
      projection: {
        _id: 1,
        runId: 1,
        embeddingSpaceId: 1,
        start: 1,
        end: 1,
      },
      sort: { _id: 1 },
      limit: input.batchSize,
      hint: "speaker_identity_source_index_scan",
    }).toArray() as Array<{
      _id: ObjectId;
      runId?: unknown;
      embeddingSpaceId?: unknown;
      start?: unknown;
      end?: unknown;
    }>;
    const lastId = rows.at(-1)?._id ?? cursor;
    const batchKey = identitySourceBatchKey(cursor);
    const summaries = summarizeIdentitySourceBatch(rows);
    await db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).updateOne(
      { buildId: build.buildId, batchKey },
      {
        $setOnInsert: {
          buildId: build.buildId,
          batchKey,
          cursorBefore: cursor,
          cursorAfter: lastId,
          sourceSegments: rows.length,
          partitions: summaries,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    const advanced = await db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX)
      .updateOne(
        {
          _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
          "activeBuild.buildId": build.buildId,
          "activeBuild.dirtyEpoch": activeDirtyEpoch,
          dirtyEpoch: activeDirtyEpoch,
          "activeBuild.cursor": cursor,
          currentJobId: String(job.id ?? ""),
        },
        {
          $set: {
            "activeBuild.cursor": lastId,
            "activeBuild.lastBatchAt": new Date(),
            updatedAt: new Date(),
          },
          $inc: {
            "activeBuild.scannedSegments": rows.length,
            "activeBuild.batchCount": 1,
          },
        },
      );
    if (advanced.matchedCount !== 1) {
      const latestState = await db.collection<any>(
        SPEAKER_IDENTITY_SOURCE_INDEX,
      )
        .findOne({ _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID });
      if (
        !identitySourceBuildOwnsEpoch(
          latestState,
          build.buildId,
          activeDirtyEpoch,
        )
      ) {
        throw new SourceIndexMembershipChanged();
      }
      throw new Error("Speaker identity source cursor changed concurrently");
    }
    const scanned = Number(build.scannedSegments ?? 0) + rows.length;
    await job.updateProgress({
      stage: rows.length < input.batchSize ? "publishing" : "counting",
      processed: scanned,
      batchCount: Number(build.batchCount ?? 0) + 1,
      buildId: build.buildId,
    });
    if (rows.length >= input.batchSize) {
      return {
        success: true,
        processed: rows.length,
        totalProcessed: scanned,
        hasMore: true,
        cursor: lastId?.toHexString(),
        status: "counting",
        buildId: build.buildId,
      };
    }

    const partitionCount = await publishBuild(
      build.buildId,
      activeDirtyEpoch,
      String(job.id ?? ""),
    );
    await job.updateProgress({
      stage: "ready",
      processed: scanned,
      partitionCount,
      buildId: build.buildId,
    });
    return {
      success: true,
      processed: rows.length,
      totalProcessed: scanned,
      partitionCount,
      hasMore: false,
      status: "ready",
      buildId: build.buildId,
    };
  } catch (error) {
    if (error instanceof SourceIndexMembershipChanged) {
      const cleanupAt = new Date(Date.now() + 7 * 86_400_000);
      if (activeBuildId) {
        await Promise.all([
          db.collection(SPEAKER_IDENTITY_SOURCE_BATCHES).updateMany(
            { buildId: activeBuildId },
            { $set: { cleanupAt } },
          ),
          db.collection(SPEAKER_IDENTITY_SOURCE_PARTITIONS).updateMany(
            { buildId: activeBuildId },
            { $set: { cleanupAt } },
          ),
        ]);
      }
      await db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX).updateOne(
        {
          _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
          ...(activeBuildId ? { "activeBuild.buildId": activeBuildId } : {}),
          ...(activeDirtyEpoch === null
            ? {}
            : { "activeBuild.dirtyEpoch": activeDirtyEpoch }),
        },
        {
          $set: { status: "counting", updatedAt: new Date() },
          $unset: { activeBuild: "", currentJobId: "" },
        },
      );
      return {
        success: true,
        // A positive progress marker asks the generic chain to enqueue the
        // clean restart immediately instead of waiting for the watchdog.
        processed: 1,
        hasMore: true,
        status: "counting",
        message: "Source membership changed; restarting the index",
      };
    }
    await db.collection<any>(SPEAKER_IDENTITY_SOURCE_INDEX).updateOne(
      {
        _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID,
        ...(activeBuildId ? { "activeBuild.buildId": activeBuildId } : {}),
        ...(activeDirtyEpoch === null
          ? {}
          : { "activeBuild.dirtyEpoch": activeDirtyEpoch }),
      },
      {
        $set: {
          status: "blocked",
          failureReason: error instanceof Error ? error.message : String(error),
          blockedAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { currentJobId: "" },
      },
      // A failed build may only block the row it still owns. If another dirty
      // event already replaced that build, an upsert with the stale ownership
      // predicate would attempt to insert a duplicate singleton document.
      { upsert: activeBuildId === null },
    );
    throw error;
  }
}

const capability: JobCapability = {
  name,
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
  outputSchema: z.toJSONSchema(z.object({
    success: z.boolean(),
    processed: z.number(),
    totalProcessed: z.number().optional(),
    partitionCount: z.number().optional(),
    hasMore: z.boolean(),
    cursor: z.string().optional(),
    status: z.enum(["counting", "ready", "blocked"]),
    buildId: z.string().optional(),
    message: z.string().optional(),
  })),
  policies: [
    { resource: "db/diarizations", action: "read", effect: "allow" },
    {
      resource: "db/speaker_identity_source_index",
      action: "*",
      effect: "allow",
    },
    {
      resource: "db/speaker_identity_source_partitions",
      action: "*",
      effect: "allow",
    },
    {
      resource: "db/speaker_identity_source_batches",
      action: "*",
      effect: "allow",
    },
  ],
  allowedHosts: mongoAllowedHosts(env.MONGO_URL),
  maxConcurrency: 1,
  use,
  hasPendingWork: async ({ mongo }) => {
    const state = await mongo({
      action: "findOne",
      collection: SPEAKER_IDENTITY_SOURCE_INDEX,
      query: { _id: SPEAKER_IDENTITY_SOURCE_INDEX_ID },
      options: {
        projection: {
          status: 1,
          currentJobId: 1,
          queuedJobId: 1,
          publishedMaxSegmentId: 1,
        },
      },
    });
    if (!state) return 1;
    if (state.status === "blocked") return false;
    if (state.status === "counting") {
      return state.currentJobId || state.queuedJobId ? false : 1;
    }
    const rows = await mongo({
      action: "find",
      collection: "diarizations",
      query: {
        lifecycleStatus: "active",
        embedding: { $exists: true },
        ...(state.publishedMaxSegmentId
          ? { _id: { $gt: state.publishedMaxSegmentId } }
          : {}),
      },
      options: { projection: { _id: 1 }, sort: { _id: 1 }, limit: 1 },
    }) as any[];
    if (!rows.length) return false;
    await markIdentitySourceIndexCounting(mongo, "new_active_segment");
    return 1;
  },
  getTriggerJobData: () => ({ type: name }),
  triggers: {
    sources: [{
      channel: "mycelia:mongo:diarizations",
      name: "active_diarization_membership",
      filter: { event: "mongo.change" },
    }],
    ...getTriggerTiming(name),
  },
};

export default capability;
