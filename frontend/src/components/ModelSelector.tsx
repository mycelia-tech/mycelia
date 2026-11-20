import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { callResource } from "@/lib/api";
import { extractModelIds } from "@/lib/inferenceModels";
import { Link } from "react-router-dom";

// Model categories with hints
const MODEL_CATEGORIES = [
  { value: "small", label: "Small", hint: "Fast & economical" },
  { value: "medium", label: "Medium", hint: "Balanced" },
  { value: "large", label: "Large", hint: "Most capable" },
];

// Without a search query, each provider group shows only this many models so
// a provider advertising hundreds does not bury the smaller routes.
const COLLAPSED_MODELS_PER_PROVIDER = 8;

const RECENT_MODELS_KEY = "mycelia.recentModels";
const RECENT_MODELS_LIMIT = 5;

type RecentModelEntry = {
  model: string;
  providerProfileId?: string;
};

function readRecentModels(): RecentModelEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModelEntry =>
      entry && typeof entry === "object" &&
      typeof entry.model === "string" && entry.model.length > 0 &&
      (entry.providerProfileId === undefined ||
        typeof entry.providerProfileId === "string")
    ).slice(0, RECENT_MODELS_LIMIT);
  } catch {
    return [];
  }
}

function pushRecentModel(entry: RecentModelEntry): RecentModelEntry[] {
  const next = [
    entry,
    ...readRecentModels().filter((existing) =>
      existing.model !== entry.model ||
      existing.providerProfileId !== entry.providerProfileId
    ),
  ].slice(0, RECENT_MODELS_LIMIT);
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or full storage — recents just stay session-local.
  }
  return next;
}

type ProviderListing = {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  defaultAlias?: string;
  aliases?: Partial<Record<string, string>>;
  chatModel?: string;
  models?: string[];
  error?: string;
};

// Providers in failover order: lower priority number first, mirroring the
// backend's getEnabledLlmProviders sort.
function sortProviders(providers: ProviderListing[]): ProviderListing[] {
  return [...providers].sort((a, b) =>
    (a.priority ?? 50) - (b.priority ?? 50) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

// Alias-mapped and chat models lead the collapsed view; the rest keep the
// provider's own listing order.
function orderProviderModels(provider: ProviderListing): string[] {
  const featured = [
    ...Object.values(provider.aliases ?? {}),
    provider.chatModel,
  ].filter((model): model is string => Boolean(model));
  const models = provider.models ?? [];
  const featuredPresent = featured.filter((model) => models.includes(model));
  return [...new Set([...featuredPresent, ...models])];
}

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  prefetch?: boolean;
  showAvailability?: boolean;
  onCatalogLoaded?: (catalog: {
    chatDefaultModel?: string;
    resolvedAliases?: Record<string, string>;
  }) => void;
  // Chosen models report the provider they were picked from so callers can
  // pin routing to that provider. Aliases and free-typed models report
  // undefined (routing picks the best provider automatically).
  providerValue?: string;
  onSelectWithProvider?: (model: string, providerProfileId?: string) => void;
  // Static mode: no llm:list fetch — offer exactly these models. Used by
  // per-provider config fields (alias maps, chat model, STT model).
  staticModels?: string[];
  staticHeading?: string;
  // Static mode: allow committing free text that matches no listed model.
  allowCustomValue?: boolean;
}

export function ModelSelector({
  value,
  onChange,
  disabled = false,
  placeholder = "Select model...",
  className,
  prefetch = false,
  showAvailability = false,
  onCatalogLoaded,
  providerValue,
  onSelectWithProvider,
  staticModels,
  staticHeading = "Models",
  allowCustomValue = false,
}: ModelSelectorProps) {
  const isStatic = staticModels !== undefined;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [providerListings, setProviderListings] = useState<ProviderListing[]>(
    [],
  );
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    new Set(),
  );
  const [recentModels, setRecentModels] = useState<RecentModelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (isStatic) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await callResource("llm", {
        action: "list",
        ...(showAvailability ? { includeUnavailable: true } : {}),
      }) as {
        models?: unknown;
        providers?: ProviderListing[];
        chatDefaultModel?: string;
        resolvedAliases?: Record<string, string>;
      };
      setModels(extractModelIds(response.models));
      setProviderListings(
        Array.isArray(response.providers)
          ? sortProviders(response.providers)
          : [],
      );
      onCatalogLoaded?.(response);
      setLoadedOnce(true);
    } catch (e) {
      console.error("Failed to fetch models:", e);
      setLoadError(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setLoading(false);
    }
  }, [isStatic, onCatalogLoaded, showAvailability]);

  // Summarization dialogs prefetch whenever they open so provider changes are
  // reflected before the user opens the model picker.
  useEffect(() => {
    if (prefetch) {
      void fetchModels();
    }
  }, [prefetch, fetchModels]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setRecentModels(readRecentModels());
      setSearch("");
      setExpandedProviders(new Set());
    }
    // Other screens keep lazy loading. A new open also provides an explicit
    // retry after an earlier provider error.
    if (
      nextOpen && !loading && (showAvailability || !loadedOnce || loadError)
    ) {
      void fetchModels();
    }
  };

  const providersById = useMemo(
    () => new Map(providerListings.map((provider) => [provider.id, provider])),
    [providerListings],
  );

  // Determine display label
  const displayLabel = useMemo(() => {
    if (!value) return placeholder;
    const category = MODEL_CATEGORIES.find((c) => c.value === value);
    if (category) return `${category.label} (${category.hint})`;
    const pinnedProvider = providerValue
      ? providersById.get(providerValue)
      : undefined;
    return pinnedProvider ? `${value} @ ${pinnedProvider.name}` : value;
  }, [value, placeholder, providerValue, providersById]);

  // Recents survive only while their provider (or model) is still offered, so
  // a removed route does not resurrect through history.
  const visibleRecents = useMemo(() => {
    if (isStatic) return [];
    return recentModels.filter((entry) =>
      entry.providerProfileId
        ? (providersById.get(entry.providerProfileId)?.models ?? []).includes(
          entry.model,
        )
        : models.includes(entry.model)
    );
  }, [isStatic, recentModels, providersById, models]);

  const failedProviders = useMemo(
    () =>
      providerListings.filter((provider) =>
        provider.enabled !== false && provider.error
      ),
    [providerListings],
  );
  const selectedProvider = providerValue
    ? providersById.get(providerValue)
    : undefined;

  const commitSelection = (
    selected: string,
    providerProfileId: string | undefined,
  ) => {
    onChange(selected);
    onSelectWithProvider?.(selected, providerProfileId);
    if (selected && !MODEL_CATEGORIES.some((c) => c.value === selected)) {
      setRecentModels(pushRecentModel({
        model: selected,
        ...(providerProfileId ? { providerProfileId } : {}),
      }));
    }
    setOpen(false);
  };

  const handleSelect = (selectedValue: string) => {
    commitSelection(selectedValue === value ? "" : selectedValue, undefined);
  };

  const handleSelectFromProvider = (
    selectedValue: string,
    providerProfileId: string,
  ) => {
    const samePick = selectedValue === value &&
      providerProfileId === providerValue;
    commitSelection(
      samePick ? "" : selectedValue,
      samePick ? undefined : providerProfileId,
    );
  };

  const searching = search.trim().length > 0;
  const customCandidate = allowCustomValue && searching &&
      !staticModels?.includes(search.trim())
    ? search.trim()
    : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
          disabled={disabled}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {displayLabel}
          </span>
          {showAvailability && (
            <span
              className="ml-2 shrink-0 text-xs text-muted-foreground"
              title={selectedProvider?.error || undefined}
            >
              {loading
                ? "Checking models…"
                : loadError
                ? "Catalogue error"
                : loadedOnce && providerValue &&
                    (!selectedProvider || selectedProvider.error)
                ? "Provider unavailable"
                : loadedOnce && providerListings.length === 0
                ? "No providers"
                : loadedOnce
                ? `${models.length} model${models.length === 1 ? "" : "s"}${
                  failedProviders.length ? " ⚠" : ""
                }`
                : null}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search models..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {loading
                ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Loading models...
                  </div>
                )
                : (
                  "No model found."
                )}
            </CommandEmpty>

            {/* Static mode: one flat list, optionally with free-text entry. */}
            {isStatic && (
              <CommandGroup heading={staticHeading}>
                {customCandidate && (
                  <CommandItem
                    key="__custom"
                    value={customCandidate}
                    onSelect={() => commitSelection(customCandidate, undefined)}
                  >
                    <Check className="mr-2 h-4 w-4 opacity-0" />
                    <span className="text-sm">
                      Use "<span className="font-mono">
                        {customCandidate}
                      </span>"
                    </span>
                  </CommandItem>
                )}
                {staticModels?.map((model) => (
                  <CommandItem
                    key={model}
                    value={model}
                    onSelect={handleSelect}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === model ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="font-mono text-sm">{model}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Categories */}
            {!isStatic && (
              <CommandGroup heading="Aliases">
                {MODEL_CATEGORIES.map((category) => (
                  <CommandItem
                    key={category.value}
                    value={category.value}
                    onSelect={handleSelect}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === category.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="font-medium">{category.label}</span>
                    <span className="ml-2 text-muted-foreground text-xs">
                      ({category.hint})
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Recently picked models, with their provider pin. */}
            {!isStatic && visibleRecents.length > 0 && (
              <CommandGroup heading="Recent">
                {visibleRecents.map((entry) => {
                  const provider = entry.providerProfileId
                    ? providersById.get(entry.providerProfileId)
                    : undefined;
                  const selected = value === entry.model &&
                    providerValue === entry.providerProfileId;
                  return (
                    <CommandItem
                      key={`recent:${
                        entry.providerProfileId ?? ""
                      }:${entry.model}`}
                      value={`recent ${provider?.name ?? ""} ${entry.model}`}
                      onSelect={() =>
                        entry.providerProfileId
                          ? handleSelectFromProvider(
                            entry.model,
                            entry.providerProfileId,
                          )
                          : handleSelect(entry.model)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate font-mono text-sm">
                        {entry.model}
                      </span>
                      {provider && (
                        <span className="ml-auto pl-2 text-xs text-muted-foreground">
                          {provider.name}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {
              /* Provider groups in failover-priority order. Picking a model
              pins the request to that provider. */
            }
            {!isStatic &&
              providerListings.filter((provider) => provider.enabled !== false)
                .map((provider) => {
                  const ordered = orderProviderModels(provider);
                  if (ordered.length === 0) return null;
                  const expanded = searching ||
                    expandedProviders.has(provider.id);
                  const shown = expanded
                    ? ordered
                    : ordered.slice(0, COLLAPSED_MODELS_PER_PROVIDER);
                  const hiddenCount = ordered.length - shown.length;
                  return (
                    <CommandGroup
                      key={provider.id}
                      heading={`${provider.name} · priority ${
                        provider.priority ?? 50
                      }`}
                    >
                      {shown.map((model) => (
                        <CommandItem
                          key={`${provider.id}:${model}`}
                          value={`${provider.name} ${model}`}
                          onSelect={() =>
                            handleSelectFromProvider(model, provider.id)}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              value === model && providerValue === provider.id
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                          <span className="truncate font-mono text-sm">
                            {model}
                          </span>
                        </CommandItem>
                      ))}
                      {hiddenCount > 0 && (
                        <CommandItem
                          key={`${provider.id}:__more`}
                          value={`${provider.name} show more`}
                          onSelect={() =>
                            setExpandedProviders((current) =>
                              new Set(current).add(provider.id)
                            )}
                        >
                          <span className="pl-6 text-xs text-muted-foreground">
                            Show all {ordered.length} models…
                          </span>
                        </CommandItem>
                      )}
                    </CommandGroup>
                  );
                })}

            {loading && models.length === 0 && !isStatic && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">
                  Loading models...
                </span>
              </div>
            )}
          </CommandList>

          {showAvailability && !loading && !loadError && loadedOnce &&
            providerValue && !selectedProvider && (
            <div className="border-t px-3 py-2 text-xs text-destructive">
              The selected provider is disabled or missing. Choose another
              model.
            </div>
          )}

          {
            /* Unreachable providers stay visible instead of silently dropping
            their models from the list. */
          }
          {!loading && !loadError && failedProviders.map((provider) => (
            <div
              key={provider.id}
              className="flex items-start gap-2 border-t px-3 py-2 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {provider.name}: models unavailable — {provider.error}
              </span>
              <button
                type="button"
                className="shrink-0 underline hover:no-underline"
                onClick={() => void fetchModels()}
              >
                Retry
              </button>
            </div>
          ))}

          {loadError && !loading && (
            <div className="flex items-start gap-2 border-t px-3 py-3 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Could not load provider models: {loadError}
              </span>
              <button
                type="button"
                className="shrink-0 underline hover:no-underline"
                onClick={() => void fetchModels()}
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !loadError && loadedOnce && !isStatic &&
            models.length === 0 && (
            <div className="border-t px-3 py-3 text-xs text-muted-foreground">
              {showAvailability && providerListings.length === 0
                ? "No inference providers are enabled."
                : failedProviders.length === 0
                ? "The providers returned no named models."
                : "No configured provider advertised a model."}
              {showAvailability && (
                <Link to="/settings/inference" className="ml-1 underline">
                  Inference settings
                </Link>
              )}
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
