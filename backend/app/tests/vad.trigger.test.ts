// Set DENO_ENV to test to use shorter debounce
Deno.env.set("DENO_ENV", "test");

import { expect } from "@std/expect";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { triggerManager } from "@/lib/jobs/trigger-manager.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { delay } from "@std/async/delay";
import { redis } from "@/lib/redis.ts";

Deno.test(
  "VAD Trigger - should trigger VAD job when receiving Redis insert event",
  withFixtures([
    "Admin",
    "Mongo",
    "Migrations",
  ], async (admin) => {
    // Start only the VAD trigger worker (mocking the change stream via Redis)
    await triggerManager.start();

    try {
      const mongoResource = await getMongoResource(admin);

      // 1. Manually insert a chunk into Mongo (so checkAndTriggerVad finds it)
      console.log("[Test] Inserting audio chunk into DB...");
      await mongoResource({
        action: "insertOne",
        collection: "audio_chunks",
        doc: {
          index: 0,
          start: new Date(),
          data: new Uint8Array([0, 1, 2, 3]),
          // vad is missing
        },
      });

      // 2. Mock the Change Stream event by publishing to Redis directly
      console.log("[Test] Mocking Change Stream event via Redis publish...");
      const channel = "mycelia:mongo:audio_chunks";
      const payload = {
        event: "mongo.change",
        data: {
          operationType: "insert",
          document: {
            // The worker only checks if 'vad' is missing
          }
        },
        timestamp: new Date().toISOString()
      };
      await redis.publish(channel, JSON.stringify(payload));

      // 3. Wait within a bounded budget for debounce and indexed discovery.
      console.log("[Test] Waiting for VAD trigger...");
      let job;
      const deadline = performance.now() + 5000;
      do {
        job = await mongoResource({
          action: "findOne",
          collection: "jobs",
          query: { type: "vad" },
        });
        if (job) break;
        await delay(50);
      } while (performance.now() < deadline);
      
      expect(job).not.toBeNull();
      if (job) {
        expect(job.type).toBe("vad");
        expect(job.trigger.reason).toBe("auto_new_chunks");
        expect(job.trigger.type).toBe("auto");
        expect(job.trigger.principal).toBe("server");
        expect(job.state).toBe("waiting");
        console.log("[Test] VAD job successfully triggered and found in DB:", job._id);
      }

      // 5. Test debounce and "job already exists" logic
      console.log("[Test] Mocking second insert event (should not trigger new job)...");
      await redis.publish(channel, JSON.stringify(payload));

      await delay(500);
      const jobsCount = await mongoResource({
        action: "count",
        collection: "jobs",
        query: { type: "vad" },
      });
      expect(jobsCount).toBe(1);
      console.log("[Test] Correctly skipped trigger for second event as job already exists.");

    } finally {
      // Cleanup worker
      console.log("[Test] Stopping worker...");
      await triggerManager.stop();
    }
  }),
);

