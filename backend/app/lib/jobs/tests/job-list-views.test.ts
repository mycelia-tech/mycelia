import { expect } from "@std/expect";
import { ObjectId } from "bson";
import type { Auth } from "@/lib/auth/core.server.ts";
import { logicalJobListPipeline } from "@/lib/resources/worker.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import "./fixtures.ts";

Deno.test("jobs list pipeline bounds ordinary jobs before campaign grouping", () => {
  const candidateQuery = {
    type: { $in: ["transcription", "mediaFolderImport"] },
  };
  const visibleQuery = {
    state: { $in: ["completed"] },
    dismissedAt: { $exists: false },
  };
  const pipeline = logicalJobListPipeline(
    candidateQuery,
    visibleQuery,
    200,
  ) as any[];

  expect(pipeline[0]).toEqual({
    $match: {
      $and: [
        candidateQuery,
        visibleQuery,
        {
          type: {
            $nin: ["mediaFolderImport", "mediaRecognitionBatch"],
          },
        },
      ],
    },
  });
  const unionIndex = pipeline.findIndex((stage) => stage.$unionWith);
  expect(unionIndex).toBeGreaterThan(0);
  expect(pipeline.slice(0, unionIndex).some((stage) => stage.$group)).toBe(
    false,
  );
  expect(pipeline.slice(0, unionIndex).some((stage) => stage.$limit === 200))
    .toBe(true);

  const campaignPipeline = pipeline[unionIndex].$unionWith.pipeline as any[];
  const groupIndex = campaignPipeline.findIndex((stage) => stage.$group);
  const lifecycleIndex = campaignPipeline.findIndex((stage) =>
    stage.$match === visibleQuery
  );
  expect(groupIndex).toBeGreaterThan(0);
  expect(lifecycleIndex).toBeGreaterThan(groupIndex);
  expect(campaignPipeline.slice(0, groupIndex).some((stage) => stage.$project))
    .toBe(true);
  expect(campaignPipeline[groupIndex].$group.job.$top.output).toEqual(
    expect.objectContaining({
      _id: "$_id",
      type: "$type",
      createdAt: "$createdAt",
    }),
  );
  expect(JSON.stringify(pipeline)).not.toContain("$$ROOT");
});

Deno.test(
  "jobs list separates automatic no-op checks before applying the limit",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    const now = Date.now();
    await mongo.db.collection("jobs").insertMany([
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "completed",
        trigger: { type: "auto", reason: "new_speech_chunk" },
        result: { status: "success", processed: 0, hasMore: false },
        createdAt: new Date(now),
        finishedAt: new Date(now),
      },
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "completed",
        trigger: { type: "manual", reason: "operator check" },
        result: { status: "success", processed: 0, hasMore: false },
        createdAt: new Date(now - 1_000),
        finishedAt: new Date(now - 900),
      },
      {
        _id: new ObjectId(),
        type: "transcription",
        state: "completed",
        trigger: { type: "auto", reason: "sequence_ready" },
        result: { result: "empty", processed: 1, wordCount: 0 },
        createdAt: new Date(now - 2_000),
        finishedAt: new Date(now - 1_900),
      },
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "completed",
        trigger: { type: "auto", reason: "new_speech_chunk" },
        result: { status: "success", processed: 4, hasMore: false },
        createdAt: new Date(now - 3_000),
        finishedAt: new Date(now - 2_900),
      },
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "active",
        trigger: { type: "auto", reason: "new_speech_chunk" },
        progress: { processed: 0 },
        createdAt: new Date(now - 4_000),
        startedAt: new Date(now - 3_900),
      },
    ]);

    const jobs = admin.getResource("jobs");
    const types = ["transcription_sequence_creator", "transcription"];
    const statuses = ["active", "completed"] as const;

    const operational = await jobs({
      action: "list",
      view: "operational",
      types,
      statuses: [...statuses],
      limit: 1,
    });
    expect(operational).toHaveLength(1);
    expect(operational[0].trigger.type).toBe("manual");

    const idle = await jobs({
      action: "list",
      view: "idle_auto",
      types,
      statuses: [...statuses],
      limit: 10,
    });
    expect(idle).toHaveLength(1);
    expect(idle[0].trigger).toEqual({
      type: "auto",
      reason: "new_speech_chunk",
    });
    expect(idle[0].result.processed).toBe(0);

    const all = await jobs({
      action: "list",
      types,
      statuses: [...statuses],
      limit: 10,
    });
    expect(all).toHaveLength(5);
  }),
);

Deno.test(
  "jobs stats counts idle automatic runs separately from semantic empty work",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    const now = new Date();
    await mongo.db.collection("jobs").insertMany([
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "completed",
        trigger: { type: "auto" },
        result: { processed: 0 },
        createdAt: now,
      },
      {
        _id: new ObjectId(),
        type: "transcription_sequence_creator",
        state: "completed",
        trigger: { type: "manual" },
        result: { processed: 0 },
        createdAt: now,
      },
      {
        _id: new ObjectId(),
        type: "transcription",
        state: "completed",
        trigger: { type: "auto" },
        result: { result: "empty", processed: 1, wordCount: 0 },
        createdAt: now,
      },
    ]);
    await mongo.db.collection("objects").insertOne({
      _id: new ObjectId(),
      name: "fixture",
    });

    const jobs = admin.getResource("jobs");
    await jobs({ action: "refresh_run_history" });
    let response = await jobs({ action: "stats" });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (response.snapshot?.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
      response = await jobs({ action: "stats" });
    }
    expect(response.snapshot?.state).toBe("ready");
    const creator = response.stats.find((row: any) =>
      row.type === "transcription_sequence_creator"
    );
    const transcription = response.stats.find((row: any) =>
      row.type === "transcription"
    );

    expect(creator.emptyRuns).toBe(2);
    expect(creator.idleAutoRuns).toBe(1);
    expect(transcription.idleAutoRuns).toBe(0);
  }),
);

Deno.test(
  "jobs provider filter searches beyond 500 newer jobs before the result limit",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    const now = Date.now();
    const targetId = new ObjectId();
    await mongo.db.collection("jobs").insertMany([
      ...Array.from({ length: 501 }, (_, index) => ({
        _id: new ObjectId(),
        type: "diarization",
        state: "completed",
        data: {
          routingContext: {
            providerProfileId: "current-gpu",
            providerProfileName: "Current GPU",
          },
        },
        createdAt: new Date(now - index),
        finishedAt: new Date(now - index),
      })),
      {
        _id: targetId,
        type: "diarization",
        state: "completed",
        data: {
          routingContext: {
            providerProfileId: "legacy-gpu",
            providerProfileName: "Legacy GPU",
          },
        },
        createdAt: new Date(now - 10_000),
        finishedAt: new Date(now - 9_000),
      },
    ]);

    const result = await admin.getResource("jobs")({
      action: "list",
      view: "all",
      types: ["diarization"],
      statuses: ["completed"],
      providerProfileId: "legacy-gpu",
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(targetId.toString());
    expect(result[0].routingContext.providerProfileId).toBe("legacy-gpu");
  }),
);

Deno.test(
  "jobs list hides photo item jobs and groups logical media campaigns before the limit",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    const now = Date.now();
    const batchId = new ObjectId().toString();
    const campaignId = new ObjectId().toString();
    const olderBatchJobId = new ObjectId();
    const latestBatchJobId = new ObjectId();
    const latestFolderJobId = new ObjectId();
    await mongo.db.collection("jobs").insertMany([
      ...Array.from({ length: 501 }, (_, index) => ({
        _id: new ObjectId(),
        type: "mediaRecognition",
        state: "completed",
        data: { assetId: new ObjectId().toString() },
        createdAt: new Date(now - index),
        finishedAt: new Date(now - index),
      })),
      {
        _id: latestBatchJobId,
        type: "mediaRecognitionBatch",
        state: "completed",
        data: { batchId },
        result: { batchId, processed: 9 },
        createdAt: new Date(now - 2_000),
        finishedAt: new Date(now - 1_900),
      },
      {
        _id: olderBatchJobId,
        type: "mediaRecognitionBatch",
        state: "completed",
        progress: { batchId, processed: 4, total: 10 },
        createdAt: new Date(now - 3_000),
        finishedAt: new Date(now - 2_900),
      },
      {
        _id: latestFolderJobId,
        type: "mediaFolderImport",
        state: "completed",
        result: { campaignId, processed: 20 },
        createdAt: new Date(now - 4_000),
        finishedAt: new Date(now - 3_900),
      },
      {
        _id: new ObjectId(),
        type: "mediaFolderImport",
        state: "completed",
        data: { campaignId },
        createdAt: new Date(now - 5_000),
        finishedAt: new Date(now - 4_900),
      },
    ]);

    const jobs = admin.getResource("jobs");
    const visible = await jobs({
      action: "list",
      statuses: ["completed"],
      limit: 10,
    });
    expect(visible.map((job: any) => job.type).sort()).toEqual([
      "mediaFolderImport",
      "mediaRecognitionBatch",
    ]);
    expect(
      visible.find((job: any) => job.type === "mediaRecognitionBatch")?.id,
    ).toBe(latestBatchJobId.toString());
    expect(
      visible.find((job: any) => job.type === "mediaFolderImport")?.id,
    ).toBe(latestFolderJobId.toString());

    const internal = await jobs({
      action: "list",
      types: ["mediaRecognition"],
      statuses: ["completed"],
      limit: 3,
    });
    expect(internal).toHaveLength(3);
    expect(internal.every((job: any) => job.type === "mediaRecognition"))
      .toBe(true);
  }),
);

Deno.test(
  "jobs error stats hide photo item failures unless explicitly requested",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    await mongo.db.collection("jobs").insertMany([
      {
        _id: new ObjectId(),
        type: "mediaRecognition",
        state: "failed",
        failedReason: "internal photo failure",
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        type: "mediaRecognitionBatch",
        state: "failed",
        failedReason: "batch failure",
        createdAt: new Date(),
      },
    ]);

    const jobs = admin.getResource("jobs");
    const visible = await jobs({ action: "error_stats", sinceDays: 1 });
    expect(visible.failures.map((row: any) => row.type)).toEqual([
      "mediaRecognitionBatch",
    ]);

    const internal = await jobs({
      action: "error_stats",
      sinceDays: 1,
      types: ["mediaRecognition"],
    });
    expect(internal.failures.map((row: any) => row.type)).toEqual([
      "mediaRecognition",
    ]);
  }),
);

Deno.test(
  "jobs lifecycle filters use the latest logical campaign attempt",
  withFixtures(["Admin", "Mongo", "JobsResource"], async (
    admin: Auth,
    mongo,
  ) => {
    const campaignId = new ObjectId().toString();
    const failedId = new ObjectId();
    const completedId = new ObjectId();
    const now = Date.now();
    await mongo.db.collection("jobs").insertMany([
      {
        _id: failedId,
        type: "mediaFolderImport",
        state: "failed",
        data: { campaignId },
        failedReason: "interrupted attempt",
        createdAt: new Date(now - 1_000),
      },
      {
        _id: completedId,
        type: "mediaFolderImport",
        state: "completed",
        data: { campaignId },
        result: { campaignId, processed: 25 },
        createdAt: new Date(now),
      },
    ]);

    const jobs = admin.getResource("jobs");
    const failed = await jobs({
      action: "list",
      types: ["mediaFolderImport"],
      statuses: ["failed"],
      limit: 10,
    });
    expect(failed).toEqual([]);

    const completed = await jobs({
      action: "list",
      types: ["mediaFolderImport"],
      statuses: ["completed"],
      limit: 10,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(completedId.toString());
  }),
);
