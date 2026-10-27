import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { Object, ObjectFormData } from "@/types/objects";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Box,
  Building2,
  Calendar,
  Check,
  Clock,
  Combine,
  Film,
  FolderKanban,
  Handshake,
  History,
  Lightbulb,
  MapPin,
  MessageSquare,
  Package,
  PawPrint,
  Pencil,
  Save,
  Scissors,
  Star,
  Tag,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { SmartBackButton } from "@/components/SmartBackButton";
import { useQueryClient } from "@tanstack/react-query";
import {
  objectKeys,
  useDeleteObject,
  useDuplicateCandidates,
  useObject,
  useUpdateObject,
} from "@/hooks/useObjectQueries";
import { MergeObjectDialog } from "@/components/dialogs/MergeObjectDialog";
import { SplitObjectDialog } from "@/components/dialogs/SplitObjectDialog";
import { ObjectForm } from "@/components/ObjectForm";
import { RelationshipsPanel } from "@/components/RelationshipsPanel";
import { TagChips } from "@/components/tags/TagChips";
import { MetadataDisplay } from "@/components/MetadataDisplay";
import { ObjectLocationSection } from "@/components/location/ObjectLocationSection";
import { ObjectPlayerTranscript } from "@/components/ObjectPlayerTranscript";
import { TimeRangeEditDialog } from "@/components/TimeRangeEditDialog";
import { SummarySection } from "@/components/SummarySection";
import { Markdown } from "@/components/Markdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/formatTime";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmojiPickerButton } from "@/components/ui/emoji-picker";
import { useActionDialog } from "@/components/ActionDialogProvider";

// Helper to get object type info
function getObjectType(
  object: {
    isPromise?: boolean;
    isRelationship?: boolean;
    isConversation?: boolean;
    isPerson?: boolean;
    isEvent?: boolean;
    isPlace?: boolean;
    isOrganization?: boolean;
    isProduct?: boolean;
    isProject?: boolean;
    isAnimal?: boolean;
    isConcept?: boolean;
    isMedia?: boolean;
  },
): {
  type: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
} {
  if (object.isPromise) {
    return {
      type: "Promise",
      icon: Handshake,
      color: "bg-orange-100 text-orange-800 border border-orange-200",
    };
  }
  if (object.isRelationship) {
    return {
      type: "Relationship",
      icon: Users,
      color: "bg-purple-100 text-purple-800 border border-purple-200",
    };
  }
  if (object.isConversation) {
    return {
      type: "Conversation",
      icon: MessageSquare,
      color: "bg-cyan-100 text-cyan-800 border border-cyan-200",
    };
  }
  if (object.isPerson) {
    return {
      type: "Person",
      icon: User,
      color: "bg-blue-100 text-blue-800 border border-blue-200",
    };
  }
  if (object.isEvent) {
    return {
      type: "Event",
      icon: Calendar,
      color: "bg-green-100 text-green-800 border border-green-200",
    };
  }
  if (object.isPlace) {
    return {
      type: "Place",
      icon: MapPin,
      color: "bg-teal-100 text-teal-800 border border-teal-200",
    };
  }
  if (object.isOrganization) {
    return {
      type: "Organization",
      icon: Building2,
      color: "bg-indigo-100 text-indigo-800 border border-indigo-200",
    };
  }
  if (object.isProduct) {
    return {
      type: "Product",
      icon: Box,
      color: "bg-amber-100 text-amber-800 border border-amber-200",
    };
  }
  if (object.isProject) {
    return {
      type: "Project",
      icon: FolderKanban,
      color: "bg-violet-100 text-violet-800 border border-violet-200",
    };
  }
  if (object.isAnimal) {
    return {
      type: "Animal",
      icon: PawPrint,
      color: "bg-lime-100 text-lime-800 border border-lime-200",
    };
  }
  if (object.isConcept) {
    return {
      type: "Concept",
      icon: Lightbulb,
      color: "bg-sky-100 text-sky-800 border border-sky-200",
    };
  }
  if (object.isMedia) {
    return {
      type: "Media",
      icon: Film,
      color: "bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-200",
    };
  }
  return {
    type: "Object",
    icon: Package,
    color: "bg-gray-100 text-gray-800 border border-gray-200",
  };
}

// Inline editable title component
function EditableTitle({
  icon,
  name,
  onIconChange,
  onNameChange,
}: {
  icon: any;
  name: string;
  onIconChange: (icon: any) => void;
  onNameChange: (name: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditName(name);
  }, [name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (editName.trim() !== name) {
      onNameChange(editName.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditName(name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div className="flex items-center gap-3 group flex-1 min-w-0">
      <div className="text-4xl flex-shrink-0">
        <EmojiPickerButton value={icon} onChange={onIconChange} />
      </div>
      {isEditing
        ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
              className="text-2xl font-bold h-auto py-1 flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSave}
              className="flex-shrink-0"
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              className="flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        )
        : (
          <h1
            className="text-2xl font-bold cursor-pointer hover:text-primary transition-colors flex items-center gap-2 flex-1 min-w-0"
            onClick={() => setIsEditing(true)}
          >
            <span className="truncate">{name || "Untitled Object"}</span>
            <Pencil className="w-4 h-4 opacity-0 group-hover:opacity-50 transition-opacity flex-shrink-0" />
          </h1>
        )}
    </div>
  );
}

// Compact "which AI made this" rows for the Metadata card. Shows the
// provider, alias and model recorded for extraction, summaries and tagging
// when that provenance exists on the object.
function AiGenerationInfo({ object }: { object: any }) {
  const formatProvenance = (p?: {
    providerProfileName?: string;
    requestedModel?: string;
    resolvedModel?: string;
    reasoning?: string;
    reasoningTokens?: number;
  }): string | null => {
    if (!p) return null;
    const requested = p.requestedModel;
    const resolved = p.resolvedModel;
    const model = requested && resolved && requested !== resolved
      ? `${requested} → ${resolved}`
      : resolved || requested;
    if (!p.providerProfileName && !model) return null;
    const reasoning = p.reasoning
      ? `reasoning ${p.reasoning}${
        typeof p.reasoningTokens === "number"
          ? ` (${p.reasoningTokens} tok)`
          : ""
      }`
      : null;
    return [p.providerProfileName, model, reasoning].filter(Boolean)
      .join(" · ");
  };

  const rows: Array<{ label: string; value: string }> = [];
  const extractionLabel = formatProvenance(object?.metadata?.extractedWith);
  if (extractionLabel) {
    rows.push({ label: "Extraction", value: extractionLabel });
  } else {
    // Entities carry generatedWith instead of extractedWith.
    const generatedLabel = formatProvenance(object?.metadata?.generatedWith);
    if (generatedLabel) {
      rows.push({ label: "Extracted by", value: generatedLabel });
    }
  }
  const summaries: any[] = Array.isArray(object?.summaries)
    ? object.summaries
    : [];
  summaries.forEach((summary, index) => {
    const label = formatProvenance({
      providerProfileName: summary?.provenance?.providerProfileName,
      requestedModel: summary?.requestedModel ?? summary?.model,
      resolvedModel: summary?.resolvedModel ?? summary?.modelName,
      reasoning: summary?.provenance?.reasoning,
      reasoningTokens: summary?.provenance?.reasoningTokens,
    });
    if (label) {
      rows.push({
        label: summaries.length > 1 ? `Summary #${index + 1}` : "Summary",
        value: label,
      });
    }
  });
  const taggingRuns = object?.metadata?.aiProvenance?.taggingRuns;
  const lastTagging = Array.isArray(taggingRuns)
    ? taggingRuns[taggingRuns.length - 1]
    : undefined;
  const taggingLabel = formatProvenance(lastTagging);
  if (taggingLabel) rows.push({ label: "Tagging", value: taggingLabel });

  if (rows.length === 0) return null;
  return (
    <div className="pt-1.5 mt-1.5 border-t border-border/50 space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        AI generation
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-2">
          <span className="text-muted-foreground shrink-0">{row.label}:</span>
          <span className="text-right break-all font-mono" title={row.value}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const ObjectDetailPage = () => {
  const { confirmAction } = useActionDialog();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const summaryJobId = searchParams.get("summaryJobId");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Use React Query hooks
  const { data: object, isLoading: loading, error } = useObject(id);
  const updateObjectMutation = useUpdateObject();
  const deleteObjectMutation = useDeleteObject();

  // State for time range editing from metadata display
  const [editingTimeRangeIndex, setEditingTimeRangeIndex] = useState<
    number | null
  >(null);

  // Merge / split dialogs
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeInitialOtherId, setMergeInitialOtherId] = useState<
    string | undefined
  >(undefined);
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const canMergeSplit = !!object && !object.isRelationship &&
    !object.isConversation;
  const { data: duplicateCandidates = [] } = useDuplicateCandidates(
    canMergeSplit ? id : undefined,
  );

  // State for summary details dialog
  const [selectedSummary, setSelectedSummary] = useState<any | null>(null);
  const selectedSummarySource = selectedSummary?.sourceRefs;
  const selectedSummaryStart = selectedSummarySource
    ? new Date(selectedSummarySource.coverageStart).getTime()
    : NaN;
  const selectedSummaryEnd = selectedSummarySource
    ? new Date(selectedSummarySource.coverageEnd).getTime()
    : NaN;
  const selectedSummaryTranscriptHref = Number.isFinite(selectedSummaryStart) &&
      Number.isFinite(selectedSummaryEnd)
    ? `/transcript?start=${selectedSummaryStart}&end=${selectedSummaryEnd}`
    : undefined;

  // State for editing details
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [editingDetailsValue, setEditingDetailsValue] = useState("");

  // Autosave settings and status
  const { autoSave, setAutoSave, timeFormat: dateFormat } = useSettingsStore();
  const [pendingChanges, setPendingChanges] = useState<Record<string, any>>({});
  const pendingChangesRef = useRef<Record<string, any>>({}); // Ref to always get latest pending changes
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [, forceUpdate] = useState(0); // For relative time updates
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    pendingChangesRef.current = pendingChanges;
  }, [pendingChanges]);

  // Update relative time every minute
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Core save function - saves all pending changes sequentially with proper version tracking
  const saveAllPendingChanges = useCallback(async () => {
    // Get current object from cache to ensure we have the latest version
    const currentObject = queryClient.getQueryData<typeof object>(
      objectKeys.detail(id!),
    );
    if (!currentObject || !id) return;

    // Use ref to get latest pending changes (avoids stale closure issue)
    const changesToSave = { ...pendingChangesRef.current };
    if (Object.keys(changesToSave).length === 0) return;

    setIsSaving(true);
    let currentVersion = currentObject.version;
    let successCount = 0;

    // Save changes sequentially with updated version after each save
    for (const [field, value] of Object.entries(changesToSave)) {
      try {
        const result = await updateObjectMutation.mutateAsync({
          id: currentObject._id.toString(),
          version: currentVersion,
          field,
          value,
        });
        // Update version from response for next iteration
        if (result && typeof result.version === "number") {
          currentVersion = result.version;
        }
        successCount++;
        // Clear this field from pending
        setPendingChanges((prev) => {
          const { [field]: _, ...rest } = prev;
          return rest;
        });
      } catch (error) {
        console.error(`Failed to save field ${field}:`, error);
        // Stop on error to avoid cascading failures
        break;
      }
    }

    setIsSaving(false);
    if (successCount > 0) {
      setLastSaved(new Date());
      // Invalidate to ensure UI shows latest version
      queryClient.invalidateQueries({ queryKey: objectKeys.detail(id) });
    }
  }, [id, updateObjectMutation, queryClient]);

  // Schedule autosave - debounces all changes together
  const scheduleAutoSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveAllPendingChanges();
    }, 500);
  }, [saveAllPendingChanges]);

  // Handle field update - updates UI immediately, schedules save if autosave enabled
  const handleFieldUpdate = useCallback((field: string, value: any) => {
    if (!object || !id) return;

    // Update pendingChanges immediately for instant visual feedback
    setPendingChanges((prev) => ({ ...prev, [field]: value }));

    if (autoSave) {
      scheduleAutoSave();
    }
  }, [object, id, autoSave, scheduleAutoSave]);

  // Handle starring a summary - only one can be starred at a time
  const handleStarSummary = useCallback((index: number) => {
    if (!object || !object.summaries) return;

    // Get current summaries, applying any pending changes
    const currentSummaries = pendingChanges.summaries || object.summaries;

    // Create new array with updated starred state
    const newSummaries = currentSummaries.map((summary: any, i: number) => {
      if (i === index) {
        // Toggle the starred state for the selected summary
        return { ...summary, starred: !summary.starred };
      }
      // Unstar all other summaries
      return { ...summary, starred: false };
    });

    handleFieldUpdate("summaries", newSummaries);
  }, [object, pendingChanges.summaries, handleFieldUpdate]);

  // Manual save - saves immediately
  const handleManualSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveAllPendingChanges();
  }, [saveAllPendingChanges]);

  const hasPendingChanges = Object.keys(pendingChanges).length > 0;

  // Convert Object to ObjectFormData for the form
  // Merge pendingChanges for instant visual feedback (before throttled save completes)
  const formObject: ObjectFormData = object
    ? {
      ...object,
      ...pendingChanges, // Apply pending changes immediately for instant UI feedback
      // Use pending relationship changes if present, otherwise use server's relationship
      relationship: pendingChanges.relationship !== undefined
        ? pendingChanges.relationship
        : object.relationship
        ? {
          object: object.relationship.object,
          subject: object.relationship.subject,
          symmetrical: object.relationship.symmetrical,
        }
        : undefined,
    }
    : {} as ObjectFormData;

  const handleDelete = async () => {
    if (!object || !id) return;
    const confirmed = await confirmAction({
      title: "Delete this object?",
      description: "The object will be removed from active views.",
      actionLabel: "Delete object",
      destructive: true,
    });
    if (!confirmed) return;

    deleteObjectMutation.mutate(id, {
      onSuccess: () => {
        navigate("/objects");
      },
    });
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <SmartBackButton defaultPath="/objects" />
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">Loading object...</p>
        </div>
      </div>
    );
  }

  if (error || !object) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <SmartBackButton defaultPath="/objects" />
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-red-500">
            Error: {error?.message || "Object not found"}
          </p>
        </div>
      </div>
    );
  }

  // Tombstone: the object was deleted (directly or by a merge); the backend
  // reports when/by whom instead of failing with an error.
  if (object.deleted) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <SmartBackButton defaultPath="/objects" />
        </div>
        <div className="border rounded-lg p-8 text-center space-y-3">
          <p className="text-lg font-medium">
            {object.name ? `«${object.name}»` : "This object"} was deleted
          </p>
          <p className="text-sm text-muted-foreground">
            {object.deletedAt && <>Deleted {formatTime(object.deletedAt)}</>}
            {object.deletedBy && <>by {object.deletedBy}</>}
          </p>
          {object.mergedInto && (
            <Button
              variant="outline"
              onClick={() => navigate(`/objects/${object.mergedInto}`)}
            >
              It was merged — open the combined object
            </Button>
          )}
        </div>
      </div>
    );
  }

  const hasTimeRanges = object.timeRanges && object.timeRanges.length > 0;

  // Get object type info for badge
  const typeInfo = getObjectType(object);
  const TypeIcon = typeInfo.icon;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Sticky Header with navigation and actions */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b pb-3 -mx-4 px-4 pt-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SmartBackButton defaultPath="/objects" />
            {/* Star toggle button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleFieldUpdate("starred", !object.starred)}
              className={object.starred
                ? "text-yellow-500 hover:text-yellow-600"
                : "text-muted-foreground hover:text-yellow-500"}
              title={object.starred ? "Remove from starred" : "Add to starred"}
            >
              <Star
                className={`w-5 h-5 ${object.starred ? "fill-current" : ""}`}
              />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            {/* Status indicator */}
            <div className="flex items-center gap-1.5 text-sm">
              {updateObjectMutation.isPending
                ? <span className="text-primary font-medium">Saving...</span>
                : hasPendingChanges
                ? <span className="text-amber-600 font-medium">● Unsaved</span>
                : (
                  <span className="flex items-center gap-1 text-green-600 font-medium">
                    <Check className="w-4 h-4" />
                    Saved
                  </span>
                )}
            </div>

            {/* Autosave toggle */}
            <div className="flex items-center gap-1.5 text-sm">
              <Switch
                checked={autoSave}
                onCheckedChange={setAutoSave}
                className="h-4 w-7"
              />
              <span className="text-muted-foreground">Auto</span>
            </div>

            {/* Save button (shown when autosave is off) */}
            {!autoSave && (
              <Button
                variant={hasPendingChanges ? "default" : "outline"}
                size="sm"
                onClick={handleManualSave}
                disabled={!hasPendingChanges || updateObjectMutation.isPending}
              >
                <Save className="w-4 h-4 mr-1" />
                Save
              </Button>
            )}

            {canMergeSplit && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  title="Merge with a duplicate object"
                  onClick={() => {
                    if (hasPendingChanges) handleManualSave();
                    setMergeInitialOtherId(undefined);
                    setMergeDialogOpen(true);
                  }}
                >
                  <Combine className="w-4 h-4 mr-1" />
                  Merge
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  title="Split into two objects"
                  onClick={() => {
                    if (hasPendingChanges) handleManualSave();
                    setSplitDialogOpen(true);
                  }}
                >
                  <Scissors className="w-4 h-4 mr-1" />
                  Split
                </Button>
              </>
            )}
            {object.isTag && (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/objects?tag=${id}`}>
                  <Tag className="w-4 h-4 mr-1" />
                  Tagged objects
                </Link>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/objects/${id}/history`}>
                <History className="w-4 h-4 mr-1" />
                History
                <span className="ml-1 text-muted-foreground">
                  v{object.version}
                </span>
              </Link>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteObjectMutation.isPending}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Title row: Icon + Name on left, metadata on right - all on one line */}
      <div className="flex items-center justify-between gap-4">
        <EditableTitle
          icon={object.icon}
          name={object.name || ""}
          onIconChange={(icon) => handleFieldUpdate("icon", icon)}
          onNameChange={(name) => handleFieldUpdate("name", name)}
        />

        {/* Object Type, Date, Duration, Tags - aligned on one line */}
        <div className="flex items-center gap-3 flex-shrink-0 text-xs">
          {/* Object Type Badge */}
          <div
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium ${typeInfo.color}`}
          >
            <TypeIcon className="w-3 h-3" />
            <span>{typeInfo.type}</span>
          </div>

          {/* Date and Duration together */}
          {hasTimeRanges && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span>
                {formatTime(
                  new Date(object.timeRanges[0].start),
                  "gregorian-local-natural",
                )}
              </span>
              {object.timeRanges[0].end && (
                <span className="font-semibold text-foreground">
                  {Math.round(
                    (new Date(object.timeRanges[0].end).getTime() -
                      new Date(object.timeRanges[0].start).getTime()) / 60000,
                  )}m
                </span>
              )}
            </div>
          )}

          {/* Aliases */}
          {object.aliases && object.aliases.length > 0 && (
            <div className="flex items-center gap-1">
              <Tag className="w-3 h-3 text-muted-foreground" />
              {object.aliases.slice(0, 2).map((alias: string, idx: number) => (
                <Badge key={idx} variant="secondary" className="text-xs py-0">
                  {alias}
                </Badge>
              ))}
              {object.aliases.length > 2 && (
                <span className="text-muted-foreground">
                  +{object.aliases.length - 2}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tags on their own line so a long title never hides them */}
      <div className="text-xs -mt-3">
        <TagChips object={object} />
      </div>

      {/* Row 1: Summary (left) + Player/Transcript (right) - flexible height */}
      {hasTimeRanges && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Summary - with model selector, generate button, and history navigation */}
          <SummarySection
            object={pendingChanges.summaries
              ? { ...object, summaries: pendingChanges.summaries }
              : object}
            summaryJobId={summaryJobId}
            onSummaryClick={setSelectedSummary}
            onStarSummary={handleStarSummary}
          />

          {/* Player + Transcript - flexible height, expands for long content */}
          <ObjectPlayerTranscript
            timeRange={object.timeRanges[0]}
            minHeight={400}
            maxHeight={800}
          />
        </div>
      )}

      {/* Where this happened, from imported GPS tracks (hidden without data) */}
      {object && (
        <ObjectLocationSection
          object={object}
          onApplyLocation={(latitude, longitude) =>
            handleFieldUpdate("location", { latitude, longitude })}
        />
      )}

      {/* Row 2: Relationships (left) | Object Type (right) - equal height */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-3"
        style={{ gridAutoRows: "1fr" }}
      >
        {/* Relationships */}
        <div className="border rounded-lg p-3 min-h-[200px] max-h-[280px] overflow-y-auto flex flex-col">
          <RelationshipsPanel object={object} />
        </div>

        {/* Object Type - with labels, clickable */}
        <div className="border rounded-lg p-3 min-h-[200px] max-h-[280px] overflow-y-auto">
          <ObjectForm
            object={formObject}
            onUpdate={async (updates) => {
              if (!object) return;
              for (const [field, value] of Object.entries(updates)) {
                handleFieldUpdate(field, value);
              }
            }}
            hideSummary
            hideIconName
            hideDetails
            compact
          />
        </div>
      </div>

      {/* Possible duplicates (case-insensitive name/alias collisions) */}
      {canMergeSplit && duplicateCandidates.length > 0 && (
        <div className="border border-amber-300 bg-amber-50/50 rounded-lg p-3 space-y-2">
          <h3 className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
            <Combine className="w-3.5 h-3.5" />
            Possible duplicates
          </h3>
          <div className="space-y-1">
            {duplicateCandidates.map((candidate: any) => {
              const candidateId = candidate._id.toString();
              const candidateType = getObjectType(candidate);
              return (
                <div
                  key={candidateId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <Link
                    to={`/objects/${candidateId}`}
                    className="flex items-center gap-2 min-w-0 hover:underline"
                  >
                    <span className="truncate font-medium">
                      {candidate.icon?.text ? `${candidate.icon.text} ` : ""}
                      {candidate.name ?? "Unnamed"}
                    </span>
                    {candidate.aliases?.length > 0 && (
                      <span className="text-xs text-muted-foreground truncate">
                        ({candidate.aliases.join(", ")})
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-medium ${candidateType.color}`}
                    >
                      {candidateType.type}
                    </span>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs flex-shrink-0"
                    onClick={() => {
                      if (hasPendingChanges) handleManualSave();
                      setMergeInitialOtherId(candidateId);
                      setMergeDialogOpen(true);
                    }}
                  >
                    <Combine className="w-3 h-3 mr-1" />
                    Merge…
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 3: Time Info + Metadata + Details (3 columns) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Time Information - compact inline */}
        <div className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Time Information
            </h3>
            {hasTimeRanges && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs"
                onClick={() => setEditingTimeRangeIndex(0)}
              >
                <Pencil className="w-3 h-3" />
              </Button>
            )}
          </div>
          <div className="text-xs space-y-1">
            {hasTimeRanges && object.timeRanges?.[0] && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Started:</span>
                  <span>
                    {formatTime(object.timeRanges[0].start, dateFormat)}
                  </span>
                </div>
                {object.timeRanges[0].end && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ended:</span>
                    <span>
                      {formatTime(object.timeRanges[0].end, dateFormat)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span className="font-medium">
                    {Math.round(
                      (new Date(object.timeRanges[0].end || Date.now())
                        .getTime() -
                        new Date(object.timeRanges[0].start).getTime()) / 60000,
                    )}m
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Metadata - compact */}
        <div className="border rounded-lg p-3 space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Metadata
          </h3>
          <div className="text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created:</span>
              <span>{formatTime(object.createdAt, dateFormat)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Updated:</span>
              <span>{formatTime(object.updatedAt, dateFormat)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version:</span>
              <span>{object.version}</span>
            </div>
            <AiGenerationInfo object={object} />
          </div>
        </div>

        {/* Details - compact */}
        <div className="border rounded-lg p-3 bg-muted/30 flex flex-col max-h-[150px]">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Details
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant={isEditingDetails ? "default" : "ghost"}
                size="sm"
                className="h-5 px-1.5 text-xs"
                onClick={() => {
                  if (!isEditingDetails) {
                    setEditingDetailsValue(object.details || "");
                  }
                  setIsEditingDetails(!isEditingDetails);
                }}
              >
                {isEditingDetails ? "Preview" : "Edit"}
              </Button>
              {isEditingDetails && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-xs"
                  onClick={() => {
                    handleFieldUpdate("details", editingDetailsValue);
                    setIsEditingDetails(false);
                  }}
                >
                  <Check className="w-3 h-3" />
                </Button>
              )}
            </div>
          </div>
          {isEditingDetails
            ? (
              <Textarea
                value={editingDetailsValue}
                onChange={(e) => setEditingDetailsValue(e.target.value)}
                placeholder="Add details..."
                className="flex-1 min-h-[60px] resize-none font-mono text-xs"
              />
            )
            : (
              <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]]:!overflow-y-scroll">
                <div className="prose prose-xs max-w-none pr-2 text-xs">
                  {object.details
                    ? <Markdown>{object.details}</Markdown>
                    : (
                      <p className="text-muted-foreground text-xs">
                        No details. Click Edit to add.
                      </p>
                    )}
                </div>
              </ScrollArea>
            )}
        </div>
      </div>

      {/* Merge / Split dialogs */}
      {canMergeSplit && (
        <>
          <MergeObjectDialog
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            currentObject={object}
            initialOtherId={mergeInitialOtherId}
          />
          <SplitObjectDialog
            open={splitDialogOpen}
            onOpenChange={setSplitDialogOpen}
            sourceObject={object}
          />
        </>
      )}

      {/* Time Range Edit Dialog triggered from MetadataDisplay */}
      {editingTimeRangeIndex !== null && object.timeRanges &&
        object.timeRanges[editingTimeRangeIndex] && (
        <TimeRangeEditDialog
          open={editingTimeRangeIndex !== null}
          onOpenChange={(open) => !open && setEditingTimeRangeIndex(null)}
          timeRange={object.timeRanges[editingTimeRangeIndex]}
          index={editingTimeRangeIndex}
          onSave={(index, range) => {
            const newRanges = [...(object.timeRanges || [])];
            newRanges[index] = range;
            handleFieldUpdate("timeRanges", newRanges);
          }}
          onDelete={(index) => {
            const newRanges = (object.timeRanges || []).filter((_: unknown, i: number) =>
              i !== index
            );
            handleFieldUpdate(
              "timeRanges",
              newRanges.length > 0 ? newRanges : undefined,
            );
          }}
        />
      )}

      {/* Summary Details Dialog */}
      <Dialog
        open={selectedSummary !== null}
        onOpenChange={(open) => !open && setSelectedSummary(null)}
      >
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
                    {selectedSummary.model} {selectedSummary.modelName &&
                      `(${selectedSummary.modelName})`}
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

              <div>
                <Label className="text-sm font-medium">
                  Conversation Emoji
                </Label>
                <div className="mt-1 text-sm">
                  {object?.icon && "text" in object.icon && object.icon.text
                    ? object.icon.text
                    : "Missing on conversation (usually legacy extraction)"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Emoji belongs to the conversation object, not to an individual
                  summary version.
                </p>
              </div>

              <div>
                <Label className="text-sm font-medium">Summary Source</Label>
                {selectedSummarySource
                  ? (
                    <div className="mt-2 space-y-2 rounded-md bg-muted p-3 text-sm">
                      <div>
                        {selectedSummarySource.conversationChunkIds.length}{" "}
                        conversation chunk(s),{" "}
                        {selectedSummarySource.transcriptionIds.length}{" "}
                        transcription(s)
                      </div>
                      {selectedSummarySource.conversationChunkIds.length > 0 &&
                        (
                          <div className="break-all font-mono text-xs text-muted-foreground">
                            Chunk:{" "}
                            {selectedSummarySource.conversationChunkIds.join(
                              ", ",
                            )}
                          </div>
                        )}
                      <div className="flex flex-wrap gap-3">
                        {selectedSummaryTranscriptHref && (
                          <Link
                            className="font-medium text-primary hover:underline"
                            to={selectedSummaryTranscriptHref}
                          >
                            Open source transcript
                          </Link>
                        )}
                        {selectedSummarySource.extractorJobId && (
                          <Link
                            className="font-medium text-primary hover:underline"
                            to={`/jobs/${selectedSummarySource.extractorJobId}`}
                          >
                            Open extraction job
                          </Link>
                        )}
                      </div>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Show transcription IDs
                        </summary>
                        <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                          {selectedSummarySource.transcriptionIds.join(", ") ||
                            "No transcription IDs recorded"}
                        </div>
                      </details>
                    </div>
                  )
                  : (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Legacy summary: exact source chunk and transcription IDs
                      were not recorded when this version was generated.
                    </p>
                  )}
              </div>

              {selectedSummary.usage && (
                <div>
                  <Label className="text-sm font-medium">Token Usage</Label>
                  <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">
                        Prompt
                      </div>
                      <div className="font-medium">
                        {selectedSummary.usage.promptTokens?.toLocaleString()}
                      </div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">
                        Completion
                      </div>
                      <div className="font-medium">
                        {selectedSummary.usage.completionTokens
                          ?.toLocaleString()}
                      </div>
                    </div>
                    <div className="p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">Total</div>
                      <div className="font-medium">
                        {selectedSummary.usage.totalTokens?.toLocaleString()}
                      </div>
                    </div>
                  </div>
                  {selectedSummary.usage.cost != null && (
                    <div className="mt-3 p-2 bg-muted rounded">
                      <div className="text-xs text-muted-foreground">
                        Estimated Cost
                      </div>
                      <div className="font-medium">
                        ${selectedSummary.usage.cost.toFixed(6)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {selectedSummary.promptName && (
                <div>
                  <Label className="text-sm font-medium">Prompt</Label>
                  <div className="mt-1 text-sm">
                    {selectedSummary.promptName}
                  </div>
                </div>
              )}

              {selectedSummary.prompt && (
                <div>
                  <Label className="text-sm font-medium">System Prompt</Label>
                  <div className="mt-2 p-3 bg-muted rounded-md text-sm whitespace-pre-wrap max-h-[200px] overflow-y-auto font-mono">
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
    </div>
  );
};

export default ObjectDetailPage;
