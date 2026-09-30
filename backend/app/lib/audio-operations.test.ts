import { expect } from "@std/expect";
import {
  AUDIO_IMPORTS_INDEX,
  readAudioOperations,
  saveAudioOperations,
} from "./audio-operations.ts";

Deno.test("audio operations polling uses only capped indexed metadata reads", async () => {
  const calls: any[] = [];
  const result = await readAudioOperations(async (input) => {
    calls.push(input);
    return input.action === "find"
      ? [{ _id: "one", path: "/private/audio.m4a", ingested_at: new Date(0) }]
      : null;
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    action: "find",
    collection: "source_files",
    options: {
      limit: 5,
      hint: AUDIO_IMPORTS_INDEX,
      maxTimeMS: 1000,
      sort: { ingested_at: -1, _id: -1 },
    },
  });
  expect(calls[1]).toMatchObject({
    action: "findOne",
    query: { _id: "audio_operations:v1" },
    options: { maxTimeMS: 1000 },
  });
  expect(result.recentImports?.[0].name).toBe("audio.m4a");
  expect(result.recentImports?.[0]).not.toHaveProperty("path");
});

Deno.test("audio operations errors stay unknown without unindexed fallback", async () => {
  let calls = 0;
  const result = await readAudioOperations(() => {
    calls++;
    return Promise.reject(new Error("missing index"));
  });
  expect(calls).toBe(2);
  expect(result.recentImports).toBeNull();
  expect(result.snapshot).toBeNull();
  expect(result.warnings).toHaveLength(2);
});

Deno.test("partial counts cannot overwrite a previously complete snapshot with fallback zeros", async () => {
  const calls: any[] = [];
  const mongo = async (input: any) => {
    calls.push(input);
  };
  await saveAudioOperations(mongo, {
    warnings: ["timeout"],
    chunksAwaitingVad: 0,
  });
  expect(calls[0].update.$set.state).toBe("stale");
  expect(calls[0].update.$set).not.toHaveProperty("data");
  expect(calls[0].update.$set).not.toHaveProperty("asOf");
  await saveAudioOperations(mongo, {
    warnings: [],
    chunksAwaitingVad: 123,
    chunksVadProcessed: 7,
  });
  expect(calls[1].update.$set).toMatchObject({
    state: "ready",
    data: { vadPending: 123, vadProcessed: 7 },
  });
  expect(calls[1].options).toEqual({ upsert: true, maxTimeMS: 1000 });
});

Deno.test("unrelated job history failure does not discard valid core audio counts", async () => {
  const calls: any[] = [];
  const mongo = async (input: any) => {
    calls.push(input);
  };
  await saveAudioOperations(mongo, {
    warnings: ["history timeout"],
    chunksAwaitingVad: 12,
  }, ["pipeline job state"]);
  expect(calls[0].update.$set).toMatchObject({
    state: "ready",
    data: { vadPending: 12 },
  });
  await saveAudioOperations(mongo, { chunksAwaitingVad: 0 }, ["VAD coverage"]);
  expect(calls[1].update.$set).not.toHaveProperty("data");
});
