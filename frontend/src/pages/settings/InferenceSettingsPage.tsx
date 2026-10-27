import { probeProviderConnection } from "@/lib/providerProbe";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { callResource } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelSelector } from "@/components/ModelSelector";
import {
  AlertTriangle,
  CheckCircle,
  Cpu,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";

type ModelAlias = "small" | "medium" | "large";

const MODEL_ALIASES: ModelAlias[] = ["small", "medium", "large"];

type LlmProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  // An unmapped alias means this provider does not serve that alias and the
  // routing chain skips it ("None").
  aliases: Partial<Record<ModelAlias, string>>;
  defaultAlias: ModelAlias;
  modelSelectionMode: "fixed" | "automatic";
  chatModel?: string;
  enabled: boolean;
  priority: number;
  // Max simultaneous requests routed to this provider.
  concurrency: number;
  promptCaching?: {
    enabled?: boolean;
    sessionPrefix?: string;
  };
};

type RouteHealth = {
  providerProfileId: string;
  status: "disabled" | "healthy" | "loading" | "unavailable" | "misconfigured";
  enabled: boolean;
  message: string;
  model?: string;
  priority: number;
  concurrency?: number;
  latencyMs?: number;
};

type EnvironmentRoute = {
  configured: boolean;
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  chatModel?: string;
  aliases?: Partial<Record<ModelAlias, string>>;
  priority: number;
  concurrency?: number;
  message: string;
};

type ServerProbe = {
  available: boolean;
  success: boolean;
  status?: number | null;
  latencyMs?: number;
  message: string;
};

type ModelProbe = {
  serverAvailable: boolean;
  modelsLoaded: boolean;
  success: boolean;
  status?: number | null;
  latencyMs?: number;
  message: string;
  models: string[];
};

type ProviderProbeState = {
  server?: ServerProbe;
  models?: ModelProbe;
};

const emptyProfile = (): LlmProfile => ({
  id: `provider-${Date.now()}`,
  name: "New provider",
  baseUrl: "",
  apiKey: "",
  aliases: {},
  defaultAlias: "medium",
  modelSelectionMode: "fixed",
  chatModel: "",
  enabled: true,
  priority: 50,
  concurrency: 4,
  promptCaching: { enabled: true, sessionPrefix: "mycelia" },
});

const MODEL_ROUTES = [
  {
    workerType: "summarization",
    fallbackWorkerType: "summarization",
    label: "Summaries and summary titles",
    description:
      "Automatic and manual conversation summaries, plus generated titles.",
  },
  {
    workerType: "conversation_extractor_merged",
    fallbackWorkerType: "conversation_extractor_merged",
    label: "Conversation extraction",
    description:
      "Conversation extraction resolves the current model when the extractor job is dispatched; chunk creation does not call an LLM.",
  },
  {
    workerType: "tagger",
    fallbackWorkerType: "tagger",
    label: "Automatic tagging",
    description: "Tag selection and assignment for conversation objects.",
  },
  {
    workerType: "entity_typing",
    fallbackWorkerType: "entity_typing",
    label: "Entity typing backfill",
    description:
      "Batch classification of untyped objects into person, place, organization, product, or project.",
  },
] as const;

const ROUTING_WORKER_TYPES = [
  ...new Set(
    MODEL_ROUTES.flatMap((
      route,
    ) => [route.workerType, route.fallbackWorkerType]),
  ),
];

const sortByPriority = (a: LlmProfile, b: LlmProfile) =>
  a.priority - b.priority || a.name.localeCompare(b.name) ||
  a.id.localeCompare(b.id);

const isModelAlias = (model: string) =>
  MODEL_ALIASES.includes(model as ModelAlias);

const profileAdvertisesModel = (profile: LlmProfile, model: string) =>
  Object.values(profile.aliases).includes(model) || profile.chatModel === model;

type StatusTone = "neutral" | "success" | "warning" | "error";

const STATUS_TONE_CLASSES: Record<
  StatusTone,
  { surface: string; badge: string; dot: string }
> = {
  neutral: {
    surface:
      "border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/30",
    badge:
      "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
    dot: "bg-slate-400",
  },
  success: {
    surface:
      "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30",
    badge:
      "border-green-400 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300",
    dot: "bg-green-500",
  },
  warning: {
    surface:
      "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
    badge:
      "border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  error: {
    surface: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30",
    badge:
      "border-red-400 bg-red-100 text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300",
    dot: "bg-red-500",
  },
};

const routeHealthTone = (status: RouteHealth["status"]): StatusTone => {
  if (status === "healthy") return "success";
  if (status === "loading") return "warning";
  if (status === "unavailable" || status === "misconfigured") return "error";
  return "neutral";
};

const StatusBadge = ({
  tone,
  label,
  pulse = false,
}: {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
}) => (
  <Badge
    variant="outline"
    className={`gap-1.5 whitespace-nowrap transition-colors ${
      STATUS_TONE_CLASSES[tone].badge
    }`}
  >
    <span
      aria-hidden="true"
      className={`h-2 w-2 rounded-full ${STATUS_TONE_CLASSES[tone].dot} ${
        pulse ? "animate-pulse" : ""
      }`}
    />
    {label}
  </Badge>
);

const InferenceSettingsPage = () => {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState<LlmProfile>(emptyProfile);
  const [includeEnvironment, setIncludeEnvironment] = useState(false);
  const [environmentPriority, setEnvironmentPriority] = useState(50);
  const [environmentConcurrency, setEnvironmentConcurrency] = useState(4);
  const [environmentRoute, setEnvironmentRoute] = useState<
    EnvironmentRoute | null
  >(null);
  const [routeHealth, setRouteHealth] = useState<RouteHealth[]>([]);
  const [draftModels, setDraftModels] = useState<string[]>([]);
  const [providerProbes, setProviderProbes] = useState<
    Record<string, ProviderProbeState>
  >({});
  const [workerDefaults, setWorkerDefaults] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [taskModels, setTaskModels] = useState<Record<string, string>>({});
  // Provider pin per task route: set when the task model was picked from a
  // specific provider's group, so those jobs skip cross-provider failover.
  const [taskProviders, setTaskProviders] = useState<Record<string, string>>(
    {},
  );
  const [taskFallbackModels, setTaskFallbackModels] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingServer, setCheckingServer] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<
    { success: boolean; text: string } | null
  >(null);

  const refreshHealth = async (
    showError = false,
  ): Promise<RouteHealth[]> => {
    setRefreshing(true);
    try {
      const pipeline = await callResource("jobs", {
        action: "services_health",
        force: true,
      });
      const llm = pipeline?.services?.find((service: { id: string }) =>
        service.id === "llm"
      );
      const routes = llm?.routes ?? [];
      setRouteHealth(routes);
      return routes;
    } catch (error) {
      setRouteHealth([]);
      if (showError) {
        setMessage({
          success: false,
          text: error instanceof Error
            ? `Could not refresh route health: ${error.message}`
            : "Could not refresh route health",
        });
      }
      return [];
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [config, environment, ...defaultsResults] = await Promise.all([
          callResource("config", { action: "get" }),
          callResource("llm", { action: "environment_status" }),
          ...ROUTING_WORKER_TYPES.map((workerType) =>
            callResource("jobs", {
              action: "get_worker_defaults",
              workerType,
            })
          ),
        ]);

        const defaultsByWorker: Record<string, Record<string, unknown>> = {};
        const modelsByWorker: Record<string, string> = {};
        const providersByWorker: Record<string, string> = {};
        const fallbackModelsByWorker: Record<string, string> = {};
        ROUTING_WORKER_TYPES.forEach((workerType, index) => {
          defaultsByWorker[workerType] = defaultsResults[index]?.defaults || {};
        });
        MODEL_ROUTES.forEach((route) => {
          const defaults = defaultsByWorker[route.workerType] || {};
          const fallbackDefaults = defaultsByWorker[route.fallbackWorkerType] ||
            {};
          if (typeof defaults.model === "string" && defaults.model) {
            modelsByWorker[route.workerType] = defaults.model;
          }
          if (
            typeof defaults.providerProfileId === "string" &&
            defaults.providerProfileId
          ) {
            providersByWorker[route.workerType] = defaults.providerProfileId;
          }
          if (typeof fallbackDefaults.fallbackModel === "string") {
            fallbackModelsByWorker[route.workerType] =
              fallbackDefaults.fallbackModel;
          }
        });
        setWorkerDefaults(defaultsByWorker);
        setTaskModels(modelsByWorker);
        setTaskFallbackModels(fallbackModelsByWorker);

        const legacy = config?.llm || config?.inference || {};
        const saved = config?.llmProfiles?.profiles as
          | Array<Partial<LlmProfile>>
          | undefined;
        const legacyModel = legacy.model || "";
        const nextProfiles: LlmProfile[] = saved?.length
          ? saved.map((profile, index) => ({
            id: profile.id || `provider-${index + 1}`,
            name: profile.name || `Provider ${index + 1}`,
            baseUrl: profile.baseUrl || "",
            apiKey: profile.apiKey || "",
            aliases: { ...(profile.aliases || {}) },
            defaultAlias: profile.defaultAlias || "medium",
            modelSelectionMode: profile.modelSelectionMode || "fixed",
            chatModel: profile.chatModel || "",
            enabled: profile.enabled ?? true,
            priority: profile.priority ?? 50,
            concurrency: profile.concurrency ?? 4,
            promptCaching: profile.promptCaching ??
              { enabled: true, sessionPrefix: "mycelia" },
          }))
          : [{
            id: "primary",
            name: "Primary",
            baseUrl: legacy.baseUrl || "",
            apiKey: legacy.apiKey || "",
            aliases: legacyModel
              ? { small: legacyModel, medium: legacyModel, large: legacyModel }
              : {},
            defaultAlias: "medium",
            modelSelectionMode: "fixed",
            chatModel: legacy.chatModel || legacyModel,
            enabled: true,
            priority: 50,
            concurrency: 4,
            promptCaching: { enabled: true, sessionPrefix: "mycelia" },
          }];
        // Older task defaults stored an exact model without its provider id.
        // Recover the pin only when the configured model identifies exactly
        // one provider; otherwise force the user to choose an alias or a
        // provider-qualified model instead of silently sending it elsewhere.
        const resolvedProvidersByWorker = { ...providersByWorker };
        MODEL_ROUTES.forEach((route) => {
          const model = modelsByWorker[route.workerType]?.trim();
          if (!model || isModelAlias(model)) {
            delete resolvedProvidersByWorker[route.workerType];
            return;
          }
          if (resolvedProvidersByWorker[route.workerType]) return;
          const matches = nextProfiles.filter((profile) =>
            profileAdvertisesModel(profile, model)
          );
          if (matches.length === 1) {
            resolvedProvidersByWorker[route.workerType] = matches[0].id;
          }
        });
        setTaskProviders(resolvedProvidersByWorker);
        const active = [...nextProfiles].sort(sortByPriority).find((profile) =>
          profile.enabled
        ) ?? nextProfiles[0];
        setProfiles(nextProfiles);
        setActiveId(active.id);
        setDraft(active);
        setIncludeEnvironment(
          config?.llmProfiles?.includeEnvironment ?? false,
        );
        setEnvironmentPriority(
          environment?.priority ??
            config?.llmProfiles?.environmentPriority ?? 50,
        );
        setEnvironmentConcurrency(
          environment?.concurrency ??
            config?.llmProfiles?.environmentConcurrency ?? 4,
        );
        setEnvironmentRoute(environment ?? null);
        await refreshHealth();
      } catch (error) {
        setMessage({
          success: false,
          text: error instanceof Error
            ? error.message
            : "Failed to load inference settings",
        });
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const currentProfiles = useMemo(
    () => profiles.map((profile) => profile.id === activeId ? draft : profile),
    [profiles, activeId, draft],
  );

  const primaryProfile = useMemo(
    () =>
      [...currentProfiles].sort(sortByPriority).find((profile) =>
        profile.enabled
      ),
    [currentProfiles],
  );

  const failoverOrder = useMemo(
    () =>
      [...currentProfiles].filter((profile) => profile.enabled).sort(
        sortByPriority,
      ),
    [currentProfiles],
  );

  const globalAlias = primaryProfile?.defaultAlias ?? "medium";
  const globalModel = primaryProfile?.aliases[globalAlias] || "";

  const selectProfile = (id: string) => {
    if (id === activeId) return;
    const committed = currentProfiles;
    const next = committed.find((profile) => profile.id === id);
    if (!next) return;
    setProfiles(committed);
    setActiveId(id);
    setDraft(next);
    setDraftModels([]);
    setMessage(null);
  };

  const addProfile = () => {
    const next = emptyProfile();
    setProfiles([...currentProfiles, next]);
    setActiveId(next.id);
    setDraft(next);
    setDraftModels([]);
    setMessage(null);
  };

  const deleteProfile = () => {
    if (currentProfiles.length <= 1) return;
    const remaining = currentProfiles.filter((profile) =>
      profile.id !== activeId
    );
    setProfiles(remaining);
    setActiveId(remaining[0].id);
    setDraft(remaining[0]);
    setDraftModels([]);
    setMessage(null);
  };

  const validate = (nextProfiles: LlmProfile[]): string | null => {
    for (const profile of nextProfiles) {
      if (!profile.name.trim()) return "Every provider needs a name.";
      if (!profile.baseUrl.trim()) {
        return `${profile.name}: base URL is required.`;
      }
      try {
        new URL(profile.baseUrl);
      } catch {
        return `${profile.name}: enter a valid URL.`;
      }
      if (
        !Number.isInteger(profile.priority) || profile.priority < 1 ||
        profile.priority > 100
      ) {
        return `${profile.name}: priority must be 1-100.`;
      }
      if (
        !Number.isInteger(profile.concurrency) || profile.concurrency < 1 ||
        profile.concurrency > 32
      ) {
        return `${profile.name}: parallel requests must be 1-32.`;
      }
    }
    const enabled = nextProfiles.filter((profile) => profile.enabled);
    const routingEnabled = enabled.length > 0 ||
      Boolean(includeEnvironment && environmentRoute?.configured);
    if (routingEnabled) {
      for (const route of MODEL_ROUTES) {
        const model = taskModels[route.workerType]?.trim();
        if (!model || isModelAlias(model)) continue;
        const providerId = taskProviders[route.workerType]?.trim();
        if (!providerId) {
          return `${route.label}: choose the exact model from a provider ` +
            "or use a small/medium/large alias.";
        }
        const providerEnabled = providerId === "environment"
          ? Boolean(includeEnvironment && environmentRoute?.configured)
          : nextProfiles.some((profile) =>
            profile.id === providerId && profile.enabled
          );
        if (!providerEnabled) {
          return `${route.label}: the selected model belongs to a disabled ` +
            "provider. Enable it or choose another provider/alias.";
        }
      }
    }
    if (
      !Number.isInteger(environmentPriority) || environmentPriority < 1 ||
      environmentPriority > 100
    ) {
      return "Environment priority must be 1-100.";
    }
    const invalidFallback = MODEL_ROUTES.find((route) => {
      const primary = taskModels[route.workerType]?.trim() || globalAlias;
      const fallback = taskFallbackModels[route.workerType]?.trim();
      return fallback && fallback === primary;
    });
    if (invalidFallback) {
      return `${invalidFallback.label}: fallback must differ from the primary model.`;
    }
    return null;
  };

  const save = async () => {
    const nextProfiles = currentProfiles.map((profile) => {
      const aliases: Partial<Record<ModelAlias, string>> = {};
      for (const alias of MODEL_ALIASES) {
        const model = profile.aliases[alias]?.trim();
        if (model) aliases[alias] = model;
      }
      return {
        ...profile,
        name: profile.name.trim(),
        baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: profile.apiKey.trim(),
        aliases,
        chatModel: profile.chatModel?.trim() || undefined,
        promptCaching: {
          enabled: profile.promptCaching?.enabled ?? true,
          sessionPrefix: profile.promptCaching?.sessionPrefix?.trim() ||
            "mycelia",
        },
      };
    });
    const validationError = validate(nextProfiles);
    if (validationError) {
      setMessage({ success: false, text: validationError });
      return;
    }
    const primary =
      [...nextProfiles].sort(sortByPriority).find((profile) =>
        profile.enabled
      ) ?? nextProfiles[0];
    const primaryModel = primary.aliases[primary.defaultAlias] || "";

    const updatedDefaults: Record<string, Record<string, unknown>> = {};
    for (const workerType of ROUTING_WORKER_TYPES) {
      updatedDefaults[workerType] = { ...(workerDefaults[workerType] || {}) };
    }
    MODEL_ROUTES.forEach((route) => {
      const defaults = updatedDefaults[route.workerType];
      const taskModel = taskModels[route.workerType]?.trim();
      const fallbackDefaults = updatedDefaults[route.fallbackWorkerType];

      // Extraction settings belong only to the extractor. Chunk creation is a
      // deterministic grouping step and carries no model/provider snapshot.
      const taskProvider = taskModel
        ? taskProviders[route.workerType]?.trim()
        : undefined;
      if (taskModel) {
        defaults.model = taskModel;
        if (taskProvider) {
          defaults.providerProfileId = taskProvider;
        } else {
          delete defaults.providerProfileId;
        }
      } else {
        delete defaults.model;
        delete defaults.providerProfileId;
      }

      // An explicit fallback overrides; an empty one is removed so jobs use
      // the provider route's configured fallback (unified default).
      const taskFallback = taskFallbackModels[route.workerType]?.trim();
      if (taskFallback) {
        fallbackDefaults.fallbackModel = taskFallback;
      } else {
        delete fallbackDefaults.fallbackModel;
      }
    });

    setSaving(true);
    setMessage(null);
    try {
      await callResource("config", {
        action: "patch",
        updates: {
          llmProfiles: {
            // Deprecated but kept in sync for older builds during rollback.
            activeProfileId: primary.id,
            profiles: nextProfiles,
            includeEnvironment,
            environmentPriority,
            environmentConcurrency,
          },
          llm: {
            baseUrl: primary.baseUrl,
            apiKey: primary.apiKey,
            model: primaryModel,
            chatModel: primary.chatModel || primaryModel,
            fallbackEnabled: false,
            fallbackModel: "",
            promptCaching: primary.promptCaching,
          },
          inference: {
            baseUrl: primary.baseUrl,
            apiKey: primary.apiKey,
            model: primaryModel,
            chatModel: primary.chatModel || primaryModel,
            fallbackEnabled: false,
            fallbackModel: "",
            promptCaching: primary.promptCaching,
          },
        },
      });
      await Promise.all(
        Object.entries(updatedDefaults).map(([workerType, defaults]) =>
          callResource("jobs", {
            action: "update_worker_defaults",
            workerType,
            defaults,
          })
        ),
      );
      setWorkerDefaults(updatedDefaults);
      setProfiles(nextProfiles);
      setDraft(nextProfiles.find((profile) => profile.id === activeId)!);
      setMessage({
        success: true,
        text: `Saved ${nextProfiles.length} provider(s); ${
          nextProfiles.filter((profile) => profile.enabled).length
        } enabled for routing.`,
      });
      await refreshHealth();
    } catch (error) {
      setMessage({
        success: false,
        text: error instanceof Error
          ? error.message
          : "Failed to save inference settings",
      });
    } finally {
      setSaving(false);
    }
  };

  const checkDraftServer = async () => {
    if (!draft.baseUrl.trim()) {
      setMessage({ success: false, text: "Enter the provider URL first." });
      return;
    }
    setCheckingServer(true);
    setMessage(null);
    try {
      const result = await probeProviderConnection(draft.baseUrl, draft.apiKey);
      setProviderProbes((current) => ({
        ...current,
        [draft.id]: {
          ...current[draft.id],
          server: {
            available: Boolean(result?.available),
            success: Boolean(result?.success),
            status: result?.status,
            latencyMs: result?.latencyMs,
            message: result?.message || "No response",
          },
        },
      }));
    } catch (error) {
      setProviderProbes((current) => ({
        ...current,
        [draft.id]: {
          ...current[draft.id],
          server: {
            available: false,
            success: false,
            message: error instanceof Error
              ? error.message
              : "Provider connection test failed",
          },
        },
      }));
    } finally {
      setCheckingServer(false);
    }
  };

  const loadDraftModels = async () => {
    if (!draft.baseUrl.trim()) {
      setMessage({ success: false, text: "Enter the provider URL first." });
      return;
    }
    setLoadingModels(true);
    setMessage(null);
    try {
      const result = await callResource("llm", {
        action: "models",
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey,
      });
      const nextModels = Array.isArray(result?.models) ? result.models : [];
      setDraftModels(nextModels);
      setProviderProbes((current) => ({
        ...current,
        [draft.id]: {
          ...current[draft.id],
          models: {
            serverAvailable: Boolean(result?.serverAvailable),
            modelsLoaded: Boolean(result?.modelsLoaded),
            success: Boolean(result?.success),
            status: result?.status,
            latencyMs: result?.latencyMs,
            message: result?.message || "No response",
            models: nextModels,
          },
        },
      }));
    } catch (error) {
      setDraftModels([]);
      setProviderProbes((current) => ({
        ...current,
        [draft.id]: {
          ...current[draft.id],
          models: {
            serverAvailable: false,
            modelsLoaded: false,
            success: false,
            message: error instanceof Error
              ? error.message
              : "Could not load provider models",
            models: [],
          },
        },
      }));
    } finally {
      setLoadingModels(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const healthById = new Map(
    routeHealth.map((route) => [route.providerProfileId, route]),
  );
  const draftProbe = providerProbes[draft.id];
  const preferredDefaultModel = draft.aliases[draft.defaultAlias]?.trim() || "";
  const automaticRuntimeModel = draft.modelSelectionMode === "automatic" &&
      draftProbe?.models?.modelsLoaded
    ? draftProbe.models.models.includes(preferredDefaultModel)
      ? preferredDefaultModel
      : draftProbe.models.models[0] || ""
    : preferredDefaultModel;
  const automaticModelChanged = draft.modelSelectionMode === "automatic" &&
    Boolean(preferredDefaultModel) && Boolean(automaticRuntimeModel) &&
    automaticRuntimeModel !== preferredDefaultModel;
  const serverStatusTone: StatusTone = checkingServer
    ? "warning"
    : !draftProbe?.server
    ? "neutral"
    : draftProbe.server.success
    ? "success"
    : draftProbe.server.available
    ? "warning"
    : "error";
  const serverStatusLabel = checkingServer
    ? "Checking…"
    : !draftProbe?.server
    ? "Not checked"
    : draftProbe.server.success
    ? "Online"
    : draftProbe.server.available
    ? "Reachable with errors"
    : "Offline";
  const modelStatusTone: StatusTone = loadingModels
    ? "warning"
    : !draftProbe?.models
    ? "neutral"
    : draftProbe.models.modelsLoaded
    ? "success"
    : draftProbe.models.serverAvailable
    ? "warning"
    : "error";
  const modelStatusLabel = loadingModels
    ? "Loading…"
    : !draftProbe?.models
    ? "Not loaded"
    : draftProbe.models.modelsLoaded
    ? `${draftProbe.models.models.length} loaded`
    : draftProbe.models.serverAvailable
    ? "No models loaded"
    : "Unavailable";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <Cpu className="h-6 w-6" />
            LLM inference providers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage inference routes, their priorities, per-provider models and
            health. Requests use the highest-priority enabled provider and fail
            over down the list.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refreshHealth(true)}
          disabled={refreshing}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh health
        </Button>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={includeEnvironment &&
              Boolean(environmentRoute?.configured)}
            onCheckedChange={setIncludeEnvironment}
            disabled={!environmentRoute?.configured}
            aria-label="Use environment LLM route"
          />
          <div className="min-w-56 flex-1">
            <p className="font-medium">Backend environment route</p>
            <p className="text-xs text-muted-foreground">
              {environmentRoute?.configured
                ? `${environmentRoute.baseUrl} · ${
                  environmentRoute.model || "default model not set"
                } · deployment managed`
                : "OPENAI_BASE_URL / OPENAI_API_KEY not configured in the backend environment"}
            </p>
          </div>
          <div className="w-36 space-y-1">
            <Label htmlFor="environmentPriority">Priority (1 first)</Label>
            <Input
              id="environmentPriority"
              type="number"
              min={1}
              max={100}
              value={environmentPriority}
              disabled={!includeEnvironment || !environmentRoute?.configured}
              onChange={(event) =>
                setEnvironmentPriority(Number(event.target.value))}
            />
          </div>
          <div className="w-36 space-y-1">
            <Label htmlFor="environmentConcurrency">Parallel requests</Label>
            <Input
              id="environmentConcurrency"
              type="number"
              min={1}
              max={32}
              value={environmentConcurrency}
              disabled={!includeEnvironment || !environmentRoute?.configured}
              onChange={(event) =>
                setEnvironmentConcurrency(Number(event.target.value))}
            />
          </div>
          {healthById.get("environment") && (
            <StatusBadge
              tone={routeHealthTone(healthById.get("environment")!.status)}
              label={healthById.get("environment")!.status}
            />
          )}
          <Badge
            variant={environmentRoute?.configured ? "outline" : "destructive"}
          >
            {environmentRoute?.configured
              ? includeEnvironment ? "Enabled" : "Disabled"
              : "Unavailable"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {environmentRoute?.message || "Checking backend environment route…"}
          {environmentRoute?.configured &&
            " Its URL, API key and models can only be changed in .env."}
        </p>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            Configured providers ({currentProfiles.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            {failoverOrder.length > 0
              ? `Failover order: ${
                failoverOrder.map((profile) => profile.name).join(" → ")
              }`
              : "No providers are enabled for routing."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={addProfile}>
            <Plus className="mr-2 h-4 w-4" />
            Add provider
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={deleteProfile}
            disabled={currentProfiles.length <= 1}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete selected
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {currentProfiles.map((profile) => {
          const health = healthById.get(profile.id);
          return (
            <button
              key={profile.id}
              type="button"
              aria-pressed={profile.id === activeId}
              onClick={() => selectProfile(profile.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                profile.id === activeId
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/50"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{profile.name}</span>
                <Badge variant={profile.enabled ? "secondary" : "outline"}>
                  {profile.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                P{profile.priority} · {profile.concurrency}{" "}
                req{profile.concurrency === 1 ? "" : "s"} ·{" "}
                {profile.modelSelectionMode === "automatic" ? "auto · " : ""}
                {profile.defaultAlias} →{" "}
                {profile.aliases[profile.defaultAlias] || "not mapped"}
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {profile.baseUrl || "URL not set"}
              </span>
              {health && (
                <span className="mt-2 flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Health</span>
                  <StatusBadge
                    tone={routeHealthTone(health.status)}
                    label={health.status}
                  />
                  {typeof health.latencyMs === "number" &&
                    ` · ${health.latencyMs} ms`}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Card className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Selected provider</h3>
            <p className="text-xs text-muted-foreground">
              Lower priority numbers are tried first; on errors the request
              falls through to the next enabled provider.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.enabled}
              aria-label={`Enable ${draft.name}`}
              onCheckedChange={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))}
            />
            Enabled
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-6">
          <div className="space-y-2 md:col-span-4">
            <Label htmlFor="llmName">Provider name</Label>
            <Input
              id="llmName"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))}
            />
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="llmPriority">Priority</Label>
            <Input
              id="llmPriority"
              type="number"
              min={1}
              max={100}
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  priority: Number(event.target.value),
                }))}
            />
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label htmlFor="llmConcurrency" title="Simultaneous requests">
              Parallel req.
            </Label>
            <Input
              id="llmConcurrency"
              type="number"
              min={1}
              max={32}
              value={draft.concurrency}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  concurrency: Number(event.target.value),
                }))}
            />
          </div>
          <div className="space-y-2 md:col-span-4">
            <Label htmlFor="llmBaseUrl">OpenAI-compatible base URL</Label>
            <Input
              id="llmBaseUrl"
              value={draft.baseUrl}
              placeholder="https://openrouter.ai/api/v1"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }))}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="llmApiKey">API key</Label>
            <Input
              id="llmApiKey"
              type="password"
              value={draft.apiKey}
              placeholder="sk-…"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  apiKey: event.target.value,
                }))}
            />
          </div>
        </div>

        <div className="space-y-2 rounded-md border p-4">
          <Label htmlFor="llmModelSelectionMode">Model selection policy</Label>
          <Select
            value={draft.modelSelectionMode}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                modelSelectionMode: value as "fixed" | "automatic",
              }))}
          >
            <SelectTrigger id="llmModelSelectionMode" className="max-w-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
                Fixed — require the configured model
              </SelectItem>
              <SelectItem value="automatic">
                Automatic — use a currently available model
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {draft.modelSelectionMode === "automatic"
              ? "Alias mappings are preferences. If a preferred self-hosted model disappears, Mycelia uses the first model currently advertised by /models. Exact task and chat overrides stay fixed."
              : "Alias mappings are strict. Requests fail or use another provider when the configured model is unavailable."}
          </p>
        </div>

        <div>
          <p className="font-medium">Alias models</p>
          <p className="text-xs text-muted-foreground">
            Tasks may request small / medium / large. Map each alias to one of
            this provider's models. In automatic mode these are preferred
            models; in fixed mode an empty alias is skipped. Profiles can be
            saved while offline or before any model is selected.
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-3">
            {MODEL_ALIASES.map((alias) => (
              <div key={alias} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`alias-${alias}`} className="capitalize">
                    {alias}
                  </Label>
                  <Badge
                    variant={draft.aliases[alias] ? "secondary" : "outline"}
                  >
                    {draft.aliases[alias] ? "Mapped" : "None"}
                  </Badge>
                </div>
                <ModelSelector
                  value={draft.aliases[alias] || ""}
                  onChange={(model) =>
                    setDraft((current) => ({
                      ...current,
                      aliases: {
                        ...current.aliases,
                        [alias]: model,
                      },
                    }))}
                  staticModels={draftModels}
                  staticHeading={`${draft.name || "Provider"} models`}
                  allowCustomValue
                  placeholder="None — alias not served"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Default alias for background tasks</Label>
            <Select
              value={draft.defaultAlias}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  defaultAlias: value as ModelAlias,
                }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_ALIASES.map((alias) => (
                  <SelectItem key={alias} value={alias}>
                    <span className="capitalize">{alias}</span>
                    {draft.aliases[alias] ? ` — ${draft.aliases[alias]}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="llmChatModel">Default chat model (optional)</Label>
            <ModelSelector
              value={draft.chatModel || ""}
              onChange={(model) =>
                setDraft((current) => ({
                  ...current,
                  chatModel: model,
                }))}
              staticModels={draftModels}
              staticHeading={`${draft.name || "Provider"} models`}
              allowCustomValue
              placeholder="Falls back to the default alias model"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.promptCaching?.enabled ?? true}
              onCheckedChange={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  promptCaching: { ...current.promptCaching, enabled },
                }))}
            />
            Prompt caching (OpenRouter)
          </label>
          <div className="w-56 space-y-1">
            <Label htmlFor="llmCachePrefix">Cache session prefix</Label>
            <Input
              id="llmCachePrefix"
              value={draft.promptCaching?.sessionPrefix || "mycelia"}
              disabled={!(draft.promptCaching?.enabled ?? true)}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  promptCaching: {
                    ...current.promptCaching,
                    sessionPrefix: event.target.value,
                  },
                }))}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={checkDraftServer}
            disabled={checkingServer}
          >
            {checkingServer
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Server className="mr-2 h-4 w-4" />}
            Check server
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={loadDraftModels}
            disabled={loadingModels}
          >
            {loadingModels
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Zap className="mr-2 h-4 w-4" />}
            Load models
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2" aria-live="polite">
          <div
            className={`rounded-md border p-3 transition-colors ${
              STATUS_TONE_CLASSES[serverStatusTone].surface
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Server availability</p>
              <StatusBadge
                tone={serverStatusTone}
                label={serverStatusLabel}
                pulse={checkingServer}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {draftProbe?.server?.message ||
                "Check the host without loading its model catalogue."}
              {typeof draftProbe?.server?.latencyMs === "number" &&
                ` · ${draftProbe.server.latencyMs} ms`}
            </p>
          </div>
          <div
            className={`rounded-md border p-3 transition-colors ${
              STATUS_TONE_CLASSES[modelStatusTone].surface
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Provider models</p>
              <StatusBadge
                tone={modelStatusTone}
                label={modelStatusLabel}
                pulse={loadingModels}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {draftProbe?.models?.message ||
                "Load /models to see whether models are available."}
              {typeof draftProbe?.models?.latencyMs === "number" &&
                ` · ${draftProbe.models.latencyMs} ms`}
            </p>
            {draftProbe?.models?.modelsLoaded && (
              <p className="mt-2 break-all font-mono text-xs">
                {draftProbe.models.models.join(", ")}
              </p>
            )}
          </div>
        </div>

        {draft.modelSelectionMode === "automatic" &&
          draftProbe?.models?.modelsLoaded && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
              automaticModelChanged
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {automaticModelChanged
              ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              : <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              <p>
                Runtime model:{" "}
                <span className="font-mono">
                  {automaticRuntimeModel || "none"}
                </span>
              </p>
              {automaticModelChanged && (
                <p className="mt-1 text-xs">
                  Preferred {draft.defaultAlias} model{" "}
                  <span className="font-mono">{preferredDefaultModel}</span>
                  {" "}
                  is no longer advertised. Automatic mode will use the available
                  model shown above without changing the saved preference.
                </p>
              )}
              {!preferredDefaultModel && (
                <p className="mt-1 text-xs">
                  No preferred model is saved; automatic mode uses the first
                  advertised model.
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card className="space-y-5 p-5">
        <div>
          <h3 className="text-lg font-semibold">Model routing for tasks</h3>
          <div className="text-sm text-muted-foreground">
            Each task uses an alias (resolved per provider) or an exact model.
            Empty override means the primary provider default:{" "}
            <Badge variant="secondary">{globalAlias}</Badge>{" "}
            <span className="font-mono text-xs">
              {globalModel ? `→ ${globalModel}` : "(not mapped yet)"}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {MODEL_ROUTES.map((route) => {
            const override = taskModels[route.workerType] || "";
            const effectiveModel = override || globalAlias;
            const fallback = taskFallbackModels[route.workerType] || "";
            const pinnedProviderId = override
              ? taskProviders[route.workerType] || ""
              : "";
            const pinnedProfile = pinnedProviderId
              ? profiles.find((profile) => profile.id === pinnedProviderId)
              : undefined;
            const pinnedProviderName = pinnedProviderId
              ? pinnedProfile?.name ?? pinnedProviderId
              : "";
            // A pin to a disabled/deleted provider makes every job for this
            // task fail — surface it loudly instead of leaving the failure
            // to the jobs page.
            const pinnedProviderBroken = Boolean(
              pinnedProviderId && (!pinnedProfile || !pinnedProfile.enabled),
            );
            return (
              <div
                key={route.workerType}
                className="space-y-3 rounded-md border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{route.label}</p>
                      <Badge variant={override ? "default" : "secondary"}>
                        {override ? "Task override" : "Global default"}
                      </Badge>
                      {pinnedProviderName && (
                        <Badge
                          variant={pinnedProviderBroken
                            ? "destructive"
                            : "outline"}
                        >
                          pinned to {pinnedProviderName}
                        </Badge>
                      )}
                      {pinnedProviderName && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            setTaskProviders((current) => ({
                              ...current,
                              [route.workerType]: "",
                            }))}
                          title="Remove the provider pin; routing picks the provider by priority"
                        >
                          Unpin
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {route.description}
                    </p>
                    {pinnedProviderBroken && (
                      <p className="mt-1 text-xs text-red-500">
                        {pinnedProfile
                          ? "This provider is disabled — jobs for this task will fail until it is enabled or unpinned."
                          : "This provider no longer exists — jobs for this task will fail until unpinned."}
                      </p>
                    )}
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-muted-foreground">Effective primary</p>
                    <p className="max-w-md break-all font-mono">
                      {effectiveModel}
                      {pinnedProviderName ? ` @ ${pinnedProviderName}` : ""}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      On error: {fallback || "provider route fallback"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ModelSelector
                    value={override}
                    onChange={(model) =>
                      setTaskModels((current) => ({
                        ...current,
                        [route.workerType]: model,
                      }))}
                    providerValue={pinnedProviderId || undefined}
                    onSelectWithProvider={(_model, providerProfileId) =>
                      setTaskProviders((current) => ({
                        ...current,
                        [route.workerType]: providerProfileId || "",
                      }))}
                    placeholder={`Use default: ${globalAlias}${
                      globalModel ? ` → ${globalModel}` : ""
                    }`}
                    className="flex-1"
                    prefetch
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!override}
                    onClick={() => {
                      setTaskModels((current) => ({
                        ...current,
                        [route.workerType]: "",
                      }));
                      setTaskProviders((current) => ({
                        ...current,
                        [route.workerType]: "",
                      }));
                    }}
                    title="Use global default"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-2 rounded-md bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label>Fallback after a primary error</Label>
                    <Badge variant={fallback ? "default" : "outline"}>
                      {fallback ? "Task override" : "Route default"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <ModelSelector
                      value={fallback}
                      onChange={(model) =>
                        setTaskFallbackModels((current) => ({
                          ...current,
                          [route.workerType]: model,
                        }))}
                      placeholder="Use the provider route's configured fallback"
                      className="flex-1"
                      prefetch
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={!fallback}
                      onClick={() =>
                        setTaskFallbackModels((current) => ({
                          ...current,
                          [route.workerType]: "",
                        }))}
                      title="Clear the task override; use the provider route's configured fallback"
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                  {fallback && fallback === effectiveModel && (
                    <p className="text-xs text-red-500">
                      Choose a different fallback model, or clear it to stop on
                      error.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Model-level fallback retries within the same provider. Provider-level
          failover across routes happens automatically by priority.
        </p>
      </Card>

      {message && (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
            message.success
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.success
            ? <CheckCircle className="mt-0.5 h-4 w-4" />
            : <XCircle className="mt-0.5 h-4 w-4" />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={saving}>
          {saving
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <Save className="mr-2 h-4 w-4" />}
          Save all providers
        </Button>
        <Button variant="outline" asChild>
          <Link to="/jobs">
            Open Jobs health
            <ExternalLink className="ml-2 h-4 w-4" />
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/settings/speech-to-text">
            Speech-to-text servers
            <ExternalLink className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default InferenceSettingsPage;
