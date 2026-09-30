export type LlmModelAlias = "small" | "medium" | "large";

export const LLM_MODEL_ALIASES: readonly LlmModelAlias[] = [
  "small",
  "medium",
  "large",
];

export function isLlmModelAlias(value: string): value is LlmModelAlias {
  return (LLM_MODEL_ALIASES as readonly string[]).includes(value);
}

export type ResolvedLlmProvider = {
  photoOnly?: boolean;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  // A provider without a mapping for the requested alias cannot serve it and
  // is skipped by the failover chain.
  aliases: Partial<Record<LlmModelAlias, string>>;
  defaultAlias: LlmModelAlias;
  modelSelectionMode?: "fixed" | "automatic";
  chatModel?: string;
  enabled: boolean;
  priority: number;
  // Maximum simultaneous chat-completion requests routed to this provider.
  concurrency: number;
  // Model-level fallback retried within the same provider (env/legacy only).
  fallbackEnabled?: boolean;
  fallbackModel?: string;
  promptCachingEnabled: boolean;
  promptCacheSessionPrefix?: string;
  source: "llm_env" | "llm_profile" | "legacy";
};

/** In-flight request count per provider profile id. */
export type LlmProviderLoad = Record<string, number>;

/**
 * Whether the provider's configuration names the requested model. Aliases
 * count when mapped; explicit models count when some alias (or the chat
 * default) resolves to them. Providers that advertise the requested explicit
 * model are preferred over blind failover candidates.
 */
export function providerAdvertisesModel(
  requestedModel: string,
  provider: ResolvedLlmProvider,
): boolean {
  const requested = requestedModel.trim();
  if (isLlmModelAlias(requested)) {
    return provider.modelSelectionMode === "automatic" ||
      provider.aliases[requested] != null;
  }
  return Object.values(provider.aliases).includes(requested) ||
    provider.chatModel === requested;
}

/** Enabled providers in failover order, regardless of the requested model. */
export function getEnabledLlmProviders(
  providers: readonly ResolvedLlmProvider[],
): ResolvedLlmProvider[] {
  return providers
    .filter((provider) => provider.enabled && !provider.photoOnly)
    .sort((a, b) =>
      a.priority - b.priority ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
    );
}

/**
 * Resolve the model a provider would run for a request. Aliases resolve
 * through the provider's alias map; explicit model IDs stay explicit and are
 * never silently replaced.
 */
export function resolveProviderModel(
  requestedModel: string,
  provider: ResolvedLlmProvider,
): string | null {
  const requested = requestedModel.trim();
  if (!isLlmModelAlias(requested)) return requested || null;
  return provider.aliases[requested] ?? null;
}

/**
 * Build the failover chain for a request. Providers must be enabled and able
 * to serve the requested model (an alias must be mapped). Providers that
 * advertise an explicitly requested model outrank blind candidates; then
 * lower numeric priorities are preferred; equal priorities balance by
 * in-flight load ratio; final ties break on name, then id.
 */
export function selectLlmProviders(
  providers: readonly ResolvedLlmProvider[],
  requestedModel: string,
  load: LlmProviderLoad = {},
  options: { allowUnadvertisedExplicitModels?: boolean } = {},
): ResolvedLlmProvider[] {
  const requested = requestedModel.trim();
  const requireAdvertisement = !isLlmModelAlias(requested) &&
    !options.allowUnadvertisedExplicitModels;
  return providers
    .filter((provider) =>
      provider.enabled &&
      (
        provider.modelSelectionMode === "automatic" &&
          isLlmModelAlias(requested) ||
        resolveProviderModel(requested, provider) !== null
      ) &&
      (!requireAdvertisement || providerAdvertisesModel(requested, provider))
    )
    .sort((a, b) => {
      const advertises = Number(providerAdvertisesModel(requestedModel, b)) -
        Number(providerAdvertisesModel(requestedModel, a));
      const aRatio = (load[a.id] ?? 0) / a.concurrency;
      const bRatio = (load[b.id] ?? 0) / b.concurrency;
      return advertises || a.priority - b.priority || aRatio - bRatio ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id);
    });
}

/**
 * Resolve the provider whose identity should be snapshotted when an LLM-backed
 * job is enqueued. The caller must pass the fully resolved provider list so the
 * deployment-managed environment route participates alongside saved profiles.
 */
export function selectLlmJobProvider(
  providers: readonly ResolvedLlmProvider[],
  requestedModel: string,
  requestedProviderId?: string,
): ResolvedLlmProvider | undefined {
  const enabledProviders = getEnabledLlmProviders(providers);
  if (requestedProviderId) {
    return enabledProviders.find((provider) =>
      provider.id === requestedProviderId
    );
  }
  const requested = requestedModel.trim();
  if (!requested) return enabledProviders[0];
  return selectLlmProviders(enabledProviders, requested)[0];
}

/**
 * Tracks in-flight chat-completion requests per provider so each route stays
 * within its configured parallel-request budget. When every eligible route is
 * saturated, callers wait for any release and rescan.
 */
export class LlmProviderLimiter {
  #inFlight = new Map<string, number>();
  #waiters: Array<() => void> = [];

  load(): LlmProviderLoad {
    return Object.fromEntries(this.#inFlight);
  }

  tryAcquire(
    provider: Pick<ResolvedLlmProvider, "id" | "concurrency">,
  ): boolean {
    const current = this.#inFlight.get(provider.id) ?? 0;
    if (current >= provider.concurrency) return false;
    this.#inFlight.set(provider.id, current + 1);
    return true;
  }

  release(providerId: string): void {
    const current = this.#inFlight.get(providerId) ?? 0;
    if (current <= 1) this.#inFlight.delete(providerId);
    else this.#inFlight.set(providerId, current - 1);
    // Wake every waiter; they rescan the chain against the fresh load.
    const waiters = this.#waiters.splice(0);
    for (const wake of waiters) wake();
  }

  waitForRelease(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}
