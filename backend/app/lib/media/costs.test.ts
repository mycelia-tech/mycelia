import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.15";
import {
  type MediaRecognitionProfile,
  zMediaKnowledgeConfig,
} from "@myceliasdk/media.ts";
import {
  assertMediaItemsWithinPerImportBudget,
  assertMediaPerImportBudget,
  estimateGoogleConnectorTestGrossUsd,
  estimateMediaGrossUsd,
  gcpUsageLedgerId,
  summarizeGcpUsage,
} from "./costs.ts";

Deno.test("a multi-file import is guarded per asset, not by batch total", () => {
  const config = zMediaKnowledgeConfig.parse({});

  assertMediaItemsWithinPerImportBudget(
    config,
    Array.from({ length: 6 }, () => 0.006),
  );
  assertThrows(
    () => assertMediaItemsWithinPerImportBudget(config, [0.006, 0.012]),
    Error,
    "for one asset exceeds the per-asset limit",
  );
});

const googleProfile: MediaRecognitionProfile = {
  id: "google-media",
  name: "Google Cloud",
  providerType: "google-cloud",
  enabled: true,
  concurrency: 1,
  projectId: "mycelia-photo-project",
  location: "eu",
  vertexModel: "gemini-3.5-flash-lite",
  embeddingModel: "gemini-embedding-001",
  embeddingLocation: "europe-west4",
  documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
  allowGlobalPhotoAnalysis: true,
};

Deno.test("visual understanding stays below the default per-import guard", () => {
  const config = zMediaKnowledgeConfig.parse({});
  const estimate = estimateMediaGrossUsd(
    "image",
    1,
    ["visual-understanding"],
    googleProfile,
  );

  assertEquals(estimate, 0.006);
  assertMediaPerImportBudget(config, estimate);
});

Deno.test("retry cannot bypass the per-import guard with extra tasks", () => {
  const config = zMediaKnowledgeConfig.parse({});
  const estimate = estimateMediaGrossUsd(
    "image",
    1,
    ["visual-understanding", "ocr", "labels", "objects"],
    googleProfile,
  );

  assertEquals(estimate, 0.01125);
  assertThrows(
    () => assertMediaPerImportBudget(config, estimate),
    Error,
    "exceeds the per-asset limit",
  );
});

Deno.test("self-hosted analysis does not reserve Google spend", () => {
  const profile: MediaRecognitionProfile = {
    id: "selfhost",
    name: "Self-hosted",
    providerType: "self-hosted",
    enabled: true,
    concurrency: 1,
    baseUrl: "http://media-provider:8789",
  };

  assertEquals(
    estimateMediaGrossUsd(
      "image",
      1,
      ["visual-understanding", "ocr"],
      profile,
    ),
    0,
  );
});

Deno.test("Google usage snapshot exposes committed, reserved, and remaining guards", () => {
  const config = zMediaKnowledgeConfig.parse({
    promoGuard: {
      monthlyGrossLimitUsd: 1,
      dailyGrossLimitUsd: 0.1,
      perImportGrossLimitUsd: 0.01,
    },
  });
  const snapshot = summarizeGcpUsage(
    {
      grossCommittedUsd: 0.25,
      grossReservedUsd: 0.05,
      days: { "2026-08-21": { grossUsd: 0.02 } },
    },
    config,
    new Date("2026-08-21T12:00:00.000Z"),
  );

  assertEquals(snapshot.grossMonthUsd, 0.3);
  assertEquals(snapshot.grossTodayUsd, 0.02);
  assertEquals(snapshot.monthlyRemainingUsd, 0.7);
  assertEquals(snapshot.dailyRemainingUsd, 0.08);
});

Deno.test("Google spend ledger is shared by every Mycelia principal using a project", () => {
  assertEquals(
    gcpUsageLedgerId("mycelia-media-260821", "2026-08"),
    "mycelia-media-260821:2026-08",
  );
});

Deno.test("disabled daily stop retains usage and JSON-safe unlimited values", () => {
  const config = zMediaKnowledgeConfig.parse({
    promoGuard: { dailyGrossLimitUsd: null, monthlyGrossLimitUsd: 300 },
  });
  const snapshot = summarizeGcpUsage(
    {
      grossCommittedUsd: 51,
      grossReservedUsd: 1,
      days: { "2026-08-21": { grossUsd: 52 } },
    },
    config,
    new Date("2026-08-21T12:00:00.000Z"),
  );

  assertEquals(snapshot.grossTodayUsd, 52);
  assertEquals(snapshot.dailyLimitUsd, null);
  assertEquals(snapshot.dailyRemainingUsd, null);
  assertEquals(snapshot.monthlyRemainingUsd, 248);
  assertEquals(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assertThrows(() => assertMediaPerImportBudget(config, 0.02));
});

Deno.test("Google connector estimate includes Vertex and Vision plus optional Document AI", () => {
  assertEquals(estimateGoogleConnectorTestGrossUsd(false), 0.0075);
  assertEquals(estimateGoogleConnectorTestGrossUsd(true), 0.009);
});
