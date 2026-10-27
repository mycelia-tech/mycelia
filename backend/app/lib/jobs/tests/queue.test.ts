import { expect } from "@std/expect";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { createWorker, enqueueJob, getJob, getQueue } from "../queue.ts";
import { ObjectId } from "bson";
import { schema as VadJobDataSchema } from "#/workers/vad.ts";
import type { z } from "zod";
import "./fixtures.ts";

type VadJobDataInput = z.input<typeof VadJobDataSchema>;

Deno.test(
  "BullMQ worker concurrency is effective immediately",
  withFixtures(["JobQueue"], async () => {
    const worker = createWorker(
      `test-concurrency-${new ObjectId().toString()}`,
      async () => ({ success: true }),
      2,
    );
    try {
      expect(worker.concurrency).toBe(2);
      worker.concurrency = 4;
      expect(worker.concurrency).toBe(4);
    } finally {
      // The assertions above intentionally run before asynchronous startup.
      // Let the lazy blocking Redis connection finish opening before teardown:
      // closing it on the same tick otherwise rejects its pending connect().
      try {
        await worker.waitUntilReady();
      } finally {
        await worker.close();
      }
    }
  }),
);

Deno.test(
  "enqueueJob creates job with ObjectId",
  withFixtures(["JobQueue", "Mongo"], async () => {
    const jobData: VadJobDataInput = {
      type: "vad",
      limit: 100,
    };

    const job = await enqueueJob(jobData as any);

    expect(job.id).toBeDefined();
    expect(ObjectId.isValid(job.id!)).toBe(true);
    expect(job.data.type).toBe("vad");
    expect(job.data.limit).toBe(100);
    expect(job.data.batchSize).toBe(100);
    // VAD runs on the Python worker; only routed STT/LLM jobs get an
    // automatically resolved provider snapshot.
    expect(job.data.routingContext).toBeUndefined();
  }),
);

Deno.test(
  "enqueueJob accepts custom jobId",
  withFixtures(["JobQueue", "Mongo"], async () => {
    // const customId = new ObjectId().toString();
    // const jobData: VadJobDataInput = {
    //   type: "vad",
    //   limit: 100,
    // };

    // const job = await enqueueJob(jobData, { jobId: customId });

    // expect(job.id).toBe(customId);
  }),
);

Deno.test(
  "enqueueJob sets priority",
  withFixtures(["JobQueue", "Mongo"], async () => {
    const jobData: VadJobDataInput = {
      type: "vad",
      limit: 100,
    };

    const job = await enqueueJob(jobData, { priority: 5 });

    expect(job.opts.priority).toBe(5);
  }),
);

Deno.test(
  "getQueue returns queue for job type",
  withFixtures(["JobQueue"], async () => {
    const vadQueue = getQueue("vad");

    expect(vadQueue).toBeDefined();
    expect(vadQueue.name).toBe("jobs-vad");
  }),
);

Deno.test(
  "getQueue returns same instance for same type",
  withFixtures(["JobQueue"], async () => {
    const vadQueue1 = getQueue("vad");
    const vadQueue2 = getQueue("vad");

    expect(vadQueue1).toBe(vadQueue2);
  }),
);

Deno.test(
  "getJob retrieves enqueued job",
  withFixtures(["JobQueue", "Mongo"], async () => {
    const jobData: VadJobDataInput = {
      type: "vad",
      limit: 100,
    };

    const enqueuedJob = await enqueueJob(jobData);
    const retrievedJob = await getJob("vad", enqueuedJob.id!);

    expect(retrievedJob).toBeDefined();
    expect(retrievedJob?.id).toBe(enqueuedJob.id);
    expect(retrievedJob?.data.type).toBe("vad");
    expect(retrievedJob?.data.limit).toBe(100);
    expect(retrievedJob?.data.batchSize).toBe(100);
    expect(retrievedJob?.data).toEqual(enqueuedJob.data);
  }),
);

Deno.test(
  "getJob returns null for non-existent job",
  withFixtures(["JobQueue"], async () => {
    const fakeId = new ObjectId().toString();
    const job = await getJob("vad", fakeId);

    expect(job).toBeNull();
  }),
);

Deno.test(
  "enqueued job has correct default options",
  withFixtures(["JobQueue", "Mongo"], async () => {
    const jobData: VadJobDataInput = {
      type: "vad",
      limit: 100,
    };

    const job = await enqueueJob(jobData as any);

    expect(job.opts.attempts).toBe(1);
  }),
);

Deno.test(
  "multiple job types use separate queues",
  withFixtures(["JobQueue", "Mongo"], async () => {
    const vadData: VadJobDataInput = {
      type: "vad",
      limit: 100,
    };

    const vadJob = await enqueueJob(vadData);

    const vadQueue = getQueue("vad");
    const transcriptionQueue = getQueue("transcription");

    expect(vadQueue.name).toBe("jobs-vad");
    expect(transcriptionQueue.name).toBe("jobs-transcription");
    expect(vadQueue).not.toBe(transcriptionQueue);

    const retrievedVadJob = await getJob("vad", vadJob.id!);
    expect(retrievedVadJob).toBeDefined();

    const notInTranscriptionQueue = await getJob("transcription", vadJob.id!);
    expect(notInTranscriptionQueue).toBeNull();
  }),
);
