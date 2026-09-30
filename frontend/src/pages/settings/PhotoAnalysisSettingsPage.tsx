import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Profile = {
  id: string;
  name: string;
  providerType: string;
  connectionId?: string;
  model?: string;
  language?: string;
  concurrency?: number;
  maxOutputTokens?: number;
  connectionSnapshot?: { baseUrl: string };
  enabled: boolean;
};
type Settings = {
  googleEnabled: boolean;
  profiles: Profile[];
  activeProfileId?: string;
  connections: {
    id: string;
    name: string;
    enabled: boolean;
    baseUrl?: string;
    credentialConfigured: boolean;
  }[];
};
const initial = {
  id: "general-photos",
  name: "Photo analysis",
  connectionId: "",
  model: "",
  language: "Russian",
  concurrency: 1,
  maxOutputTokens: 1600,
  enabled: true,
};

export default function PhotoAnalysisSettingsPage() {
  const [settings, setSettings] = useState<Settings>();
  const [form, setForm] = useState(initial);
  const [connection, setConnection] = useState({
    name: "Photo connection",
    baseUrl: "",
    apiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const selectProfile = (profile?: Profile) => {
    setForm(
      profile
        ? {
          ...initial,
          ...profile,
          connectionId: profile.connectionId ?? "",
          model: profile.model ?? "",
          language: profile.language ?? "Russian",
          concurrency: profile.concurrency ?? 1,
          maxOutputTokens: profile.maxOutputTokens ?? 1600,
        }
        : initial,
    );
    setSaved(Boolean(profile));
  };
  useEffect(() => {
    callResource("media", { action: "photoSettings" }).then(
      (value: Settings) => {
        setSettings(value);
        selectProfile(
          value.profiles.find((p) =>
            p.id === value.activeProfileId &&
            p.providerType === "openai-compatible"
          ),
        );
      },
    ).catch((e: Error) => setError(e.message));
  }, []);
  const update = (patch: Partial<typeof initial>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await callResource("media", {
        action: "savePhotoProfile",
        profile: {
          ...form,
          providerType: "openai-compatible",
          connectionId: form.connectionId === "new"
            ? "pending"
            : form.connectionId,
        },
        ...(form.connectionId === "new"
          ? { connection: { ...connection, concurrency: form.concurrency } }
          : {}),
      });
      setSettings(result);
      const current = result.profiles.find((p: Profile) => p.id === form.id);
      if (current) selectProfile(current);
      else setSaved(true);
      setConnection((current) => ({ ...current, apiKey: "" }));
      toast.success("Photo analysis settings saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    const profile = settings?.profiles.find((p) => p.id === form.id);
    if (
      !window.confirm(
        `Send one synthetic test image to ${
          profile?.connectionSnapshot?.baseUrl ??
            settings?.connections.find((c) => c.id === form.connectionId)
              ?.baseUrl
        }? Model: ${form.model}. Up to ${form.maxOutputTokens} output tokens. Cost is unknown; provider charges may apply.`,
      )
    ) return;
    setBusy(true);
    setError("");
    try {
      await callResource("media", {
        action: "testPhotoProfile",
        profileId: form.id,
        consent: true,
      });
      toast.success("Image analysis succeeded");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image test failed");
    } finally {
      setBusy(false);
    }
  };
  if (!settings) {
    return <p role="status">{error || "Loading photo settings…"}</p>;
  }
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Photo analysis</h1>
        <Badge variant="secondary">
          {settings.googleEnabled ? "Google is enabled" : "Google is off"}
        </Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vision connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {settings.profiles.filter((p) =>
              p.providerType === "openai-compatible"
            ).map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={form.id === p.id ? "secondary" : "outline"}
                onClick={() => selectProfile(p)}
              >
                {p.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                selectProfile();
                update({ id: `photo-${crypto.randomUUID()}` });
              }}
            >
              New profile
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="photo-name">Profile name</Label>
              <Input
                id="photo-name"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="photo-connection">Connection</Label>
              <select
                id="photo-connection"
                className="h-9 w-full rounded-md border bg-background px-2"
                value={form.connectionId}
                onChange={(e) => update({ connectionId: e.target.value })}
              >
                <option value="">Select existing connection</option>
                {settings.connections.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.enabled}>
                    {c.name}
                    {c.enabled ? "" : " (disabled)"}
                  </option>
                ))}
                <option value="new">New OpenAI-compatible connection</option>
              </select>
            </div>
            {form.connectionId === "new" && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="connection-name">Connection name</Label>
                  <Input
                    id="connection-name"
                    value={connection.name}
                    onChange={(e) =>
                      setConnection({ ...connection, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="photo-url">API base URL</Label>
                  <Input
                    id="photo-url"
                    placeholder="http://localhost:8000/v1"
                    value={connection.baseUrl}
                    onChange={(e) =>
                      setConnection({ ...connection, baseUrl: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="photo-key">API key (optional)</Label>
                  <Input
                    id="photo-key"
                    type="password"
                    autoComplete="new-password"
                    value={connection.apiKey}
                    onChange={(e) =>
                      setConnection({ ...connection, apiKey: e.target.value })}
                  />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="photo-model">Vision model</Label>
              <Input
                id="photo-model"
                value={form.model}
                onChange={(e) => update({ model: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="photo-language">Description language</Label>
              <Input
                id="photo-language"
                value={form.language}
                onChange={(e) => update({ language: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="photo-output-tokens">
                Max output tokens / photo
              </Label>
              <Input
                id="photo-output-tokens"
                type="number"
                min={256}
                max={8192}
                value={form.maxOutputTokens}
                onChange={(e) =>
                  update({ maxOutputTokens: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="photo-concurrency">Parallel photos</Label>
              <Input
                id="photo-concurrency"
                type="number"
                min={1}
                max={8}
                value={form.concurrency}
                onChange={(e) =>
                  update({ concurrency: Number(e.target.value) })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />Enable this photo profile
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !form.connectionId || !form.model.trim()}
              onClick={save}
            >
              Save
            </Button>
            <Button
              variant="outline"
              disabled={busy || !saved || !form.enabled}
              onClick={test}
            >
              Test image
            </Button>
            <Button asChild variant="ghost">
              <Link to="/media/analysis">Analysis & results</Link>
            </Button>
          </div>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">
              Connection and privacy details
            </summary>
            <p className="mt-2">
              Only explicitly selected photos are sent as sanitized previews.
              Existing results stay local. Shared connection capacity also
              limits photo requests. New photo-only connections do not change
              text-model routing. Prices are unknown unless provided by the
              connector.
            </p>
            <p className="mt-2">
              If processing was paused, resume mediaRecognition and
              mediaRecognitionBatch in{" "}
              <Link className="underline" to="/jobs">Jobs</Link>. No library
              batch starts automatically.
            </p>
          </details>
        </CardContent>
      </Card>
      <Link
        className="text-sm text-muted-foreground underline"
        to="/settings/google-cloud"
      >
        Optional Google Cloud settings
      </Link>
    </div>
  );
}
