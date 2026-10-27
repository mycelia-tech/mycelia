import {
  probeProviderConnection,
  type ProviderProbe,
} from "@/lib/providerProbe";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsStore } from "@/stores/settingsStore";
import { callResource } from "@/lib/api";
import { getCurrentJWT } from "@/lib/auth";
import { ArrowRight, CheckCircle2, Cpu, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SetupStatus = "checking" | "idle" | "saving" | "success" | "error";

export default function InferenceSetupPage() {
  const navigate = useNavigate();
  const { sessionStatus } = useSettingsStore();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SetupStatus>("checking");
  const [probe, setProbe] = useState<ProviderProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const probeVersion = useRef(0);
  useEffect(() => {
    probeVersion.current += 1;
    setProbe(null);
    setProbing(false);
    return () => {
      probeVersion.current += 1;
    };
  }, [baseUrl, apiKey]);
  const checkConnection = async () => {
    const version = ++probeVersion.current;
    setProbing(true);
    try {
      const result = await probeProviderConnection(baseUrl, apiKey);
      if (version === probeVersion.current) setProbe(result);
    } catch (error) {
      if (version === probeVersion.current) {
        setProbe({
          available: false,
          success: false,
          message: error instanceof Error
            ? error.message
            : "Could not check provider connection.",
        });
      }
    } finally {
      if (version === probeVersion.current) setProbing(false);
    }
  };
  const connectionText = probe
    ? `${
      probe.success
        ? "Provider connection verified"
        : "Provider connection could not be verified"
    }: ${probe.message}`
    : "Provider connection has not been checked.";
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check if inference is already configured
  useEffect(() => {
    if (sessionStatus === "unknown") {
      void getCurrentJWT();
      return;
    }
    if (sessionStatus === "anonymous") {
      navigate("/setup", { replace: true });
      return;
    }

    const checkExistingConfig = async () => {
      try {
        const config = await callResource("config", {
          action: "get",
        });

        // If inference is already configured with both baseUrl and apiKey, skip this step
        if (config?.inference?.baseUrl && config?.inference?.apiKey) {
          navigate("/", { replace: true });
          return;
        }

        // Pre-fill with existing values if available
        if (config?.inference?.baseUrl) {
          setBaseUrl(config.inference.baseUrl);
        }
        if (config?.inference?.apiKey) {
          setApiKey(config.inference.apiKey);
        }

        setStatus("idle");
      } catch (error) {
        // If check fails, just show the form
        console.error("Failed to check existing config:", error);
        setStatus("idle");
      }
    };

    checkExistingConfig();
  }, [sessionStatus, navigate]);

  const saveInferenceConfig = async () => {
    setStatus("saving");

    try {
      await callResource("config", {
        action: "patch",
        path: "inference",
        updates: {
          baseUrl,
          apiKey,
        },
      });

      setErrorMessage(null);
      setStatus("success");
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to save configuration",
      );
    }
  };

  const skipSetup = () => {
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 mb-6 shadow-lg shadow-cyan-500/30">
            <Cpu className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
            Inference Provider
          </h1>
          <p className="text-slate-300 text-lg">
            Configure your AI inference backend
          </p>
        </div>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-3 h-3 rounded-full bg-green-400" />
          <div className="w-8 h-0.5 bg-green-400" />
          <div className="w-3 h-3 rounded-full bg-purple-400 ring-2 ring-purple-400/50" />
        </div>

        {/* Setup Card */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 border border-white/20 shadow-2xl">
          {status === "checking" && (
            <div className="text-center py-8">
              <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mx-auto mb-4" />
              <p className="text-white text-lg font-medium">
                Checking configuration...
              </p>
            </div>
          )}

          {(status === "idle" || status === "saving" || status === "error") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveInferenceConfig();
              }}
            >
              {status === "error" && (
                <div className="mb-6 p-4 rounded-lg bg-red-500/20 border border-red-500/30">
                  <div className="flex items-start gap-3">
                    <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-red-300 font-medium">
                        Configuration Failed
                      </p>
                      <p className="text-red-300/80 text-sm mt-1">
                        {errorMessage}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-4 mb-6">
                <div>
                  <Label
                    htmlFor="baseUrl"
                    className="text-slate-200 mb-2 block"
                  >
                    Inference API URL
                  </Label>
                  <Input
                    id="baseUrl"
                    type="url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://your-openai-compatible-server:8080/v1"
                    disabled={status === "saving"}
                    className="bg-white/10 border-white/20 text-white placeholder:text-slate-400 focus:border-cyan-400 disabled:opacity-50"
                  />
                  <p className="text-slate-400 text-xs mt-1">
                    OpenAI-compatible inference endpoint
                  </p>
                </div>

                <div>
                  <Label htmlFor="apiKey" className="text-slate-200 mb-2 block">
                    API Key
                  </Label>
                  <Input
                    id="apiKey"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter your API key"
                    disabled={status === "saving"}
                    className="bg-white/10 border-white/20 text-white placeholder:text-slate-400 focus:border-cyan-400 disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={!baseUrl || probing || status === "saving"}
                  onClick={() => {
                    void checkConnection();
                  }}
                >
                  {probing
                    ? "Checking connection…"
                    : "Check provider connection"}
                </Button>
                <p role="status" className="text-sm text-slate-300">
                  {connectionText}
                </p>
                <Button
                  type="submit"
                  disabled={!baseUrl || status === "saving"}
                  className="w-full bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white font-medium py-6 text-lg rounded-xl shadow-lg shadow-cyan-500/30 transition-all hover:shadow-cyan-500/50 disabled:opacity-80"
                >
                  {status === "saving"
                    ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        Saving...
                      </>
                    )
                    : (
                      <>
                        Save configuration
                        <ArrowRight className="w-5 h-5 ml-2" />
                      </>
                    )}
                </Button>

                <Button
                  type="button"
                  onClick={skipSetup}
                  disabled={status === "saving"}
                  variant="ghost"
                  className="w-full text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-50"
                >
                  Skip for now
                </Button>
              </div>

              <p className="text-slate-400 text-sm text-center mt-4">
                You can change this later in Settings
              </p>
            </form>
          )}

          {status === "success" && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-4" />
              <p className="text-white text-lg font-medium">
                Configuration Saved!
              </p>
              <p className="text-slate-400 text-sm mt-2">
                {connectionText} Model generation has not been tested.
              </p>
              <Button
                className="mt-4"
                onClick={() => navigate("/", { replace: true })}
              >
                Continue to Mycelia
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-slate-500 text-xs text-center mt-6">
          Step 2 of 2 - Inference Configuration
        </p>
      </div>
    </div>
  );
}
