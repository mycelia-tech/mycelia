import { expect } from "@std/expect";
import type { Db } from "mongodb";
import {
  collectTimelineDensityWriteDays,
  withTimelineDensityWrite,
} from "./density-write.ts";

function database(oldDays: string[] = [], beforeRead?: () => void) {
  const queries: Array<{ collection: string; pipeline: any[]; options: any }> =
    [];
  const db = {
    collection: (collection: string) => ({
      aggregate(pipeline: any[], options: any) {
        beforeRead?.();
        queries.push({ collection, pipeline, options });
        return {
          toArray: () =>
            Promise.resolve(
              oldDays.map((day) => ({ _id: new Date(day) })),
            ),
        };
      },
    }),
  } as unknown as Db;
  return { db, queries };
}

const dates = (days: Date[]) => days.map((day) => day.toISOString());

Deno.test("bulk ingestion invalidates unique UTC days without reading audio", async () => {
  const { db, queries } = database();
  const days = await collectTimelineDensityWriteDays(db, {
    action: "bulkWrite",
    collection: "audio_chunks",
    operations: [
      "2026-09-29T22:01:00Z",
      "2026-09-30T00:01:00Z",
      "2026-09-30T01:00:00Z",
    ].map((start, index) => ({
      updateOne: {
        filter: { original_id: "source", index },
        update: {
          $setOnInsert: { start: new Date(start), data: new Uint8Array(3) },
        },
        upsert: true,
      },
    })),
  });
  expect(dates(days)).toEqual([
    "2026-09-29T00:00:00.000Z",
    "2026-09-30T00:00:00.000Z",
  ]);
  expect(queries).toHaveLength(0);
});

Deno.test("timestamp moves preserve old and new days while VAD bulk reads once", async () => {
  const { db, queries } = database(["2026-08-01T00:00:00Z"]);
  const operations = Array.from({ length: 50 }, (_, index) => ({
    updateOne: {
      filter: { _id: index },
      update: { $set: { "vad.has_speech": true, "vad.prob": 0.8 } },
    },
  }));
  const days = await collectTimelineDensityWriteDays(db, {
    action: "bulkWrite",
    collection: "audio_chunks",
    operations: [...operations, {
      updateOne: {
        filter: { _id: "moved" },
        update: { $set: { start: new Date("2026-09-30T09:00:00Z") } },
      },
    }],
  });
  expect(dates(days)).toEqual([
    "2026-08-01T00:00:00.000Z",
    "2026-09-30T00:00:00.000Z",
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0].collection).toBe("audio_chunks");
  expect(queries[0].pipeline[0].$match.$or).toHaveLength(51);
  expect(queries[0].pipeline.some((stage) => stage.$group)).toBe(true);
  expect(queries[0].options.maxTimeMS).toBeGreaterThan(0);
});

Deno.test("deletions and parent VAD removal invalidate existing days", async () => {
  for (
    const mutation of [
      {
        action: "deleteMany",
        collection: "transcriptions",
        query: { original: "source" },
      },
      {
        action: "updateMany",
        collection: "audio_chunks",
        query: { original_id: "source" },
        update: { $unset: { vad: "" } },
      },
    ]
  ) {
    const { db } = database(["2026-09-30T00:00:00Z"]);
    expect(dates(await collectTimelineDensityWriteDays(db, mutation))).toEqual([
      "2026-09-30T00:00:00.000Z",
    ]);
  }
});

Deno.test("bookkeeping and transcript text changes do not schedule density", async () => {
  const { db, queries } = database();
  for (const collection of ["audio_chunks", "transcriptions"]) {
    expect(
      await collectTimelineDensityWriteDays(db, {
        action: "updateMany",
        collection,
        query: {},
        update: {
          $set: {
            transcribed_at: new Date(),
            chunk_id: "chunk",
            "vad.ran_at": new Date(),
            text: "edited",
          },
        },
      }),
    ).toEqual([]);
  }
  expect(queries).toHaveLength(0);
});

Deno.test("unsupported computed timestamp writes fail before touching source", async () => {
  const { db } = database();
  let executed = false;
  await expect(withTimelineDensityWrite(db, {
    action: "updateOne",
    collection: "audio_chunks",
    query: { _id: "chunk" },
    update: { $currentDate: { start: true } },
  }, async () => {
    executed = true;
  }, {
    begin: async (_db, days) => ({ id: "intent", days }),
    extend: async () => {},
    finish: async () => {},
  })).rejects.toThrow("start");
  expect(executed).toBe(false);
});

Deno.test("failed source writes retain the durable intent until expiry recovery", async () => {
  const { db } = database();
  const events: string[] = [];
  const failure = new Error("partial bulk write");
  await expect(withTimelineDensityWrite(db, {
    action: "insertMany",
    collection: "transcriptions",
    docs: [{ start: new Date("2026-09-30T12:00:00Z") }],
  }, async () => {
    events.push("write");
    throw failure;
  }, {
    async begin(_db, days) {
      events.push("begin");
      expect(days).toEqual([]);
      return { id: "intent", days };
    },
    async extend(_db, _intent, days) {
      events.push("extend");
      expect(dates(days)).toEqual(["2026-09-30T00:00:00.000Z"]);
    },
    async finish(_db, intent) {
      expect(intent.id).toBe("intent");
      events.push("finish");
    },
  })).rejects.toBe(failure);
  expect(events).toEqual(["begin", "extend", "write"]);
});

Deno.test("confirmed source success survives a failed intent settlement", async () => {
  const { db } = database();
  const result = { insertedId: "saved" };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    expect(
      await withTimelineDensityWrite(
        db,
        {
          action: "insertOne",
          collection: "transcriptions",
          doc: { start: new Date("2026-09-30T12:00:00Z") },
        },
        async () => result,
        {
          begin: async (_db, days) => ({ id: "intent", days }),
          extend: async () => {},
          finish: async () => {
            throw new Error("settlement unavailable");
          },
        },
      ),
    ).toBe(result);
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("stale intent responses cannot start a source write without a full safety window", async () => {
  const { db } = database();
  const events: string[] = [];
  await expect(withTimelineDensityWrite(db, {
    action: "insertOne",
    collection: "audio_chunks",
    doc: { start: new Date("2026-09-30T12:00:00Z") },
  }, async () => {
    events.push("write");
  }, {
    begin: async (_db, days) => ({
      id: "intent",
      days,
      expiresAt: new Date(Date.now() + 90_000),
    }),
    extend: async () => {},
    finish: async () => {
      events.push("finish");
    },
  })).rejects.toThrow("intent");
  expect(events).toEqual(["finish"]);
});

Deno.test("replacement moves and query-derived upserts retain every affected day", async () => {
  const { db } = database(["2026-08-01T00:00:00Z"]);
  const days = await collectTimelineDensityWriteDays(db, {
    action: "bulkWrite",
    collection: "transcriptions",
    operations: [
      {
        replaceOne: {
          filter: { _id: "old" },
          replacement: { start: new Date("2026-09-30T23:00:00Z") },
        },
      },
      {
        updateOne: {
          filter: { start: { $eq: new Date("2026-09-29T12:00:00Z") } },
          update: { $set: { text: "created" } },
          upsert: true,
        },
      },
    ],
  });
  expect(dates(days)).toEqual([
    "2026-08-01T00:00:00.000Z",
    "2026-09-29T00:00:00.000Z",
    "2026-09-30T00:00:00.000Z",
  ]);
});

Deno.test("failed durable intent prevents source writes and successful settlement preserves the result", async () => {
  const { db } = database();
  const input = {
    action: "insertOne",
    collection: "audio_chunks",
    doc: { start: new Date("2026-09-30T12:00:00Z") },
  };
  let executed = false;
  const execute = async () => {
    executed = true;
    return { insertedId: "chunk" };
  };
  await expect(withTimelineDensityWrite(db, input, execute, {
    begin: async () => {
      throw new Error("queue unavailable");
    },
    extend: async () => {},
    finish: async () => {},
  })).rejects.toThrow("queue unavailable");
  expect(executed).toBe(false);
  expect(
    await withTimelineDensityWrite(db, input, execute, {
      begin: async (_db, days) => ({ id: "intent", days }),
      extend: async () => {},
      finish: async () => {},
    }),
  ).toEqual({ insertedId: "chunk" });
  expect(executed).toBe(true);
});

Deno.test("broad source mutation holds a barrier before reading preimages", async () => {
  let active = false;
  const events: string[] = [];
  const { db } = database(["2026-09-30T00:00:00Z"], () => {
    events.push("preimage");
    expect(active).toBe(true);
  });
  await withTimelineDensityWrite(db, {
    action: "deleteMany",
    collection: "audio_chunks",
    query: { original_id: "source" },
  }, async () => {
    events.push("write");
  }, {
    async begin(_db, days) {
      expect(days).toEqual([]);
      active = true;
      events.push("begin");
      return { id: "intent", days };
    },
    async extend(_db, intent, days) {
      expect(dates(intent.days)).toEqual(["2026-09-30T00:00:00.000Z"]);
      expect(days).toEqual(intent.days);
      events.push("extend");
    },
    async finish() {
      active = false;
      events.push("finish");
    },
  });
  expect(events).toEqual(["begin", "preimage", "extend", "write", "finish"]);
  expect(active).toBe(false);
});

Deno.test("preimage failure releases the barrier without mutating source", async () => {
  const events: string[] = [];
  const { db } = database([], () => {
    throw new Error("preimage timeout");
  });
  await expect(withTimelineDensityWrite(db, {
    action: "deleteMany",
    collection: "transcriptions",
    query: {},
  }, async () => {
    events.push("write");
  }, {
    async begin(_db, days) {
      events.push("begin");
      return { id: "intent", days };
    },
    async extend() {
      events.push("extend");
    },
    async finish(_db, intent) {
      expect(intent.days).toEqual([]);
      events.push("finish");
    },
  })).rejects.toThrow("preimage timeout");
  expect(events).toEqual(["begin", "finish"]);
});

Deno.test("bookkeeping updates bypass the durable barrier", async () => {
  const { db } = database([], () => {
    throw new Error("unexpected preimage read");
  });
  const result = await withTimelineDensityWrite(
    db,
    {
      action: "bulkWrite",
      collection: "audio_chunks",
      operations: [{
        updateMany: {
          filter: {},
          update: { $set: { transcribed_at: new Date() } },
        },
      }],
    },
    async () => "written",
    {
      begin: async () => {
        throw new Error("unexpected intent");
      },
      extend: async () => {
        throw new Error("unexpected extension");
      },
      finish: async () => {
        throw new Error("unexpected settlement");
      },
    },
  );
  expect(result).toBe("written");
});
