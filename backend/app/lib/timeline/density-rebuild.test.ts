import { expect } from "@std/expect";
import { type Auth, defaultResourceManager } from "@/lib/auth/index.ts";
import { MongoResource } from "@/lib/mongo/core.server.ts";
import type { Db } from "mongodb";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { rebuildTimelineDensityDay } from "./density-rebuild.ts";
import {
  updateAllHistogram,
  updateHistogram,
} from "#/workers/histRecalculation.ts";

const resolutions = ["5min", "1hour", "1day", "1week"] as const;
const day = new Date("2026-08-19T00:00:00.000Z");

function withDensityFixture(
  run: (auth: Auth, fixture: { db: Db }) => Promise<void>,
) {
  return withFixtures(
    ["Admin", "Mongo"],
    async (auth: Auth, { db }: { db: Db }) => {
      // A fresh Docker replica set can exceed the generic fixture's one-second
      // operation timeout while creating indexes. Keep these integration tests
      // isolated, with the same bounded timeout as the rebuild itself.
      const isolatedDB = db.client.db(db.databaseName, { timeoutMS: 30_000 });
      const resource = new MongoResource();
      resource.getRootDB = async () => isolatedDB;
      defaultResourceManager.registerResource(resource);
      await run(auth, { db: isolatedDB });
    },
  );
}

async function setup(db: Db) {
  for (
    const collection of [
      "audio_chunks",
      "transcriptions",
      ...resolutions.map((resolution) => `histogram_${resolution}`),
    ]
  ) {
    await db.collection(collection).createIndex({ start: 1 });
  }
}

async function totals(db: Db, resolution: string, start: Date, end: Date) {
  const rows = await db.collection(`histogram_${resolution}`).find({
    start: { $gte: start, $lt: end },
  }).toArray();
  return rows.reduce((sum, row) => ({
    audio: sum.audio + Number(row.totals?.audio_chunks?.count ?? 0),
    transcripts: sum.transcripts +
      Number(row.totals?.transcriptions?.count ?? 0),
  }), { audio: 0, transcripts: 0 });
}

Deno.test(
  "automatic density bounds raw VAD reads to an hour without losing boundary counts",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    const end = new Date("2026-08-20T00:00:00.000Z");
    const starts = [
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:59:59.999Z",
      "2026-08-19T01:00:00.000Z",
      "2026-08-19T01:59:59.999Z",
      "2026-08-19T02:00:00.000Z",
      "2026-08-19T11:59:59.999Z",
      "2026-08-19T12:00:00.000Z",
      "2026-08-19T23:59:59.999Z",
    ];
    await db.collection("audio_chunks").insertMany(starts.map((start) => ({
      start: new Date(start),
      vad: { prob: 0.75, has_speech: true },
    })));
    await db.collection("transcriptions").insertMany([
      "2026-08-19T00:59:59.999Z",
      "2026-08-19T01:00:00.000Z",
      "2026-08-19T12:00:00.000Z",
      "2026-08-19T23:59:59.999Z",
    ].map((start) => ({ start: new Date(start), text: "boundary" })));
    // The parent week must retain a previously built neighbouring day.
    await db.collection("histogram_1day").insertOne({
      start: new Date("2026-08-18T00:00:00.000Z"),
      totals: { audio_chunks: { count: 3 }, transcriptions: { count: 2 } },
    });
    const mongo = auth.getResource("mongo");
    const rawWindows: Array<{ start: Date; end: Date }> = [];
    const recordingAuth = Object.create(auth) as Auth;
    recordingAuth.getResource = ((code: string) =>
      code === "mongo"
        ? async (input: any) => {
          if (
            input.action === "aggregate" &&
            input.collection === "audio_chunks" &&
            input.pipeline.some((stage: any) =>
              stage.$group
            )
          ) {
            const range = input.pipeline[0].$match.start;
            rawWindows.push({ start: range.$gte, end: range.$lt });
          }
          return await mongo(input);
        }
        : auth.getResource(code)) as Auth["getResource"];

    expect(await rebuildTimelineDensityDay(recordingAuth, day))
      .toEqual({ audio_chunks: 8, transcriptions: 4 });
    expect(rawWindows.length).toBeGreaterThan(1);
    for (const window of rawWindows) {
      expect(window.end.getTime() - window.start.getTime())
        .toBeLessThanOrEqual(3_600_000);
      expect(window.start.getTime() % 300_000).toBe(0);
      expect(window.end.getTime() % 300_000).toBe(0);
    }
    for (const resolution of ["5min", "1hour", "1day"]) {
      expect(await totals(db, resolution, day, end))
        .toEqual({ audio: 8, transcripts: 4 });
    }
    expect(
      await totals(
        db,
        "1week",
        new Date("2026-08-13T00:00:00.000Z"),
        end,
      ),
    ).toEqual({ audio: 11, transcripts: 6 });

    rawWindows.length = 0;
    await updateAllHistogram(recordingAuth, day, end);
    expect(rawWindows).toEqual([{ start: day, end }]);
  }),
);

Deno.test(
  "daily density creates every resolution for a previously empty day",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    await db.collection("audio_chunks").insertMany([
      {
        start: new Date("2026-08-19T00:00:00.000Z"),
        vad: { prob: 0.8, has_speech: true },
      },
      {
        start: new Date("2026-08-19T23:59:59.999Z"),
        vad: { prob: 0.2, has_speech: false },
      },
    ]);
    await db.collection("transcriptions").insertOne({
      start: new Date("2026-08-19T12:15:00.000Z"),
      text: "hello",
    });

    expect(await rebuildTimelineDensityDay(auth, day))
      .toEqual({ audio_chunks: 2, transcriptions: 1 });

    for (const resolution of resolutions) {
      expect(
        await totals(
          db,
          resolution,
          new Date("2026-08-13T00:00:00.000Z"),
          new Date("2026-08-20T00:00:00.000Z"),
        ),
      ).toEqual({ audio: 2, transcripts: 1 });
    }
  }),
);

Deno.test(
  "daily density removes deleted-source ghosts while preserving adjacent days and weeks",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    await db.collection("audio_chunks").insertMany([
      { start: new Date("2026-08-18T10:00:00.000Z") },
      { start: new Date("2026-08-19T10:00:00.000Z") },
      { start: new Date("2026-08-20T10:00:00.000Z") },
    ]);
    await db.collection("transcriptions").insertOne({
      start: new Date("2026-08-19T10:00:00.000Z"),
      text: "deleted later",
    });
    await rebuildTimelineDensityDay(auth, new Date("2026-08-18T00:00:00.000Z"));
    await rebuildTimelineDensityDay(auth, new Date("2026-08-20T00:00:00.000Z"));
    await rebuildTimelineDensityDay(auth, day);
    const nextWeek = await db.collection("histogram_1week").findOne({
      start: new Date("2026-08-20T00:00:00.000Z"),
    });

    await db.collection("transcriptions").deleteMany({});
    await rebuildTimelineDensityDay(auth, day);
    expect(await totals(db, "1day", day, new Date("2026-08-20T00:00:00.000Z")))
      .toEqual({ audio: 1, transcripts: 0 });

    await db.collection("audio_chunks").deleteMany({
      start: { $gte: day, $lt: new Date("2026-08-20T00:00:00.000Z") },
    });
    await rebuildTimelineDensityDay(auth, day);
    for (const resolution of ["5min", "1hour", "1day"]) {
      expect(
        await totals(db, resolution, day, new Date("2026-08-20T00:00:00.000Z")),
      )
        .toEqual({ audio: 0, transcripts: 0 });
    }
    expect(
      await totals(
        db,
        "1week",
        new Date("2026-08-13T00:00:00.000Z"),
        new Date("2026-08-20T00:00:00.000Z"),
      ),
    )
      .toEqual({ audio: 1, transcripts: 0 });
    expect(
      await db.collection("histogram_1week").findOne({
        start: new Date("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual(nextWeek);
  }),
);

Deno.test(
  "daily density rejects verification when source counts change during rebuild",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    await db.collection("audio_chunks").insertOne({
      start: new Date("2026-08-19T10:00:00.000Z"),
    });
    const mongo = auth.getResource("mongo");
    let inserted = false;
    const racingAuth = Object.create(auth) as Auth;
    racingAuth.getResource = (() => async (input: any) => {
      const result = await mongo(input);
      if (
        !inserted && input.action === "bulkWrite" &&
        input.collection === "histogram_1hour"
      ) {
        inserted = true;
        await db.collection("audio_chunks").insertOne({
          start: new Date("2026-08-19T11:00:00.000Z"),
        });
      }
      return result;
    }) as Auth["getResource"];

    await expect(rebuildTimelineDensityDay(racingAuth, day)).rejects.toThrow(
      "Timeline density verification failed",
    );
    await rebuildTimelineDensityDay(auth, day);
    expect(await totals(db, "1day", day, new Date("2026-08-20T00:00:00.000Z")))
      .toEqual({ audio: 2, transcripts: 0 });
  }),
);

Deno.test(
  "histogram batching never overwrites a shared day with only its second half",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    await db.collection("audio_chunks").insertMany([
      { start: new Date("2026-02-07T01:00:00.000Z") },
      { start: new Date("2026-02-07T13:00:00.000Z") },
    ]);
    await updateAllHistogram(
      auth,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-09T00:00:00.000Z"),
    );
    expect(
      await totals(
        db,
        "1day",
        new Date("2026-02-07T00:00:00.000Z"),
        new Date("2026-02-08T00:00:00.000Z"),
      ),
    )
      .toEqual({ audio: 2, transcripts: 0 });
  }),
);

Deno.test(
  "histogram source batching does not write bins after the requested end",
  withDensityFixture(async (auth: Auth, { db }: { db: Db }) => {
    await setup(db);
    await db.collection("audio_chunks").insertOne({
      start: new Date("2026-08-20T12:00:00.000Z"),
    });
    await updateHistogram(
      auth,
      day,
      new Date("2026-08-20T00:05:00.000Z"),
      "5min",
    );
    expect(await db.collection("histogram_5min").countDocuments()).toBe(0);
  }),
);
