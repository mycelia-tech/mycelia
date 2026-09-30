import { useEffect, useState } from "react";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Save, Loader2, Settings, FileText, Zap, RefreshCw } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const configFormSchema = z.object({
  inference: z.object({
    baseUrl: z.string().url("Must be a valid URL").optional(),
    apiKey: z.string().optional(),
  }).optional(),
  rawConfig: z.string().optional(),
});

type ConfigFormData = z.infer<typeof configFormSchema>;

const ConfigSettingsPage = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRawEditor, setShowRawEditor] = useState(false);

  const form = useForm<ConfigFormData>({
    resolver: zodResolver(configFormSchema),
    defaultValues: {
      inference: {
        baseUrl: "",
        apiKey: "",
      },
      rawConfig: "",
    },
  });

  const fetchConfig = async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await callResource("config", {
        action: "get",
      });

      form.reset({
        inference: {
          baseUrl: result.inference?.baseUrl || "",
          apiKey: result.inference?.apiKey || "",
        },
        rawConfig: JSON.stringify(result, null, 2),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch configuration");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleSaveConfig = async (data: ConfigFormData) => {
    try {
      setSaving(true);
      setError(null);

      if (showRawEditor && data.rawConfig) {
        // Save raw JSON config
        const parsedConfig = JSON.parse(data.rawConfig);
        await callResource("config", {
          action: "update",
          config: parsedConfig,
        });
      } else {
        // Save form data as patches
        const updates: { inference?: ConfigFormData["inference"] } = {};

        if (data.inference?.baseUrl || data.inference?.apiKey) {
          updates.inference = data.inference;
        }

        await callResource("config", {
          action: "patch",
          updates,
        });
      }

      // Refresh config after save
      await fetchConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium">Configuration</h3>
          <p className="text-sm text-muted-foreground">
            Manage server configuration settings
          </p>
        </div>
        <div className="flex items-center justify-center p-8">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Configuration</h3>
        <p className="text-sm text-muted-foreground">
          Manage server configuration settings. Changes are applied immediately.
        </p>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          variant={showRawEditor ? "outline" : "default"}
          onClick={() => setShowRawEditor(false)}
        >
          <Settings className="w-4 h-4 mr-2" />
          Form Editor
        </Button>
        <Button
          variant={showRawEditor ? "default" : "outline"}
          onClick={() => setShowRawEditor(true)}
        >
          <FileText className="w-4 h-4 mr-2" />
          Raw JSON
        </Button>
        <Button variant="outline" onClick={fetchConfig} disabled={loading}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      <form onSubmit={form.handleSubmit(handleSaveConfig)} className="space-y-6">
        {!showRawEditor ? (
          <>
            {/* Inference Configuration */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  Inference Provider
                </CardTitle>
                <CardDescription>
                  Configure your AI inference provider settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="baseUrl">Base URL</Label>
                  <Input
                    id="baseUrl"
                    placeholder="http://your-openai-compatible-server:8080/v1"
                    {...form.register("inference.baseUrl")}
                  />
                  {form.formState.errors.inference?.baseUrl && (
                    <p className="text-sm text-destructive mt-1">
                      {form.formState.errors.inference.baseUrl.message}
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="apiKey">API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder="Your API key"
                    {...form.register("inference.apiKey")}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Configuration Info */}
            <Card>
              <CardHeader>
                <CardTitle>Configuration Priority</CardTitle>
                <CardDescription>
                  Configuration values are resolved in this order:
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="default">1. Database</Badge>
                    <span className="text-sm">Highest priority (this form)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">2. config.yml</Badge>
                    <span className="text-sm">File-based configuration</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">3. Defaults</Badge>
                    <span className="text-sm">Schema default values</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Raw Configuration</CardTitle>
              <CardDescription>
                Edit the configuration as JSON. Be careful - invalid JSON will be rejected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={20}
                className="font-mono text-sm"
                {...form.register("rawConfig")}
              />
              {form.formState.errors.rawConfig && (
                <p className="text-sm text-destructive mt-2">
                  {form.formState.errors.rawConfig.message}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save Configuration
          </Button>
        </div>
      </form>
    </div>
  );
};

export default ConfigSettingsPage;
