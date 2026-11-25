import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { callResource } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Save,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Trash2,
  Info,
  Shield,
} from "lucide-react";
import type { WorkerPolicy } from "@/types/jobs";

interface SchemaProperty {
  type?: string;
  default?: unknown;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

interface WorkerEntry {
  _id: string;
  name: string;
  discovered: boolean;
  inputSchema: {
    type?: string;
    properties?: Record<string, SchemaProperty>;
    required?: string[];
  };
  outputSchema: Record<string, unknown>;
  policies?: WorkerPolicy[];
  defaultOverrides?: Record<string, unknown>;
  lastSeen: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkerDefaults {
  workerType: string;
  defaults: Record<string, unknown>;
}

const getNestedValue = (obj: any, path: string): any => {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
};

const setNestedValue = (obj: any, path: string, value: any): any => {
  const parts = path.split(".");
  const result = { ...obj };
  let current = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null ||
      Array.isArray(current[part])
    ) {
      current[part] = {};
    } else {
      current[part] = { ...current[part] };
    }
    current = current[part];
  }

  const lastPart = parts[parts.length - 1];
  if (value === null || value === undefined) {
    delete current[lastPart];

    // Clean up empty parent objects
    for (let i = parts.length - 2; i >= 0; i--) {
      let parentRef = result;
      for (let j = 0; j <= i; j++) {
        if (parentRef === null || parentRef === undefined) break;
        parentRef = parentRef[parts[j]];
      }
      if (parentRef && Object.keys(parentRef).length === 0) {
        let grandParentRef = result;
        for (let j = 0; j < i; j++) {
          grandParentRef = grandParentRef[parts[j]];
        }
        delete grandParentRef[parts[i]];
      } else {
        break;
      }
    }
  } else {
    current[lastPart] = value;
  }

  return result;
};

const flattenNestedFields = (obj: any, prefix = ""): Array<[string, any]> => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const result: Array<[string, any]> = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const nested = flattenNestedFields(value, fullPath);
      result.push(...nested);
    } else {
      result.push([fullPath, value]);
    }
  }

  return result;
};

const getTypeString = (value: unknown): string => {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    const firstType = getTypeString(value[0]);
    return `${firstType}[]`;
  }
  if (typeof value === "object") return "object";
  return "unknown";
};

const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

const WorkerDetailPage = () => {
  const { workerType } = useParams<{ workerType: string }>();
  const navigate = useNavigate();

  const [worker, setWorker] = useState<WorkerEntry | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [showAddField, setShowAddField] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const [newFieldType, setNewFieldType] = useState<"string" | "number" | "boolean">("string");

  useEffect(() => {
    const fetchWorker = async () => {
      if (!workerType) return;

      try {
        setLoading(true);
        const [workersResult, defaultsResult] = await Promise.all([
          callResource("jobs", { action: "list_workers" }),
          callResource("jobs", { action: "get_worker_defaults", workerType }),
        ]);

        const foundWorker = (workersResult.workers as WorkerEntry[])?.find(
          (w) => w.name === workerType
        );

        if (!foundWorker) {
          setError(`Worker "${workerType}" not found`);
          return;
        }

        setWorker(foundWorker);
        setOverrides((defaultsResult as WorkerDefaults).defaults || {});
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch worker");
      } finally {
        setLoading(false);
      }
    };

    fetchWorker();
  }, [workerType]);

  const handleSave = async () => {
    if (!workerType) return;

    setSaving(true);
    setSaveSuccess(false);

    try {
      await callResource("jobs", {
        action: "update_worker_defaults",
        workerType,
        defaults: overrides,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save defaults");
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = () => {
    setOverrides({});
  };

  const handleFieldChange = (fieldName: string, value: unknown) => {
    setOverrides((prev) => setNestedValue(prev, fieldName, value));
  };

  const handleResetToSchemaDefault = (fieldName: string, _schemaDefault: unknown) => {
    setOverrides((prev) => setNestedValue(prev, fieldName, null));
  };

  const handleDeleteField = (fieldName: string) => {
    setOverrides((prev) => setNestedValue(prev, fieldName, null));
  };

  const handleAddCustomField = () => {
    if (!newFieldName.trim()) return;

    let value: string | number | boolean;
    if (newFieldType === "number") {
      value = parseFloat(newFieldValue) || 0;
    } else if (newFieldType === "boolean") {
      value = newFieldValue.toLowerCase() === "true";
    } else {
      value = newFieldValue;
    }

    handleFieldChange(newFieldName, value);
    setNewFieldName("");
    setNewFieldValue("");
    setNewFieldType("string");
    setShowAddField(false);
  };

  const getSchemaFields = (): Array<{
    name: string;
    schema: SchemaProperty;
    isRequired: boolean;
  }> => {
    if (!worker?.inputSchema) return [];

    const flattenSchema = (
      schema: SchemaProperty,
      prefix = "",
      required: string[] = []
    ): Array<{ name: string; schema: SchemaProperty; isRequired: boolean }> => {
      const properties = schema.properties;
      if (!properties) return [];

      const result: Array<{
        name: string;
        schema: SchemaProperty;
        isRequired: boolean;
      }> = [];

      for (const [key, prop] of Object.entries(properties)) {
        if (key === "type") continue;
        const fullPath = prefix ? `${prefix}.${key}` : key;
        const isPropRequired = required.includes(key);

        if (prop.type === "object" && prop.properties) {
          result.push(...flattenSchema(prop, fullPath, prop.required || []));
        } else {
          result.push({
            name: fullPath,
            schema: prop,
            isRequired: isPropRequired,
          });
        }
      }
      return result;
    };

    const schema = worker.inputSchema as Record<string, unknown>;
    let properties: Record<string, SchemaProperty> | undefined;
    let required: string[] = [];

    if (schema.properties && typeof schema.properties === "object") {
      properties = schema.properties as Record<string, SchemaProperty>;
      required = (schema.required as string[]) || [];
    } else if (schema.$defs || schema.definitions) {
      const defs = (schema.$defs || schema.definitions) as Record<
        string,
        unknown
      >;
      const mainDef = Object.values(defs)[0] as
        | Record<string, unknown>
        | undefined;
      if (mainDef?.properties) {
        properties = mainDef.properties as Record<string, SchemaProperty>;
        required = (mainDef.required as string[]) || [];
      }
    }

    if (!properties) return [];

    return flattenSchema({ properties, required } as SchemaProperty);
  };

  const getExtraFields = (): Array<[string, unknown]> => {
    const schemaFields = getSchemaFields();
    const schemaFieldNames = new Set(schemaFields.map((f) => f.name));
    const flatOverrides = flattenNestedFields(overrides);

    return flatOverrides.filter(
      ([key]) => !schemaFieldNames.has(key) && key !== "type"
    );
  };

  const renderFieldInput = (
    fieldName: string,
    schema: SchemaProperty,
    currentValue: unknown,
    schemaDefault: unknown,
    isOverridden: boolean
  ) => {
    const displayValue = isOverridden ? currentValue : schemaDefault;

    if (schema.type === "boolean") {
      return (
        <div className="flex items-center gap-2">
          <Switch
            checked={Boolean(displayValue)}
            onCheckedChange={(checked) => handleFieldChange(fieldName, checked)}
          />
          <span className="text-sm text-muted-foreground">
            {displayValue ? "true" : "false"}
          </span>
        </div>
      );
    }

    if (schema.type === "number" || schema.type === "integer") {
      return (
        <Input
          type="number"
          step={schema.type === "integer" ? "1" : "any"}
          value={displayValue !== undefined ? String(displayValue) : ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" && schemaDefault === undefined) {
              handleDeleteField(fieldName);
            } else {
              handleFieldChange(
                fieldName,
                schema.type === "integer" ? parseInt(val, 10) : parseFloat(val)
              );
            }
          }}
          placeholder={schemaDefault !== undefined ? String(schemaDefault) : ""}
          className={isOverridden ? "border-amber-500" : "border-blue-500"}
        />
      );
    }

    if (schema.enum) {
      return (
        <select
          value={displayValue !== undefined ? String(displayValue) : ""}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isOverridden ? "border-amber-500" : "border-blue-500"
          }`}
        >
          {schemaDefault === undefined && (
            <option value="">Select a value</option>
          )}
          {schema.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      );
    }

    const stringValue = displayValue !== undefined ? String(displayValue) : "";
    const isLongText = stringValue.length > 100 || stringValue.includes("\n");

    if (isLongText || schema.description?.toLowerCase().includes("prompt")) {
      return (
        <Textarea
          value={stringValue}
          onChange={(e) => {
            if (e.target.value === "" && schemaDefault === undefined) {
              handleDeleteField(fieldName);
            } else {
              handleFieldChange(fieldName, e.target.value);
            }
          }}
          placeholder={schemaDefault !== undefined ? String(schemaDefault) : ""}
          className={`min-h-[100px] ${isOverridden ? "border-amber-500" : "border-blue-500"}`}
        />
      );
    }

    return (
      <Input
        type="text"
        value={stringValue}
        onChange={(e) => {
          if (e.target.value === "" && schemaDefault === undefined) {
            handleDeleteField(fieldName);
          } else {
            handleFieldChange(fieldName, e.target.value);
          }
        }}
        placeholder={schemaDefault !== undefined ? String(schemaDefault) : ""}
        className={isOverridden ? "border-amber-500" : "border-blue-500"}
      />
    );
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/settings/workers")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Workers
        </Button>
        <div className="border rounded-lg p-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          <p className="text-muted-foreground">Loading worker configuration...</p>
        </div>
      </div>
    );
  }

  if (error || !worker) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/settings/workers")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Workers
        </Button>
        <div className="border rounded-lg p-8 text-center">
          <XCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-500">{error || "Worker not found"}</p>
        </div>
      </div>
    );
  }

  const schemaFields = getSchemaFields();
  const hasOverrides = Object.keys(overrides).length > 0;
  const extraFields = getExtraFields();

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Button variant="ghost" onClick={() => navigate("/settings/workers")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Workers
          </Button>
          <div className="flex items-center gap-2">
            {hasOverrides && (
              <Button variant="outline" onClick={handleResetAll}>
                <RotateCcw className="w-4 h-4 mr-2" />
                Reset All
              </Button>
            )}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : saveSuccess ? (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Saved
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-2xl font-semibold">{worker.name}</h2>
            {worker.discovered ? (
              <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30">
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Unavailable
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            Configure default values for this worker. Values set here will be used
            when jobs don't specify them explicitly.
          </p>
        </div>

        {saveSuccess && (
          <div className="p-4 rounded-md bg-green-50 border border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-400 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" />
            <span>Configuration saved successfully!</span>
          </div>
        )}

        <Card className="p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">Configuration Fields</h3>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span>📋</span>
                <span>Using default</span>
              </div>
              <div className="flex items-center gap-1">
                <span>✏️</span>
                <span>Custom value</span>
              </div>
            </div>
          </div>

          {schemaFields.length === 0 && !hasOverrides ? (
            <p className="text-muted-foreground text-center py-8">
              This worker has no schema-defined fields. Add custom fields below.
            </p>
          ) : (
            <div className="space-y-6">
              {schemaFields.map(({ name, schema, isRequired }) => {
                const schemaDefault = schema.default;
                const currentValue = getNestedValue(overrides, name);
                const isOverridden = currentValue !== undefined;
                const isUsingDefault = !isOverridden || valuesEqual(currentValue, schemaDefault);

                return (
                  <div key={name} className="space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span title={isUsingDefault ? "Using schema default" : "Custom override"}>
                          {isUsingDefault ? "📋" : "✏️"}
                        </span>
                        <Label htmlFor={name} className="text-sm font-medium">
                          {name}
                        </Label>
                        <Badge variant="outline" className="text-xs">
                          {schema.type || "any"}
                        </Badge>
                        {isRequired && (
                          <Badge
                            variant="outline"
                            className="text-xs text-amber-600 border-amber-500/50"
                          >
                            required
                          </Badge>
                        )}
                        {schema.description && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="w-4 h-4 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              <p>{schema.description}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      {isOverridden && !valuesEqual(currentValue, schemaDefault) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleResetToSchemaDefault(name, schemaDefault)}
                          className="text-xs h-7"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Reset to default
                        </Button>
                      )}
                    </div>

                    {renderFieldInput(name, schema, currentValue, schemaDefault, isOverridden)}

                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {schemaDefault !== undefined && (
                        <span>
                          Schema default:{" "}
                          <code className="bg-muted px-1 rounded">
                            {typeof schemaDefault === "string" && schemaDefault.length > 50
                              ? `${schemaDefault.substring(0, 50)}...`
                              : JSON.stringify(schemaDefault)}
                          </code>
                        </span>
                      )}
                    </div>

                    <Separator className="mt-4" />
                  </div>
                );
              })}
            </div>
          )}

          {extraFields.length > 0 && (
            <>
              {schemaFields.length > 0 && <Separator className="my-6" />}
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-muted-foreground">Custom Fields (not in schema)</h4>
                <div className="border rounded-lg divide-y">
                  {extraFields.map(([key, value]) => {
                    const valueType = getTypeString(value);
                    const isBoolean = valueType === "boolean";
                    const isNumber = valueType === "number";

                    return (
                      <div
                        key={key}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3 @2xl/settings:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                      >
                        <div className="col-span-2 break-all font-mono text-sm font-medium @2xl/settings:col-span-1">{key}</div>
                        {isBoolean ? (
                          <select
                            aria-label={key}
                            value={String(value)}
                            onChange={(e) => {
                              handleFieldChange(key, e.target.value === "true");
                            }}
                            className="flex h-9 w-full rounded-md border border-amber-500 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : isNumber ? (
                          <Input
                            type="number"
                            step="any"
                            aria-label={key}
                            value={value !== undefined ? String(value) : ""}
                            onChange={(e) => {
                              const numValue =
                                e.target.value === "" ? 0 : parseFloat(e.target.value);
                              handleFieldChange(key, numValue);
                            }}
                            className="text-sm border-amber-500"
                          />
                        ) : (
                          <Input
                            aria-label={key}
                            value={typeof value === "string" ? value : JSON.stringify(value)}
                            onChange={(e) => {
                              handleFieldChange(key, e.target.value);
                            }}
                            className="text-sm border-amber-500"
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${key}`}
                          onClick={() => handleDeleteField(key)}
                          className="h-8 w-8 p-0"
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <Separator className="my-6" />

          {showAddField ? (
            <div className="border rounded-lg p-4 space-y-3 bg-muted/50">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="new-field-name" className="text-xs">
                    Field Name
                  </Label>
                  <Input
                    id="new-field-name"
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    placeholder="fieldName"
                    className="mt-1 font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="new-field-type" className="text-xs">
                    Type
                  </Label>
                  <select
                    id="new-field-type"
                    value={newFieldType}
                    onChange={(e) =>
                      setNewFieldType(e.target.value as "string" | "number" | "boolean")
                    }
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                </div>
              </div>
              <div>
                <Label htmlFor="new-field-value" className="text-xs">
                  Value
                </Label>
                {newFieldType === "boolean" ? (
                  <select
                    id="new-field-value"
                    value={newFieldValue}
                    onChange={(e) => setNewFieldValue(e.target.value)}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <Input
                    id="new-field-value"
                    type={newFieldType === "number" ? "number" : "text"}
                    value={newFieldValue}
                    onChange={(e) => setNewFieldValue(e.target.value)}
                    placeholder={newFieldType === "number" ? "0" : "value"}
                    className="mt-1"
                  />
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddCustomField}
                  disabled={!newFieldName.trim()}
                >
                  Add Field
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowAddField(false);
                    setNewFieldName("");
                    setNewFieldValue("");
                    setNewFieldType("string");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowAddField(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Custom Field
            </Button>
          )}
        </Card>

        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Priority Order</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge className="w-6 h-6 flex items-center justify-center rounded-full">
                1
              </Badge>
              <span>
                <strong>Job Data</strong> — Explicit values in the job payload
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className="w-6 h-6 flex items-center justify-center rounded-full bg-amber-500/10 text-amber-700"
              >
                2
              </Badge>
              <span>
                <strong>Default Overrides</strong> — Custom values configured on this page
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="w-6 h-6 flex items-center justify-center rounded-full bg-blue-500/10 text-blue-700 border-blue-500/30"
              >
                3
              </Badge>
              <span>
                <strong>Schema Defaults</strong> — Default values defined in worker code
              </span>
            </div>
          </div>
        </Card>

        {/* Policies Section */}
        {worker.policies && worker.policies.length > 0 && (
          <Card className="p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-muted-foreground" />
                <h3 className="text-lg font-semibold">Worker Policies</h3>
                <Badge variant="secondary" className="text-xs">
                  {worker.policies.length}
                </Badge>
              </div>
            </div>

            <div className="space-y-2">
              {worker.policies.map((policy, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 p-2 rounded-md bg-muted/50 text-sm font-mono"
                >
                  <Badge
                    variant={policy.effect === "allow" ? "default" : "destructive"}
                    className="text-xs"
                  >
                    {policy.effect}
                  </Badge>
                  <span className="text-muted-foreground">{policy.action}</span>
                  <span className="text-muted-foreground">on</span>
                  <span>{policy.resource}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
};

export default WorkerDetailPage;
