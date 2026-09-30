import { z } from "zod";
import { assertGoogleAccess } from "@myceliasdk/google-policy.ts";
import { Resource } from "@/lib/auth/resources.ts";
import { Auth } from "@/lib/auth/core.server.ts";
import { getServerConfig } from "@/lib/config/serverConfig.server.ts";
import { meter, tracer } from "@/lib/telemetry.ts";
import {
  getConfiguredFallback,
  normalizeOpenAIBaseUrl,
  sanitizeProviderBaseUrl,
} from "./model-routing.ts";
import { normalizeChatCompletionResponse } from "./completion-response.ts";
import { getPromptCacheUsage } from "./prompt-cache-usage.ts";
import {
  getEnabledLlmProviders,
  type ResolvedLlmProvider,
  selectLlmProviders,
} from "./provider-routing.ts";
import {
  parseProviderModelIds,
  resolveProviderModelForRequest,
} from "./provider-model-catalog.ts";

// Server-wide limiter: every worker call funnels through this backend
// process, so a single instance enforces the per-provider request budgets.
import { llmProviderLimiter } from "./provider-limiter.ts";

// Providers whose last request hit the transport timeout are skipped for a
// short cooldown, so one black-holed host does not tax every call in a
// batch with a full timeout before failover.
const providerTimeoutCooldownUntil = new Map<string, number>();
const PROVIDER_TIMEOUT_COOLDOWN_MS = 60_000;

/**
 * In-flight chat-completion requests per provider profile id. Health checks
 * use this to recognize a saturated route as alive: a provider that is busy
 * serving us cannot be probed (single-slot GPUs stop answering /models during
 * generation) but is evidently not down.
 */
export function getLlmProviderInFlight(): Record<string, number> {
  return llmProviderLimiter.load();
}

const llmRequestCounter = meter.createCounter("llm_requests_total", {
  description: "Total number of LLM requests",
});

const llmRequestDuration = meter.createHistogram(
  "llm_request_duration_seconds",
  {
    description: "Duration of LLM requests",
    unit: "s",
  },
);

const llmErrorsCounter = meter.createCounter("llm_errors_total", {
  description: "Total number of LLM errors",
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "function", "tool"]),
  content: z.string().nullable(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
    }),
  }),
]);

const chatCompletionRequestSchema = z.object({
  action: z.literal("completions"),
  model: z.string(),
  messages: z.array(messageSchema),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  // Sent only to OpenRouter. A stable value makes its provider routing sticky,
  // which keeps a provider-side prompt cache warm across related requests.
  session_id: z.string().trim().min(1).max(128).optional(),
  // Restrict routing to one provider profile (no cross-provider failover).
  provider_profile_id: z.string().trim().min(1).max(120).optional(),
  fallbackModel: z.string().optional(),
  reasoning_budget: z.number().int().min(-1).optional(),
  chat_template_kwargs: z.record(z.string(), z.unknown()).optional(),
  // Normalized reasoning mode. "off" is translated per provider (OpenRouter:
  // reasoning.enabled=false; OpenAI-compatible local servers: reasoning_budget
  // 0 + enable_thinking false) and echoed back in mycelia_routing.reasoning.
  reasoning: z.enum(["off", "default", "on"]).optional(),
  // Spend-attribution category. Sent to OpenRouter as the app title
  // ("Mycelia <category>"), so the OpenRouter activity dashboard breaks the
  // bill down per request kind (summarization, tagging, extraction, chat...).
  category: z.string().trim().min(1).max(64).optional(),
  response_format: z
    .union([
      z.object({ type: z.literal("text") }),
      z.object({ type: z.literal("json_object") }),
      z.object({ type: z.literal("json_schema"), json_schema: z.any() }),
    ])
    .optional(),
});

const listModelsRequestSchema = z.object({
  action: z.literal("list"),
});

const providerModelsRequestSchema = z.object({
  action: z.literal("models"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  profileId: z.string().optional(),
});

const providerProbeRequestSchema = z.object({
  action: z.literal("probe"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  profileId: z.string().optional(),
});

const environmentStatusRequestSchema = z.object({
  // The environment route is intentionally inspectable but never editable:
  // its URL, credentials and models belong to the deployment .env.
  action: z.literal("environment_status"),
});

const llmRequestSchema = z.discriminatedUnion("action", [
  chatCompletionRequestSchema,
  listModelsRequestSchema,
  providerModelsRequestSchema,
  providerProbeRequestSchema,
  environmentStatusRequestSchema,
]);

type LLMRequest = z.infer<typeof llmRequestSchema>;
type LLMResponse = any | Response;

function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

function readFiniteCost(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * OpenRouter exposes the final billed amount through its generation metadata
 * endpoint. The chat-completions response intentionally contains token usage,
 * but not necessarily cost, so this is the authoritative fallback when a
 * LiteLLM-compatible response-cost header is unavailable.
 */
async function getOpenRouterGenerationCost(
  baseUrl: string,
  apiKey: string,
  generationId: string | null,
): Promise<number | undefined> {
  if (!generationId || !isOpenRouterBaseUrl(baseUrl)) return undefined;

  try {
    const generationResponse = await fetch(
      `${baseUrl}/generation?id=${encodeURIComponent(generationId)}`,
      { headers: { "Authorization": `Bearer ${apiKey}` } },
    );
    if (!generationResponse.ok) {
      console.warn(
        `[llm] OpenRouter generation metadata unavailable for ${generationId}: HTTP ${generationResponse.status}`,
      );
      return undefined;
    }
    const generation = await generationResponse.json() as {
      data?: { total_cost?: unknown };
    };
    return readFiniteCost(generation.data?.total_cost);
  } catch (error) {
    console.warn(
      `[llm] Failed to fetch OpenRouter generation metadata for ${generationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export interface InferenceProviderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  chatModel?: string;
  defaultAlias?: "small" | "medium" | "large";
  smallModel?: string;
  mediumModel?: string;
  largeModel?: string;
  profileId?: string;
  profileName?: string;
  fallbackEnabled: boolean;
  fallbackModel?: string;
  promptCachingEnabled: boolean;
  promptCacheSessionPrefix?: string;
}

function getOpenRouterSessionId(
  baseUrl: string,
  provider: {
    promptCachingEnabled: boolean;
    promptCacheSessionPrefix?: string;
  },
  requestedSessionId: string | undefined,
): string | undefined {
  if (
    !requestedSessionId || !provider.promptCachingEnabled ||
    !isOpenRouterPromptCachingBaseUrl(baseUrl)
  ) {
    return undefined;
  }

  const prefix = provider.promptCacheSessionPrefix?.trim() || "mycelia";
  // The request schema limits the suffix to 128 characters, so this stays
  // comfortably below OpenRouter's 256-character session_id limit.
  return `${prefix}:${requestedSessionId}`;
}

function isOpenRouterPromptCachingBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

export class LLMResource implements Resource<LLMRequest, LLMResponse> {
  code = "llm";
  description = "LLM chat completions";
  // Injectable for tests so provider resolution never depends on a live DB.
  #loadConfig: typeof getServerConfig;

  constructor(loadConfig: typeof getServerConfig = getServerConfig) {
    this.#loadConfig = loadConfig;
  }
  schemas: {
    request: z.ZodType<LLMRequest>;
    response: z.ZodType<LLMResponse>;
  } = {
    request: llmRequestSchema as z.ZodType<LLMRequest>,
    response: z.any() as z.ZodType<LLMResponse>,
  };

  /**
   * Resolve every configured LLM route, mirroring the STT provider model.
   * Configured profiles are the source of truth; the environment route is a
   * separately prioritized, read-only route instead of a hard override.
   */
  async getInferenceProviders(): Promise<ResolvedLlmProvider[]> {
    const providers = await this.getConfiguredInferenceProviders();
    const config = await this.#loadConfig().catch(() => ({}));
    return providers.map((provider) => {
      try {
        assertGoogleAccess(config, { baseUrl: provider.baseUrl });
        return provider;
      } catch {
        return { ...provider, enabled: false };
      }
    });
  }

  private async getConfiguredInferenceProviders(): Promise<
    ResolvedLlmProvider[]
  > {
    let config: Awaited<ReturnType<typeof getServerConfig>> | null = null;
    try {
      config = await this.#loadConfig();
    } catch {
      // Environment-only deployments may not expose config storage.
    }

    const envBaseUrl = Deno.env.get("OPENAI_BASE_URL")?.trim();
    const envApiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
    // Model resolution: OPENAI_MODEL (for override) > BASE_MODEL (primary config)
    const envModel = (Deno.env.get("OPENAI_MODEL") ||
      Deno.env.get("BASE_MODEL"))?.trim();
    const envChatModel = (Deno.env.get("OPENAI_CHAT_MODEL") ||
      Deno.env.get("CHAT_MODEL"))?.trim();
    const envFallbackModel = Deno.env.get("OPENAI_FALLBACK_MODEL");
    const envFallbackEnabledValue = Deno.env.get("OPENAI_FALLBACK_ENABLED");
    const envAlias = (name: string) =>
      Deno.env.get(name)?.trim() || envModel || undefined;

    const resolveEnvironmentProvider = (): ResolvedLlmProvider | null => {
      if (!envBaseUrl || !envApiKey) return null;
      return {
        id: "environment",
        name: "Environment LLM",
        baseUrl: envBaseUrl,
        apiKey: envApiKey,
        // Unset MODEL_* aliases fall back to the environment default model so
        // env-only deployments keep serving every alias.
        aliases: {
          small: envAlias("MODEL_SMALL"),
          medium: envAlias("MODEL_MEDIUM"),
          large: envAlias("MODEL_LARGE"),
        },
        defaultAlias: "medium",
        modelSelectionMode: "fixed",
        chatModel: envChatModel || envModel,
        enabled: true,
        priority: config?.llmProfiles?.environmentPriority ?? 50,
        concurrency: config?.llmProfiles?.environmentConcurrency ?? 4,
        fallbackEnabled: envFallbackEnabledValue === "true",
        fallbackModel: envFallbackModel,
        promptCachingEnabled: Deno.env.get("OPENROUTER_PROMPT_CACHING") !==
          "false",
        promptCacheSessionPrefix: Deno.env.get("OPENROUTER_SESSION_PREFIX"),
        source: "llm_env",
      };
    };

    if (config?.llmProfiles?.profiles?.some((profile) => !profile.photoOnly)) {
      const configuredProviders: ResolvedLlmProvider[] = config.llmProfiles
        .profiles.map((profile) => ({
          id: profile.id,
          photoOnly: profile.photoOnly,
          name: profile.name,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          aliases: { ...profile.aliases },
          defaultAlias: profile.defaultAlias ?? "medium",
          modelSelectionMode: profile.modelSelectionMode ?? "fixed",
          chatModel: profile.chatModel,
          enabled: profile.enabled ?? true,
          priority: profile.priority ?? 50,
          concurrency: profile.concurrency ?? 4,
          promptCachingEnabled: profile.promptCaching?.enabled ?? true,
          promptCacheSessionPrefix: profile.promptCaching?.sessionPrefix,
          source: "llm_profile" as const,
        }));
      if (!config.llmProfiles.includeEnvironment) {
        return configuredProviders;
      }
      const environmentProvider = resolveEnvironmentProvider();
      return environmentProvider
        ? [environmentProvider, ...configuredProviders]
        : configuredProviders;
    }

    const environmentProvider = resolveEnvironmentProvider();
    if (environmentProvider) return [environmentProvider];

    const provider = config?.llm || config?.inference;
    if (!provider?.baseUrl || !provider?.apiKey) {
      return [];
    }
    const legacyModel = envModel || provider.model?.trim() || undefined;
    const legacyAlias = (name: string) =>
      Deno.env.get(name)?.trim() || legacyModel;
    return [{
      id: "legacy",
      name: "Legacy provider",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      aliases: {
        small: legacyAlias("MODEL_SMALL"),
        medium: legacyAlias("MODEL_MEDIUM"),
        large: legacyAlias("MODEL_LARGE"),
      },
      defaultAlias: "medium",
      modelSelectionMode: "fixed",
      chatModel: envChatModel || provider.chatModel?.trim() || legacyModel,
      enabled: true,
      priority: 50,
      concurrency: 4,
      fallbackEnabled: envFallbackEnabledValue === undefined
        ? provider.fallbackEnabled ?? false
        : envFallbackEnabledValue === "true",
      fallbackModel: envFallbackModel || provider.fallbackModel,
      promptCachingEnabled: provider.promptCaching?.enabled ?? true,
      promptCacheSessionPrefix: provider.promptCaching?.sessionPrefix,
      source: "legacy",
    }];
  }

  /**
   * Backward-compatible view of the highest-priority enabled route for
   * callers that only need a single provider (chat defaults, health).
   */
  async getInferenceProvider(): Promise<InferenceProviderConfig | null> {
    const providers = await this.getInferenceProviders();
    const provider = getEnabledLlmProviders(providers)[0];
    if (!provider) return null;
    const defaultAlias = provider.defaultAlias;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.aliases[defaultAlias],
      chatModel: provider.chatModel || provider.aliases[defaultAlias],
      defaultAlias,
      smallModel: provider.aliases.small,
      mediumModel: provider.aliases.medium,
      largeModel: provider.aliases.large,
      profileId: provider.id,
      profileName: provider.name,
      fallbackEnabled: provider.fallbackEnabled ?? false,
      fallbackModel: provider.fallbackModel,
      promptCachingEnabled: provider.promptCachingEnabled,
      promptCacheSessionPrefix: provider.promptCacheSessionPrefix,
    };
  }

  async use(input: LLMRequest, auth: Auth): Promise<LLMResponse> {
    const startTime = performance.now();
    // Track the resolved model for consistent metrics (set after resolution)
    let resolvedModel = input.action === "completions" ? input.model : "n/a";

    const span = tracer.startSpan("llm_resource_use", {
      attributes: {
        "llm.action": input.action,
        "llm.model_requested": input.action === "completions"
          ? input.model
          : undefined,
      },
    });

    try {
      switch (input.action) {
        case "completions": {
          const {
            action,
            fallbackModel: _fallbackModel,
            session_id: requestedSessionId,
            provider_profile_id: pinnedProviderProfileId,
            reasoning: requestedReasoning,
            category: requestCategory,
            ...body
          } = input;

          let allProviders = await this.getInferenceProviders();
          if (pinnedProviderProfileId) {
            allProviders = allProviders.filter((provider) =>
              provider.id === pinnedProviderProfileId
            );
            if (allProviders.length === 0) {
              llmErrorsCounter.add(1, {
                error_type: "provider_not_configured",
                model: input.model,
              });
              span.setStatus({ code: 2, message: "Pinned provider missing" });
              throw new Error(
                `LLM provider profile not found: ${pinnedProviderProfileId}`,
              );
            }
          }
          // The failover chain: enabled providers that can serve the
          // requested alias or explicit model, in priority order.
          const providerSelectionOptions = {
            // A provider-qualified exact model may come from that provider's
            // live /models catalogue without being copied into an alias map.
            // Unpinned exact names, however, must never leak to another
            // provider just because it has a higher routing priority.
            allowUnadvertisedExplicitModels: Boolean(
              pinnedProviderProfileId,
            ),
          };
          const chain = selectLlmProviders(
            allProviders,
            input.model,
            {},
            providerSelectionOptions,
          );
          if (chain.length === 0) {
            llmErrorsCounter.add(1, {
              error_type: "provider_not_configured",
              model: input.model,
            });
            span.setStatus({
              code: 2,
              message: "Inference provider not configured",
            });
            throw new Error(
              allProviders.length > 0
                ? `No enabled LLM provider can serve model "${input.model}". ` +
                  "Check provider enablement, priorities and alias mappings in server settings."
                : "Inference provider not configured. Please configure it in server settings.",
            );
          }

          const providerAttempts: Array<{
            providerProfileId: string;
            providerProfileName: string;
            providerBaseUrl: string;
            model: string;
            fallbackUsed: boolean;
            error?: string;
          }> = [];

          let proxyResponse: Response | null = null;
          let succeeded: {
            provider: ResolvedLlmProvider;
            baseUrl: string;
            sessionId: string | undefined;
            fallbackModel: string | null;
            fallbackUsed: boolean;
            releaseSlot: () => void;
          } | null = null;

          // Serve the request within per-provider parallel-request budgets:
          // prefer the highest-priority route with a free slot, overflow to
          // the next route when saturated, and wait for any release when
          // every eligible route is at capacity.
          const failedProviderIds = new Set<string>();
          let queuedAt: number | null = null;
          while (!succeeded) {
            const remaining = selectLlmProviders(
              allProviders.filter((provider) =>
                !failedProviderIds.has(provider.id) &&
                (providerTimeoutCooldownUntil.get(provider.id) ?? 0) <=
                  Date.now()
              ),
              input.model,
              llmProviderLimiter.load(),
              providerSelectionOptions,
            );
            if (remaining.length === 0) break;
            const candidate = remaining.find((provider) =>
              llmProviderLimiter.tryAcquire(provider)
            );
            if (!candidate) {
              if (queuedAt === null) {
                queuedAt = Date.now();
                const load = llmProviderLimiter.load();
                console.log(
                  `[llm] All routes at capacity for model "${input.model}" (${
                    remaining.map((p) =>
                      `${p.name} ${load[p.id] ?? 0}/${p.concurrency}`
                    ).join(", ")
                  }); queueing request`,
                );
              }
              await llmProviderLimiter.waitForRelease();
              continue;
            }
            if (queuedAt !== null) {
              console.log(
                `[llm] Slot on "${candidate.name}" acquired after ${
                  Date.now() - queuedAt
                }ms in queue`,
              );
              queuedAt = null;
            }
            let released = false;
            const releaseSlot = () => {
              if (released) return;
              released = true;
              llmProviderLimiter.release(candidate.id);
            };
            try {
              const baseUrl = normalizeOpenAIBaseUrl(candidate.baseUrl);
              const sessionId = getOpenRouterSessionId(
                baseUrl,
                candidate,
                requestedSessionId,
              );
              assertGoogleAccess(await this.#loadConfig().catch(() => ({})), {
                baseUrl,
                model: input.model,
              });

              // Aliases resolve through the provider's alias map. Explicit
              // task models remain explicit and are never silently replaced.
              resolvedModel = await resolveProviderModelForRequest(
                input.model,
                candidate,
              ) as string;
              if (!resolvedModel) {
                throw new Error(
                  `Provider "${candidate.name}" has no available model for "${input.model}"`,
                );
              }
              // A caller can explicitly provide a fallback model, or provide an
              // empty string to opt out. Calls that do not declare a policy
              // retain the provider-level fallback for backwards compatibility.
              const requestControlsFallback = input.fallbackModel !== undefined;
              const requestedFallback = requestControlsFallback
                ? input.fallbackModel
                : candidate.fallbackModel;
              const configuredFallback = requestedFallback
                ? await resolveProviderModelForRequest(
                  requestedFallback,
                  candidate,
                ) ?? undefined
                : undefined;
              const fallbackModel = getConfiguredFallback(
                resolvedModel,
                requestControlsFallback
                  ? Boolean(requestedFallback?.trim())
                  : candidate.fallbackEnabled ?? false,
                configuredFallback,
              );

              // Record request with resolved model
              llmRequestCounter.add(1, {
                action: input.action,
                model: resolvedModel,
              });

              span.setAttributes({
                "llm.model": resolvedModel,
                "llm.base_url": baseUrl,
                "llm.has_api_key": !!candidate.apiKey,
                "llm.provider_profile_id": candidate.id,
              });

              // Without a deadline a black-holed provider (host up, port
              // dropping packets) hangs the fetch until the JOB times out —
              // failover never gets a chance. The budget must still cover
              // slow local-model generation.
              const requestTimeoutMs = Number(
                Deno.env.get("LLM_REQUEST_TIMEOUT_MS") ?? "240000",
              );
              // Reasoning mode translated per candidate: failover can cross
              // provider types, and each speaks a different dialect. "off"
              // disables thinking explicitly; "on" force-enables it (models
              // like DeepSeek do not think unless asked); "default" sends
              // nothing and lets the provider decide.
              const reasoningParams = requestedReasoning === "off"
                ? isOpenRouterBaseUrl(baseUrl)
                  ? { reasoning: { enabled: false } }
                  : {
                    reasoning_budget: 0,
                    chat_template_kwargs: {
                      ...(body.chat_template_kwargs ?? {}),
                      enable_thinking: false,
                    },
                  }
                : requestedReasoning === "on"
                ? isOpenRouterBaseUrl(baseUrl)
                  ? { reasoning: { enabled: true } }
                  : {
                    chat_template_kwargs: {
                      ...(body.chat_template_kwargs ?? {}),
                      enable_thinking: true,
                    },
                  }
                : {};
              // OpenRouter groups activity/spend by app (HTTP-Referer +
              // X-Title). A per-category title splits the dashboard into
              // "Mycelia summarization", "Mycelia tagging", etc.
              const attributionHeaders: Record<string, string> =
                isOpenRouterBaseUrl(baseUrl)
                  ? {
                    "HTTP-Referer": "https://github.com/mycelia-tech/mycelia",
                    "X-Title": requestCategory
                      ? `Mycelia ${requestCategory}`
                      : "Mycelia",
                  }
                  : {};
              const sendRequest = async (model: string) => {
                assertGoogleAccess(await this.#loadConfig().catch(() => ({})), {
                  baseUrl,
                  model,
                });
                return fetch(`${baseUrl}/chat/completions`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${candidate.apiKey}`,
                    ...attributionHeaders,
                  },
                  body: JSON.stringify({
                    ...body,
                    ...reasoningParams,
                    model,
                    ...(sessionId ? { session_id: sessionId } : {}),
                  }),
                  signal: AbortSignal.timeout(requestTimeoutMs),
                  redirect: "error",
                });
              };

              let response: Response;
              let attemptError: string | null = null;
              let fallbackUsed = false;

              try {
                response = await sendRequest(resolvedModel);
                if (!response.ok) {
                  const errorBody = await response.text();
                  attemptError = `HTTP ${response.status}: ${
                    errorBody.slice(0, 500)
                  }`;
                }
              } catch (error) {
                attemptError = error instanceof Error
                  ? error.message
                  : String(error);
                if (error instanceof Error && error.name === "TimeoutError") {
                  attemptError =
                    `request timed out after ${requestTimeoutMs}ms`;
                  providerTimeoutCooldownUntil.set(
                    candidate.id,
                    Date.now() + PROVIDER_TIMEOUT_COOLDOWN_MS,
                  );
                }
                response = new Response(null, { status: 502 });
              }

              // Model-level fallback retries within the same provider before
              // the chain advances to the next route.
              if (attemptError && fallbackModel) {
                console.warn(
                  `[llm] Primary model "${resolvedModel}" failed; retrying explicitly configured fallback "${fallbackModel}": ${attemptError}`,
                );
                span.setAttribute("llm.fallback_used", true);
                fallbackUsed = true;
                resolvedModel = fallbackModel;
                try {
                  response = await sendRequest(resolvedModel);
                  if (response.ok) {
                    attemptError = null;
                  } else {
                    const errorBody = await response.text();
                    attemptError =
                      `${attemptError} Fallback HTTP ${response.status}: ${
                        errorBody.slice(0, 500)
                      }`;
                  }
                } catch (error) {
                  attemptError = `${attemptError} Fallback error: ${
                    error instanceof Error ? error.message : String(error)
                  }`;
                  if (
                    error instanceof Error && error.name === "TimeoutError"
                  ) {
                    providerTimeoutCooldownUntil.set(
                      candidate.id,
                      Date.now() + PROVIDER_TIMEOUT_COOLDOWN_MS,
                    );
                  }
                  response = new Response(null, { status: 502 });
                }
              }

              span.setAttributes({
                "llm.response_status": response.status,
                "llm.response_ok": response.ok,
              });

              providerAttempts.push({
                providerProfileId: candidate.id,
                providerProfileName: candidate.name,
                // Persist only the normalized provider route, never credentials.
                providerBaseUrl: sanitizeProviderBaseUrl(baseUrl),
                model: resolvedModel,
                fallbackUsed,
                ...(attemptError ? { error: attemptError } : {}),
              });

              if (!attemptError && response.ok) {
                proxyResponse = response;
                // The slot stays reserved until the response body is consumed.
                succeeded = {
                  provider: candidate,
                  baseUrl,
                  sessionId,
                  fallbackModel,
                  fallbackUsed,
                  releaseSlot,
                };
                break;
              }

              llmErrorsCounter.add(1, {
                error_type: "provider_failover",
                model: resolvedModel,
                status_code: response.status.toString(),
              });
              console.warn(
                `[llm] Provider "${candidate.name}" failed for requested model "${input.model}"; trying next route: ${attemptError}`,
              );
              failedProviderIds.add(candidate.id);
              releaseSlot();
            } catch (error) {
              releaseSlot();
              throw error;
            }
          }

          if (!succeeded || !proxyResponse) {
            llmErrorsCounter.add(1, {
              error_type: "api_error",
              model: resolvedModel,
            });
            span.setStatus({
              code: 2,
              message: "All LLM provider routes failed",
            });
            const detail = providerAttempts.map((attempt) =>
              `${attempt.providerProfileName} (${attempt.model}): ${
                attempt.error ?? "unknown error"
              }`
            ).join("; ");
            throw new Error(
              `LLM API error; requested model "${input.model}" failed on ${providerAttempts.length} provider route(s): ${detail}`,
            );
          }

          const provider = succeeded.provider;
          const baseUrl = succeeded.baseUrl;
          const sessionId = succeeded.sessionId;
          const fallbackModel = succeeded.fallbackModel;
          const fallbackUsed = succeeded.fallbackUsed;

          // Check if streaming is requested
          if (input.stream) {
            span.setStatus({ code: 1 }); // Success
            const releaseSlot = succeeded.releaseSlot;
            // Hold the provider slot until the stream is fully consumed or
            // the client cancels; release is idempotent.
            const monitoredBody = proxyResponse.body
              ? proxyResponse.body.pipeThrough(
                new TransformStream({
                  flush() {
                    releaseSlot();
                  },
                  cancel() {
                    releaseSlot();
                  },
                }),
              )
              : null;
            if (!monitoredBody) releaseSlot();
            return new Response(monitoredBody, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              },
            });
          }

          let responseText = "";
          try {
            responseText = await proxyResponse.text();
            const jsonResponse = JSON.parse(responseText);

            normalizeChatCompletionResponse(jsonResponse, {
              requestedModel: input.model,
              resolvedModel,
            });

            // Persistable routing provenance for workers. This makes it
            // possible to distinguish requested aliases, the model that
            // actually ran, and an explicit fallback retry.
            const promptCacheUsage = getPromptCacheUsage(jsonResponse.usage);
            jsonResponse.mycelia_routing = {
              requestedModel: input.model,
              resolvedModel,
              fallbackModel: fallbackModel || undefined,
              fallbackUsed,
              // Requested reasoning mode, so artifacts can be analyzed by the
              // reasoning setting they were produced with.
              reasoning: requestedReasoning ?? "default",
              // Persist only the normalized provider route, never credentials.
              providerBaseUrl: sanitizeProviderBaseUrl(baseUrl),
              providerProfileId: provider.id,
              providerProfileName: provider.name,
              // Every route tried for this request, including failed ones, so
              // job provenance shows provider failover explicitly.
              providerAttempts,
              promptCaching: sessionId
                ? { enabled: true, sessionId, ...promptCacheUsage }
                : { enabled: false },
            };

            // Prefer a cost supplied inline or by LiteLLM. OpenRouter chat
            // completions normally provide neither, but include a generation
            // id whose metadata has the authoritative final billed amount.
            const responseCostHeader = proxyResponse.headers.get(
              "x-litellm-response-cost",
            );
            const inlineCost = readFiniteCost(jsonResponse.usage?.cost);
            const headerCost = responseCostHeader === null
              ? undefined
              : readFiniteCost(Number(responseCostHeader));
            const generationCost = inlineCost === undefined &&
                headerCost === undefined
              ? await getOpenRouterGenerationCost(
                baseUrl,
                provider.apiKey,
                proxyResponse.headers.get("x-generation-id"),
              )
              : undefined;
            const responseCost = inlineCost ?? headerCost ?? generationCost;
            if (responseCost !== undefined) {
              jsonResponse.response_cost = responseCost;
            }

            span.setStatus({ code: 1 }); // Success
            return jsonResponse;
          } catch (parseError) {
            if (
              parseError instanceof Error &&
              (
                parseError.message.startsWith("LLM_INVALID_RESPONSE:") ||
                parseError.message.startsWith("LLM_EMPTY_RESPONSE:")
              )
            ) {
              throw parseError;
            }
            llmErrorsCounter.add(1, {
              error_type: "json_parse_error",
              model: resolvedModel,
            });
            const errorMessage = parseError instanceof Error
              ? parseError.message
              : "Unknown parse error";
            span.setStatus({
              code: 2,
              message: `JSON parse error: ${errorMessage}`,
            });
            const preview = responseText.length > 200
              ? responseText.slice(0, 200) + "..."
              : responseText;
            throw new Error(
              `Invalid JSON response from model "${resolvedModel}": ${errorMessage}. Response: ${preview}`,
            );
          } finally {
            succeeded.releaseSlot();
          }
        }
        case "list": {
          const providers = getEnabledLlmProviders(
            await this.getInferenceProviders(),
          );
          if (providers.length === 0) {
            span.setStatus({
              code: 2,
              message: "Inference provider not configured",
            });
            throw new Error(
              "Inference provider not configured. Please configure it in server settings.",
            );
          }

          // Fetch available models from every enabled route so task routing
          // can offer models grouped by provider. Unreachable providers only
          // annotate their own entry instead of failing the whole listing.
          const providerListings = await Promise.all(
            providers.map(async (candidate) => {
              const baseUrl = normalizeOpenAIBaseUrl(candidate.baseUrl);
              try {
                assertGoogleAccess(await this.#loadConfig().catch(() => ({})), {
                  baseUrl,
                });
                const response = await fetch(`${baseUrl}/models`, {
                  headers: { "Authorization": `Bearer ${candidate.apiKey}` },
                  signal: AbortSignal.timeout(10_000),
                  redirect: "error",
                });
                if (!response.ok) {
                  const errorText = await response.text();
                  return {
                    provider: candidate,
                    entries: [] as unknown[],
                    error: `HTTP ${response.status}: ${
                      errorText.slice(0, 200)
                    }`,
                  };
                }
                const data = await response.json();
                return {
                  provider: candidate,
                  entries: Array.isArray(data?.data) ? data.data : [],
                  error: undefined,
                };
              } catch (error) {
                return {
                  provider: candidate,
                  entries: [] as unknown[],
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }),
          );

          if (providerListings.every((listing) => listing.error)) {
            span.setStatus({
              code: 2,
              message: "Failed to fetch models from every provider",
            });
            throw new Error(
              `Failed to fetch models: ${
                providerListings.map((listing) =>
                  `${listing.provider.name}: ${listing.error}`
                ).join("; ")
              }`,
            );
          }

          // The primary route keeps the backward-compatible top-level shape.
          const primary = providers[0];
          const seenModelIds = new Set<string>();
          const mergedModels = providerListings.flatMap((listing) =>
            listing.entries.filter((entry: unknown) => {
              const id = entry && typeof entry === "object" &&
                  typeof (entry as { id?: unknown }).id === "string"
                ? (entry as { id: string }).id
                : typeof entry === "string"
                ? entry
                : undefined;
              if (!id || seenModelIds.has(id)) return false;
              seenModelIds.add(id);
              return true;
            })
          );

          const categories = {
            small: {
              default: primary.aliases.small || "small",
              models: [] as string[],
            },
            medium: {
              default: primary.aliases.medium || "medium",
              models: [] as string[],
            },
            large: {
              default: primary.aliases.large || "large",
              models: [] as string[],
            },
          };

          span.setStatus({ code: 1 });
          return {
            models: mergedModels,
            categories,
            defaultAlias: primary.defaultAlias,
            defaultModel: primary.aliases[primary.defaultAlias] ||
              primary.defaultAlias,
            chatDefaultModel: primary.chatModel ||
              primary.aliases[primary.defaultAlias] || primary.defaultAlias,
            resolvedAliases: {
              small: primary.aliases.small || "small",
              medium: primary.aliases.medium || "medium",
              large: primary.aliases.large || "large",
            },
            providerProfileName: primary.name,
            providers: providerListings.map(({ provider, entries, error }) => ({
              id: provider.id,
              name: provider.name,
              source: provider.source,
              enabled: provider.enabled,
              priority: provider.priority,
              concurrency: provider.concurrency,
              defaultAlias: provider.defaultAlias,
              aliases: provider.aliases,
              chatModel: provider.chatModel,
              models: entries.map((entry: unknown) =>
                entry && typeof entry === "object" &&
                  typeof (entry as { id?: unknown }).id === "string"
                  ? (entry as { id: string }).id
                  : typeof entry === "string"
                  ? entry
                  : ""
              ).filter(Boolean),
              ...(error ? { error } : {}),
            })),
          };
        }
        case "models": {
          const providers = await this.getInferenceProviders();
          let baseUrl = input.baseUrl?.trim();
          let apiKey = input.apiKey;
          if (input.profileId) {
            const profile = providers.find((candidate) =>
              candidate.id === input.profileId
            );
            if (!profile) {
              throw new Error(
                `LLM provider profile not found: ${input.profileId}`,
              );
            }
            baseUrl = baseUrl || profile.baseUrl;
            apiKey = apiKey ?? profile.apiKey;
          }
          if (!baseUrl) {
            const configured = getEnabledLlmProviders(providers)[0];
            baseUrl = configured?.baseUrl;
            apiKey = apiKey ?? configured?.apiKey;
          }
          if (!baseUrl) {
            throw new Error("LLM provider URL is required");
          }

          const modelsUrl = `${normalizeOpenAIBaseUrl(baseUrl)}/models`;
          assertGoogleAccess(await this.#loadConfig().catch(() => ({})), {
            baseUrl,
          });
          const startedAt = performance.now();
          try {
            const response = await fetch(modelsUrl, {
              redirect: "error",
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
              signal: AbortSignal.timeout(10_000),
            });
            const bodyText = await response.text();
            const models = response.ok ? parseProviderModelIds(bodyText) : [];
            const modelsLoaded = response.ok && models.length > 0;
            return {
              success: modelsLoaded,
              serverAvailable: true,
              modelsLoaded,
              status: response.status,
              latencyMs: Math.round(performance.now() - startedAt),
              message: response.ok
                ? modelsLoaded
                  ? `Loaded ${models.length} model${
                    models.length === 1 ? "" : "s"
                  } from the provider catalogue`
                  : "The server responded, but advertised no loaded models"
                : bodyText.trim().replace(/\s+/g, " ").slice(0, 300) ||
                  `HTTP ${response.status}`,
              models,
              modelsUrl,
            };
          } catch (error) {
            return {
              success: false,
              serverAvailable: false,
              modelsLoaded: false,
              status: null,
              latencyMs: Math.round(performance.now() - startedAt),
              message: error instanceof Error ? error.message : String(error),
              models: [] as string[],
              modelsUrl,
            };
          }
        }
        case "probe": {
          const providers = await this.getInferenceProviders();
          let baseUrl = input.baseUrl?.trim();
          let apiKey = input.apiKey;
          if (input.profileId) {
            const profile = providers.find((candidate) =>
              candidate.id === input.profileId
            );
            if (!profile) {
              throw new Error(
                `LLM provider profile not found: ${input.profileId}`,
              );
            }
            baseUrl = baseUrl || profile.baseUrl;
            apiKey = apiKey ?? profile.apiKey;
          }
          if (!baseUrl) throw new Error("LLM provider URL is required");

          const normalizedBaseUrl = normalizeOpenAIBaseUrl(baseUrl);
          assertGoogleAccess(await this.#loadConfig().catch(() => ({})), {
            baseUrl,
          });
          const parsedBaseUrl = new URL(normalizedBaseUrl);
          const healthUrl = new URL("/health", parsedBaseUrl.origin).toString();
          const startedAt = performance.now();
          try {
            let response = await fetch(healthUrl, {
              redirect: "error",
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
              signal: AbortSignal.timeout(5_000),
            });
            let checkedUrl = healthUrl;
            if ([404, 405].includes(response.status)) {
              response.body?.cancel();
              response = await fetch(normalizedBaseUrl, {
                redirect: "error",
                headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
                signal: AbortSignal.timeout(5_000),
              });
              checkedUrl = normalizedBaseUrl;
            }
            response.body?.cancel();
            return {
              success: response.ok,
              available: true,
              status: response.status,
              latencyMs: Math.round(performance.now() - startedAt),
              message: response.ok
                ? `Server is available (HTTP ${response.status})`
                : `Server responded with HTTP ${response.status}`,
              checkedUrl,
            };
          } catch (error) {
            return {
              success: false,
              available: false,
              status: null,
              latencyMs: Math.round(performance.now() - startedAt),
              message: error instanceof Error ? error.message : String(error),
              checkedUrl: healthUrl,
            };
          }
        }
        case "environment_status": {
          let config: Awaited<ReturnType<typeof getServerConfig>> | null = null;
          try {
            config = await this.#loadConfig();
          } catch {
            // Configuration storage is optional for environment-only installs.
          }
          const baseUrl = Deno.env.get("OPENAI_BASE_URL")?.trim();
          const hasApiKey = Boolean(Deno.env.get("OPENAI_API_KEY")?.trim());
          const configured = Boolean(baseUrl && hasApiKey);
          const profilesConfigured = Boolean(
            config?.llmProfiles?.profiles?.length,
          );
          const envModel = (Deno.env.get("OPENAI_MODEL") ||
            Deno.env.get("BASE_MODEL"))?.trim();
          const envAlias = (name: string) =>
            Deno.env.get(name)?.trim() || envModel;
          return {
            configured,
            enabled: profilesConfigured
              ? Boolean(config?.llmProfiles?.includeEnvironment)
              : configured,
            baseUrl: baseUrl?.replace(/\/+$/, ""),
            model: envModel,
            chatModel: (Deno.env.get("OPENAI_CHAT_MODEL") ||
              Deno.env.get("CHAT_MODEL"))?.trim() || envModel,
            aliases: {
              small: envAlias("MODEL_SMALL"),
              medium: envAlias("MODEL_MEDIUM"),
              large: envAlias("MODEL_LARGE"),
            },
            priority: config?.llmProfiles?.environmentPriority ?? 50,
            concurrency: config?.llmProfiles?.environmentConcurrency ?? 4,
            message: configured
              ? "Deployment-managed route; URL, key and models are read-only here."
              : "OPENAI_BASE_URL and OPENAI_API_KEY are not both configured in the backend environment.",
          };
        }
        default:
          llmErrorsCounter.add(1, {
            error_type: "unknown_action",
            action: (input as any).action,
          });
          span.setStatus({ code: 2, message: "Unknown action" });
          throw new Error("Unknown action");
      }
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      const duration = (performance.now() - startTime) / 1000;
      llmRequestDuration.record(duration, {
        action: input.action,
        model: resolvedModel,
      });
      span.setAttributes({ "llm.duration_seconds": duration });
      span.end();
    }
  }

  extractActions(input: LLMRequest) {
    if (
      input.action === "list" || input.action === "models" ||
      input.action === "probe" ||
      input.action === "environment_status"
    ) {
      return [{
        path: ["llm", "models"],
        actions: ["list"],
      }];
    }
    return [{
      path: ["llm", "chat"],
      actions: [input.action],
    }];
  }
}

export async function getLLMResource(
  auth: Auth,
): Promise<(input: LLMRequest) => Promise<LLMResponse>> {
  return auth.getResource("llm");
}
