import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { callResource } from "@/lib/api";
import { ModelSelector } from "@/components/ModelSelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  CheckCircle,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";

type SttProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  priority: number;
  concurrency: number;
};

type RouteHealth = {
  providerProfileId: string;
  status: "healthy" | "loading" | "unavailable" | "misconfigured";
  message: string;
  model?: string;
};

type EnvironmentRoute = {
  configured: boolean;
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  priority: number;
  concurrency: number;
  message: string;
};

const emptyProfile = (): SttProfile => ({
  id: `stt-provider-${Date.now()}`,
  name: "New STT provider",
  baseUrl: "",
  apiKey: "",
  model: "whisper",
  enabled: true,
  priority: 50,
  concurrency: 1,
});

// Keep the local Argmax full Turbo variant selectable before a server probe.
// The probe can add provider-specific models, but should not be required to
// persist a routing snapshot for this known profile.
const knownSttModels = ["large-v3-v20240930_turbo"];

const TranscriptionSettingsPage = () => {
  const [profiles, setProfiles] = useState<SttProfile[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState<SttProfile>(emptyProfile);
  const [includeEnvironment, setIncludeEnvironment] = useState(false);
  const [environmentPriority, setEnvironmentPriority] = useState(50);
  const [environmentRoute, setEnvironmentRoute] = useState<
    EnvironmentRoute | null
  >(null);
  const [batchSize, setBatchSize] = useState(16);
  const [baseTimeout, setBaseTimeout] = useState(120);
  const [perSequenceTimeout, setPerSequenceTimeout] = useState(60);
  const [routeHealth, setRouteHealth] = useState<RouteHealth[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<
    {
      success: boolean;
      text: string;
    } | null
  >(null);

  const modelOptions = useMemo(
    () => Array.from(new Set([...knownSttModels, ...models])),
    [models],
  );

  const refreshHealth = async (): Promise<RouteHealth[]> => {
    setRefreshing(true);
    try {
      const pipeline = await callResource("jobs", {
        action: "services_health",
        force: true,
      });
      const stt = pipeline?.services?.find((service: { id: string }) =>
        service.id === "stt"
      );
      const routes = stt?.routes ?? [];
      setRouteHealth(routes);
      return routes;
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [config, environment] = await Promise.all([
          callResource("config", { action: "get" }),
          callResource("transcription", { action: "environment_status" }),
        ]);
        const legacy = config?.transcription ?? {};
        const saved = config?.transcriptionProfiles?.profiles as
          | Array<Partial<SttProfile>>
          | undefined;
        const nextProfiles: SttProfile[] = saved?.length
          ? saved.map((profile, index) => ({
            id: profile.id || `stt-provider-${index + 1}`,
            name: profile.name || `STT provider ${index + 1}`,
            baseUrl: profile.baseUrl || "",
            apiKey: profile.apiKey || "",
            model: profile.model || "whisper",
            enabled: profile.enabled ?? true,
            priority: profile.priority ?? 50,
            concurrency: profile.concurrency ?? 1,
          }))
          : [{
            id: "primary",
            name: "Primary STT",
            baseUrl: legacy.baseUrl || "",
            apiKey: legacy.apiKey || "",
            model: legacy.model || "whisper",
            enabled: true,
            priority: 50,
            concurrency: 1,
          }];
        const active = nextProfiles.find((profile) => profile.enabled) ??
          nextProfiles[0];
        setProfiles(nextProfiles);
        setActiveId(active.id);
        setDraft(active);
        setIncludeEnvironment(
          config?.transcriptionProfiles?.includeEnvironment ?? false,
        );
        setEnvironmentPriority(
          environment?.priority ??
            config?.transcriptionProfiles?.environmentPriority ?? 50,
        );
        setEnvironmentRoute(environment ?? null);
        setBatchSize(legacy.batchSize ?? 16);
        setBaseTimeout(legacy.batchTimeoutBaseSeconds ?? 120);
        setPerSequenceTimeout(
          legacy.batchTimeoutPerSequenceSeconds ?? 60,
        );
        const routes = await refreshHealth();
        const modelByProfileId = new Map(
          routes
            .filter((route) => Boolean(route.model))
            .map((route) => [route.providerProfileId, route.model!]),
        );
        const profilesWithDetectedModels = nextProfiles.map((profile) => ({
          ...profile,
          model: modelByProfileId.get(profile.id) || profile.model,
        }));
        const activeWithDetectedModel = profilesWithDetectedModels.find(
          (profile) => profile.id === active.id,
        )!;
        setProfiles(profilesWithDetectedModels);
        setDraft(activeWithDetectedModel);
      } catch (error) {
        setMessage({
          success: false,
          text: error instanceof Error
            ? error.message
            : "Failed to load STT settings",
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

  const selectProfile = (id: string) => {
    if (id === activeId) return;
    const committed = currentProfiles;
    const next = committed.find((profile) => profile.id === id);
    if (!next) return;
    setProfiles(committed);
    setActiveId(id);
    setDraft(next);
    setModels([]);
    setMessage(null);
  };

  const addProfile = () => {
    if (currentProfiles.length >= 8) {
      setMessage({
        success: false,
        text: "At most 8 STT providers are allowed.",
      });
      return;
    }
    const next = emptyProfile();
    setProfiles([...currentProfiles, next]);
    setActiveId(next.id);
    setDraft(next);
    setModels([]);
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
    setModels([]);
    setMessage(null);
  };

  const validate = (nextProfiles: SttProfile[]): string | null => {
    for (const profile of nextProfiles) {
      if (!profile.name.trim()) return "Every provider needs a name.";
      if (!profile.baseUrl.trim() || !profile.apiKey.trim()) {
        return `${profile.name}: URL and API key are required.`;
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
        profile.concurrency > 8
      ) {
        return `${profile.name}: slots must be 1-8.`;
      }
    }
    const enabled = nextProfiles.filter((profile) => profile.enabled);
    const total = enabled.reduce(
      (sum, profile) => sum + profile.concurrency,
      includeEnvironment && environmentRoute?.configured ? 1 : 0,
    );
    if (total > 8) return "Enabled STT slots cannot exceed 8 in total.";
    if (
      !Number.isInteger(environmentPriority) || environmentPriority < 1 ||
      environmentPriority > 100
    ) {
      return "Environment priority must be 1-100.";
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) {
      return "Sequences per job must be 1-32.";
    }
    if (
      !Number.isInteger(baseTimeout) || baseTimeout < 60 ||
      baseTimeout > 1800
    ) {
      return "Base timeout must be 60-1800 seconds.";
    }
    if (
      !Number.isInteger(perSequenceTimeout) || perSequenceTimeout < 15 ||
      perSequenceTimeout > 300
    ) {
      return "Per-sequence timeout must be 15-300 seconds.";
    }
    return null;
  };

  const save = async () => {
    const nextProfiles = currentProfiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: profile.apiKey.trim(),
      model: profile.model.trim() || "whisper",
    }));
    const validationError = validate(nextProfiles);
    if (validationError) {
      setMessage({ success: false, text: validationError });
      return;
    }
    const enabled = nextProfiles.filter((profile) => profile.enabled);
    const totalConcurrency = enabled.reduce(
      (sum, profile) => sum + profile.concurrency,
      includeEnvironment && environmentRoute?.configured ? 1 : 0,
    );
    const legacyProfile =
      [...enabled].sort((a, b) =>
        a.priority - b.priority || a.name.localeCompare(b.name)
      )[0] ?? nextProfiles[0];
    setSaving(true);
    setMessage(null);
    try {
      await callResource("config", {
        action: "patch",
        updates: {
          transcriptionProfiles: {
            profiles: nextProfiles,
            includeEnvironment,
            environmentPriority,
          },
          transcription: {
            baseUrl: legacyProfile.baseUrl,
            apiKey: legacyProfile.apiKey,
            model: legacyProfile.model,
            batchSize,
            batchTimeoutBaseSeconds: baseTimeout,
            batchTimeoutPerSequenceSeconds: perSequenceTimeout,
            fallbackEnabled: false,
            fallbackModel: "",
          },
        },
      });
      if (totalConcurrency > 0) {
        await callResource("jobs", {
          action: "set_worker_concurrency",
          workerType: "transcription",
          concurrency: totalConcurrency,
        });
      }
      setProfiles(nextProfiles);
      setDraft(nextProfiles.find((profile) => profile.id === activeId)!);
      setMessage({
        success: true,
        text: totalConcurrency > 0
          ? `Saved ${nextProfiles.length} provider(s); transcription worker concurrency is ${totalConcurrency}.`
          : `Saved ${nextProfiles.length} provider(s); all STT routes are disabled.`,
      });
      await refreshHealth();
    } catch (error) {
      setMessage({
        success: false,
        text: error instanceof Error
          ? error.message
          : "Failed to save STT settings",
      });
    } finally {
      setSaving(false);
    }
  };

  const testActive = async () => {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
      setMessage({ success: false, text: "Enter URL and API key first." });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      const result = await callResource("transcription", {
        action: "health",
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      setMessage({
        success: Boolean(result?.success),
        text: `${draft.name}: ${result?.message || "No health response"}`,
      });
    } catch (error) {
      setMessage({
        success: false,
        text: error instanceof Error
          ? error.message
          : "STT health check failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const result = await callResource("transcription", {
        action: "models",
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      const nextModels = Array.isArray(result?.models) ? result.models : [];
      setModels(nextModels);
      const detectedModel = result?.reportedModel || nextModels[0];
      if (detectedModel) {
        setDraft((current) => ({ ...current, model: detectedModel }));
      }
      setMessage({
        success: Boolean(result?.success),
        text: detectedModel
          ? `${
            result.message || "Loaded STT model"
          } (selected: ${detectedModel})`
          : result?.message ||
            (nextModels.length
              ? `Loaded ${nextModels.length} model(s).`
              : "Provider is healthy and does not expose /v1/models."),
      });
    } catch (error) {
      setMessage({
        success: false,
        text: error instanceof Error ? error.message : "Failed to load models",
      });
    } finally {
      setTesting(false);
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
  const enabledSlots = currentProfiles.filter((profile) => profile.enabled)
    .reduce(
      (sum, profile) => sum + profile.concurrency,
      includeEnvironment && environmentRoute?.configured ? 1 : 0,
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <Server className="h-6 w-6" />
            Speech-to-text servers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage local and remote STT routes, priorities, health and parallel
            capacity in one place.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refreshHealth()}
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
            aria-label="Use environment STT route"
          />
          <div className="min-w-56 flex-1">
            <p className="font-medium">Backend environment route</p>
            <p className="text-xs text-muted-foreground">
              {environmentRoute?.configured
                ? `${environmentRoute.baseUrl} · ${
                  environmentRoute.model || "whisper"
                } · 1 slot · deployment managed`
                : "STT_SERVER_URL / PROXY_API_KEY not configured in the backend environment"}
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
          {healthById.get("environment") && (
            <Badge variant="secondary">
              {healthById.get("environment")!.status}
            </Badge>
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
            " Its URL, API key and default model can only be changed in .env."}
        </p>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            Configured providers ({currentProfiles.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            {enabledSlots}/8 total parallel slots currently selected.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={addProfile}>
            <Plus className="mr-2 h-4 w-4" />
            Add server
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

      <div className="grid gap-3 @xl/settings:grid-cols-2 @4xl/settings:grid-cols-3">
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
                slot{profile.concurrency === 1 ? "" : "s"} ·{" "}
                {profile.model || "model not set"}
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {profile.baseUrl || "URL not set"}
              </span>
              {health && (
                <span className="mt-2 block text-xs">
                  Health: {health.status}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Card className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Selected server</h3>
            <p className="text-xs text-muted-foreground">
              Lower priority numbers run first; equal priorities load-balance.
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

        <div className="grid gap-4 @2xl/settings:grid-cols-6">
          <div className="space-y-2 @2xl/settings:col-span-3">
            <Label htmlFor="sttName">Server name</Label>
            <Input
              id="sttName"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))}
            />
          </div>
          <div className="space-y-2 @2xl/settings:col-span-1">
            <Label htmlFor="sttPriority">Priority</Label>
            <Input
              id="sttPriority"
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
          <div className="space-y-2 @2xl/settings:col-span-1">
            <Label htmlFor="sttSlots">Slots</Label>
            <Input
              id="sttSlots"
              type="number"
              min={1}
              max={8}
              value={draft.concurrency}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  concurrency: Number(event.target.value),
                }))}
            />
          </div>
          <div className="flex items-end text-xs text-muted-foreground @2xl/settings:col-span-1">
            1-8 jobs in parallel
          </div>
          <div className="space-y-2 @2xl/settings:col-span-6">
            <Label htmlFor="sttBaseUrl">OpenAI-compatible base URL</Label>
            <Input
              id="sttBaseUrl"
              value={draft.baseUrl}
              placeholder="http://host.docker.internal:10301"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }))}
            />
          </div>
          <div className="space-y-2 @2xl/settings:col-span-3">
            <Label htmlFor="sttApiKey">API key</Label>
            <Input
              id="sttApiKey"
              type="password"
              value={draft.apiKey}
              placeholder="local-no-auth"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  apiKey: event.target.value,
                }))}
            />
          </div>
          <div className="space-y-2 @2xl/settings:col-span-3">
            <Label htmlFor="sttModel">Model</Label>
            <ModelSelector
              value={draft.model}
              onChange={(model) =>
                setDraft((current) => ({
                  ...current,
                  model,
                }))}
              staticModels={modelOptions}
              staticHeading="STT models"
              allowCustomValue
              placeholder="Select model..."
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={testActive}
            disabled={testing}
          >
            <Zap className="mr-2 h-4 w-4" />
            Test selected
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={loadModels}
            disabled={testing}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${testing ? "animate-spin" : ""}`}
            />
            Load models
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h3 className="font-semibold">Batching and timeout</h3>
          <p className="text-xs text-muted-foreground">
            Batch sequences remain serial inside each job. Server slots are the
            only setting that controls parallel STT requests.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sttBatchSize">Sequences per job</Label>
            <Input
              id="sttBatchSize"
              type="number"
              min={1}
              max={32}
              value={batchSize}
              onChange={(event) => setBatchSize(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sttBaseTimeout">Base timeout (sec)</Label>
            <Input
              id="sttBaseTimeout"
              type="number"
              min={60}
              max={1800}
              value={baseTimeout}
              onChange={(event) => setBaseTimeout(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sttSequenceTimeout">Per sequence (sec)</Label>
            <Input
              id="sttSequenceTimeout"
              type="number"
              min={15}
              max={300}
              value={perSequenceTimeout}
              onChange={(event) =>
                setPerSequenceTimeout(Number(event.target.value))}
            />
          </div>
        </div>
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
          Save all STT servers
        </Button>
        <Button variant="outline" asChild>
          <Link to="/jobs">
            Open Jobs health
            <ExternalLink className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default TranscriptionSettingsPage;
