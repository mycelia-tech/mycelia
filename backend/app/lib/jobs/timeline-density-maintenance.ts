import { getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { enqueueJob, getQueue } from "./queue.ts";
import {
  pickTimelineDensityDay,
  recoverTimelineDensityWrites,
} from "@/lib/timeline/density-maintenance.ts";

let reconciling = false;

/** Pending days are canonical; lost queue jobs are recreated on the next tick. */
export async function reconcileAutomaticTimelineDensity(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const auth = await getServerAuth();
    const mongo = await getMongoResource(auth);
    await recoverTimelineDensityWrites(mongo);
    const queue = getQueue("histRecalculation");
    if (await queue.isPaused()) return;
    const counts = await queue.getJobCounts(
      "active",
      "waiting",
      "delayed",
      "prioritized",
    );
    if (Object.values(counts).some((count) => count > 0)) return;
    const day = await pickTimelineDensityDay(mongo);
    if (!day) return;
    await enqueueJob({
      type: "histRecalculation",
      automaticDensity: true,
      start: day.start,
    }, {
      priority: 20,
      trigger: { type: "auto", reason: `timeline_density:${day._id}` },
    }, auth);
  } catch (error) {
    console.error(
      "[timeline-density] Automatic maintenance will retry:",
      error,
    );
  } finally {
    reconciling = false;
  }
}
