import {
  isLlmModelAlias,
  type ResolvedLlmProvider,
  resolveProviderModel,
} from "./provider-routing.ts";
import { normalizeOpenAIBaseUrl } from "./model-routing.ts";

const MODEL_CATALOG_CACHE_MS = 30_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: string[];
};

const modelCatalogCache = new Map<string, ModelCatalogCacheEntry>();

export function parseProviderModelIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body);
    const entries: unknown[] = Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.models)
      ? parsed.models
      : [];
    const modelIds = entries.map((entry: unknown): string => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      const candidate = entry as Record<string, unknown>;
      return [candidate.id, candidate.model, candidate.name].find(
        (value): value is string => typeof value === "string",
      ) || "";
    }).map((model: string) => model.trim()).filter(Boolean);
    return [...new Set(modelIds)];
  } catch {
    return [];
  }
}

export function chooseProviderModelFromCatalog(
  requestedModel: string,
  provider: ResolvedLlmProvider,
  models: readonly string[],
): string | null {
  const configuredModel = resolveProviderModel(requestedModel, provider);
  if (
    provider.modelSelectionMode !== "automatic" ||
    !isLlmModelAlias(requestedModel.trim())
  ) {
    return configuredModel;
  }
  if (configuredModel && models.includes(configuredModel)) {
    return configuredModel;
  }
  return models[0] ?? null;
}

export async function loadProviderModelCatalog(
  provider: ResolvedLlmProvider,
): Promise<string[]> {
  const modelsUrl = `${normalizeOpenAIBaseUrl(provider.baseUrl)}/models`;
  const cacheKey = `${provider.id}:${modelsUrl}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const response = await fetch(modelsUrl, {
    redirect: "error",
    headers: provider.apiKey
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {},
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim().replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `${provider.name} model catalogue returned HTTP ${response.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const models = parseProviderModelIds(body);
  if (models.length === 0) {
    throw new Error(`${provider.name} advertised no available models`);
  }
  modelCatalogCache.set(cacheKey, {
    expiresAt: Date.now() + MODEL_CATALOG_CACHE_MS,
    models,
  });
  return models;
}

export async function resolveProviderModelForRequest(
  requestedModel: string,
  provider: ResolvedLlmProvider,
): Promise<string | null> {
  if (
    provider.modelSelectionMode !== "automatic" ||
    !isLlmModelAlias(requestedModel.trim())
  ) {
    return resolveProviderModel(requestedModel, provider);
  }
  const models = await loadProviderModelCatalog(provider);
  return chooseProviderModelFromCatalog(requestedModel, provider, models);
}

export function clearProviderModelCatalogCache(): void {
  modelCatalogCache.clear();
}
