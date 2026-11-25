import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { callResource } from "@/lib/api";
import {
  type DiarizationProfile,
  type DiarizationReadinessMode,
  getEnabledDiarizationCapacity,
  validateDiarizationRoutes,
} from "@/lib/diarizationSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, RefreshCw, Save, Server, Trash2 } from "lucide-react";

type RouteHealth = {
  providerProfileId: string;
  providerProfileName: string;
  baseUrl?: string;
  status: "healthy" | "loading" | "unavailable" | "misconfigured" | "disabled";
  enabled: boolean;
  priority: number;
  readinessMode?: DiarizationReadinessMode;
  detectedReadinessMode?: "ready" | "legacy-health";
  latencyMs?: number;
  message: string;
};

const statusLabel: Record<RouteHealth["status"], string> = {
  healthy: "Running",
  loading: "Loading model",
  unavailable: "Down",
  misconfigured: "Misconfigured",
  disabled: "Disabled",
};

const readinessModeLabel: Record<DiarizationReadinessMode, string> = {
  auto: "Auto detect",
  strict: "Strict /ready",
  legacy: "Legacy /health",
};

const emptyProfile = (): DiarizationProfile => ({
  id: `diarizator-${Date.now()}`,
  name: "Remote diarizator",
  baseUrl: "https://",
  enabled: true,
  priority: 50,
  concurrency: 1,
  readinessMode: "auto",
});

export default function DiarizationSettingsPage() {
  const [profiles, setProfiles] = useState<DiarizationProfile[]>([]);
  const [includeEnvironment, setIncludeEnvironment] = useState(true);
  const [environmentPriority, setEnvironmentPriority] = useState(50);
  const [environmentConcurrency, setEnvironmentConcurrency] = useState(1);
  const [environmentReadinessMode, setEnvironmentReadinessMode] = useState<
    DiarizationReadinessMode
  >("auto");
  const [health, setHealth] = useState<RouteHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refreshHealth = async () => {
    setRefreshing(true);
    try {
      const pipeline = await callResource("jobs", {
        action: "services_health",
        force: true,
      });
      const service = pipeline?.services?.find((item: { id: string }) =>
        item.id === "diarizator"
      );
      setHealth(service?.routes ?? []);
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Health check failed",
      });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const config = await callResource("config", { action: "get" });
        setProfiles(
          (config?.diarizationProfiles?.profiles ?? []).map(
            (profile: DiarizationProfile) => ({
              ...profile,
              concurrency: profile.concurrency ?? 1,
              readinessMode: profile.readinessMode ?? "auto",
            }),
          ),
        );
        setIncludeEnvironment(
          config?.diarizationProfiles?.includeEnvironment ?? true,
        );
        setEnvironmentPriority(
          config?.diarizationProfiles?.environmentPriority ?? 50,
        );
        setEnvironmentConcurrency(
          config?.diarizationProfiles?.environmentConcurrency ?? 1,
        );
        setEnvironmentReadinessMode(
          config?.diarizationProfiles?.environmentReadinessMode ?? "auto",
        );
        await refreshHealth();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const healthById = useMemo(
    () => new Map(health.map((route) => [route.providerProfileId, route])),
    [health],
  );

  const save = async () => {
    const effectiveEnvironmentConcurrency = environmentReadinessMode ===
        "legacy"
      ? 1
      : environmentConcurrency;
    const normalized = profiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""),
      readinessMode: profile.readinessMode ?? "auto",
      concurrency: profile.readinessMode === "legacy" ? 1 : profile.concurrency,
    }));
    const error = validateDiarizationRoutes(
      normalized,
      includeEnvironment,
      effectiveEnvironmentConcurrency,
    );
    if (error) return setMessage({ ok: false, text: error });
    if (
      !Number.isInteger(environmentPriority) || environmentPriority < 1 ||
      environmentPriority > 100
    ) {
      return setMessage({
        ok: false,
        text: "Environment priority must be 1-100.",
      });
    }
    const totalConcurrency = getEnabledDiarizationCapacity(
      normalized,
      includeEnvironment,
      effectiveEnvironmentConcurrency,
    );
    setSaving(true);
    setMessage(null);
    try {
      await callResource("config", {
        action: "patch",
        updates: {
          diarizationProfiles: {
            profiles: normalized,
            includeEnvironment,
            environmentPriority,
            environmentConcurrency: effectiveEnvironmentConcurrency,
            environmentReadinessMode,
          },
        },
      });
      if (totalConcurrency > 0) {
        await callResource("jobs", {
          action: "set_worker_concurrency",
          workerType: "diarization",
          concurrency: totalConcurrency,
        });
      }
      setProfiles(normalized);
      setEnvironmentConcurrency(effectiveEnvironmentConcurrency);
      const enabledCount = normalized.filter((profile) =>
        profile.enabled
      ).length +
        (includeEnvironment ? 1 : 0);
      setMessage({
        ok: true,
        text: enabledCount > 0
          ? `Diarizator routing saved. Provider capacity and diarization worker concurrency are ${totalConcurrency}.`
          : "Diarizator routing saved. All routes are disabled; their cards remain available for re-enabling.",
      });
      await refreshHealth();
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Failed to save",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const environmentHealth = healthById.get("environment");
  const enabledSlots = getEnabledDiarizationCapacity(
    profiles,
    includeEnvironment,
    environmentConcurrency,
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            <Server className="h-6 w-6" />Diarization servers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose local or remote speaker diarization services. Health here is
            the same gate used when a job starts.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button
            variant="outline"
            onClick={() => void refreshHealth()}
            disabled={refreshing}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />Refresh health
          </Button>
          <nav
            aria-label="Related diarization pages"
            className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs font-medium"
          >
            <Link
              className="text-primary hover:underline"
              to="/jobs?type=diarization"
            >
              Diarization jobs
            </Link>
            <Link className="text-primary hover:underline" to="/audio/pipeline">
              Audio Pipeline
            </Link>
            <Link
              className="text-primary hover:underline"
              to="/settings/voice-identity/operations"
            >
              Generations & identity
            </Link>
          </nav>
        </div>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={includeEnvironment}
            onCheckedChange={setIncludeEnvironment}
            aria-label="Use environment diarizator"
          />
          <div className="min-w-56 flex-1">
            <p className="font-medium">Local / environment route</p>
            <p className="text-xs text-muted-foreground">
              {environmentHealth?.baseUrl ?? "http://host.docker.internal:8085"}
              {" "}
              · DIARIZATION_SERVER_URL · deployment managed
            </p>
          </div>
          <div className="w-32 space-y-1">
            <Label>Readiness</Label>
            <Select
              value={environmentReadinessMode}
              onValueChange={(value) => {
                const mode = value as DiarizationReadinessMode;
                setEnvironmentReadinessMode(mode);
                if (mode === "legacy") setEnvironmentConcurrency(1);
              }}
            >
              <SelectTrigger aria-label="Environment readiness mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(readinessModeLabel).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-32 space-y-1">
            <Label htmlFor="diar-env-priority">Priority</Label>
            <Input
              id="diar-env-priority"
              type="number"
              min={1}
              max={100}
              value={environmentPriority}
              onChange={(event) =>
                setEnvironmentPriority(Number(event.target.value))}
            />
          </div>
          <div className="w-28 space-y-1">
            <Label htmlFor="diar-env-slots">Slots</Label>
            <Input
              id="diar-env-slots"
              type="number"
              min={1}
              max={8}
              value={environmentConcurrency}
              disabled={!includeEnvironment ||
                environmentReadinessMode === "legacy"}
              onChange={(event) =>
                setEnvironmentConcurrency(Number(event.target.value))}
            />
          </div>
          <Badge
            variant={environmentHealth?.status === "healthy"
              ? "secondary"
              : "destructive"}
          >
            {environmentHealth
              ? statusLabel[environmentHealth.status]
              : includeEnvironment
              ? "Not checked"
              : "Disabled"}
          </Badge>
          {environmentHealth?.detectedReadinessMode === "legacy-health" && (
            <Badge variant="outline">Legacy</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {environmentHealth?.message ??
            "Start the CPU diarizator container on this Mac, then refresh health."}
        </p>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            Configured remote servers ({profiles.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Lower priority numbers are preferred; an unhealthy route is skipped.
            {` ${enabledSlots}/8 total parallel slots are selected.`}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            profiles.length < 8 && setProfiles([...profiles, emptyProfile()])}
          disabled={profiles.length >= 8}
        >
          <Plus className="mr-2 h-4 w-4" />Add server
        </Button>
      </div>

      {profiles.length === 0 && (
        <Card className="p-5 text-sm text-muted-foreground">
          No remote diarizators configured. The local environment route is
          currently {includeEnvironment ? "enabled" : "disabled"}.
        </Card>
      )}
      {profiles.map((profile, index) => {
        const routeHealth = healthById.get(profile.id);
        const update = (next: Partial<DiarizationProfile>) =>
          setProfiles(profiles.map((item, itemIndex) =>
            itemIndex === index ? { ...item, ...next } : item
          ));
        return (
          <Card key={profile.id} className="space-y-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={profile.enabled}
                  aria-label={`Enable ${profile.name}`}
                  onCheckedChange={(enabled) => update({ enabled })}
                />Enabled
              </label>
              <div className="flex items-center gap-2">
                <Badge
                  variant={routeHealth?.status === "healthy"
                    ? "secondary"
                    : routeHealth
                    ? "destructive"
                    : "outline"}
                >
                  {routeHealth
                    ? statusLabel[routeHealth.status]
                    : "Save to test"}
                </Badge>
                {routeHealth?.detectedReadinessMode === "legacy-health" && (
                  <Badge variant="outline">Legacy</Badge>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${profile.name}`}
                  onClick={() =>
                    setProfiles(
                      profiles.filter((_, itemIndex) => itemIndex !== index),
                    )}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid gap-4 @4xl/settings:grid-cols-7">
              <div className="space-y-2 @4xl/settings:col-span-2">
                <Label>Name</Label>
                <Input
                  value={profile.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </div>
              <div className="space-y-2 @4xl/settings:col-span-2">
                <Label>Base URL</Label>
                <Input
                  value={profile.baseUrl}
                  placeholder="https://diarizator.example.com"
                  onChange={(event) => update({ baseUrl: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Readiness</Label>
                <Select
                  value={profile.readinessMode ?? "auto"}
                  onValueChange={(value) => {
                    const mode = value as DiarizationReadinessMode;
                    update({
                      readinessMode: mode,
                      ...(mode === "legacy" ? { concurrency: 1 } : {}),
                    });
                  }}
                >
                  <SelectTrigger aria-label={`${profile.name} readiness mode`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(readinessModeLabel).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={profile.priority}
                  onChange={(event) =>
                    update({ priority: Number(event.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label>Slots</Label>
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={profile.concurrency}
                  disabled={profile.readinessMode === "legacy"}
                  onChange={(event) =>
                    update({ concurrency: Number(event.target.value) })}
                />
              </div>
            </div>
            {routeHealth && (
              <p className="text-xs text-muted-foreground">
                {routeHealth.message}
                {routeHealth.latencyMs != null
                  ? ` · ${routeHealth.latencyMs} ms`
                  : ""}
              </p>
            )}
          </Card>
        );
      })}

      {message && (
        <div
          className={`rounded-md border p-3 text-sm ${
            message.ok
              ? "border-green-500/40 bg-green-500/10"
              : "border-destructive/40 bg-destructive/10"
          }`}
        >
          {message.text}
        </div>
      )}
      <Button onClick={() => void save()} disabled={saving}>
        <Save className="mr-2 h-4 w-4" />
        {saving ? "Saving…" : "Save routing and slots"}
      </Button>
    </div>
  );
}
