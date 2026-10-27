import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { exchangeApiKeyForJWT, endBrowserSession } from "@/lib/auth";
import { callResource } from "@/lib/api";
import { APIEndpointField } from "@/components/forms/APIEndpointField";
import { ClientCredentialsFields } from "@/components/forms/ClientCredentialsFields";
import { APIActions } from "@/components/forms/APIActions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, Edit2, Key, Plus, Save, X } from "lucide-react";
import { ObjectId } from "bson";
import { useActionDialog } from "@/components/ActionDialogProvider";

interface ApiKey {
  _id: ObjectId;
  name: string;
  owner: string;
  openPrefix: string;
  isActive: boolean;
  createdAt: Date;
  policiesYaml: string;
}

const defaultPolicyYaml = `- resource: "**"
  action: "**"
  effect: allow`;

const APISettingsPage = () => {
  const { confirmAction } = useActionDialog();
  // --- Client config state ---
  const {
    apiEndpoint,
    clientId,
    clientSecret,
    setApiEndpoint,
    setClientId,
    setClientSecret,
    clearSettings,
  } = useSettingsStore();
  const [localEndpoint, setLocalEndpoint] = useState(apiEndpoint);
  const [localClientId, setLocalClientId] = useState(clientId);
  const [localClientSecret, setLocalClientSecret] = useState(clientSecret);
  const [isSaved, setIsSaved] = useState(false);
  const [isExchanging, setIsExchanging] = useState(false);
  const [exchangeResult, setExchangeResult] = useState<
    "success" | string | null
  >(null);

  // --- API Keys state ---
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyOwner, setNewKeyOwner] = useState("system");
  const [newKeyPolicies, setNewKeyPolicies] = useState(defaultPolicyYaml);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<
    { clientId: string; apiKey: string } | null
  >(null);
  const [copiedClientId, setCopiedClientId] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editedPolicies, setEditedPolicies] = useState<string>("");
  const [updating, setUpdating] = useState(false);

  // --- Client config handlers ---
  const handleSave = async () => {
    setIsExchanging(true);
    setExchangeResult(null);
    try {
      const result = await exchangeApiKeyForJWT(localEndpoint, localClientId, localClientSecret);
      if (!result.jwt) throw new Error(result.error || "Unable to start session");
      setApiEndpoint(localEndpoint);
      setClientId(localClientId);
      setClientSecret("");
      setLocalClientSecret("");
      useSettingsStore.getState().setSessionStatus("authenticated");
      setIsSaved(true);
      setExchangeResult("success");
      setTimeout(() => setIsSaved(false), 2000);
    } catch (error) {
      setExchangeResult(error instanceof Error ? error.message : "Unable to start session");
    } finally { setIsExchanging(false); }
  };

  const handleClear = async () => {
    if (
      await confirmAction({
        title: "Sign out of this browser?",
        description: "The browser session will end. Your device API keys remain active.",
        actionLabel: "Sign out",
        destructive: true,
      })
    ) {
      try {
        await endBrowserSession();
      } catch (error) {
        setExchangeResult(error instanceof Error ? error.message : "Sign out failed");
        return;
      }
      clearSettings();
      setLocalEndpoint(useSettingsStore.getState().apiEndpoint);
      setLocalClientId("");
      setLocalClientSecret("");
      setExchangeResult(null);
    }
  };

  const handleExchangeToken = handleSave;

  const hasChanges = localEndpoint !== apiEndpoint ||
    localClientId !== clientId || localClientSecret !== clientSecret;

  // --- API Keys handlers ---
  const fetchApiKeys = async () => {
    try {
      setKeysLoading(true);
      const result = await callResource("apikeys", { action: "list" });
      setApiKeys(result);
    } catch (err) {
      setKeysError(
        err instanceof Error ? err.message : "Failed to fetch API keys",
      );
    } finally {
      setKeysLoading(false);
    }
  };

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const currentKey = apiKeys.find((k) => k._id.toString() === clientId);

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) {
      setKeysError("Name is required");
      return;
    }

    setCreating(true);
    setKeysError(null);

    try {
      const result = await callResource("apikeys", {
        action: "create",
        name: newKeyName,
        owner: newKeyOwner,
        policiesYaml: newKeyPolicies,
      });

      setCreatedKey({ clientId: result.clientId, apiKey: result.apiKey });
      setNewKeyName("");
      setNewKeyPolicies(defaultPolicyYaml);
      await fetchApiKeys();
    } catch (err) {
      setKeysError(
        err instanceof Error ? err.message : "Failed to create API key",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string, owner: string) => {
    if (
      !await confirmAction({
        title: "Revoke this API key?",
        description:
          "Clients using this key will no longer be able to authenticate.",
        actionLabel: "Revoke API key",
        destructive: true,
      })
    ) {
      return;
    }

    try {
      await callResource("apikeys", { action: "revoke", id, owner });
      await fetchApiKeys();
    } catch (err) {
      setKeysError(
        err instanceof Error ? err.message : "Failed to revoke API key",
      );
    }
  };

  const handleStartEdit = (key: ApiKey) => {
    setEditingKeyId(key._id.toString());
    setEditedPolicies(key.policiesYaml);
    setKeysError(null);
  };

  const handleCancelEdit = () => {
    setEditingKeyId(null);
    setEditedPolicies("");
    setKeysError(null);
  };

  const handleUpdateKey = async (id: string, owner: string) => {
    setUpdating(true);
    setKeysError(null);

    try {
      await callResource("apikeys", {
        action: "update",
        id,
        owner,
        policiesYaml: editedPolicies,
      });
      setEditingKeyId(null);
      setEditedPolicies("");
      await fetchApiKeys();
    } catch (err) {
      setKeysError(
        err instanceof Error
          ? err.message
          : "Failed to update API key policies",
      );
    } finally {
      setUpdating(false);
    }
  };

  const copyToClipboard = async (text: string, type: "clientId" | "secret") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "clientId") {
        setCopiedClientId(true);
        setTimeout(() => setCopiedClientId(false), 2000);
      } else {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold mb-2">API</h2>
        <p className="text-muted-foreground">
          Configure your API endpoint, credentials, and manage API keys.
        </p>
      </div>

      {currentKey && (
        <div className="flex items-center gap-3 border rounded-lg px-4 py-3 bg-muted/50">
          <Key className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="text-sm">
            <span className="text-muted-foreground">Session key:</span>
            <span className="font-medium">{currentKey.name}</span>
            <span className="text-muted-foreground">
              ({currentKey.openPrefix}...)
            </span>
            {!currentKey.isActive && (
              <span className="ml-2 text-destructive font-medium">
                inactive
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Client Configuration ── */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Client Configuration</h3>
        <div className="border rounded-lg p-6 space-y-6">
          <div className="space-y-4">
            <APIEndpointField
              value={localEndpoint}
              onChange={setLocalEndpoint}
            />

            <ClientCredentialsFields
              clientId={localClientId}
              clientSecret={localClientSecret}
              onClientIdChange={setLocalClientId}
              onClientSecretChange={setLocalClientSecret}
            />
          </div>

          <APIActions
            hasChanges={hasChanges}
            isSaved={isSaved}
            isExchanging={isExchanging}
            exchangeResult={exchangeResult}
            canTest={!!localClientId && !!localClientSecret && !!localEndpoint}
            onSave={handleSave}
            onTestToken={handleExchangeToken}
            onClear={handleClear}
          />
        </div>
      </div>

      {/* ── API Keys ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">API Keys</h3>
          <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
            <Plus className="w-4 h-4 mr-2" />
            Create API Key
          </Button>
        </div>

        {keysError && (
          <div className="border border-red-500 rounded-lg p-4 bg-red-50 dark:bg-red-950">
            <p className="text-red-600 dark:text-red-400">{keysError}</p>
          </div>
        )}

        {createdKey && (
          <Card className="p-6 border-green-500 bg-green-50 dark:bg-green-950">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-green-600 dark:text-green-400" />
                <h3 className="font-semibold text-green-900 dark:text-green-100">
                  API Key Created Successfully
                </h3>
              </div>
              <p className="text-sm text-green-700 dark:text-green-300">
                Save these credentials securely. You won't be able to see the
                secret again.
              </p>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-sm font-semibold text-green-800 dark:text-green-200">
                    Client ID
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={createdKey.clientId}
                      readOnly
                      className="font-mono text-sm bg-white dark:bg-gray-900"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(createdKey.clientId, "clientId")}
                    >
                      {copiedClientId
                        ? <Check className="w-4 h-4" />
                        : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-semibold text-green-800 dark:text-green-200">
                    Client Secret (API Key)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={createdKey.apiKey}
                      readOnly
                      className="font-mono text-sm bg-white dark:bg-gray-900"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(createdKey.apiKey, "secret")}
                    >
                      {copiedSecret
                        ? <Check className="w-4 h-4" />
                        : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreatedKey(null)}
              >
                Dismiss
              </Button>
            </div>
          </Card>
        )}

        {showCreateForm && (
          <Card className="p-6">
            <div className="space-y-4">
              <h3 className="font-semibold text-lg">Create New API Key</h3>

              <div className="space-y-2">
                <Label htmlFor="keyName">Name</Label>
                <Input
                  id="keyName"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="My API Key"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="keyOwner">Owner</Label>
                <Input
                  id="keyOwner"
                  value={newKeyOwner}
                  onChange={(e) => setNewKeyOwner(e.target.value)}
                  placeholder="system"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="policies">Policies</Label>
                <textarea
                  id="policies"
                  value={newKeyPolicies}
                  onChange={(e) => setNewKeyPolicies(e.target.value)}
                  className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={defaultPolicyYaml}
                />
                <p className="text-xs text-muted-foreground">
                  Define access policies in YAML format.
                </p>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleCreateKey} disabled={creating}>
                  {creating ? "Creating..." : "Create Key"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        {keysLoading
          ? (
            <div className="border rounded-lg p-8 text-center">
              <p className="text-muted-foreground">Loading API keys...</p>
            </div>
          )
          : apiKeys.length === 0
          ? (
            <Card className="p-8 text-center border-dashed">
              <Key className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">
                No API keys yet. Create one to get started.
              </p>
            </Card>
          )
          : (
            <div className="space-y-2">
              {apiKeys.map((key) => {
                const isActiveKey = clientId === key._id.toString();
                return (
                  <Card
                    key={key._id.toString()}
                    className={`p-3 ${
                      isActiveKey ? "ring-2 ring-primary" : ""
                    }`}
                  >
                    <details
                      className="group"
                      open={editingKeyId === key._id.toString()}
                    >
                      <summary className="list-none cursor-pointer">
                        <div className="flex items-center gap-2">
                          {/* Name column - fixed width */}
                          <div className="w-[160px] shrink-0 truncate flex items-center gap-2">
                            <h3 className="font-semibold text-sm truncate">
                              {key.name}
                            </h3>
                            {isActiveKey && (
                              <Badge
                                variant="outline"
                                className="shrink-0 text-[10px] px-1.5 py-0"
                              >
                                current
                              </Badge>
                            )}
                          </div>

                          {/* ID column - fixed width */}
                          <div className="w-[120px] shrink-0 flex items-center gap-1 text-xs">
                            <span className="text-muted-foreground">ID:</span>
                            <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded truncate">
                              {key._id.toString().slice(0, 8)}...
                            </code>
                          </div>

                          {/* Secret column - fixed width */}
                          <div className="w-[160px] shrink-0 flex items-center gap-1 text-xs">
                            <span className="text-muted-foreground">
                              Secret:
                            </span>
                            <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded truncate">
                              {key.openPrefix}...
                            </code>
                          </div>

                          {/* Owner column - fixed width */}
                          <div className="w-[80px] shrink-0 flex items-center gap-1 text-xs">
                            <span className="text-muted-foreground">
                              Owner:
                            </span>
                            <span className="truncate">{key.owner}</span>
                          </div>

                          {/* Date column - fixed width */}
                          <div className="w-[90px] shrink-0 text-xs text-muted-foreground">
                            {new Date(key.createdAt).toLocaleDateString()}
                          </div>

                          {/* Spacer */}
                          <div className="flex-1" />

                          {/* Details toggle - fixed width */}
                          <div className="w-[60px] shrink-0">
                            <span className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                              <span className="group-open:hidden">▶</span>
                              <span className="hidden group-open:inline">
                                ▼
                              </span>
                              Details
                            </span>
                          </div>

                          {/* Action column - fixed width */}
                          <div className="w-[70px] shrink-0 flex justify-end">
                            {key.isActive
                              ? (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRevoke(key._id.toString(), key.owner);
                                  }}
                                  title="Revoke this API key"
                                >
                                  Revoke
                                </Button>
                              )
                              : (
                                <span className="inline-flex items-center justify-center h-7 px-2 text-[11px] rounded-md bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                                  Revoked
                                </span>
                              )}
                          </div>
                        </div>
                      </summary>

                      {/* Expandable policies section */}
                      <div className="pt-2 mt-2 border-t">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-muted-foreground">
                            Policies
                          </span>
                          {key.isActive &&
                            editingKeyId !== key._id.toString() && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartEdit(key);
                              }}
                              title="Edit policies"
                            >
                              <Edit2 className="w-3 h-3 mr-1" />
                              Edit
                            </Button>
                          )}
                        </div>
                        {editingKeyId === key._id.toString()
                          ? (
                            <div className="space-y-2">
                              <textarea
                                value={editedPolicies}
                                onChange={(e) =>
                                  setEditedPolicies(e.target.value)}
                                className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                placeholder={defaultPolicyYaml}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleUpdateKey(
                                      key._id.toString(),
                                      key.owner,
                                    );
                                  }}
                                  disabled={updating}
                                >
                                  <Save className="w-3 h-3 mr-1" />
                                  {updating ? "Saving..." : "Save"}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCancelEdit();
                                  }}
                                  disabled={updating}
                                >
                                  <X className="w-3 h-3 mr-1" />
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )
                          : (
                            <pre className="p-2 bg-muted rounded text-[11px] font-mono overflow-x-auto">
                        {key.policiesYaml}
                            </pre>
                          )}
                      </div>
                    </details>
                  </Card>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
};

export default APISettingsPage;
