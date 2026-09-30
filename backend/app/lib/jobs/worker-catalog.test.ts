import { expect } from "@std/expect";
import { buildWorkerCatalog, WORKER_CATALOG } from "./worker-catalog.ts";

Deno.test("worker catalog has unique entries and one-line descriptions", () => {
  expect(new Set(WORKER_CATALOG.map((entry) => entry.type)).size).toBe(
    WORKER_CATALOG.length,
  );
  for (const entry of WORKER_CATALOG) {
    expect(entry.label.trim().length).toBeGreaterThan(0);
    expect(entry.progressKind.trim().length).toBeGreaterThan(0);
    expect(entry.description.includes("\n")).toBe(false);
    expect(entry.description.trim().endsWith(".")).toBe(true);
  }
});

Deno.test("photo analysis exposes only the durable batch coordinator", () => {
  const batch = WORKER_CATALOG.find((entry) =>
    entry.type === "mediaRecognitionBatch"
  );
  expect(batch?.label).toBe("Photo analysis batch");
  expect(batch?.progressKind).toBe("media-recognition-batch");
  expect(batch?.capabilities.manualRun).toBe(false);
  expect(batch?.capabilities.schedule).toBe(false);
  expect(
    WORKER_CATALOG.some((entry) => entry.type === "mediaRecognition"),
  ).toBe(false);
});

Deno.test("chunk creator is non-routed and ingestion is daemon-managed", () => {
  const catalog = buildWorkerCatalog(
    WORKER_CATALOG.map((entry) => entry.type),
    {
      pythonCapabilities: WORKER_CATALOG.map((entry) => entry.type),
    },
  );
  const creator = catalog.find((entry) =>
    entry.type === "conversation_chunk_creator"
  );
  const ingestion = catalog.find((entry) => entry.type === "ingestion");
  expect(creator?.routingKind).toBe("none");
  expect(ingestion?.availability).toBe("daemon-managed");
  expect(ingestion?.capabilities.manualRun).toBe(true);
  expect(ingestion?.capabilities.schedule).toBe(false);
  expect(ingestion?.capabilities.pause).toBe(false);
  expect(ingestion?.capabilities.concurrency).toBe(false);
});

Deno.test("python availability follows executable capabilities", () => {
  const types = WORKER_CATALOG.map((entry) => entry.type);
  const catalog = buildWorkerCatalog(types, { pythonCapabilities: ["vad"] });
  expect(
    catalog.find((entry) => entry.type === "vad")?.availability,
  ).toBe("ready");
  expect(
    catalog.find((entry) => entry.type === "speakerIdentity")?.availability,
  ).toBe("unavailable");
  expect(
    catalog.find((entry) => entry.type === "conversation_chunk_creator")
      ?.availability,
  ).toBe("ready");
});

Deno.test("catalog remains visible while registry is starting", () => {
  const catalog = buildWorkerCatalog([]);
  expect(catalog.length).toBe(WORKER_CATALOG.length);
  expect(
    catalog.filter((entry) => entry.executionKind !== "daemon").every((entry) =>
      entry.availability === "starting"
    ),
  ).toBe(true);
});
