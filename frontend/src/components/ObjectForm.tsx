import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Object, ObjectFormData } from "@/types/objects";
import { zObject } from "@/types/objects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowRight,
  Box,
  Building2,
  Calendar,
  Edit3,
  ExternalLink,
  Eye,
  Film,
  FolderKanban,
  Handshake,
  Lightbulb,
  MapPin,
  PawPrint,
  MessageSquare,
  MoveHorizontal,
  Plus,
  RefreshCcw,
  Trash2,
  User,
  Users,
  X,
  Wand2,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { EmojiPickerButton } from "@/components/ui/emoji-picker";
import { ObjectId } from "bson";
import { ObjectSelectionDropdown } from "@/components/ObjectSelectionDropdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTimeRangeShorterThanTranscriptThreshold } from "@/lib/transcriptUtils";
import { SummarizeDialog } from "@/components/dialogs/SummarizeDialog";
import { TimeRangeCompact, TimeRangeEditDialog } from "@/components/TimeRangeEditDialog";

// Details field with edit/preview toggle
function DetailsField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [isPreview, setIsPreview] = useState(false);
  
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="details">Details</Label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={!isPreview ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setIsPreview(false)}
          >
            <Edit3 className="w-3 h-3 mr-1" />
            Edit
          </Button>
          <Button
            type="button"
            variant={isPreview ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setIsPreview(true)}
            disabled={!value}
          >
            <Eye className="w-3 h-3 mr-1" />
            Preview
          </Button>
        </div>
      </div>
      
      {isPreview ? (
        <div className="min-h-[100px] w-full rounded-md border border-input bg-muted/30 px-3 py-2">
          {value ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No content to preview</p>
          )}
        </div>
      ) : (
        <textarea
          id="details"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Optional details about this object (supports Markdown)"
          className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
        />
      )}
      
      {!isPreview && value && (
        <p className="text-xs text-muted-foreground">
          Supports Markdown: **bold**, *italic*, `code`, [links](url), lists, etc.
        </p>
      )}
    </div>
  );
}

// Time Ranges Section with compact display and edit dialog
interface TimeRange {
  start: Date;
  end?: Date;
  name?: string;
}

function TimeRangesSection({ 
  timeRanges, 
  onUpdate 
}: { 
  timeRanges?: TimeRange[];
  onUpdate: (ranges: TimeRange[] | undefined) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  if (!timeRanges || timeRanges.length === 0) {
    return null;
  }

  const handleSave = (index: number, range: TimeRange) => {
    const newRanges = [...timeRanges];
    newRanges[index] = range;
    onUpdate(newRanges);
  };

  const handleDelete = (index: number) => {
    const newRanges = timeRanges.filter((_, i) => i !== index);
    onUpdate(newRanges.length > 0 ? newRanges : undefined);
  };

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Time Ranges</Label>
      <div className="space-y-2">
        {timeRanges.map((range, index) => (
          <TimeRangeCompact
            key={index}
            timeRange={range}
            index={index}
            onEdit={setEditingIndex}
            onDelete={handleDelete}
          />
        ))}
      </div>
      
      {editingIndex !== null && timeRanges[editingIndex] && (
        <TimeRangeEditDialog
          open={editingIndex !== null}
          onOpenChange={(open) => !open && setEditingIndex(null)}
          timeRange={timeRanges[editingIndex]}
          index={editingIndex}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

interface ObjectFormProps {
  object: ObjectFormData;
  onUpdate?: (updates: Partial<ObjectFormData>) => Promise<void>;
  onFieldUpdate?: (field: string, value: any) => void;
  /** Hide the summary section when already displayed elsewhere on the page */
  hideSummary?: boolean;
  /** Hide icon and name when displayed as page title */
  hideIconName?: boolean;
  /** Hide details section when displayed elsewhere on the page */
  hideDetails?: boolean;
  /** Use compact layout with smaller text and spacing */
  compact?: boolean;
}

const renderIcon = (icon: any) => {
  if (!icon) return "";
  if (typeof icon === "string") return icon;
  if (icon.text) return icon.text;
  if (icon.base64) return "📷"; // Placeholder for base64 images
  return "";
};

// Extract known fields from the Zod schema
const KNOWN_FIELDS = new Set(
  Object.keys(zObject.shape),
);

const getTypeString = (value: any): string => {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    const firstType = getTypeString(value[0]);
    return `${firstType}[]`;
  }
  return "unknown";
};

const formatValue = (value: any): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value.toString();
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

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
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) {
      current[part] = {};
    } else {
      current[part] = { ...current[part] };
    }
    current = current[part];
  }

  const lastPart = parts[parts.length - 1];
  if (value === null) {
    delete current[lastPart];
    
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
  const result: Array<[string, any]> = [];
  
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId)) {
      const nested = flattenNestedFields(value, fullPath);
      result.push(...nested);
    } else {
      result.push([fullPath, value]);
    }
  }
  
  return result;
};


// Custom hook for debounced auto-save
function useDebouncedUpdate(
  value: string,
  delay: number,
  onUpdate: (updates: Partial<ObjectFormData>) => Promise<void>,
  fieldName: keyof ObjectFormData,
) {
  const [localValue, setLocalValue] = useState(value);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Update local value when prop changes (e.g., from server)
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Debounced update
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (localValue !== value) {
      timeoutRef.current = setTimeout(() => {
        onUpdate({ [fieldName]: localValue } as Partial<ObjectFormData>);
      }, delay);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [localValue, value, delay, onUpdate, fieldName]);

  return [localValue, setLocalValue] as const;
}

export function ObjectForm(
  { object, onUpdate: onPartialUpdate, onFieldUpdate, hideSummary, hideIconName, hideDetails, compact = false }: ObjectFormProps,
) {
  // Some consumers save a patch; others accumulate individual field edits.
  // Every form control must support both contracts, including multi-field edits.
  const onUpdate = async (updates: Partial<ObjectFormData>) => {
    if (onPartialUpdate) await onPartialUpdate(updates);
    else for (const [field, value] of Object.entries(updates)) onFieldUpdate?.(field, value);
  };
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const [newFieldType, setNewFieldType] = useState<
    "string" | "number" | "boolean"
  >("string");
  const [showAddField, setShowAddField] = useState(false);
  const [isSummarizeOpen, setIsSummarizeOpen] = useState(false);
  const [selectedSummary, setSelectedSummary] = useState<any>(null);

  const updateField = (field: string, value: any) => {
    if (field.includes(".")) {
      const updated = setNestedValue(object, field, value);
      if (onUpdate) {
        onUpdate(updated as Partial<ObjectFormData>);
      } else if (onFieldUpdate) {
        const topLevelKey = field.split(".")[0];
        onFieldUpdate(topLevelKey, updated[topLevelKey]);
      }
    } else {
      if (onFieldUpdate) {
        onFieldUpdate(field, value);
      } else if (onUpdate) {
        onUpdate({ [field]: value } as Partial<ObjectFormData>);
      }
    }
  };

  const updateFieldsAsync = async (updates: Partial<ObjectFormData>) => {
    if (onUpdate) {
      await onUpdate(updates);
    } else if (onFieldUpdate && Object.keys(updates).length === 1) {
      const [field, value] = Object.entries(updates)[0];
      onFieldUpdate(field, value);
    }
  };

  // Use debounced auto-save for name field
  const [nameValue, setNameValue] = useDebouncedUpdate(
    object.name || "",
    500, // 500ms delay
    updateFieldsAsync,
    "name",
  );

  // Use debounced auto-save for details field
  const [detailsValue, setDetailsValue] = useDebouncedUpdate(
    object.details || "",
    500, // 500ms delay
    updateFieldsAsync,
    "details",
  );

  const extraFieldsFlat = flattenNestedFields(
    Object.fromEntries(
      Object.entries(object).filter(([key]) => !KNOWN_FIELDS.has(key))
    )
  );
  
  const extraFields = extraFieldsFlat.filter(([path]) => {
    const topLevelKey = path.split(".")[0];
    return !KNOWN_FIELDS.has(topLevelKey);
  });

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

    if (newFieldName.includes(".")) {
      const updated = setNestedValue(object, newFieldName, value);
      if (onUpdate) {
        onUpdate(updated as Partial<ObjectFormData>);
      } else if (onFieldUpdate) {
        const topLevelKey = newFieldName.split(".")[0];
        onFieldUpdate(topLevelKey, updated[topLevelKey]);
      }
    } else {
      updateField(newFieldName, value);
    }

    setNewFieldName("");
    setNewFieldValue("");
    setNewFieldType("string");
    setShowAddField(false);
  };

  const handleDeleteCustomField = (fieldName: string) => {
    if (fieldName.includes(".")) {
      const updated = setNestedValue(object, fieldName, null);
      if (onUpdate) {
        onUpdate(updated as Partial<ObjectFormData>);
      } else if (onFieldUpdate) {
        const topLevelKey = fieldName.split(".")[0];
        const topLevelValue = updated[topLevelKey];
        if (topLevelValue !== undefined) {
          onFieldUpdate(topLevelKey, topLevelValue);
        } else {
          onFieldUpdate(topLevelKey, null);
        }
      }
    } else {
      updateField(fieldName, null);
    }
  };

  return (
    <div className="space-y-6">
      {!hideIconName && (
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">
            <Label className="text-sm font-medium">Icon</Label>
            <div className="mt-1">
              <EmojiPickerButton
                value={object.icon}
                onChange={(icon) => updateField("icon", icon)}
              />
            </div>
          </div>

          <div className="flex-1">
            <Label htmlFor="name" className="text-sm font-medium">Name</Label>
            <Input
              id="name"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="Object name"
              className="mt-1"
            />
          </div>
        </div>
      )}

      {!hideDetails && (
        <DetailsField
          value={detailsValue}
          onChange={setDetailsValue}
        />
      )}

      <SummarizeDialog
        open={isSummarizeOpen}
        onOpenChange={setIsSummarizeOpen}
        startDate={object.timeRanges?.[0]?.start || new Date()}
        endDate={object.timeRanges?.[0]?.end || new Date()}
        objectId={object._id?.toString()}
        title="Summarize Conversation"
        description="Generate a summary for this conversation based on its time range."
      />

      <Dialog open={selectedSummary !== null} onOpenChange={(open) => !open && setSelectedSummary(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Summary Details</DialogTitle>
          </DialogHeader>
          {selectedSummary && (
            <div className="space-y-4">
              

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium">Model</Label>
                  <div className="mt-1 text-sm">
                    {selectedSummary.model} ({selectedSummary.modelName})
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Generated</Label>
                  <div className="mt-1 text-sm">
                    {new Date(selectedSummary.date).toLocaleString([], {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </div>
                </div>
              </div>

              {selectedSummary.usage && (
                <div>
                  <Label className="text-sm font-medium">Token Usage</Label>
                  <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">Prompt</div>
                      <div className="font-medium">{selectedSummary.usage.promptTokens.toLocaleString()}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">Completion</div>
                      <div className="font-medium">{selectedSummary.usage.completionTokens.toLocaleString()}</div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">Total</div>
                      <div className="font-medium">{selectedSummary.usage.totalTokens.toLocaleString()}</div>
                    </div>
                  </div>
                </div>
              )}

              {selectedSummary.prompt && (
                <div>
                  <Label className="text-sm font-medium">System Prompt</Label>
                  <div className="mt-2 p-3 bg-muted rounded-md text-sm whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                    {selectedSummary.prompt}
                  </div>
                </div>
              )}

              {selectedSummary.jobId && (
                <div>
                  <Label className="text-sm font-medium">Job ID</Label>
                  <div className="mt-1 text-sm font-mono text-muted-foreground">
                    {selectedSummary.jobId}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {!hideSummary && object.summaries && object.summaries.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{object.summaries.length > 1 ? 'Summaries' : 'Summary'}</Label>
          <div className="space-y-3">
            {[...object.summaries].reverse().map((summary, index) => (
              <div
                key={index}
                className="border rounded-lg p-4 space-y-3 bg-muted/30"
              >
                <div className="text-sm">
                  <Markdown>{summary.text}</Markdown>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Model:</span>
                    <span>{summary.model} ({summary.modelName})</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Date:</span>
                    <span>
                      {new Date(summary.date).toLocaleString([], {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {(summary.usage || summary.prompt || summary.jobId) && (
                    <Button 
                      variant="link" 
                      size="sm"
                      onClick={() => setSelectedSummary(summary)}
                      className="p-0 h-auto"
                    >
                      <span className="text-xs text-muted-foreground hover:text-foreground">
                        See all details...
                      </span>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Object Type Toggle Buttons */}
      <div className={compact ? "space-y-1" : "space-y-2"}>
        <Label className={`text-muted-foreground ${compact ? 'text-xs' : 'text-sm'}`}>Object Type</Label>
        <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-2'}`}>
          <button
            type="button"
            onClick={() => updateField("isPerson", !object.isPerson)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isPerson
                ? "bg-blue-500 text-white border-blue-600 shadow-sm"
                : "bg-background border-border hover:bg-blue-50 hover:border-blue-300"
              }
            `}
          >
            <User className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Person</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isEvent", !object.isEvent)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isEvent
                ? "bg-green-500 text-white border-green-600 shadow-sm"
                : "bg-background border-border hover:bg-green-50 hover:border-green-300"
              }
            `}
          >
            <Calendar className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Event</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isPlace", !object.isPlace)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isPlace
                ? "bg-teal-500 text-white border-teal-600 shadow-sm"
                : "bg-background border-border hover:bg-teal-50 hover:border-teal-300"
              }
            `}
          >
            <MapPin className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Place</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isOrganization", !object.isOrganization)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isOrganization
                ? "bg-indigo-500 text-white border-indigo-600 shadow-sm"
                : "bg-background border-border hover:bg-indigo-50 hover:border-indigo-300"
              }
            `}
          >
            <Building2 className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Organization</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isProduct", !object.isProduct)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isProduct
                ? "bg-amber-500 text-white border-amber-600 shadow-sm"
                : "bg-background border-border hover:bg-amber-50 hover:border-amber-300"
              }
            `}
          >
            <Box className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Product</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isProject", !object.isProject)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isProject
                ? "bg-violet-500 text-white border-violet-600 shadow-sm"
                : "bg-background border-border hover:bg-violet-50 hover:border-violet-300"
              }
            `}
          >
            <FolderKanban className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Project</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isAnimal", !object.isAnimal)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isAnimal
                ? "bg-lime-500 text-white border-lime-600 shadow-sm"
                : "bg-background border-border hover:bg-lime-50 hover:border-lime-300"
              }
            `}
          >
            <PawPrint className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Animal</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isConcept", !object.isConcept)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isConcept
                ? "bg-sky-500 text-white border-sky-600 shadow-sm"
                : "bg-background border-border hover:bg-sky-50 hover:border-sky-300"
              }
            `}
          >
            <Lightbulb className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Concept</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isMedia", !object.isMedia)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isMedia
                ? "bg-fuchsia-500 text-white border-fuchsia-600 shadow-sm"
                : "bg-background border-border hover:bg-fuchsia-50 hover:border-fuchsia-300"
              }
            `}
          >
            <Film className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Media</span>
          </button>

          <button
            type="button"
            onClick={() => updateField("isConversation", !object.isConversation)}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isConversation
                ? "bg-cyan-500 text-white border-cyan-600 shadow-sm"
                : "bg-background border-border hover:bg-cyan-50 hover:border-cyan-300"
              }
            `}
          >
            <MessageSquare className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Conversation</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (object.isRelationship) {
                onUpdate?.({
                  isRelationship: false,
                  relationship: undefined,
                  isPromise: false,
                });
              } else {
                onUpdate?.({
                  isRelationship: true,
                  relationship: { symmetrical: false },
                });
              }
            }}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isRelationship && !object.isPromise
                ? "bg-purple-500 text-white border-purple-600 shadow-sm"
                : "bg-background border-border hover:bg-purple-50 hover:border-purple-300"
              }
            `}
          >
            <Users className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Relationship</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (object.isPromise) {
                onUpdate?.({ isPromise: false });
              } else {
                const updates: Partial<ObjectFormData> = { isPromise: true };
                if (!object.isRelationship) {
                  updates.isRelationship = true;
                  updates.relationship = { symmetrical: false };
                }
                onUpdate?.(updates);
              }
            }}
            className={`
              flex items-center rounded-md border transition-all font-medium whitespace-nowrap
              ${compact ? 'gap-1 px-1.5 py-0.5 text-[10px]' : 'gap-2 px-3 py-2 text-sm border-2'}
              ${object.isPromise
                ? "bg-orange-500 text-white border-orange-600 shadow-sm"
                : "bg-background border-border hover:bg-orange-50 hover:border-orange-300"
              }
            `}
          >
            <Handshake className={compact ? "w-3 h-3" : "w-4 h-4"} />
            <span>Promise</span>
          </button>
        </div>
      </div>

      {object.isRelationship && object.relationship && (
        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-end min-w-0">
            {/* Subject */}
            <div className="space-y-2 min-w-0">
              <div className="flex items-center gap-2">
                <Label className="text-xs font-medium">Subject</Label>
                {object.relationship.subject && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/objects/${
                          object.relationship.subject instanceof ObjectId
                            ? object.relationship.subject.toHexString()
                            : String(object.relationship.subject)
                        }`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <button
                          type="button"
                          className="flex items-center gap-1 p-1 hover:bg-muted rounded"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Open subject</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                {!object.relationship.symmetrical && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1 p-1 hover:bg-muted rounded"
                        onClick={() => {
                          if (object.relationship) {
                            const newRelationship = {
                              ...object.relationship,
                              subject: object.relationship.object,
                              object: object.relationship.subject,
                            };
                            onUpdate({ relationship: newRelationship });
                          }
                        }}
                      >
                        <RefreshCcw className="w-3 h-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Reverse direction</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div className="flex gap-2 min-w-0">
                <ObjectSelectionDropdown
                  value={object.relationship.subject instanceof ObjectId
                    ? object.relationship.subject.toHexString()
                    : String(object.relationship.subject)}
                  onChange={(value) => {
                    if (object.relationship && value) {
                      const newRelationship = {
                        ...object.relationship,
                        subject: new ObjectId(value),
                      };
                      onUpdate({ relationship: newRelationship });
                    }
                  }}
                  placeholder="Select a subject..."
                  className="min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Direction Toggle */}
            <div className="flex items-center justify-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (object.relationship) {
                        const newRelationship = {
                          ...object.relationship,
                          symmetrical: !object.relationship.symmetrical,
                        };
                        onUpdate({ relationship: newRelationship });
                      }
                    }}
                    className="h-8 w-8 p-0"
                  >
                    {object.relationship.symmetrical
                      ? <MoveHorizontal className="w-4 h-4" />
                      : <ArrowRight className="w-4 h-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {object.relationship.symmetrical
                      ? "Make Directional"
                      : "Make Symmetrical"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Object */}
            <div className="space-y-2 min-w-0">
              <div className="flex items-center gap-2">
                <Label className="text-xs font-medium">Object</Label>
                {object.relationship.object && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/objects/${
                          object.relationship.object instanceof ObjectId
                            ? object.relationship.object.toHexString()
                            : String(object.relationship.object)
                        }`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <button
                          type="button"
                          className="flex items-center gap-1 p-1 hover:bg-muted rounded"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Open object</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div className="flex gap-2 min-w-0">
                <ObjectSelectionDropdown
                  value={object.relationship.object instanceof ObjectId
                    ? object.relationship.object.toHexString()
                    : String(object.relationship.object)}
                  onChange={(value) => {
                    if (object.relationship && value) {
                      const newRelationship = {
                        ...object.relationship,
                        object: new ObjectId(value),
                      };
                      onUpdate({ relationship: newRelationship });
                    }
                  }}
                  placeholder="Select an object..."
                  className="min-w-0 flex-1"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {object.aliases && object.aliases.length > 0 && (
          <Label className="text-sm font-medium">Aliases</Label>
        )}
        <div className="space-y-2">
          {(object.aliases || []).map((alias, index) => (
            <div key={index} className="flex gap-2">
              <Input
                value={alias}
                onChange={(e) => {
                  const newAliases = [...(object.aliases || [])];
                  newAliases[index] = e.target.value;
                  onUpdate({ aliases: newAliases });
                }}
                placeholder="Alias"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const newAliases = (object.aliases || []).filter((_, i) =>
                    i !== index
                  );
                  onUpdate({
                    aliases: newAliases.length > 0 ? newAliases : undefined,
                  });
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {object.location && (
          <Label className="text-sm font-medium">Location</Label>
        )}
        {object.location && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label
                  htmlFor="latitude"
                  className="text-xs text-muted-foreground"
                >
                  Latitude
                </Label>
                <Input
                  id="latitude"
                  type="number"
                  step="any"
                  value={object.location.latitude}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === "") {
                      onUpdate({ location: undefined });
                    } else {
                      onUpdate({
                        location: {
                          latitude: parseFloat(value),
                          longitude: object.location?.longitude ?? 0,
                        },
                      });
                    }
                  }}
                  placeholder="0.0"
                />
              </div>
              <div>
                <Label
                  htmlFor="longitude"
                  className="text-xs text-muted-foreground"
                >
                  Longitude
                </Label>
                <Input
                  id="longitude"
                  type="number"
                  step="any"
                  value={object.location.longitude}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === "") {
                      onUpdate({ location: undefined });
                    } else {
                      onUpdate({
                        location: {
                          latitude: object.location?.latitude ?? 0,
                          longitude: parseFloat(value),
                        },
                      });
                    }
                  }}
                  placeholder="0.0"
                />
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUpdate({ location: undefined })}
            >
              Clear Location
            </Button>
          </div>
        )}
      </div>

      {/* Time Ranges - compact display with edit dialog */}
      <TimeRangesSection 
        timeRanges={object.timeRanges}
        onUpdate={(newRanges) => onUpdate({ timeRanges: newRanges })}
      />

      <div className="space-y-2">

        {showAddField && (
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
                <Label htmlFor="new-field-type" className="text-xs">Type</Label>
                <select
                  id="new-field-type"
                  value={newFieldType}
                  onChange={(e) =>
                    setNewFieldType(
                      e.target.value as "string" | "number" | "boolean",
                    )}
                  className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="new-field-value" className="text-xs">Value</Label>
              {newFieldType === "boolean"
                ? (
                  <select
                    id="new-field-value"
                    value={newFieldValue}
                    onChange={(e) => setNewFieldValue(e.target.value)}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                )
                : (
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
        )}

        {extraFields.length > 0 && (
          <div className="border rounded-lg divide-y">
            {extraFields.map(([key, value]) => {
              const valueType = getTypeString(value);
              const isBoolean = valueType === "boolean";
              const isNumber = valueType === "number";
              const isString = valueType === "string";
              const isArray = valueType.includes("[]");
              
              return (
                <div
                  key={key}
                  className="p-3 grid grid-cols-[auto_1fr_auto] gap-3 items-center"
                >
                  <div className="font-mono text-sm font-medium">{key}</div>
                  {isBoolean ? (
                    <select
                      value={String(value)}
                      onChange={(e) => {
                        const newValue = e.target.value === "true";
                        updateField(key, newValue);
                      }}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : isNumber ? (
                    <Input
                      type="number"
                      step="any"
                      value={value ?? ""}
                      onChange={(e) => {
                        const numValue = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateField(key, numValue);
                      }}
                      className="text-sm"
                    />
                  ) : isArray ? (
                    <Input
                      value={formatValue(value)}
                      readOnly
                      className="text-sm bg-muted"
                      title="Array values are not directly editable"
                    />
                  ) : (
                    <Input
                      value={typeof value === "string" ? value : String(value ?? "")}
                      onChange={(e) => {
                        updateField(key, e.target.value);
                      }}
                      className="text-sm"
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteCustomField(key)}
                    className="h-8 w-8 p-0"
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Buttons Section */}
      <div className="flex flex-wrap gap-2 pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const newAliases = [...(object.aliases || []), ""];
            onUpdate({ aliases: newAliases });
          }}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Alias
        </Button>

        {!object.location && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onUpdate({
                location: {
                  latitude: 0,
                  longitude: 0,
                },
              })}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Location
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const newRanges = [
              ...(object.timeRanges || []),
              { start: new Date(), end: undefined, name: undefined },
            ];
            onUpdate({ timeRanges: newRanges });
          }}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Time Range
        </Button>

        {object.isConversation && object.timeRanges?.[0]?.start && object.timeRanges?.[0]?.end && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsSummarizeOpen(true)}
          >
            <Wand2 className="w-4 h-4 mr-2" />
            Generate Summary
          </Button>
        )}

        {!showAddField && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddField(true)}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Custom Field
          </Button>
        )}
      </div>
    </div>
  );
}
