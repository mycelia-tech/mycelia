import { assertEquals, assertThrows } from "@std/assert";
import { ObjectId } from "bson";
import {
  zMediaAsset,
  zMediaKnowledgeConfig,
  zMediaRecognitionProfile,
  zMediaVisualUnderstanding,
} from "./media.ts";

Deno.test("media asset accepts normalized capture timezone and location", () => {
  const parsed = zMediaAsset.parse({
    _id: new ObjectId(),
    owner: "media-owner",
    kind: "image",
    storageMode: "external_reference",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    byteLength: 123,
    sha256: "a".repeat(64),
    metadata: {},
    capturedAt: "2026-08-21T08:34:56.000Z",
    capturedAtSource: "exif",
    capturedAtTimeZone: "+04:00",
    capturedAtTimeZoneSource: "exif_offset",
    location: {
      latitude: 40.18,
      longitude: 44.51,
      altitudeMeters: 990,
    },
    status: "staged",
    createdAt: "2026-08-21T08:35:00.000Z",
    updatedAt: "2026-08-21T08:35:00.000Z",
  });
  assertEquals(parsed.capturedAtTimeZoneSource, "exif_offset");
  assertEquals(parsed.location?.altitudeMeters, 990);
});

Deno.test("media defaults keep Google spend guard deliberately tiny", () => {
  const parsed = zMediaKnowledgeConfig.parse({});
  assertEquals(parsed.promoGuard.monthlyGrossLimitUsd, 1);
  assertEquals(parsed.promoGuard.dailyGrossLimitUsd, 0.1);
  assertEquals(parsed.promoGuard.perImportGrossLimitUsd, 0.01);
  assertEquals(parsed.promoGuard.promotionExpiresAt, undefined);
  assertEquals(parsed.promoGuard.verifiedBillingAccountType, undefined);
});

Deno.test("media event aggregation defaults are bounded and opt-in ready", () => {
  const parsed = zMediaKnowledgeConfig.parse({});
  assertEquals(parsed.eventAggregation, {
    maxGapMinutes: 240,
    maxDistanceKm: 25,
    linkWindowMinutes: 90,
    maxAssetsPerEvent: 50,
    maxPreviewsPerAnalysis: 8,
    perEventGrossLimitUsd: 0.02,
  });
});

Deno.test("only explicit null disables the daily stop without changing other caps", () => {
  const parsed = zMediaKnowledgeConfig.parse({
    promoGuard: { dailyGrossLimitUsd: null },
  });
  assertEquals(parsed.promoGuard.dailyGrossLimitUsd, null);
  assertEquals(parsed.promoGuard.monthlyGrossLimitUsd, 1);
  assertEquals(parsed.promoGuard.perImportGrossLimitUsd, 0.01);
  for (const invalid of [0, -1, 51, "", "unlimited"]) {
    assertThrows(() =>
      zMediaKnowledgeConfig.parse({
        promoGuard: { dailyGrossLimitUsd: invalid },
      })
    );
  }
});

Deno.test("self-hosted media URLs cannot embed credentials or query secrets", () => {
  const profile = {
    id: "self-hosted-media",
    name: "Self-hosted media",
    providerType: "self-hosted" as const,
    enabled: true,
    concurrency: 1,
  };
  assertThrows(() =>
    zMediaRecognitionProfile.parse({
      ...profile,
      baseUrl: "https://user:secret@example.test?token=secret",
    })
  );
  const parsed = zMediaRecognitionProfile.parse({
    ...profile,
    baseUrl: "http://127.0.0.1:8791/provider",
  });
  if (parsed.providerType !== "self-hosted") {
    throw new Error("expected a self-hosted media profile");
  }
  assertEquals(parsed.baseUrl, "http://127.0.0.1:8791/provider");
});

Deno.test("promo guard records the billing account type explicitly", () => {
  const parsed = zMediaKnowledgeConfig.parse({
    promoGuard: { verifiedBillingAccountType: "free_trial" },
  });
  assertEquals(parsed.promoGuard.verifiedBillingAccountType, "free_trial");
  const paid = zMediaKnowledgeConfig.parse({
    promoGuard: { verifiedBillingAccountType: "paid_with_promo" },
  });
  assertEquals(
    paid.promoGuard.verifiedBillingAccountType,
    "paid_with_promo",
  );
});

Deno.test("legacy Google media profile gains pinned Vertex models", () => {
  const parsed = zMediaRecognitionProfile.parse({
    id: "google-media",
    name: "Google Media",
    providerType: "google-cloud",
    enabled: false,
    concurrency: 1,
    projectId: "mycelia-photo-project",
    location: "eu",
    documentAiProcessorId: "optional-ocr",
    documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
    allowGlobalPhotoAnalysis: false,
  });
  assertEquals(parsed.providerType, "google-cloud");
  if (parsed.providerType !== "google-cloud") return;
  assertEquals(parsed.vertexModel, "gemini-3.5-flash-lite");
  assertEquals(parsed.embeddingModel, "gemini-embedding-001");
  assertEquals(parsed.embeddingLocation, "europe-west4");
});

Deno.test("visual understanding accepts Russian provider-neutral structure", () => {
  const parsed = zMediaVisualUnderstanding.parse({
    shortCaption: "Люди у моря",
    description: "Два человека стоят на берегу рядом с водой.",
    scene: {
      summary: "Побережье",
      environment: "outdoor",
      placeType: "пляж",
      timeOfDay: "day",
      confidence: 0.9,
    },
    objects: [{
      name: "море",
      attributes: ["спокойное"],
      confidence: 0.95,
    }],
    activities: [{ description: "прогулка", confidence: 0.7 }],
    peopleCount: 2,
    keywords: ["море", "люди"],
    possibleEvent: null,
    confidence: 0.85,
    warnings: [],
  });
  assertEquals(parsed.peopleCount, 2);
  assertEquals(parsed.scene.environment, "outdoor");
});
