import { expect } from "@std/expect";
import capability, {
  RECOGNITION_BATCH_POLL_MS,
  runRecognitionBatchCoordinator,
} from "./mediaRecognitionBatch.ts";

Deno.test("media recognition coordinator polls one job until the batch is terminal", async () => {
  const updates: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const results = [
    {
      success: true,
      processed: 16,
      hasMore: true,
      progress: { processed: 0, total: 20, queued: 16 },
    },
    {
      success: true,
      processed: 1,
      hasMore: true,
      progress: { processed: 1, total: 20, queued: 16 },
    },
    {
      success: true,
      processed: 0,
      hasMore: false,
      progress: { processed: 20, total: 20, stage: "completed" },
    },
  ];
  let calls = 0;

  const result = await runRecognitionBatchCoordinator({
    id: "0123456789abcdef01234567",
    data: {
      type: "mediaRecognitionBatch",
      batchId: "fedcba987654321001234567",
    },
    updateProgress: (progress: unknown) => {
      updates.push(progress as Record<string, unknown>);
      return Promise.resolve();
    },
  } as any, {
    processBatch: () => Promise.resolve(results[calls++]),
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
  });

  expect(calls).toBe(3);
  expect(sleeps).toEqual([
    RECOGNITION_BATCH_POLL_MS,
    RECOGNITION_BATCH_POLL_MS,
  ]);
  expect(updates).toEqual(results.map((entry) => entry.progress));
  expect(result).toMatchObject({
    success: true,
    processed: 17,
    hasMore: false,
  });
});

Deno.test("media recognition watchdog binds recovery to the oldest open batch", async () => {
  const requests: Record<string, unknown>[] = [];
  const batchId = "0123456789abcdef01234567";
  const data = await capability.getTriggerJobData?.(
    undefined,
    "interval",
    {
      mongo: (request: Record<string, unknown>) => {
        requests.push(request);
        return Promise.resolve(
          request.action === "find" ? [{ _id: batchId }] : { _id: batchId },
        );
      },
    },
  );

  expect(data).toEqual({ type: "mediaRecognitionBatch", batchId });
  expect(requests[0]).toMatchObject({
    collection: "media_recognition_batches",
    query: { status: { $in: ["queued", "running"] } },
    options: { sort: { createdAt: 1, _id: 1 }, limit: 1 },
  });
  expect(requests[1]).toMatchObject({
    action: "findOneAndUpdate",
    collection: "media_recognition_batches",
    query: {
      _id: batchId,
      status: { $in: ["queued", "running"] },
    },
    options: { returnDocument: "after" },
  });
});

Deno.test("media watchdog starts a stream coordinator before its first photo wave", async () => {
  const mongo = (request: Record<string, unknown>) =>
    Promise.resolve(
      request.collection === "media_folder_campaigns"
        ? [{ _id: "stream" }]
        : [],
    );
  expect(await capability.hasPendingWork?.({ mongo, reason: "interval" })).toBe(
    1,
  );
  expect(await capability.getTriggerJobData?.(undefined, "interval", { mongo }))
    .toEqual({ type: "mediaRecognitionBatch" });
});
