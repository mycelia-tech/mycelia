import { expect } from "@std/expect";
import type { Db } from "mongodb";
import type { Auth } from "@/lib/auth/index.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { up as migrateDensityMaintenance } from "#/migrations/0085_timeline_density_maintenance.ts";
import { withTimelineDensityWrite } from "./density-write.ts";
import {
  beginTimelineDensityWrite,
  completeTimelineDensityDay,
  type DensityDay,
  densityMongo,
  extendTimelineDensityWrite,
  failTimelineDensityDay,
  finishTimelineDensityWrite,
  getTimelineDensityMaintenance,
  pickTimelineDensityDay,
  queueTimelineDensityDays,
  recoverTimelineDensityWrites,
  TIMELINE_DENSITY_PENDING,
  TIMELINE_DENSITY_WRITES,
} from "./density-maintenance.ts";

Deno.test({
  name: "durable Timeline maintenance retains work across writes and restarts",
  // Reusable Testcontainers handles outlive individual Deno test scopes.
  // withFixtures owns cleanup of this test's isolated database and client.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await withFixtures(["Admin", "Mongo"], async (
      _auth: Auth,
      fixture: { db: Db },
    ) => {
      // Keep the existing reusable test server, with a bounded timeout that can
      // accommodate index creation on a busy VM instead of the fixture's 1s.
      const db = fixture.db.client.db(fixture.db.databaseName, {
        timeoutMS: 30_000,
      });
      // The fixture teardown must use the same bounded timeout as its writes.
      fixture.db = db;
      const mongo = densityMongo(db);
      const day = new Date("2026-09-01T00:00:00Z");
      const later = new Date(Date.now() + 10 * 60_000);
      const counts = { audio_chunks: 2, transcriptions: 1 };
      await t.step(
        "migration is additive and idempotent with existing start indexes",
        async () => {
          await db.collection("transcriptions").createIndex({ start: 1 }, {
            name: "transcriptions_start_1",
          });
          await migrateDensityMaintenance(db);
          await migrateDensityMaintenance(db);
          for (
            const collection of [
              "audio_chunks",
              "transcriptions",
              "histogram_5min",
              "histogram_1hour",
              "histogram_1day",
              "histogram_1week",
            ]
          ) {
            expect(
              (await db.collection(collection).indexes()).some((index) =>
                Object.keys(index.key).length === 1 && index.key.start === 1
              ),
            ).toBe(true);
          }
        },
      );
      await t.step(
        "expired intents cannot restart a source mutation",
        async () => {
          const intent = await beginTimelineDensityWrite(db, [day]);
          await db.collection(TIMELINE_DENSITY_WRITES).updateOne(
            { _id: intent.id } as any,
            { $set: { expiresAt: new Date(Date.now() - 1) } },
          );
          await expect(extendTimelineDensityWrite(db, intent, [day])).rejects
            .toThrow("expired before source mutation");
          await recoverTimelineDensityWrites(mongo);
          expect(
            await db.collection(TIMELINE_DENSITY_WRITES).countDocuments({}),
          ).toBe(0);
          expect(
            await db.collection(TIMELINE_DENSITY_PENDING).countDocuments({}),
          ).toBeGreaterThan(0);
          await db.collection(TIMELINE_DENSITY_PENDING).deleteMany({});
        },
      );
      await t.step(
        "new writes during rebuilding survive acknowledgement",
        async () => {
          await queueTimelineDensityDays(mongo, [day]);
          const first = (await pickTimelineDensityDay(mongo, later))!;
          expect(first.start).toEqual(day);
          await queueTimelineDensityDays(mongo, [day]);
          expect(await completeTimelineDensityDay(mongo, first, counts)).toBe(
            false,
          );
          const second = (await pickTimelineDensityDay(mongo, later))!;
          expect(second.revision).not.toBe(first.revision);
          expect(await completeTimelineDensityDay(mongo, second, counts)).toBe(
            true,
          );
          expect(await pickTimelineDensityDay(mongo, later)).toBeNull();
        },
      );
      await t.step(
        "in-flight source writes prevent premature completion",
        async () => {
          const intent = await beginTimelineDensityWrite(db, [day]);
          expect(
            await pickTimelineDensityDay(mongo, new Date(Date.now() + 60_000)),
          ).toBeNull();
          await finishTimelineDensityWrite(db, intent);
          const item = (await pickTimelineDensityDay(mongo, later))!;
          expect(item).not.toBeNull();
          await completeTimelineDensityDay(mongo, item, counts);
        },
      );
      await t.step(
        "abandoned intent is recovered and a late settlement still queues work",
        async () => {
          const intent = await beginTimelineDensityWrite(db, [day]);
          await recoverTimelineDensityWrites(mongo, later);
          const item = (await pickTimelineDensityDay(
            mongo,
            new Date(later.getTime() + 60_000),
          ))!;
          expect(item).not.toBeNull();
          await completeTimelineDensityDay(mongo, item, counts);
          await finishTimelineDensityWrite(db, intent);
          expect(
            await pickTimelineDensityDay(
              mongo,
              new Date(later.getTime() + 60_000),
            ),
          ).not.toBeNull();
        },
      );
      await t.step(
        "sparse dates stay separate and a burst coalesces by UTC day",
        async () => {
          const old = new Date("2020-01-01T02:00:00Z");
          await queueTimelineDensityDays(mongo, [
            old,
            new Date("2020-01-01T17:00:00Z"),
            day,
          ]);
          const status = await getTimelineDensityMaintenance(mongo);
          expect(status.pendingDays).toBe(2);
          expect(status.state).toBe("updating");
        },
      );
      await t.step(
        "real source writes persist only affected days and refresh revisions after deletion",
        async () => {
          await db.collection(TIMELINE_DENSITY_PENDING).deleteMany({});
          const audio = [
            {
              original_id: "ingestion",
              start: new Date("2026-08-19T23:59:59Z"),
            },
            {
              original_id: "ingestion",
              start: new Date("2026-08-20T00:00:00Z"),
            },
          ];
          await withTimelineDensityWrite(db, {
            action: "insertMany",
            collection: "audio_chunks",
            docs: audio,
          }, () => db.collection("audio_chunks").insertMany(audio));
          const pending = db.collection<DensityDay>(TIMELINE_DENSITY_PENDING);
          const first = await pending.findOne({
            _id: "2026-08-19T00:00:00.000Z",
          });
          expect(first).not.toBeNull();
          const transcription = {
            start: new Date("2026-08-19T23:59:59Z"),
            text: "saved",
          };
          await withTimelineDensityWrite(db, {
            action: "insertOne",
            collection: "transcriptions",
            doc: transcription,
          }, () => db.collection("transcriptions").insertOne(transcription));
          const second = await pending.findOne({ _id: first!._id });
          expect(second!.revision).not.toBe(first!.revision);
          const beforeDelete = await pending.find({}).sort({ start: 1 })
            .toArray();
          await withTimelineDensityWrite(
            db,
            {
              action: "deleteMany",
              collection: "audio_chunks",
              query: { original_id: "ingestion" },
            },
            () =>
              db.collection("audio_chunks").deleteMany({
                original_id: "ingestion",
              }),
          );
          const afterDelete = await pending.find({}).sort({ start: 1 })
            .toArray();
          expect(afterDelete.map((item) => item._id)).toEqual([
            "2026-08-19T00:00:00.000Z",
            "2026-08-20T00:00:00.000Z",
          ]);
          expect(
            afterDelete.every((item, index) =>
              item.revision !== beforeDelete[index].revision
            ),
          ).toBe(true);
          expect(
            await db.collection("audio_chunks").countDocuments({
              original_id: "ingestion",
            }),
          ).toBe(0);
          expect(await db.collection(TIMELINE_DENSITY_WRITES).countDocuments())
            .toBe(0);
        },
      );
      await t.step(
        "concurrent insertion stays pending when a broad delete missed its preimage",
        async () => {
          await db.collection(TIMELINE_DENSITY_PENDING).deleteMany({});
          let allowDelete!: () => void;
          let preimageRead!: () => void;
          const deleteReady = new Promise<void>((resolve) => {
            preimageRead = resolve;
          });
          const deleteAllowed = new Promise<void>((resolve) => {
            allowDelete = resolve;
          });
          const deletion = withTimelineDensityWrite(db, {
            action: "deleteMany",
            collection: "audio_chunks",
            query: { original_id: "concurrent" },
          }, async () => {
            preimageRead();
            await deleteAllowed;
            return await db.collection("audio_chunks").deleteMany({
              original_id: "concurrent",
            });
          });
          try {
            await Promise.race([deleteReady, deletion]);
            const audio = { original_id: "concurrent", start: day };
            await withTimelineDensityWrite(db, {
              action: "insertOne",
              collection: "audio_chunks",
              doc: audio,
            }, () => db.collection("audio_chunks").insertOne(audio));
            const inserted =
              (await db.collection<DensityDay>(TIMELINE_DENSITY_PENDING)
                .findOne({ _id: day.toISOString() }))!;
            expect(inserted).not.toBeNull();
            expect(
              await pickTimelineDensityDay(
                mongo,
                new Date(Date.now() + 60_000),
              ),
            ).toBeNull();
            expect(
              await completeTimelineDensityDay(mongo, inserted, {
                audio_chunks: 1,
                transcriptions: 0,
              }),
            ).toBe(false);
            expect(
              await db.collection(TIMELINE_DENSITY_PENDING).countDocuments(),
            ).toBe(1);
          } finally {
            allowDelete();
            await deletion;
          }
          expect(
            await db.collection("audio_chunks").countDocuments({
              original_id: "concurrent",
            }),
          ).toBe(0);
          const pending = (await pickTimelineDensityDay(
            mongo,
            new Date(Date.now() + 60_000),
          ))!;
          expect(pending).not.toBeNull();
          expect(
            await completeTimelineDensityDay(mongo, pending, {
              audio_chunks: 0,
              transcriptions: 0,
            }),
          ).toBe(true);
          expect(await db.collection(TIMELINE_DENSITY_PENDING).countDocuments())
            .toBe(0);
        },
      );
      await t.step(
        "failure backs off without losing the pending revision",
        async () => {
          const queuedAt = new Date();
          const failedAt = new Date(queuedAt.getTime() + 60_000);
          await queueTimelineDensityDays(mongo, [day], queuedAt);
          const pending = (await pickTimelineDensityDay(mongo, failedAt))!;
          await failTimelineDensityDay(
            mongo,
            pending,
            new Error("temporary rebuild failure"),
            failedAt,
          );
          const status = await getTimelineDensityMaintenance(mongo);
          expect(status.pendingDays).toBe(1);
          expect(status.state).toBe("retrying");
          expect(status.lastError).toBe("temporary rebuild failure");
          expect(
            await pickTimelineDensityDay(
              mongo,
              new Date(failedAt.getTime() + 10_000),
            ),
          ).toBeNull();
          const retry = (await pickTimelineDensityDay(
            mongo,
            new Date(failedAt.getTime() + 31_000),
          ))!;
          expect(retry.revision).toBe(pending.revision);
          expect(retry.attempts).toBe(1);
          expect(await completeTimelineDensityDay(mongo, retry, counts)).toBe(
            true,
          );
          expect((await getTimelineDensityMaintenance(mongo)).pendingDays).toBe(
            0,
          );
        },
      );
    })();
  },
});
