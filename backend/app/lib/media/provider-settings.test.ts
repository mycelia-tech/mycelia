import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.15";
import { zServerConfig } from "@myceliasdk/config.ts";
import {
  bindMediaConfig,
  photoSettingsDto,
} from "./provider-settings.server.ts";
import {
  analyzeGeneralPhoto,
  resolvePhotoConnection,
} from "./general-provider.ts";

const server = zServerConfig.parse({
  features: { enable_speaker_identification: false },
  createdAt: new Date(),
  updatedAt: new Date(),
  llmProfiles: {
    profiles: [{
      id: "local",
      name: "Local",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "private-key",
      aliases: {},
    }],
  },
  mediaKnowledge: {
    enabled: true,
    activeProfileId: "photo",
    profiles: [{
      id: "photo",
      name: "Photos",
      providerType: "openai-compatible",
      enabled: true,
      connectionId: "local",
      model: "vision",
    }],
  },
});

Deno.test("photo settings expose only safe connection state, and receipts bind endpoints", () => {
  const dto = photoSettingsDto(server);
  assertEquals(JSON.stringify(dto).includes("private-key"), false);
  assertEquals(dto.connections[0].credentialConfigured, true);
  const profile = bindMediaConfig(server).profiles[0];
  if (profile.providerType !== "openai-compatible") throw new Error("fixture");
  assertEquals(profile.connectionSnapshot?.baseUrl, "http://localhost:8000/v1");
  const disabled = {
    ...server,
    mediaKnowledge: { ...server.mediaKnowledge!, enabled: false },
  };
  assertThrows(
    () => resolvePhotoConnection(disabled, profile),
    Error,
    "PHOTO_PROFILE_CHANGED",
  );
});

Deno.test("cancellation after admission prevents the first request", async () => {
  const profile = bindMediaConfig(server).profiles[0];
  if (profile.providerType !== "openai-compatible") throw new Error("fixture");
  let calls = 0;
  await assertRejects(
    () =>
      analyzeGeneralPhoto(
        {
          profile,
          bytes: new Uint8Array(),
          mimeType: "image/webp",
          pageCount: 1,
          requestedTasks: ["visual-understanding"],
          requestId: "cancel",
        },
        resolvePhotoConnection(server, profile),
        {
          beforeDispatch: async () => {
            throw new Error("cancelled");
          },
          fetch: async () => {
            calls++;
            return Response.json({});
          },
        },
      ),
    Error,
    "cancelled",
  );
  assertEquals(calls, 0);
});
