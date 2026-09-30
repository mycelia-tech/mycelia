import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.15";
import {
  analyzeGeneralPhoto,
  photoConnectionSnapshot,
  resolvePhotoConnection,
} from "./general-provider.ts";

const profile = {
  id: "photos",
  name: "Photos",
  providerType: "openai-compatible" as const,
  enabled: true,
  concurrency: 1,
  connectionId: "local",
  model: "vision",
  language: "Russian",
  maxOutputTokens: 1600,
};
const config = {
  llmProfiles: {
    profiles: [{
      id: "local",
      name: "Local",
      enabled: true,
      baseUrl: "http://localhost:8000/v1",
      apiKey: "",
      concurrency: 2,
    }],
  },
};
const visual = {
  shortCaption: "A tree",
  description: "A tree in a park",
  scene: {
    summary: "Park",
    environment: "outdoor",
    placeType: "park",
    timeOfDay: "day",
    confidence: 0.9,
  },
  objects: [{ name: "tree", attributes: ["", "green"], confidence: 0.9 }],
  peopleCount: 0,
  keywords: ["tree"],
  confidence: 0.9,
  warnings: [],
};
const input = {
  profile,
  bytes: new Uint8Array([1, 2]),
  mimeType: "image/webp",
  pageCount: 1,
  requestedTasks: ["visual-understanding", "ocr"] as const,
  requestId: "test",
};

Deno.test("general vision is keyless, image-bearing, and succeeds without embeddings", async () => {
  const connection = resolvePhotoConnection(config as any, profile);
  const result = await analyzeGeneralPhoto(input as any, connection, {
    fetch: async (url, options) => {
      assertEquals(url, "http://localhost:8000/v1/chat/completions");
      assertEquals(new Headers(options?.headers).has("Authorization"), false);
      const body = JSON.parse(String(options?.body));
      assertEquals(body.model, "vision");
      assertEquals(
        body.messages[1].content[1].image_url.url,
        "data:image/webp;base64,AQI=",
      );
      assertEquals(options?.redirect, "error");
      return Response.json({
        choices: [{
          message: { content: JSON.stringify({ ...visual, text: "EXIT" }) },
        }],
        usage: { prompt_tokens: 40, completion_tokens: 10 },
      });
    },
  });
  assertEquals(result.visualUnderstanding?.objects[0].attributes, ["green"]);
  assertEquals(result.pages[0].text, "EXIT");
  assertEquals(result.embedding, undefined);
  assertEquals(result.usage.grossListPriceUsd, null);
  assertEquals(result.usage.inputTokens, 40);
});

Deno.test("connection binding excludes secrets and rejects changed or disabled destinations", () => {
  const connection = resolvePhotoConnection(config as any, profile);
  const snapshot = photoConnectionSnapshot(connection);
  assertEquals(JSON.stringify(snapshot).includes("apiKey"), false);
  assertThrows(() =>
    resolvePhotoConnection(
      {
        ...config,
        llmProfiles: {
          profiles: [{ ...config.llmProfiles.profiles[0], enabled: false }],
        },
      } as any,
      profile,
    )
  );
  assertThrows(() =>
    resolvePhotoConnection(config as any, {
      ...profile,
      connectionSnapshot: { ...snapshot, baseUrl: "http://other/v1" },
    })
  );
});

Deno.test("reused bare-origin connections retain the shared v1 API convention", () => {
  const bare = {
    ...config,
    llmProfiles: {
      profiles: [{
        ...config.llmProfiles.profiles[0],
        baseUrl: "http://localhost:8000",
      }],
    },
  };
  assertEquals(
    resolvePhotoConnection(bare as any, profile).baseUrl,
    "http://localhost:8000/v1",
  );
});

Deno.test("429 retries are bounded and invalid model output is a real failure", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assertRejects(
    () =>
      analyzeGeneralPhoto(
        input as any,
        resolvePhotoConnection(config as any, profile),
        {
          fetch: async () => {
            calls++;
            return new Response("secret response body", {
              status: 429,
              headers: { "retry-after": "1" },
            });
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    Error,
    "429",
  );
  assertEquals(calls, 3);
  assertEquals(delays.length, 2);
  await assertRejects(
    () =>
      analyzeGeneralPhoto(
        input as any,
        resolvePhotoConnection(config as any, profile),
        {
          fetch: async () =>
            Response.json({ choices: [{ message: { content: "not-json" } }] }),
        },
      ),
    Error,
    "valid JSON",
  );
});
