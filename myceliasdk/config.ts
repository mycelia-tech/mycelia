import { z } from "zod";

import { zDateOrString, zObjectId } from "./zod-json-schema.ts";
import { zMediaKnowledgeConfig } from "./media.ts";

export const zProviderConfig = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  chatModel: z.string().optional(),
  fallbackEnabled: z.boolean().optional().default(false),
  fallbackModel: z.string().optional(),
  promptCaching: z.object({
    enabled: z.boolean().default(true),
    sessionPrefix: z.string().trim().min(1).max(120).optional(),
  }).optional(),
});

// Each alias is optional: a provider without a mapping for the requested
// alias is skipped by the routing failover chain ("None" in the UI).
export const zModelAliasMap = z.object({
  small: z.string().min(1).optional(),
  medium: z.string().min(1).optional(),
  large: z.string().min(1).optional(),
});

export const zLlmProviderProfile = z.object({
  photoOnly: z.boolean().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  aliases: zModelAliasMap,
  defaultAlias: z.enum(["small", "medium", "large"]).default("medium"),
  // Fixed mode requires a configured alias model to remain available.
  // Automatic mode treats alias mappings as preferences and selects a live
  // /models entry when the preferred self-hosted model has changed.
  modelSelectionMode: z.enum(["fixed", "automatic"]).default("fixed"),
  chatModel: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  // Lower values are preferred. Providers are tried in priority order and
  // lower-priority routes serve as failover targets.
  priority: z.number().int().min(1).max(100).default(50),
  // Maximum simultaneous chat-completion requests routed to this provider.
  // Requests beyond the limit overflow to the next route by priority, or
  // wait for a free slot when every route is saturated.
  concurrency: z.number().int().min(1).max(32).default(4),
  // OpenRouter uses session IDs only as a routing key. The provider still
  // decides whether a particular prompt prefix is cacheable.
  promptCaching: z.object({
    enabled: z.boolean().default(true),
    sessionPrefix: z.string().trim().min(1).max(120).optional(),
  }).optional(),
});

export const zLlmProfilesConfig = z.object({
  // Deprecated: routing is priority-based; kept so older configs still parse.
  activeProfileId: z.string().min(1).optional(),
  profiles: z.array(zLlmProviderProfile).min(1),
  includeEnvironment: z.boolean().optional().default(false),
  environmentPriority: z.number().int().min(1).max(100).optional().default(50),
  environmentConcurrency: z.number().int().min(1).max(32).optional().default(4),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    if (ids.has(profile.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles", index, "id"],
        message: `Duplicate LLM provider profile id: ${profile.id}`,
      });
    }
    ids.add(profile.id);
  }
});

export const zTranscriptionCachePolicy = z.object({
  mode: z.enum(["keep_warm", "unload_after_idle"]),
  idleTimeoutSeconds: z.number().int().min(30).max(86_400).optional(),
}).superRefine((value, context) => {
  if (value.mode === "unload_after_idle" && !value.idleTimeoutSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["idleTimeoutSeconds"],
      message: "An idle timeout is required when model unloading is enabled",
    });
  }
});

export const zTranscriptionProviderConfig = zProviderConfig.extend({
  // This is the desired policy for the dedicated STT stack. The remote stack
  // reports its effective policy through /v1/stt/status after it is redeployed.
  cachePolicy: zTranscriptionCachePolicy.optional(),
  // Number of transcription sequences processed serially by one job. The next
  // sequence's audio is prepared while Whisper handles the current sequence.
  batchSize: z.number().int().min(1).max(32).optional(),
  // A job timeout is base time plus this allowance for every sequence in its
  // batch. These values are snapshotted when the job is queued.
  batchTimeoutBaseSeconds: z.number().int().min(60).max(1800).optional(),
  batchTimeoutPerSequenceSeconds: z.number().int().min(15).max(300).optional(),
});

export const zTranscriptionProviderProfile = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().trim().min(1).default("whisper"),
  enabled: z.boolean().default(true),
  // Lower values are preferred. Providers sharing a priority are balanced by
  // reserved-slot load, and lower-priority routes are used as overflow.
  priority: z.number().int().min(1).max(100).default(50),
  concurrency: z.number().int().min(1).max(8).default(1),
});

export const zTranscriptionProfilesConfig = z.object({
  profiles: z.array(zTranscriptionProviderProfile).min(1).max(8),
  includeEnvironment: z.boolean().optional().default(false),
  environmentPriority: z.number().int().min(1).max(100).optional().default(50),
}).superRefine((value, context) => {
  const enabled = value.profiles.filter((profile) => profile.enabled);
  const totalConcurrency = enabled.reduce(
    (sum, profile) => sum + profile.concurrency,
    value.includeEnvironment ? 1 : 0,
  );
  if (totalConcurrency > 8) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["profiles"],
      message: "Enabled STT provider concurrency cannot exceed 8 in total",
    });
  }
  const ids = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    if (ids.has(profile.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles", index, "id"],
        message: `Duplicate STT provider profile id: ${profile.id}`,
      });
    }
    ids.add(profile.id);
  }
});

export const zDiarizationProviderProfile = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  baseUrl: z.string().url(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(100).default(50),
  // Maximum simultaneous diarization/embed requests routed to this server.
  concurrency: z.number().int().min(1).max(8).default(1),
  // Auto prefers the inference-aware /ready contract and falls back to a
  // strongly identifiable legacy /health response only when /ready is absent.
  readinessMode: z.enum(["auto", "strict", "legacy"]).default("auto"),
});

export const zDiarizationProfilesConfig = z.object({
  profiles: z.array(zDiarizationProviderProfile).max(8).default([]),
  includeEnvironment: z.boolean().optional().default(true),
  environmentPriority: z.number().int().min(1).max(100).optional().default(50),
  environmentConcurrency: z.number().int().min(1).max(8).optional().default(1),
  environmentReadinessMode: z.enum(["auto", "strict", "legacy"])
    .optional().default("auto"),
}).superRefine((value, context) => {
  const totalConcurrency = value.profiles
    .filter((profile) => profile.enabled)
    .reduce(
      (sum, profile) => sum + profile.concurrency,
      value.includeEnvironment ? value.environmentConcurrency : 0,
    );
  if (totalConcurrency > 8) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["profiles"],
      message:
        "Enabled diarization provider concurrency cannot exceed 8 in total",
    });
  }
  const ids = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    if (ids.has(profile.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles", index, "id"],
        message: `Duplicate diarization provider profile id: ${profile.id}`,
      });
    }
    ids.add(profile.id);
  }
});

// Deprecated: use llm and transcription instead
export const zInferenceProviderConfig = zProviderConfig;

export const zWorkerConfig = z.object({
  paused: z.boolean().optional().default(false).describe(
    "Whether this worker is paused and won't process new jobs.",
  ),
  concurrency: z.number().int().min(1).max(8).optional().default(1).describe(
    "Desired number of BullMQ jobs processed concurrently by this worker.",
  ),
  presetId: z.string().trim().min(1).optional().describe(
    "Reserved worker-specific preset binding for future routing.",
  ),
  triggerIntervalSeconds: z.number().int().min(0).max(86400).optional()
    .describe(
      "Scheduled-run interval override in seconds. 0 disables scheduled runs " +
        "(event triggers still fire); unset keeps the worker's default.",
    ),
  routingContext: z.object({
    sourceId: z.string().trim().min(1).optional(),
    providerProfileId: z.string().trim().min(1).optional(),
  }).optional().describe(
    "Reserved non-secret routing defaults snapshotted into newly queued jobs.",
  ),
});

export type WorkerConfig = z.infer<typeof zWorkerConfig>;

export const zServerConfigPrompts = z.object({
  chat_system: zObjectId().optional().nullable(),
  summarization_system: zObjectId().optional().nullable(),
}).optional();

export const zServerConfig = z.object({
  prompts: zServerConfigPrompts,
  llm: zProviderConfig.optional().nullable(),
  llmProfiles: zLlmProfilesConfig.optional().nullable(),
  transcription: zTranscriptionProviderConfig.optional().nullable(),
  transcriptionProfiles: zTranscriptionProfilesConfig.optional().nullable(),
  diarizationProfiles: zDiarizationProfilesConfig.optional().nullable(),
  mediaKnowledge: zMediaKnowledgeConfig.optional().nullable(),
  externalServices: z.object({
    google: z.object({ enabled: z.boolean().default(false) }).default({
      enabled: false,
    }),
  }).default({ google: { enabled: false } }),
  // Deprecated: kept for backward compatibility
  inference: zInferenceProviderConfig.optional().nullable(),
  features: z.object({
    enable_experimental_processing: z.boolean().describe(
      "Enable experimental processing of conversations. This feature is currently in development and may not work as expected.",
    ),
    enable_speaker_identification: z.boolean().default(false).describe(
      "Enable speaker identification to recognize enrolled voices in diarization results. When enabled, diarization will match segments against enrolled speaker profiles.",
    ),
  }),
  workers: z.record(z.string(), zWorkerConfig).optional().default({}).describe(
    "Per-worker configuration. Key is worker code/type.",
  ),
  createdAt: zDateOrString(),
  updatedAt: zDateOrString(),
});

export type ServerConfig = z.infer<typeof zServerConfig>;

export const zPromptForm = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().optional(),
  text: z.string().min(1, "Prompt text is required"),
});

export type PromptFormData = z.infer<typeof zPromptForm>;

export const zPrompt = z.object({
  _id: zObjectId(),
  name: z.string(),
  text: z.string(),
  description: z.string().optional(),
});

export type Prompt = z.infer<typeof zPrompt>;

export const zWorkerEntry = z.object({
  _id: zObjectId(),
  name: z.string().describe(
    "Worker name/type (e.g., 'summarization', 'transcription')",
  ),
  discovered: z.boolean().describe(
    "Whether this worker is currently discovered/available",
  ),
  inputSchema: z.record(z.string(), z.any()).describe(
    "JSON Schema for worker input",
  ),
  outputSchema: z.record(z.string(), z.any()).describe(
    "JSON Schema for worker output",
  ),
  defaultOverrides: z.record(z.string(), z.any()).optional().describe(
    "Runtime overrides for schema defaults",
  ),
  lastSeen: z.date().describe("Last time this worker was discovered"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WorkerEntry = z.infer<typeof zWorkerEntry>;
