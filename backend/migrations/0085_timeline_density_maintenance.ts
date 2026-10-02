import type { Db } from "mongodb";
import {
  ensureCollectionExists,
  ensureIndexExists,
} from "@/utils/migrations.ts";
import {
  TIMELINE_DENSITY_PENDING,
  TIMELINE_DENSITY_RECEIPTS,
  TIMELINE_DENSITY_STATE,
  TIMELINE_DENSITY_WRITES,
} from "@/lib/timeline/density-maintenance.ts";

export async function up(db: Db): Promise<void> {
  for (
    const collection of [
      TIMELINE_DENSITY_PENDING,
      TIMELINE_DENSITY_WRITES,
      TIMELINE_DENSITY_RECEIPTS,
      TIMELINE_DENSITY_STATE,
    ]
  ) {
    await ensureCollectionExists(db, collection);
  }
  await ensureIndexExists(db, TIMELINE_DENSITY_PENDING, { firstQueuedAt: 1 }, {
    name: "density_pending_order",
  });
  await ensureIndexExists(db, TIMELINE_DENSITY_WRITES, { expiresAt: 1 }, {
    name: "density_write_recovery",
  });
  await ensureIndexExists(db, TIMELINE_DENSITY_RECEIPTS, { verifiedAt: 1 }, {
    name: "density_verified_updates",
  });
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
    await ensureIndexExists(db, collection, { start: 1 }, { name: "start_1" });
    if (collection.startsWith("histogram_")) {
      await ensureIndexExists(db, collection, { stale: 1, start: 1 }, {
        name: "density_stale_dates",
        partialFilterExpression: { stale: true },
      });
    }
  }
}

export async function down(_db: Db): Promise<void> {
  // Pending work and verification receipts survive rollback.
}
