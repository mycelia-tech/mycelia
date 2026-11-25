import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsStore } from "@/stores/settingsStore";
import { exchangeApiKeyForJWT, getCurrentJWT } from "@/lib/auth";
import {
  getDockerSetupEndpoint,
  getDockerTokenCommand,
  isMediaDevSetupLocation,
} from "@/lib/setupCommands";
import { Loader2, CheckCircle2, XCircle, Terminal, Copy, Check, ClipboardPaste, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ServerType = "docker" | "deno" | "custom";

const DENO_ENDPOINT = "http://localhost:5173";

type SetupStatus = "idle" | "verifying" | "creating_new" | "success" | "error" | "keys_exist";
type ServerTestStatus = "idle" | "testing" | "success" | "error";

interface SetupResponse {
  created: boolean;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}
function getFriendlyAuthError(error: string | null): string {
  if (!error) return "Something went wrong. Please try again.";

  switch (error) {
    case "invalid_client":
      return "The MYCELIA_CLIENT_ID or MYCELIA_TOKEN you entered is incorrect.";
    case "invalid_request":
      return "Missing required fields. Please enter both MYCELIA_CLIENT_ID and MYCELIA_TOKEN.";
    case "invalid_grant":
      return "Your authorization has expired. Please request new credentials.";
    default:
      if (error.includes("Failed to fetch") || error.includes("NetworkError")) {
        return "Could not reach the server. Make sure it's running and try again.";
      }
      return error;
  }
}

export default function SetupPage() {
  const isMediaDevStack = isMediaDevSetupLocation(window.location);
  const serverEndpoints: Record<Exclude<ServerType, "custom">, string> = {
    docker: getDockerSetupEndpoint(window.location),
    deno: DENO_ENDPOINT,
  };
  const navigate = useNavigate();
  const {
    apiEndpoint,
    clientId,
    clientSecret,
    sessionStatus,
    setApiEndpoint,
    setClientId,
    setClientSecret,
  } = useSettingsStore();

  const [serverType, setServerType] = useState<ServerType>("docker");
  const [localEndpoint, setLocalEndpoint] = useState(apiEndpoint || serverEndpoints.docker);
  const [localClientId, setLocalClientId] = useState("");
  const [localToken, setLocalToken] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const connectionRequest = useRef<AbortController | null>(null);
  const [pastedCredentials, setPastedCredentials] = useState("");
  const [status, setStatus] = useState<SetupStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverTestStatus, setServerTestStatus] = useState<ServerTestStatus>("idle");
  const [serverTestError, setServerTestError] = useState<string | null>(null);

  const handleServerTypeChange = (value: ServerType) => {
    setServerType(value);
    if (value !== "custom") {
      setLocalEndpoint(serverEndpoints[value]);
    }
    setServerTestStatus("idle");
    setServerTestError(null);
  };

  const handleEndpointChange = (value: string) => {
    setLocalEndpoint(value);
    setServerTestStatus("idle");
    setServerTestError(null);
    // Auto-switch to custom if endpoint doesn't match presets
    if (value === serverEndpoints.docker) {
      setServerType("docker");
    } else if (value === serverEndpoints.deno) {
      setServerType("deno");
    } else if (serverType !== "custom") {
      setServerType("custom");
    }
  };

  // Auto-test server when endpoint changes
  useEffect(() => {
    if (!localEndpoint) return;

    // Validate URL format first
    try {
      new URL(localEndpoint);
    } catch {
      return;
    }

    const timer = setTimeout(() => {
      testServerConnection();
    }, 500);

    return () => { clearTimeout(timer); connectionRequest.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localEndpoint]);

  const testServerConnection = async () => {
    connectionRequest.current?.abort();
    const controller = new AbortController();
    connectionRequest.current = controller;
    setServerTestStatus("testing");
    setServerTestError(null);

    try {
      const response = await fetch(`${localEndpoint}/api/setup`, {
        method: "GET",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });

      const body = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
      if (body?.service !== "mycelia") throw new Error("The address did not return a Mycelia setup response.");
      setServerTestStatus("success");
      setServerTestError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setServerTestStatus("error");
      if (error instanceof Error) {
        if (error.name === "TimeoutError") {
          setServerTestError("Connection timed out. Server may not be running.");
        } else if (error.message.includes("Failed to fetch")) {
          setServerTestError("Could not reach server. Check if it's running.");
        } else {
          setServerTestError(error.message);
        }
      }
    }
  };

  const parseCredentials = () => {
    const lines = pastedCredentials.trim().split("\n");
    let foundClientId = "";
    let foundToken = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("MYCELIA_CLIENT_ID=")) {
        foundClientId = trimmed.replace("MYCELIA_CLIENT_ID=", "").trim();
      } else if (trimmed.startsWith("MYCELIA_TOKEN=")) {
        foundToken = trimmed.replace("MYCELIA_TOKEN=", "").trim();
      }
    }

    if (foundClientId) setLocalClientId(foundClientId);
    if (foundToken) setLocalToken(foundToken);

    if (!foundClientId && !foundToken) {
      setErrorMessage("Could not find MYCELIA_CLIENT_ID or MYCELIA_TOKEN in the pasted text");
    } else {
      setPastedCredentials("");
      setErrorMessage(null);
    }
  };

  // Redirect if already configured
  useEffect(() => {
    if (sessionStatus === "unknown") void getCurrentJWT();
    if (sessionStatus === "authenticated") {
      navigate("/setup/inference", { replace: true });
    }
  }, [sessionStatus, navigate]);

  const verifyAndSaveCredentials = async () => {
    if (!localClientId || !localToken) {
      setErrorMessage("Please enter both MYCELIA_CLIENT_ID and MYCELIA_TOKEN");
      return;
    }

    setStatus("verifying");
    setErrorMessage(null);
    setApiEndpoint(localEndpoint);

    try {
      const result = await exchangeApiKeyForJWT(
        localEndpoint,
        localClientId,
        localToken
      );

      if (result.jwt) {
        setClientId(localClientId);
        setClientSecret("");
        setLocalToken("");
        setStatus("success");

        setTimeout(() => {
          navigate("/setup/inference", { replace: true });
        }, 1500);
      } else {
        setErrorMessage(result.error || "Invalid credentials");
        setStatus("error");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Verification failed");
      setStatus("error");
    }
  };

  const getBrowserName = (): string => {
    const ua = navigator.userAgent;
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Edg")) return "Edge";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Safari")) return "Safari";
    if (ua.includes("Opera") || ua.includes("OPR")) return "Opera";
    return "Browser";
  };

  const createNewCredentials = async () => {
    setStatus("creating_new");
    setErrorMessage(null);
    setApiEndpoint(localEndpoint);

    // Generate a name with browser info and timestamp
    const browser = getBrowserName();
    const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const tokenName = `${browser}-${timestamp}`;

    try {
      const response = await fetch(`${localEndpoint}/api/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mycelia-Bootstrap": bootstrapToken,
        },
        body: JSON.stringify({ create: true, name: tokenName }),
      });

      // Handle non-JSON responses (e.g., 502 proxy errors)
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error(
          response.status === 502
            ? "Backend server is not running. Please start the backend service."
            : `Server error (${response.status}). Please try again.`
        );
      }

      const data: SetupResponse = await response.json();

      // Handle keys_exist error specifically
      if (data.error === "keys_exist") {
        setStatus("keys_exist");
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || `Server returned ${response.status}`);
      }

      if (data.created && data.clientId && data.clientSecret) {
        setLocalClientId(data.clientId);
        setLocalToken(data.clientSecret);
        const result = await exchangeApiKeyForJWT(localEndpoint, data.clientId, data.clientSecret);
        if (!result.jwt) throw new Error(result.error || "Unable to start browser session");
        setClientId(data.clientId);
        setClientSecret("");
        setBootstrapToken("");
        setLocalToken("");
        setStatus("success");

        setTimeout(() => {
          navigate("/setup/inference", { replace: true });
        }, 1500);
      } else {
        setErrorMessage("Failed to create new credentials");
        setStatus("error");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create credentials");
      setStatus("error");
    }
  };

  const isLoading = status === "verifying" || status === "creating_new";
  const [copiedCommand, setCopiedCommand] = useState(false);

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 2000);
  };

  const isRemoteServer = !localEndpoint.includes("localhost") && !localEndpoint.includes("127.0.0.1");

  // Generate suggested token name with browser info
  const suggestedTokenName = `${getBrowserName()}-${new Date().toISOString().slice(0, 10)}`;
  const dockerTokenCommand = getDockerTokenCommand(suggestedTokenName, window.location);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-6 sm:py-10">
      <div className="w-full min-w-0 max-w-lg">
        <header className="mb-4">
          <p className="mb-1 text-sm font-semibold text-primary">Setup · Step 1 of 2</p>
          <h1 className="text-3xl font-semibold tracking-tight">Welcome to Mycelia</h1>
          <p className="mt-1 text-muted-foreground">Connect this browser to your Mycelia server.</p>
        </header>
        <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          {status === "success" ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 text-primary mx-auto mb-4" />
              <p className="text-foreground text-lg font-medium">
                Connected!
              </p>
              <p className="text-muted-foreground text-sm mt-2">
                Continuing to next step...
              </p>
            </div>
          ) : status === "keys_exist" ? (
            <div className="space-y-6">
              <div className="text-center">
                <Terminal className="w-12 h-12 text-primary mx-auto mb-4" />
                <h2 className="text-foreground text-lg font-medium mb-2">
                  Generate Credentials via CLI
                </h2>
                <p className="text-muted-foreground text-sm">
                  API keys already exist on this server. Generate new credentials using the command line.
                </p>
              </div>

              <div className="space-y-4">
                {isRemoteServer ? (
                  <>
                    <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
                      <p className="text-amber-800 dark:text-amber-300 text-sm">
                        <strong>Remote server detected.</strong> SSH into your server and run:
                      </p>
                    </div>
                    <div className="relative">
                      <pre className="bg-muted rounded-lg p-4 text-sm pr-12 font-mono text-foreground overflow-x-auto">
                        <code>{dockerTokenCommand}</code>
                      </pre>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Copy command"
                        className="absolute top-1 right-1 bg-muted text-muted-foreground hover:text-foreground"
                        onClick={() => copyCommand(dockerTokenCommand)}
                      >
                        {copiedCommand ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </Button>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Server endpoint: <code className="text-primary">{localEndpoint}</code>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground text-sm">
                      Run one of these commands in your terminal:
                    </p>

                    {/* Docker option */}
                    <div className="space-y-2 p-3 rounded-lg bg-muted/60 border">
                      <p className="text-muted-foreground text-sm font-medium">Docker (recommended)</p>
                      <div className="relative">
                        <pre className="bg-muted rounded-lg p-3 text-sm pr-12 font-mono text-foreground overflow-x-auto">
                          <code>{dockerTokenCommand}</code>
                        </pre>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label="Copy command"
                        className="absolute top-1 right-1 bg-muted text-muted-foreground hover:text-foreground"
                          onClick={() => copyCommand(dockerTokenCommand)}
                        >
                          {copiedCommand ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Server endpoint: <code className="text-primary">{serverEndpoints.docker}</code>
                      </p>
                    </div>

                    {/* Non-Docker option */}
                    {!isMediaDevStack && (
                    <div className="space-y-2 p-3 rounded-lg bg-muted/60 border">
                      <p className="text-muted-foreground text-sm font-medium">Local development (deno task dev)</p>
                      <div className="relative">
                        <pre className="bg-muted rounded-lg p-3 text-sm pr-12 font-mono text-foreground overflow-x-auto">
                          <code>cd backend && deno run -A server.ts token-create --name {suggestedTokenName}</code>
                        </pre>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label="Copy command"
                        className="absolute top-1 right-1 bg-muted text-muted-foreground hover:text-foreground"
                          onClick={() => copyCommand(`cd backend && deno run -A server.ts token-create --name ${suggestedTokenName}`)}
                        >
                          {copiedCommand ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Server endpoint: <code className="text-primary">http://localhost:5173</code>
                      </p>
                    </div>
                    )}
                  </>
                )}

                <div className="space-y-3">
                  <Label htmlFor="setup-credentials">Paste the command output</Label>
                  <textarea
                    id="setup-credentials"
                    value={pastedCredentials}
                    onChange={(e) => setPastedCredentials(e.target.value)}
                    placeholder={`MYCELIA_CLIENT_ID=abc123...\nMYCELIA_TOKEN=mycelia_xyz...`}
                    disabled={isLoading}
                    rows={3}
                    className="w-full resize-y rounded-lg border border-input bg-card p-3 font-mono text-base placeholder:text-muted-foreground focus:border-primary sm:text-sm"
                  />
                  {errorMessage && (
                    <p className="text-destructive text-xs">{getFriendlyAuthError(errorMessage)}</p>
                  )}
                </div>
              </div>

              <div className="border-t border-border pt-4 space-y-3">
                <Button
                  type="button"
                  onClick={() => {
                    // Parse and connect directly
                    const lines = pastedCredentials.trim().split("\n");
                    let foundClientId = "";
                    let foundToken = "";
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (trimmed.startsWith("MYCELIA_CLIENT_ID=")) {
                        foundClientId = trimmed.replace("MYCELIA_CLIENT_ID=", "").trim();
                      } else if (trimmed.startsWith("MYCELIA_TOKEN=")) {
                        foundToken = trimmed.replace("MYCELIA_TOKEN=", "").trim();
                      }
                    }
                    if (foundClientId && foundToken) {
                      setLocalClientId(foundClientId);
                      setLocalToken(foundToken);
                      setPastedCredentials("");
                      // Trigger verification
                      setStatus("verifying");
                      setErrorMessage(null);
                      setApiEndpoint(localEndpoint);
                      exchangeApiKeyForJWT(localEndpoint, foundClientId, foundToken)
                        .then((result) => {
                          if (result.jwt) {
                            setClientId(foundClientId);
                            setClientSecret("");
                            setLocalToken("");
                            setStatus("success");
                            setTimeout(() => navigate("/setup/inference", { replace: true }), 1500);
                          } else {
                            setErrorMessage(result.error || "Invalid credentials");
                            setStatus("keys_exist");
                          }
                        })
                        .catch((error) => {
                          setErrorMessage(error instanceof Error ? error.message : "Verification failed");
                          setStatus("keys_exist");
                        });
                    } else {
                      setErrorMessage("Could not find MYCELIA_CLIENT_ID or MYCELIA_TOKEN in the pasted text");
                    }
                  }}
                  disabled={!pastedCredentials.trim() || isLoading}
                  className="w-full"
                >
                  <CheckCircle2 className="w-5 h-5 mr-2" />
                  Connect
                </Button>
                <Button
                  type="button"
                  onClick={() => setStatus("idle")}
                  variant="ghost"
                  className="w-full text-muted-foreground hover:text-foreground"
                >
                  Enter manually instead
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); verifyAndSaveCredentials(); }}>
              {errorMessage && (
                <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/40">
                  <div className="flex items-start gap-3">
                    <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                    <p className="text-destructive text-sm">{getFriendlyAuthError(errorMessage)}</p>
                  </div>
                </div>
              )}

              <div className="space-y-4 mb-6">
                <div>
                  <Label htmlFor="serverType" className="text-foreground mb-2 block">
                    Server Type
                  </Label>
                  <Select value={serverType} onValueChange={(v) => handleServerTypeChange(v as ServerType)}>
                    <SelectTrigger id="serverType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="docker">Docker (default)</SelectItem>
                      <SelectItem value="deno">Deno (local dev)</SelectItem>
                      <SelectItem value="custom">Custom server</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="endpoint" className="text-foreground mb-2 block">
                    Server Endpoint
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="endpoint"
                      type="url"
                      value={localEndpoint}
                      onChange={(e) => handleEndpointChange(e.target.value)}
                      placeholder="https://your-server.com"
                      disabled={isLoading}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      onClick={testServerConnection}
                      disabled={isLoading || serverTestStatus === "testing"}
                      variant="outline"
                      size="icon"
                      className={`border-input shrink-0 ${
                        serverTestStatus === "success"
                          ? "border-green-500/50 text-primary hover:bg-green-500/20"
                          : serverTestStatus === "error"
                          ? "border-red-500/50 text-destructive hover:bg-red-500/20"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                      title="Test server connection"
                    >
                      {serverTestStatus === "testing" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : serverTestStatus === "success" ? (
                        <Wifi className="w-4 h-4" />
                      ) : serverTestStatus === "error" ? (
                        <WifiOff className="w-4 h-4" />
                      ) : (
                        <Wifi className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-sm mt-1 min-h-5">
                    {serverTestStatus === "testing" && (
                      <span className="text-muted-foreground">Testing connection...</span>
                    )}
                    {serverTestStatus === "success" && (
                      <span className="text-primary">Mycelia server recognized; sign in to verify access</span>
                    )}
                    {serverTestStatus === "error" && serverTestError && (
                      <span className="text-destructive">{serverTestError}</span>
                    )}
                  </p>
                </div>

                {/* Paste credentials section */}
                <div className="p-3 rounded-lg bg-muted/60 border space-y-3">
                  <Label htmlFor="setup-credentials" className="text-sm font-medium block">
                    Paste credentials
                  </Label>
                  <textarea
                    id="setup-credentials"
                    value={pastedCredentials}
                    onChange={(e) => setPastedCredentials(e.target.value)}
                    placeholder={`MYCELIA_CLIENT_ID=abc123...\nMYCELIA_TOKEN=mycelia_xyz...`}
                    disabled={isLoading}
                    rows={3}
                    className="w-full resize-y rounded-lg border border-input bg-card p-3 font-mono text-base placeholder:text-muted-foreground focus:border-primary sm:text-sm"
                  />
                  <Button
                    type="button"
                    onClick={parseCredentials}
                    disabled={!pastedCredentials.trim() || isLoading}
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <ClipboardPaste className="w-4 h-4 mr-2" />
                    I have credentials
                  </Button>
                </div>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="px-2 bg-card text-muted-foreground">or enter manually</span>
                  </div>
                </div>

                <div>
                  <Label htmlFor="clientId" className="text-foreground mb-2 block font-mono text-sm">
                    MYCELIA_CLIENT_ID
                  </Label>
                  <Input
                    id="clientId"
                    type="text"
                    value={localClientId}
                    onChange={(e) => setLocalClientId(e.target.value)}
                    placeholder="e.g. 695c4437205e4cbcef78776e"
                    disabled={isLoading}
                    className="font-mono"
                  />
                </div>

                <div>
                  <Label htmlFor="token" className="text-foreground mb-2 block font-mono text-sm">
                    MYCELIA_TOKEN
                  </Label>
                  <Input
                    id="token"
                    type="password"
                    value={localToken}
                    onChange={(e) => setLocalToken(e.target.value)}
                    placeholder="mycelia_..."
                    disabled={isLoading}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <Button
                  type="submit"
                  disabled={!localClientId || !localToken || isLoading}
                  className="w-full"
                >
                  {status === "verifying" ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Verifying...
                    </>
                  ) : "Connect"}
                </Button>

                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-input" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-card text-muted-foreground">or</span>
                  </div>
                </div>

                <Label htmlFor="bootstrapToken" className="text-foreground block">
                  One-time bootstrap token (new installations only)
                </Label>
                <Input id="bootstrapToken" type="password" autoComplete="off"
                  value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)}
                  placeholder="MYCELIA_BOOTSTRAP_TOKEN from your local configuration"
                  className="bg-card border-input text-foreground" />
                <Button
                  type="button"
                  onClick={createNewCredentials}
                  disabled={isLoading || bootstrapToken.length < 32}
                  variant="outline"
                  className="w-full"
                >
                  {status === "creating_new" ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Terminal className="w-5 h-5 mr-2" />
                      First-time setup
                    </>
                  )}
                </Button>

                <div className="text-muted-foreground text-xs text-center mt-4 space-y-1">
                  <p>
                    Find these values in your <code className="text-muted-foreground">.env</code> file
                  </p>
                  <p className="text-muted-foreground">
                    Don't have credentials? <button
                      type="button"
                      onClick={() => setStatus("keys_exist")}
                      className="text-primary hover:text-foreground underline underline-offset-2"
                    >
                      See how to generate them
                    </button>
                  </p>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
