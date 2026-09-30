import { assertEquals } from "@std/assert";
import { zServerConfig } from "./config.ts";

const base = {
  features: {
    enable_speaker_identification: true,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

Deno.test("server config ignores retired flags in saved configurations", () => {
  const parsed = zServerConfig.parse({
    ...base,
    features: { ...base.features, enable_experimental_processing: true },
  });
  assertEquals(parsed.features, { enable_speaker_identification: true });
});

Deno.test("server config accepts diarization provider profiles", () => {
  const parsed = zServerConfig.parse({
    ...base,
    diarizationProfiles: {
      profiles: [{
        id: "remote",
        name: "Remote diarizator",
        baseUrl: "https://voice.example",
        enabled: true,
        priority: 10,
      }],
      includeEnvironment: true,
      environmentPriority: 50,
    },
  });

  assertEquals(parsed.diarizationProfiles?.profiles[0].id, "remote");
});

Deno.test("server config rejects diarization routing with no enabled route", () => {
  const parsed = zServerConfig.safeParse({
    ...base,
    diarizationProfiles: {
      profiles: [{
        id: "off",
        name: "Off",
        baseUrl: "https://voice.example",
        enabled: false,
        priority: 10,
      }],
      includeEnvironment: false,
    },
  });

  assertEquals(parsed.success, false);
});
