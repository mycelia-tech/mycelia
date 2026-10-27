import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  ACCESS_LOG_BATCH_SIZE,
  ACCESS_LOG_GROUP,
  ACCESS_LOG_STREAM,
  type AccessLogEntry,
  type AccessLogPersistence,
  accessLogRetentionId,
  persistAccessLogBatch,
  readAccessLogBatch,
  type StoredAccessLog,
} from "./accessLog.persistence.ts";

Deno.test("access log retention boundary validates an inclusive exact stream ID", () => {
  equal(accessLogRetentionId(undefined), "0-0");
  equal(accessLogRetentionId(""), "0-0");
  equal(accessLogRetentionId("1793116438559-4323"), "1793116438559-4323");
  equal(
    accessLogRetentionId("18446744073709551615-0"),
    "18446744073709551615-0",
  );
  for (const value of ["-1-0", "001-0", "123", "1-*", " 1-0", "1-0\n"]) {
    throws(() => accessLogRetentionId(value));
  }
});

function entry(
  id = "1000-0",
  actions = '[{"path":["objects"],"actions":["read"]}]',
): AccessLogEntry {
  return [id, [
    "principal",
    "test",
    "resource",
    "mongo",
    "actions",
    actions,
    "timestamp",
    "2026-10-28T00:00:00Z",
  ]];
}

function storage() {
  const saved = new Map<string, StoredAccessLog>();
  const events: string[] = [];
  const acknowledged: string[][] = [];
  const sink: AccessLogPersistence = {
    persist: async (collection, documents) => {
      events.push(collection);
      for (const document of documents) {
        const key = `${collection}/${document._id}`;
        if (!saved.has(key)) saved.set(key, document);
      }
    },
    acknowledge: async (ids) => {
      events.push("ack");
      acknowledged.push(ids);
    },
  };
  return { saved, events, acknowledged, sink };
}

Deno.test("access log batch persists valid and invalid events before acknowledging their exact IDs", async () => {
  const state = storage();
  await persistAccessLogBatch([
    entry("1000-0"),
    entry("1000-1", "invalid private payload"),
  ], state.sink);
  deepStrictEqual(state.events, ["access_logs", "access_logs_failed", "ack"]);
  deepStrictEqual(state.acknowledged, [["1000-0", "1000-1"]]);
  const valid = state.saved.get("access_logs/redis:access_logs:1000-0")!;
  deepStrictEqual(valid.actions, [{ path: ["objects"], actions: ["read"] }]);
  equal((valid.timestamp as Date).toISOString(), "2026-10-28T00:00:00.000Z");
  const failed = state.saved.get(
    "access_logs_failed/redis:access_logs:1000-1",
  )!;
  equal(failed.messageId, "1000-1");
  equal(failed.error, "Invalid access log fields");
  equal(
    (failed.rawMessage as Record<string, string>).actions,
    "invalid private payload",
  );
});

Deno.test("Mongo write failure leaves every stream ID pending, including partial unordered writes", async () => {
  const state = storage();
  await rejects(persistAccessLogBatch([entry(), entry("1000-1")], {
    ...state.sink,
    persist: async (collection, documents) => {
      await state.sink.persist(collection, documents.slice(0, 1));
      throw new Error("Mongo unavailable after partial write");
    },
  }));
  deepStrictEqual(state.acknowledged, []);
  await persistAccessLogBatch([entry(), entry("1000-1")], state.sink);
  equal(state.saved.size, 2);
  deepStrictEqual(state.acknowledged, [["1000-0", "1000-1"]]);
});

Deno.test("quarantine write failure retains valid and invalid events for safe retry", async () => {
  const state = storage();
  const messages = [entry(), entry("1000-1", "bad")];
  await rejects(persistAccessLogBatch(messages, {
    ...state.sink,
    persist: async (collection, documents) => {
      if (collection === "access_logs_failed") {
        throw new Error("quarantine unavailable");
      }
      await state.sink.persist(collection, documents);
    },
  }));
  deepStrictEqual(state.acknowledged, []);
  await persistAccessLogBatch(messages, state.sink);
  equal(state.saved.size, 2);
  deepStrictEqual(state.acknowledged, [["1000-0", "1000-1"]]);
});

Deno.test("lost Redis acknowledgement response retries with the same Mongo identity", async () => {
  const state = storage();
  await rejects(persistAccessLogBatch([entry()], {
    ...state.sink,
    acknowledge: async () => {
      throw new Error("response lost");
    },
  }));
  await persistAccessLogBatch([entry()], state.sink);
  equal(state.saved.size, 1);
  deepStrictEqual(state.acknowledged, [["1000-0"]]);
});

Deno.test("missing or malformed stream data is durably quarantined with its original identity", async () => {
  const state = storage();
  const invalidTime = entry("1000-1");
  invalidTime[1]![7] = "not a timestamp";
  await persistAccessLogBatch([
    ["1000-0", null],
    invalidTime,
    entry("1000-2", "{}"),
    ["1000-3", ["orphan"]],
  ], state.sink);
  equal(state.saved.size, 4);
  equal(
    state.saved.get("access_logs_failed/redis:access_logs:1000-0")?.error,
    "Stream payload unavailable",
  );
  deepStrictEqual(
    state.saved.get("access_logs_failed/redis:access_logs:1000-3")?.rawFields,
    ["orphan"],
  );
  deepStrictEqual(state.events, ["access_logs_failed", "ack"]);
});

Deno.test("pending access logs are retried in bounded batches before requesting fresh entries", async () => {
  const commands: (string | number)[][] = [];
  const messages = [entry()];
  const result = await readAccessLogBatch(async (...args) => {
    commands.push(args);
    return [[ACCESS_LOG_STREAM, messages]];
  });
  deepStrictEqual(result, messages);
  equal(commands.length, 1);
  deepStrictEqual(commands[0].slice(-3), ["STREAMS", ACCESS_LOG_STREAM, "0"]);
  equal(commands[0][commands[0].indexOf("COUNT") + 1], ACCESS_LOG_BATCH_SIZE);
  equal(commands[0].includes("BLOCK"), false);
  equal(commands[0][2], ACCESS_LOG_GROUP);
});

Deno.test("empty pending set falls through to a bounded blocking read of new entries", async () => {
  const commands: (string | number)[][] = [];
  const encoder = new TextEncoder();
  const original = entry();
  const messages: AccessLogEntry[] = [[
    encoder.encode("1000-0"),
    original[1]!.map((value) => encoder.encode(String(value))),
  ]];
  const result = await readAccessLogBatch(async (...args) => {
    commands.push(args);
    return commands.length === 1
      ? [[ACCESS_LOG_STREAM, []]]
      : [[encoder.encode(ACCESS_LOG_STREAM), messages]];
  });
  const state = storage();
  await persistAccessLogBatch(result, state.sink);
  deepStrictEqual(state.acknowledged, [["1000-0"]]);
  equal(commands.length, 2);
  deepStrictEqual(commands[1].slice(-3), ["STREAMS", ACCESS_LOG_STREAM, ">"]);
  equal(commands[1][commands[1].indexOf("BLOCK") + 1], 5000);
  equal(commands[1][commands[1].indexOf("COUNT") + 1], ACCESS_LOG_BATCH_SIZE);
});

Deno.test("empty access log batches do not persist or acknowledge anything", async () => {
  const state = storage();
  await persistAccessLogBatch([], state.sink);
  deepStrictEqual(state.events, []);
});

Deno.test("access log action paths preserve both string and array resource contracts", async () => {
  const state = storage();
  await persistAccessLogBatch([
    entry("1000-0", '[{"path":"objects/*","actions":["read"]}]'),
    entry("1000-1"),
  ], state.sink);
  deepStrictEqual(state.events, ["access_logs", "ack"]);
  equal(state.saved.size, 2);
});
