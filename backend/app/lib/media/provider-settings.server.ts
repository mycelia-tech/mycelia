import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Auth } from "@/lib/auth/core.server.ts";
import { getConfigResource } from "@/lib/config/resource.server.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { type ServerConfig, zLlmProviderProfile } from "@myceliasdk/config.ts";
import {
  zMediaKnowledgeConfig,
  zMediaRecognitionProfile,
} from "@myceliasdk/media.ts";
import {
  assertGoogleAccess,
  validatePhotoEndpoint,
} from "@myceliasdk/google-policy.ts";
import {
  analyzeGeneralPhoto,
  photoConnectionSnapshot,
  resolvePhotoConnection,
} from "./general-provider.ts";

export const photoSettingsSchema = z.object({
  action: z.literal("photoSettings"),
});
export const savePhotoProfileSchema = z.object({
  action: z.literal("savePhotoProfile"),
  profile: zMediaRecognitionProfile,
  connection: z.object({
    name: z.string().trim().min(1),
    baseUrl: z.string(),
    apiKey: z.string().optional(),
    concurrency: z.number().int().min(1).max(8).default(1),
  }).optional(),
});
export const testPhotoProfileSchema = z.object({
  action: z.literal("testPhotoProfile"),
  profileId: z.string(),
  consent: z.literal(true),
});

export function bindMediaConfig(server: ServerConfig) {
  const config = zMediaKnowledgeConfig.parse(server.mediaKnowledge ?? {});
  config.profiles = config.profiles.map((profile) => {
    try {
      assertGoogleAccess(server, profile);
      if (profile.providerType !== "openai-compatible" || !profile.enabled) {
        return profile;
      }
      const unbound = { ...profile, connectionSnapshot: undefined };
      return {
        ...profile,
        connectionSnapshot: photoConnectionSnapshot(
          resolvePhotoConnection(server, unbound),
        ),
      };
    } catch {
      return { ...profile, enabled: false };
    }
  });
  return config;
}

export function photoSettingsDto(server: ServerConfig) {
  const config = bindMediaConfig(server);
  return {
    enabled: config.enabled,
    activeProfileId: config.activeProfileId,
    profiles: config.profiles,
    googleEnabled: server.externalServices?.google?.enabled === true,
    connections: (server.llmProfiles?.profiles ?? []).map((entry) => {
      let available = entry.enabled;
      let baseUrl: string | undefined;
      try {
        baseUrl = validatePhotoEndpoint(entry.baseUrl);
        assertGoogleAccess(server, { baseUrl });
      } catch {
        available = false;
      }
      return {
        id: entry.id,
        name: entry.name,
        baseUrl,
        enabled: available,
        credentialConfigured: Boolean(entry.apiKey),
        concurrency: entry.concurrency,
      };
    }),
  };
}

export async function savePhotoProfile(
  input: z.infer<typeof savePhotoProfileSchema>,
  auth: Auth,
) {
  const server = await getServerConfig();
  let profile = input.profile;
  if (profile.providerType !== "openai-compatible") {
    throw new Error("Use the separate connector settings for this provider");
  }
  // Binding is a receipt property; clients cannot persist it as current configuration.
  profile = { ...profile, connectionSnapshot: undefined };
  let llmProfiles = server.llmProfiles;
  if (input.connection) {
    const connection = zLlmProviderProfile.parse({
      ...input.connection,
      id: `photo-${randomUUID()}`,
      apiKey: input.connection.apiKey ?? "",
      aliases: {},
      photoOnly: true,
      enabled: true,
      baseUrl: validatePhotoEndpoint(input.connection.baseUrl),
    });
    llmProfiles = {
      ...(llmProfiles ?? {}),
      includeEnvironment: llmProfiles?.includeEnvironment ?? false,
      environmentPriority: llmProfiles?.environmentPriority ?? 50,
      environmentConcurrency: llmProfiles?.environmentConcurrency ?? 4,
      profiles: [...(llmProfiles?.profiles ?? []), connection],
    };
    profile.connectionId = connection.id;
  }
  const media = zMediaKnowledgeConfig.parse(server.mediaKnowledge ?? {});
  const profiles = [
    ...media.profiles.filter((entry) => entry.id !== profile.id),
    profile,
  ];
  const mediaKnowledge = zMediaKnowledgeConfig.parse({
    ...media,
    enabled: true,
    activeProfileId: profile.id,
    profiles,
  });
  if (profile.enabled) {
    resolvePhotoConnection({ ...server, llmProfiles, mediaKnowledge }, profile);
  }
  const config = await getConfigResource(auth);
  await config({
    action: "patch",
    updates: { mediaKnowledge, ...(input.connection ? { llmProfiles } : {}) },
  });
  return photoSettingsDto(await getServerConfig());
}

export async function testPhotoProfile(profileId: string) {
  const server = await getServerConfig();
  const profile = bindMediaConfig(server).profiles.find((entry) =>
    entry.id === profileId
  );
  if (profile?.providerType !== "openai-compatible") {
    throw new Error("Select a general vision profile");
  }
  const connection = resolvePhotoConnection(server, profile);
  // A synthetic 1x1 PNG. No personal archive content is used by connector tests.
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0kAAAAASUVORK5CYII=",
    "base64",
  );
  const result = await analyzeGeneralPhoto(
    {
      profile,
      bytes,
      mimeType: "image/png",
      pageCount: 1,
      requestedTasks: ["visual-understanding"],
      requestId: randomUUID(),
    },
    connection,
    {
      beforeDispatch: async () => {
        Object.assign(
          connection,
          resolvePhotoConnection(await getServerConfig(), profile),
        );
      },
    },
  );
  return {
    ok: true,
    model: result.provenance.modelVersion,
    usage: result.usage,
  };
}
