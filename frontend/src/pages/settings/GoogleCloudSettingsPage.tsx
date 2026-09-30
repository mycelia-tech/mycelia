import { useEffect, useState } from "react";
import { Cloud, Loader2, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

type GoogleProfile = {
  id: string;
  name: string;
  providerType: "google-cloud";
  enabled: boolean;
  concurrency: number;
  projectId: string;
  location: "eu";
  vertexModel: "gemini-3.5-flash-lite";
  embeddingModel: "gemini-embedding-001";
  embeddingLocation: "europe-west4";
  documentAiProcessorId?: string;
  documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07";
  allowGlobalPhotoAnalysis: boolean;
};

type SelfHostedProfile = {
  id: string;
  name: string;
  providerType: "self-hosted";
  enabled: boolean;
  concurrency: number;
  baseUrl: string;
};

type MediaConfig = {
  enabled: boolean;
  activeProfileId?: string;
  profiles: Array<GoogleProfile | SelfHostedProfile>;
  promoGuard: {
    mode: "promo_guarded";
    promotionExpiresAt?: string;
    stopBeforeHours: number;
    monthlyGrossLimitUsd: number;
    dailyGrossLimitUsd: number | null;
    perImportGrossLimitUsd: number;
    creditVerifiedAt?: string;
    creditVerifiedProjectId?: string;
    verifiedRemainingUsd?: number;
    verifiedBillingAccountType?:
      | "not_verified"
      | "free_trial"
      | "paid_with_promo";
    creditVerifiedBillingAccountType?:
      | "not_verified"
      | "free_trial"
      | "paid_with_promo";
    creditVerifiedPromotionExpiresAt?: string;
  };
  limits: {
    maxFilesPerImport: number;
    maxImageBytes: number;
    maxPdfBytes: number;
    maxPdfPages: number;
  };
  eventAggregation: {
    maxGapMinutes: number;
    maxDistanceKm: number;
    linkWindowMinutes: number;
    maxAssetsPerEvent: number;
    maxPreviewsPerAnalysis: number;
    perEventGrossLimitUsd: number;
  };
};

type ConnectorStatus = {
  googleEnabled?: boolean;
  enabled: boolean;
  sourceConfigured: boolean;
  adc: {
    configured: boolean;
    credentialPathConfigured: boolean;
    error?: string;
  };
  promoGuard: MediaConfig["promoGuard"] & {
    creditVerificationFresh: boolean;
    paidUsageAllowed?: boolean;
    creditVerificationError?: string;
  };
  usage: {
    month: string;
    day: string;
    grossCommittedUsd: number;
    grossReservedUsd: number;
    grossMonthUsd: number;
    grossTodayUsd: number;
    monthlyLimitUsd: number;
    dailyLimitUsd: number | null;
    monthlyRemainingUsd: number;
    dailyRemainingUsd: number | null;
  };
  connectorTestEstimateUsd: {
    vertexAndVision: number;
    withDocumentAi: number;
  };
};

const defaultConfig: MediaConfig = {
  enabled: false,
  profiles: [],
  promoGuard: {
    mode: "promo_guarded",
    stopBeforeHours: 72,
    monthlyGrossLimitUsd: 1,
    dailyGrossLimitUsd: 0.1,
    perImportGrossLimitUsd: 0.01,
  },
  limits: {
    maxFilesPerImport: 200,
    maxImageBytes: 20_000_000,
    maxPdfBytes: 32_000_000,
    maxPdfPages: 15,
  },
  eventAggregation: {
    maxGapMinutes: 240,
    maxDistanceKm: 25,
    linkWindowMinutes: 90,
    maxAssetsPerEvent: 50,
    maxPreviewsPerAnalysis: 8,
    perEventGrossLimitUsd: 0.02,
  },
};

function normalizeConfig(value: Partial<MediaConfig> | null): MediaConfig {
  const stored = value ?? {};
  return {
    ...defaultConfig,
    ...stored,
    profiles: (stored.profiles ?? []).map((profile) =>
      profile.providerType === "google-cloud"
        ? {
          ...profile,
          vertexModel: profile.vertexModel ??
            ("gemini-3.5-flash-lite" as const),
          embeddingModel: profile.embeddingModel ??
            ("gemini-embedding-001" as const),
          embeddingLocation: profile.embeddingLocation ??
            ("europe-west4" as const),
        }
        : profile
    ),
    promoGuard: {
      ...defaultConfig.promoGuard,
      ...(stored.promoGuard ?? {}),
    },
    limits: { ...defaultConfig.limits, ...(stored.limits ?? {}) },
    eventAggregation: {
      ...defaultConfig.eventAggregation,
      ...(stored.eventAggregation ?? {}),
    },
  };
}

function toLocalDateTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function GoogleCloudSettingsPage() {
  const [config, setConfig] = useState<MediaConfig>(defaultConfig);
  const [status, setStatus] = useState<ConnectorStatus>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [verifiedBalance, setVerifiedBalance] = useState("");
  const [billingAccountType, setBillingAccountType] = useState<
    "not_verified" | "free_trial" | "paid_with_promo"
  >("not_verified");

  const load = async () => {
    setLoading(true);
    try {
      const [stored, connector] = await Promise.all([
        callResource("config", { action: "get", path: "mediaKnowledge" }),
        callResource("media", { action: "status" }),
      ]);
      const normalized = normalizeConfig(stored);
      setConfig(normalized);
      setBillingAccountType(
        normalized.promoGuard.verifiedBillingAccountType ?? "not_verified",
      );
      setStatus(connector);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load media settings",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const google = config.profiles.find((profile) =>
    profile.providerType === "google-cloud"
  ) as GoogleProfile | undefined;
  const selfHosted = config.profiles.find((profile) =>
    profile.providerType === "self-hosted"
  ) as SelfHostedProfile | undefined;
  const activeProfile = config.profiles.find((profile) =>
    profile.id === config.activeProfileId
  );

  const updateProfile = (profile: GoogleProfile | SelfHostedProfile) => {
    setConfig((current) => ({
      ...current,
      profiles: current.profiles.some((entry) => entry.id === profile.id)
        ? current.profiles.map((entry) =>
          entry.id === profile.id ? profile : entry
        )
        : [...current.profiles, profile],
      activeProfileId: current.activeProfileId ??
        (profile.enabled ? profile.id : undefined),
    }));
  };

  const addGooglePreset = () =>
    updateProfile({
      id: "google-cloud-media",
      name: "Google Cloud EU Photo Knowledge",
      providerType: "google-cloud",
      enabled: false,
      concurrency: 1,
      projectId: "",
      location: "eu",
      vertexModel: "gemini-3.5-flash-lite",
      embeddingModel: "gemini-embedding-001",
      embeddingLocation: "europe-west4",
      documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
      allowGlobalPhotoAnalysis: false,
    });

  const addSelfHostedPreset = () =>
    updateProfile({
      id: "self-hosted-media",
      name: "Self-hosted media recognition",
      providerType: "self-hosted",
      enabled: false,
      concurrency: 1,
      baseUrl: "http://host.docker.internal:8090",
    });

  const save = async (next = config) => {
    setSaving(true);
    try {
      await callResource("config", {
        action: "patch",
        path: "mediaKnowledge",
        updates: next,
      });
      setConfig(next);
      toast.success("Media recognition settings saved");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const verifyCredit = async () => {
    const remaining = Number(verifiedBalance);
    const paidUsageAllowed = billingAccountType === "paid_with_promo";
    const expiresAt = new Date(
      config.promoGuard.promotionExpiresAt ?? "",
    ).getTime();
    if (
      !google?.projectId ||
      billingAccountType === "not_verified" ||
      (!paidUsageAllowed && (
        !Number.isFinite(remaining) ||
        remaining <= 0 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ))
    ) {
      toast.error(
        paidUsageAllowed
          ? "Confirm the exact paid Billing account type and project ID"
          : "Confirm the exact Billing account type, project ID, remaining credit, and a future promotion expiry shown in Cloud Billing",
      );
      return;
    }
    const next = {
      ...config,
      promoGuard: {
        ...config.promoGuard,
        creditVerifiedAt: new Date().toISOString(),
        creditVerifiedProjectId: google.projectId,
        verifiedRemainingUsd: Number.isFinite(remaining) && remaining > 0
          ? remaining
          : config.promoGuard.verifiedRemainingUsd,
        verifiedBillingAccountType: billingAccountType,
        creditVerifiedBillingAccountType: billingAccountType,
        creditVerifiedPromotionExpiresAt: config.promoGuard.promotionExpiresAt,
      },
    };
    await save(next);
  };

  const test = async () => {
    if (!config.activeProfileId) return;
    setTesting(true);
    try {
      const result = await callResource("media", {
        action: "testConnector",
        profileId: config.activeProfileId,
        includeDocumentAi: Boolean(google?.documentAiProcessorId),
      });
      toast.success(`Connector works (${result.latencyMs ?? "?"} ms)`);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Connector test failed",
      );
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="p-6">Loading media settings…</div>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" /> Google Cloud (optional)
          </CardTitle>
          <CardDescription>
            Visual understanding uses Gemini on Vertex AI through server-side
            Application Default Credentials. Gemini API / AI Studio keys are not
            accepted or stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor="google-services">
              Allow Google services in Mycelia
            </Label>
            <Switch
              id="google-services"
              checked={status?.googleEnabled === true}
              disabled={saving}
              onCheckedChange={async (enabled) => {
                if (
                  enabled &&
                  !window.confirm(
                    "Enable Google services? Requests may incur charges after credits expire.",
                  )
                ) return;
                setSaving(true);
                try {
                  await callResource("config", {
                    action: "patch",
                    path: "externalServices.google",
                    updates: { enabled },
                  });
                  await load();
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : "Save failed",
                  );
                } finally {
                  setSaving(false);
                }
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={status?.sourceConfigured ? "default" : "secondary"}>
              Media folder{" "}
              {status?.sourceConfigured ? "mounted" : "not mounted"}
            </Badge>
            <Badge
              variant={status?.adc?.configured ? "default" : "destructive"}
            >
              ADC {status?.adc?.configured ? "ready" : "unavailable"}
            </Badge>
            <Badge
              variant={status?.promoGuard?.creditVerificationFresh
                ? "default"
                : "secondary"}
            >
              {status?.promoGuard?.verifiedBillingAccountType ===
                  "paid_with_promo"
                ? `Paid usage ${
                  status?.promoGuard?.paidUsageAllowed ? "allowed" : "blocked"
                }`
                : `Credit check ${
                  status?.promoGuard?.creditVerificationFresh
                    ? "fresh"
                    : "required"
                }`}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Billing/auth route: server-side ADC → quota project{" "}
            <code>{google?.projectId ?? "not configured"}</code>. Google applies
            promotional credit through Cloud Billing; no static API key selects
            the credit.
          </p>
          {!status?.adc?.configured && status?.adc?.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              ADC check failed: {status.adc.error}
            </div>
          )}
          {!status?.promoGuard?.creditVerificationFresh &&
            status?.promoGuard?.creditVerificationError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              Promo guard is closed: {status.promoGuard.creditVerificationError}
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Enable Media Knowledge</Label>
              <p className="text-sm text-muted-foreground">
                Allows confirmed imports to call the selected provider.
              </p>
            </div>
            <Switch
              aria-label="Enable Media Knowledge"
              checked={config.enabled}
              onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
            />
          </div>

          {!google && (
            <Button variant="outline" onClick={addGooglePreset}>
              Add Google Cloud preset
            </Button>
          )}
          {google && (
            <div className="space-y-4 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{google.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Primary: Vertex AI Flash-Lite visual understanding in EU.
                    OCR is optional; labels/objects are a separate global
                    opt-in.
                  </div>
                </div>
                <Switch
                  aria-label="Enable Google Cloud media profile"
                  checked={google.enabled}
                  onCheckedChange={(enabled) =>
                    updateProfile({ ...google, enabled })}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="google-cloud-project-id">
                    Google project ID
                  </Label>
                  <Input
                    id="google-cloud-project-id"
                    value={google.projectId}
                    onChange={(event) =>
                      updateProfile({
                        ...google,
                        projectId: event.target.value,
                      })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="google-cloud-document-ai-processor-id">
                    Document AI EU processor ID (optional PDF OCR)
                  </Label>
                  <Input
                    id="google-cloud-document-ai-processor-id"
                    value={google.documentAiProcessorId ?? ""}
                    onChange={(event) =>
                      updateProfile({
                        ...google,
                        documentAiProcessorId: event.target.value || undefined,
                      })}
                  />
                </div>
              </div>
              <div className="text-sm">
                Vertex endpoint: <code>eu</code> · visual model:{" "}
                <code>{google.vertexModel}</code> · semantic embeddings:{" "}
                <code>{google.embeddingModel}</code> at regional endpoint{" "}
                <code>{google.embeddingLocation}</code>
              </div>
              <div className="flex items-center justify-between rounded-md bg-muted p-3">
                <div>
                  <Label>Allow global labels and objects</Label>
                  <p className="text-xs text-muted-foreground">
                    Still requires per-import confirmation.
                  </p>
                </div>
                <Switch
                  aria-label="Allow global labels and objects"
                  checked={google.allowGlobalPhotoAnalysis}
                  onCheckedChange={(allowGlobalPhotoAnalysis) =>
                    updateProfile({ ...google, allowGlobalPhotoAnalysis })}
                />
              </div>
            </div>
          )}

          {!selfHosted && (
            <Button variant="outline" onClick={addSelfHostedPreset}>
              Add self-hosted provider
            </Button>
          )}
          {selfHosted && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">{selfHosted.name}</div>
                <Switch
                  aria-label="Enable self-hosted media profile"
                  checked={selfHosted.enabled}
                  onCheckedChange={(enabled) =>
                    updateProfile({ ...selfHosted, enabled })}
                />
              </div>
              <Label htmlFor="self-hosted-media-base-url">
                Open media API base URL
              </Label>
              <Input
                id="self-hosted-media-base-url"
                value={selfHosted.baseUrl}
                onChange={(event) =>
                  updateProfile({ ...selfHosted, baseUrl: event.target.value })}
              />
            </div>
          )}

          {config.profiles.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="media-active-provider">Active provider</Label>
              <select
                id="media-active-provider"
                className="w-full rounded-md border bg-background p-2"
                value={config.activeProfileId ?? ""}
                onChange={(event) =>
                  setConfig({ ...config, activeProfileId: event.target.value })}
              >
                <option value="" disabled>Choose an enabled provider</option>
                {config.profiles.map((profile) => (
                  <option
                    key={profile.id}
                    value={profile.id}
                    disabled={!profile.enabled}
                  >
                    {profile.name}
                    {profile.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Switching applies to new recognition and explicit Retry jobs.
                Existing analysis stays versioned. Semantic vectors are matched
                only within the same embedding model and dimensions, so older
                assets must be retried with the new provider to join its
                semantic index; stored OCR and labels remain searchable.
              </p>
            </div>
          )}

          <div className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 md:grid-cols-4">
            {status?.usage && (
              <div className="grid gap-2 rounded-md bg-background/80 p-3 text-sm md:col-span-4 md:grid-cols-4">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Month used / stop
                  </div>
                  <div className="font-medium">
                    ${status.usage.grossMonthUsd.toFixed(4)}{" "}
                    / ${status.usage.monthlyLimitUsd.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Today used / stop
                  </div>
                  <div className="font-medium">
                    ${status.usage.grossTodayUsd.toFixed(4)} /{" "}
                    {status.usage.dailyLimitUsd === null
                      ? "No daily limit"
                      : `$${status.usage.dailyLimitUsd.toFixed(2)}`}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Committed</div>
                  <div className="font-medium">
                    ${status.usage.grossCommittedUsd.toFixed(4)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Reserved</div>
                  <div className="font-medium">
                    ${status.usage.grossReservedUsd.toFixed(4)}
                  </div>
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="google-cloud-monthly-stop">
                Monthly gross stop, USD
              </Label>
              <Input
                id="google-cloud-monthly-stop"
                type="number"
                value={config.promoGuard.monthlyGrossLimitUsd}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    promoGuard: {
                      ...config.promoGuard,
                      monthlyGrossLimitUsd: Number(event.target.value),
                    },
                  })}
              />
            </div>
            <div>
              <Label htmlFor="google-cloud-stop-before-hours">
                Stop before expiry, hours
              </Label>
              <Input
                id="google-cloud-stop-before-hours"
                type="number"
                min="1"
                max="168"
                value={config.promoGuard.stopBeforeHours}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    promoGuard: {
                      ...config.promoGuard,
                      stopBeforeHours: Number(event.target.value),
                    },
                  })}
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="google-cloud-daily-limit-enabled">
                  Daily limit
                </Label>
                <Switch
                  id="google-cloud-daily-limit-enabled"
                  checked={config.promoGuard.dailyGrossLimitUsd !== null}
                  onCheckedChange={(enabled) =>
                    setConfig({
                      ...config,
                      promoGuard: {
                        ...config.promoGuard,
                        dailyGrossLimitUsd: enabled ? 0.1 : null,
                      },
                    })}
                />
              </div>
              {config.promoGuard.dailyGrossLimitUsd === null
                ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No daily limit. Monthly and batch limits still apply.
                  </p>
                )
                : (
                  <Input
                    id="google-cloud-daily-stop"
                    aria-label="Daily stop, USD"
                    type="number"
                    min="0.01"
                    max="50"
                    step="0.01"
                    value={config.promoGuard.dailyGrossLimitUsd}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        promoGuard: {
                          ...config.promoGuard,
                          dailyGrossLimitUsd: Number(event.target.value),
                        },
                      })}
                  />
                )}
            </div>
            <div>
              <Label htmlFor="google-cloud-per-import-stop">
                Per asset recognition, USD
              </Label>
              <Input
                id="google-cloud-per-import-stop"
                type="number"
                value={config.promoGuard.perImportGrossLimitUsd}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    promoGuard: {
                      ...config.promoGuard,
                      perImportGrossLimitUsd: Number(event.target.value),
                    },
                  })}
              />
            </div>
            <p className="text-xs text-muted-foreground md:col-span-4">
              This is a fail-closed application guard, not a Google billing
              guarantee. Free-trial mode stops processing{" "}
              {config.promoGuard.stopBeforeHours}{" "}
              hours before the configured promotion expiry. Defaults are
              $1/month, $0.10/day, and $0.01 per asset.
            </p>
          </div>

          <div className="space-y-3 rounded-md border p-4">
            <div>
              <Label>Photo event aggregation</Label>
              <p className="text-xs text-muted-foreground">
                Clustering by time and GPS is local. A separate confirmation is
                required before up to{" "}
                {config.eventAggregation.maxPreviewsPerAnalysis}{" "}
                sanitized previews are sent to the selected provider for an
                event title, description, anonymous participant ranges, actions,
                and highlights.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <Label htmlFor="media-event-gap">Default gap, minutes</Label>
                <Input
                  id="media-event-gap"
                  type="number"
                  min="15"
                  max="1440"
                  value={config.eventAggregation.maxGapMinutes}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        maxGapMinutes: Number(event.target.value),
                      },
                    })}
                />
              </div>
              <div>
                <Label htmlFor="media-event-distance">
                  Default distance, km
                </Label>
                <Input
                  id="media-event-distance"
                  type="number"
                  min="0.1"
                  max="500"
                  step="0.1"
                  value={config.eventAggregation.maxDistanceKm}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        maxDistanceKm: Number(event.target.value),
                      },
                    })}
                />
              </div>
              <div>
                <Label htmlFor="media-event-link-window">
                  Audio link window, minutes
                </Label>
                <Input
                  id="media-event-link-window"
                  type="number"
                  min="1"
                  max="1440"
                  value={config.eventAggregation.linkWindowMinutes}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        linkWindowMinutes: Number(event.target.value),
                      },
                    })}
                />
              </div>
              <div>
                <Label htmlFor="media-event-max-assets">
                  Maximum photos per event
                </Label>
                <Input
                  id="media-event-max-assets"
                  type="number"
                  min="2"
                  max="200"
                  value={config.eventAggregation.maxAssetsPerEvent}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        maxAssetsPerEvent: Number(event.target.value),
                      },
                    })}
                />
              </div>
              <div>
                <Label htmlFor="media-event-max-previews">
                  Provider previews per event
                </Label>
                <Input
                  id="media-event-max-previews"
                  type="number"
                  min="2"
                  max="12"
                  value={config.eventAggregation.maxPreviewsPerAnalysis}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        maxPreviewsPerAnalysis: Number(event.target.value),
                      },
                    })}
                />
              </div>
              <div>
                <Label htmlFor="media-event-cost-stop">
                  Per event gross stop, USD
                </Label>
                <Input
                  id="media-event-cost-stop"
                  type="number"
                  min="0.001"
                  max="1"
                  step="0.001"
                  value={config.eventAggregation.perEventGrossLimitUsd}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      eventAggregation: {
                        ...config.eventAggregation,
                        perEventGrossLimitUsd: Number(event.target.value),
                      },
                    })}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-4">
            <div>
              <Label>Promotional-credit confirmation</Label>
              <p className="text-xs text-muted-foreground">
                In Cloud Billing, copy the exact account type, project,
                remaining promotional balance, and promotion expiry. Choose the
                paid-account option only as an explicit acknowledgement that
                Google can charge real money. Free-trial confirmation expires
                after 24 hours. Paid usage acknowledgement remains active and is
                locked to this project ID; the application gross limits still
                apply.
              </p>
            </div>
            <div className="space-y-2 rounded-md border border-amber-500/40 p-3">
              <Label htmlFor="google-cloud-billing-account-type">
                Billing Overview account type
              </Label>
              <select
                id="google-cloud-billing-account-type"
                className="w-full rounded-md border bg-background p-2"
                value={billingAccountType}
                onChange={(event) => {
                  const value = event.target.value as typeof billingAccountType;
                  setBillingAccountType(value);
                  setConfig((current) => ({
                    ...current,
                    promoGuard: {
                      ...current.promoGuard,
                      verifiedBillingAccountType: value,
                      creditVerifiedBillingAccountType: "not_verified",
                    },
                  }));
                }}
              >
                <option value="not_verified">
                  Not confirmed — block Google calls
                </option>
                <option value="free_trial">
                  Free trial account — Google says no automatic charges
                </option>
                <option value="paid_with_promo">
                  Paid account — allow charges without daily confirmation
                </option>
              </select>
              <p className="text-xs text-muted-foreground">
                Paid mode permanently acknowledges real-charge risk for this
                project. Mycelia's monthly, per-asset, per-event, and any
                enabled daily gross limits still apply, but they cannot replace
                Google Billing.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="google-cloud-verified-project">
                  Verified project
                </Label>
                <Input
                  id="google-cloud-verified-project"
                  value={google?.projectId ?? ""}
                  readOnly
                  placeholder="Add the Google preset and project ID first"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="google-cloud-remaining-credit">
                  Remaining promotional credit, USD
                </Label>
                <Input
                  id="google-cloud-remaining-credit"
                  type="number"
                  min="0.01"
                  max="300"
                  step="0.01"
                  value={verifiedBalance}
                  onChange={(event) => setVerifiedBalance(event.target.value)}
                  placeholder={config.promoGuard.verifiedRemainingUsd
                    ?.toString() ?? "300"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="google-cloud-promotion-expiry">
                  Promotion expires at (local time)
                </Label>
                <Input
                  id="google-cloud-promotion-expiry"
                  type="datetime-local"
                  value={toLocalDateTime(
                    config.promoGuard.promotionExpiresAt,
                  )}
                  onChange={(event) => {
                    const date = new Date(event.target.value);
                    if (!Number.isFinite(date.getTime())) return;
                    setConfig({
                      ...config,
                      promoGuard: {
                        ...config.promoGuard,
                        promotionExpiresAt: date.toISOString(),
                        creditVerifiedPromotionExpiresAt:
                          "1970-01-01T00:00:00.000Z",
                      },
                    });
                  }}
                />
              </div>
            </div>
            {config.promoGuard.creditVerifiedAt && (
              <p className="text-xs text-muted-foreground">
                Last confirmation: {config.promoGuard.creditVerifiedAt}{" "}
                · project {config.promoGuard.creditVerifiedProjectId ?? "?"}
                {" "}
                · remaining ${config.promoGuard.verifiedRemainingUsd ?? "?"}
                {" "}
                · account {config.promoGuard.verifiedBillingAccountType ??
                  "not confirmed"}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save()} disabled={saving}>
              {saving
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Save className="mr-2 h-4 w-4" />} Save
            </Button>
            <Button variant="outline" onClick={verifyCredit} disabled={saving}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              {billingAccountType === "paid_with_promo"
                ? "Confirm paid usage for this project"
                : "Confirm promo credit now"}
            </Button>
            <Button
              variant="outline"
              onClick={test}
              disabled={testing || !activeProfile?.enabled}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {" "}
              {activeProfile?.providerType === "google-cloud"
                ? "Test Vertex + Vision OCR"
                : "Test selected visual provider"}
            </Button>
          </div>
          {activeProfile?.providerType === "google-cloud" &&
            status?.connectorTestEstimateUsd && (
            <p className="text-xs text-muted-foreground">
              The synthetic test sends a generated 1×1 PNG to Vertex AI and
              Cloud Vision EU OCR. It reserves at most ${status
                .connectorTestEstimateUsd.vertexAndVision.toFixed(4)}.
              {google?.documentAiProcessorId && (
                <>
                  {" "}With the optional Document AI test, the maximum is
                  ${status.connectorTestEstimateUsd.withDocumentAi.toFixed(4)}.
                </>
              )} No user photo is used.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
