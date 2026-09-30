import { expect } from "@std/expect";
import { Auth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { SpeakerSegmentsResource } from "./resource.server.ts";

const MARCH_START = new Date("2024-03-01T00:00:00.000Z");
const MARCH_END = new Date("2024-03-02T00:00:00.000Z");

/**
 * `legacy-v0` records the range that existed when migration 0035 ran, but the
 * missing-diarization path keeps appending segments to that same run, so its
 * recorded range goes stale immediately.
 */
Deno.test(
  "activation supersedes legacy segments recorded after the legacy run's range",
  withFixtures(["Admin", "Mongo", "Migrations"], async (auth: Auth) => {
    const mongo = await getMongoResource(auth);
    await mongo({
      action: "insertMany",
      collection: "diarization_runs",
      docs: [
        {
          runId: "legacy-v0",
          status: "active",
          range: {
            start: new Date("2024-01-01T00:00:00.000Z"),
            end: new Date("2024-01-02T00:00:00.000Z"),
          },
        },
        {
          runId: "run-march",
          status: "ready",
          range: { start: MARCH_START, end: MARCH_END },
        },
      ],
    });
    await mongo({
      action: "insertMany",
      collection: "diarizations",
      docs: [
        {
          runId: "legacy-v0",
          lifecycleStatus: "active",
          start: new Date("2024-03-01T10:00:00.000Z"),
          end: new Date("2024-03-01T10:00:30.000Z"),
        },
        {
          runId: "run-march",
          lifecycleStatus: "ready",
          start: new Date("2024-03-01T10:00:00.000Z"),
          end: new Date("2024-03-01T10:00:30.000Z"),
        },
      ],
    });

    await new SpeakerSegmentsResource().use(
      { action: "activate-run", runId: "run-march" },
      auth,
    );

    const legacy = await mongo({
      action: "findOne",
      collection: "diarizations",
      query: { runId: "legacy-v0" },
    }) as { lifecycleStatus: string };
    const activated = await mongo({
      action: "findOne",
      collection: "diarizations",
      query: { runId: "run-march" },
    }) as { lifecycleStatus: string };

    expect(legacy.lifecycleStatus).toBe("superseded");
    expect(activated.lifecycleStatus).toBe("active");
  }),
);

Deno.test(
  "a run that keeps active segments outside the window is only partially superseded",
  withFixtures(["Admin", "Mongo", "Migrations"], async (auth: Auth) => {
    const mongo = await getMongoResource(auth);
    await mongo({
      action: "insertMany",
      collection: "diarization_runs",
      docs: [
        {
          runId: "legacy-v0",
          status: "active",
          range: {
            start: new Date("2024-01-01T00:00:00.000Z"),
            end: MARCH_END,
          },
        },
        {
          runId: "run-march",
          status: "ready",
          range: { start: MARCH_START, end: MARCH_END },
        },
      ],
    });
    await mongo({
      action: "insertMany",
      collection: "diarizations",
      docs: [
        {
          runId: "legacy-v0",
          lifecycleStatus: "active",
          start: new Date("2024-03-01T10:00:00.000Z"),
          end: new Date("2024-03-01T10:00:30.000Z"),
        },
        {
          runId: "legacy-v0",
          lifecycleStatus: "active",
          start: new Date("2024-01-15T10:00:00.000Z"),
          end: new Date("2024-01-15T10:00:30.000Z"),
        },
        {
          runId: "run-march",
          lifecycleStatus: "ready",
          start: new Date("2024-03-01T10:00:00.000Z"),
          end: new Date("2024-03-01T10:00:30.000Z"),
        },
      ],
    });

    await new SpeakerSegmentsResource().use(
      { action: "activate-run", runId: "run-march" },
      auth,
    );

    const legacyRun = await mongo({
      action: "findOne",
      collection: "diarization_runs",
      query: { runId: "legacy-v0" },
    }) as { status: string; partialSupersessions?: unknown[] };
    const untouched = await mongo({
      action: "findOne",
      collection: "diarizations",
      query: {
        runId: "legacy-v0",
        start: new Date("2024-01-15T10:00:00.000Z"),
      },
    }) as { lifecycleStatus: string };

    expect(legacyRun.status).toBe("active");
    expect(legacyRun.partialSupersessions).toHaveLength(1);
    expect(untouched.lifecycleStatus).toBe("active");
  }),
);

Deno.test(
  "overlapping run activations are serialized so only one target remains active",
  withFixtures(["Admin", "Mongo", "Migrations"], async (auth: Auth) => {
    const mongo = await getMongoResource(auth);
    await mongo({
      action: "insertMany",
      collection: "diarization_runs",
      docs: [
        {
          runId: "legacy-v0",
          status: "active",
          range: { start: MARCH_START, end: MARCH_END },
        },
        {
          runId: "run-a",
          status: "ready",
          range: { start: MARCH_START, end: MARCH_END },
        },
        {
          runId: "run-b",
          status: "ready",
          range: { start: MARCH_START, end: MARCH_END },
        },
      ],
    });
    await mongo({
      action: "insertMany",
      collection: "diarizations",
      docs: ["legacy-v0", "run-a", "run-b"].map((runId) => ({
        runId,
        lifecycleStatus: runId === "legacy-v0" ? "active" : "ready",
        start: new Date("2024-03-01T10:00:00.000Z"),
        end: new Date("2024-03-01T10:00:30.000Z"),
      })),
    });

    const resource = new SpeakerSegmentsResource();
    await Promise.all([
      resource.use({ action: "activate-run", runId: "run-a" }, auth),
      resource.use({ action: "activate-run", runId: "run-b" }, auth),
    ]);

    const activeTargets = await mongo({
      action: "find",
      collection: "diarizations",
      query: {
        runId: { $in: ["run-a", "run-b"] },
        lifecycleStatus: "active",
      },
    }) as unknown[];
    expect(activeTargets).toHaveLength(1);
  }),
);
