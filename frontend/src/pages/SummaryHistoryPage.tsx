import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow, subDays } from "date-fns";
import {
  AlertTriangle,
  Ban,
  CalendarRange,
  CheckCircle2,
  CircleDashed,
  Cpu,
  ExternalLink,
  FileText,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/DateRangePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Markdown } from "@/components/Markdown";
import { ModelSelector } from "@/components/ModelSelector";
import {
  buildSummaryHistoryPipeline,
  buildSummaryTaskPipeline,
  normalizeSummaryHistoryResult,
  normalizeSummaryTaskResult,
  type SummaryHistoryEntry,
  summaryPreview,
  type SummaryTaskEntry,
  type SummaryTaskStatus,
} from "@/lib/summaryHistory";
import {
  emptyModelArtifactResult,
  type ModelArtifactEntry,
  modelArtifactLabel,
  type ModelArtifactType,
  normalizeModelArtifactResult,
} from "@/lib/modelArtifacts";
import { useActionDialog } from "@/components/ActionDialogProvider";
import { useSettingsStore } from "@/stores/settingsStore";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import { zonedDateKey, zonedDateKeyToDate } from "@/lib/datePicker";

import {
  queueSummaryRerunRange,
  queueSummaryRerunSelection,
  summaryDateBounds,
} from "@/lib/summaryRerun";

type HistoryView = "summaries" | "tasks" | "models";
type DatePreset = "all" | "7d" | "30d" | "custom";

function formatDateTime(value?: string | Date): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return format(date, "MMM d, yyyy · HH:mm:ss");
}

function formatCoverage(entry: SummaryHistoryEntry): string {
  if (!entry.coverageStart) return "No source time range";
  const start = new Date(entry.coverageStart);
  const end = entry.coverageEnd ? new Date(entry.coverageEnd) : undefined;
  if (Number.isNaN(start.getTime())) return "No source time range";

  const startText = format(start, "MMM d, yyyy · HH:mm");
  if (!end || Number.isNaN(end.getTime())) return startText;
  const endText = start.toDateString() === end.toDateString()
    ? format(end, "HH:mm")
    : format(end, "MMM d, yyyy · HH:mm");
  return `${startText} – ${endText}`;
}

function SummaryHistoryCard({ entry }: { entry: SummaryHistoryEntry }) {
  const sourceStart = new Date(
    entry.sourceRefs?.coverageStart ?? entry.coverageStart ?? "",
  ).getTime();
  const sourceEnd = new Date(
    entry.sourceRefs?.coverageEnd ?? entry.coverageEnd ?? "",
  ).getTime();
  const transcriptHref =
    Number.isFinite(sourceStart) && Number.isFinite(sourceEnd)
      ? `/transcript?start=${sourceStart}&end=${sourceEnd}`
      : undefined;
  const modelName = entry.executedModel?.split("/").pop() || "Unknown model";
  return (
    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm transition-colors hover:border-primary/30">
      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <Link
              to={`/objects/${entry.objectId}`}
              className="text-base font-semibold leading-snug hover:text-primary sm:text-lg"
            >
              {entry.objectEmoji && (
                <span className="mr-2">{entry.objectEmoji}</span>
              )}
              {entry.objectName}
            </Link>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className="max-w-full break-all rounded-md bg-muted/70 px-2 py-1"
                title={entry.executedModel}
              >
                {modelName}
              </span>
              <span>Generated {formatDateTime(entry.generatedAt)}</span>
              {entry.fallbackUsed && (
                <Badge variant="outline">Fallback used</Badge>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" asChild>
            <Link
              to={`/objects/${entry.objectId}`}
              aria-label={`Open ${entry.objectName}`}
            >
              <ExternalLink className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <p className="line-clamp-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {summaryPreview(entry.text)}
        </p>
        <details className="group">
          <summary className="w-fit cursor-pointer text-sm font-medium text-primary">
            <span className="group-open:hidden">Read summary</span>
            <span className="hidden group-open:inline">Close summary</span>
          </summary>
          <div className="prose prose-sm mt-4 max-w-none border-t pt-4 dark:prose-invert">
            <Markdown>{entry.text}</Markdown>
          </div>
        </details>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarRange className="h-3.5 w-3.5" />
            {formatCoverage(entry)}
          </span>
          <div className="flex items-center gap-4">
            {transcriptHref && (
              <Link className="hover:text-foreground" to={transcriptHref}>
                Transcript
              </Link>
            )}
            {entry.jobId && (
              <Link
                className="hover:text-foreground"
                to={`/jobs/${entry.jobId}`}
              >
                Job details
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function taskStateLabel(state: string): string {
  switch (state) {
    case "completed":
      return "Finished successfully";
    case "active":
      return "Running";
    case "waiting":
      return "Waiting";
    case "delayed":
      return "Delayed";
    case "paused":
      return "Paused";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return state || "Unknown";
  }
}

function taskStateVariant(state: string) {
  if (state === "failed") return "destructive" as const;
  if (state === "completed") return "outline" as const;
  return "secondary" as const;
}

function SummaryTaskCard({ task }: { task: SummaryTaskEntry }) {
  const createdAt = new Date(task.createdAt);
  const progress = task.progress ?? {};
  const result = task.result ?? {};
  const processed = typeof progress.processed === "number"
    ? progress.processed
    : typeof result.processed === "number"
    ? result.processed
    : undefined;
  const total = typeof progress.total === "number"
    ? progress.total
    : typeof result.total === "number"
    ? result.total
    : undefined;

  return (
    <Card className="p-5">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={taskStateVariant(task.state)}>
              {taskStateLabel(task.state)}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">
              {task.id}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Created {formatDateTime(task.createdAt)}</span>
            {!Number.isNaN(createdAt.getTime()) && (
              <span>{formatDistanceToNow(createdAt, { addSuffix: true })}</span>
            )}
            {task.startedAt && (
              <span>Started {formatDateTime(task.startedAt)}</span>
            )}
            {task.finishedAt && (
              <span>Finished {formatDateTime(task.finishedAt)}</span>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/jobs/${task.id}`}>Open job</Link>
        </Button>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg bg-muted/40 p-4 md:grid-cols-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model
          </p>
          <p className="mt-1 break-all font-mono text-xs">
            {task.requestedModel}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Failure policy
          </p>
          <p className="mt-1 break-all text-xs">
            {task.fallbackModel
              ? `Retry once with ${task.fallbackModel}`
              : "Stop with error"}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Progress
          </p>
          <p className="mt-1 text-xs">
            {processed !== undefined
              ? `${processed}${total !== undefined ? ` / ${total}` : ""}`
              : "No progress reported"}
          </p>
        </div>
      </div>

      {task.failedReason && (
        <details className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-destructive">
            Show failure details
          </summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-destructive/30 px-4 py-3 text-xs text-destructive">
            {task.failedReason}
          </pre>
        </details>
      )}
    </Card>
  );
}

function ModelArtifactCard({ entry }: { entry: ModelArtifactEntry }) {
  return (
    <Card className="p-5">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {modelArtifactLabel(entry.artifactType)}
            </Badge>
            <Badge
              variant={entry.provenanceQuality === "exact"
                ? "secondary"
                : "outline"}
            >
              {entry.provenanceQuality === "exact"
                ? "Exact route recorded"
                : "Legacy provenance"}
            </Badge>
            {entry.fallbackUsed && (
              <Badge variant="destructive">Fallback used</Badge>
            )}
            {entry.parseStatus === "parse_error" && (
              <Badge variant="destructive">Output parse failed</Badge>
            )}
          </div>
          <Link
            to={`/objects/${entry.objectId}`}
            className="block truncate font-semibold hover:text-primary hover:underline"
          >
            {entry.objectName}
          </Link>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(entry.generatedAt)}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/objects/${entry.objectId}`}>Open object</Link>
        </Button>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg bg-muted/40 p-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model
          </p>
          <p className="mt-1 break-all font-mono text-xs">
            {entry.executedModel || "Unknown"}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Provider / result
          </p>
          <p className="mt-1 break-all text-xs">
            {entry.providerProfileName && (
              <span className="font-medium">{entry.providerProfileName} ·</span>
            )}
            {entry.providerBaseUrl ||
              (entry.provenanceQuality === "exact"
                ? "Provider route was not returned"
                : "Unavailable for legacy output")}
          </p>
          {entry.artifactType === "tagging" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {entry.selectedTagCount ?? 0} tag(s) selected; parser{" "}
              {entry.parseStatus || "unknown"}
            </p>
          )}
        </div>
      </div>

      {(entry.jobId || entry.chunkId) && (
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {entry.jobId && (
            <Link className="hover:underline" to={`/jobs/${entry.jobId}`}>
              Job {entry.jobId}
            </Link>
          )}
          {entry.chunkId && <span>Source chunk {entry.chunkId}</span>}
        </div>
      )}
    </Card>
  );
}

export default function SummaryHistoryPage() {
  const { confirmAction } = useActionDialog();
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const pickerTimeZone = resolveDefaultTimeZone(defaultTimeZone);
  const [view, setView] = useState<HistoryView>("summaries");
  const [taskStatus, setTaskStatus] = useState<SummaryTaskStatus>("all");
  const [artifactType, setArtifactType] = useState<ModelArtifactType | "all">(
    "all",
  );
  const [model, setModel] = useState("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState("100");
  const [displayLimit, setDisplayLimit] = useState(100);
  const [rerunTargetModel, setRerunTargetModel] = useState("");
  // Set when the target model was picked from a specific provider's group;
  // rerun jobs then route to that provider only.
  const [rerunTargetProviderId, setRerunTargetProviderId] = useState<
    string | undefined
  >(undefined);
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunResult, setRerunResult] = useState<string | null>(null);

  const dateBounds = summaryDateBounds(from, to, pickerTimeZone);
  const amount = limit.trim() ? Number(limit) : undefined;
  const amountValid = amount == null ||
    (Number.isInteger(amount) && amount >= 1 && amount <= 10000);
  const periodValid = datePreset === "all" || dateBounds != null;

  const query = useQuery({
    queryKey: [
      "summary-history",
      model,
      from,
      to,
      pickerTimeZone,
      limit,
      displayLimit,
    ],
    queryFn: async () => {
      const result = await api.callResource("mongo", {
        action: "aggregate",
        collection: "objects",
        pipeline: buildSummaryHistoryPipeline({
          model,
          ...(dateBounds ?? {}),
          limit: displayLimit,
          ...(amount != null ? { amount } : {}),
        }),
      });
      return normalizeSummaryHistoryResult(result);
    },
    enabled: view === "summaries" && amountValid && periodValid,
  });

  const taskQuery = useQuery({
    queryKey: ["summary-task-history", taskStatus, model, from, to, limit],
    queryFn: async () => {
      const result = await api.callResource("mongo", {
        action: "aggregate",
        collection: "jobs",
        pipeline: buildSummaryTaskPipeline({
          status: taskStatus,
          model,
          from: from || undefined,
          to: to || undefined,
          limit: Math.min(amount || 100, 500),
        }),
      });
      return normalizeSummaryTaskResult(result);
    },
    enabled: view === "tasks",
  });

  const modelArtifactQuery = useQuery({
    queryKey: [
      "model-artifacts",
      artifactType,
      model,
      from,
      to,
      pickerTimeZone,
      limit,
    ],
    queryFn: async () => {
      const result = await api.callResource("jobs", {
        action: "model_artifacts",
        model,
        limit: Math.min(amount || 100, 500),
        ...(artifactType === "all" ? {} : { artifactTypes: [artifactType] }),
        ...(dateBounds ?? {}),
      });
      return normalizeModelArtifactResult(result);
    },
    enabled: view === "models",
  });

  const data = query.data ??
    {
      entries: [],
      models: [],
      total: 0,
      objectCount: 0,
      selectedObjectIds: [],
    };
  const taskData = taskQuery.data ?? {
    entries: [],
    models: [],
    counts: {
      total: 0,
      completed: 0,
      unfinished: 0,
      failed: 0,
      cancelled: 0,
    },
  };
  const artifactData = modelArtifactQuery.data ?? emptyModelArtifactResult;
  const availableModels = view === "summaries"
    ? data.models
    : view === "tasks"
    ? taskData.models
    : artifactData.models;

  const applyDatePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset === "all") {
      setFrom("");
      setTo("");
      return;
    }
    if (preset === "custom") {
      if (!from || !to) {
        const today = new Date();
        setFrom(zonedDateKey(subDays(today, 6), pickerTimeZone));
        setTo(zonedDateKey(today, pickerTimeZone));
      }
      return;
    }

    const today = new Date();
    const days = preset === "7d" ? 7 : 30;
    setFrom(zonedDateKey(subDays(today, days - 1), pickerTimeZone));
    setTo(zonedDateKey(today, pickerTimeZone));
  };

  const changeView = (nextView: HistoryView) => {
    setView(nextView);
    setModel("all");
    setTaskStatus("all");
    setArtifactType("all");
    setLimit("100");
    setDisplayLimit(100);
    setRerunTargetModel("");
    setRerunTargetProviderId(undefined);
    setRerunResult(null);
  };

  const resetFilters = () => {
    setTaskStatus("all");
    setArtifactType("all");
    setModel("all");
    setDatePreset("all");
    setFrom("");
    setTo("");
    setLimit("100");
    setDisplayLimit(100);
  };

  const refreshCurrentView = () => {
    if (view === "summaries") return query.refetch();
    if (view === "tasks") return taskQuery.refetch();
    return modelArtifactQuery.refetch();
  };

  const currentViewFetching = view === "summaries"
    ? query.isFetching
    : view === "tasks"
    ? taskQuery.isFetching
    : modelArtifactQuery.isFetching;

  const canRerun = view === "summaries" && amountValid && periodValid &&
    (amount != null || dateBounds != null) && !query.isFetching &&
    !query.isError &&
    data.objectCount > 0 && !!rerunTargetModel && rerunTargetModel !== model &&
    !rerunPending;

  const rerunSummaries = async () => {
    if (!canRerun) return;
    const artifactIds = [...data.selectedObjectIds];
    if (model === rerunTargetModel) {
      setRerunResult("Choose a target model different from the source model.");
      return;
    }
    const accepted = await confirmAction({
      title:
        `Rerun summaries for ${data.objectCount.toLocaleString()} conversations?`,
      description: `${data.total.toLocaleString()} summaries match ${
        amount != null ? `the latest ${amount}` : "all summaries"
      }${
        dateBounds
          ? ` from ${from} through ${to} (${pickerTimeZone})`
          : " across all dates"
      }${
        model !== "all" ? `, from ${model}` : ""
      }. Append one new version per conversation using ${rerunTargetModel}. Originals are kept; existing target-model versions and queued jobs are skipped.`,
      actionLabel: "Rerun summaries",
    });
    if (!accepted) return;

    setRerunPending(true);
    setRerunResult(null);
    let queuedSoFar = 0;
    try {
      const target = {
        ...(model !== "all" ? { sourceModel: model } : {}),
        targetModel: rerunTargetModel,
        ...(rerunTargetProviderId
          ? { targetProviderProfileId: rerunTargetProviderId }
          : {}),
      };
      const call = (request: Record<string, unknown>) =>
        api.callResource("jobs", request);
      const onProgress = (queued: number, skipped: number) => {
        queuedSoFar = queued;
        setRerunResult(
          `Queued ${queued} summary rerun(s); ${skipped} already queued. Keep this page open until queueing finishes.`,
        );
      };
      const result = amount != null
        ? await queueSummaryRerunSelection(
          { ...target, artifactIds },
          call,
          onProgress,
        )
        : await queueSummaryRerunRange(
          { ...target, ...dateBounds! },
          call,
          onProgress,
        );

      setRerunResult(
        `Queueing complete: ${result.queued} summary rerun(s); ${result.skipped} already queued. Originals remain available for comparison.`,
      );
      await Promise.all([
        query.refetch(),
        modelArtifactQuery.refetch(),
        taskQuery.refetch(),
      ]);
    } catch (error) {
      setRerunResult(
        `Queueing stopped after ${queuedSoFar} confirmed rerun(s). ${
          error instanceof Error ? error.message : "Failed to queue reruns"
        } Retry the same selection to continue; existing jobs are skipped.`,
      );
    } finally {
      setRerunPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold">AI history</h1>
          </div>
          <p className="mt-1 text-muted-foreground">
            Browse your summaries and revisit them with a different model.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={refreshCurrentView}
          disabled={currentViewFetching}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${
              currentViewFetching ? "animate-spin" : ""
            }`}
          />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1 w-fit">
        {([
          ["summaries", "Summaries", FileText],
          ["tasks", "Activity", ListChecks],
          ["models", "All outputs", Cpu],
        ] as const).map(([key, label, Icon]) => (
          <Button
            key={key}
            variant={view === key ? "secondary" : "ghost"}
            className={`gap-2 rounded-lg ${
              view === key ? "bg-background shadow-sm" : "text-muted-foreground"
            }`}
            onClick={() => changeView(key)}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Button>
        ))}
      </div>

      <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 sm:p-6">
          {view === "tasks" && (
            <div className="space-y-2">
              <Label>Task status</Label>
              <Select
                value={taskStatus}
                onValueChange={(value) =>
                  setTaskStatus(value as SummaryTaskStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All task states</SelectItem>
                  <SelectItem value="completed">
                    Finished successfully
                  </SelectItem>
                  <SelectItem value="unfinished">Unfinished</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {view === "models" && (
            <div className="space-y-2">
              <Label>Output type</Label>
              <Select
                value={artifactType}
                onValueChange={(value) =>
                  setArtifactType(value as ModelArtifactType | "all")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All AI outputs</SelectItem>
                  <SelectItem value="summary">Summaries</SelectItem>
                  <SelectItem value="conversation_extraction">
                    Conversation extraction
                  </SelectItem>
                  <SelectItem value="tagging">Tagging</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>
              Model
            </Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="All models" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All models</SelectItem>
                {availableModels.map((item) => (
                  <SelectItem key={item.model} value={item.model}>
                    {item.model} ({item.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              {view === "tasks" ? "Task creation date" : "Period (generated)"}
            </Label>
            <Select
              value={datePreset}
              onValueChange={(value) => applyDatePreset(value as DatePreset)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any date</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {view === "summaries" && (
            <div className="space-y-2">
              <Label htmlFor="summary-amount">Last X (optional)</Label>
              <Input
                id="summary-amount"
                type="number"
                min={1}
                max={10000}
                step={1}
                placeholder="All matching summaries"
                value={limit}
                onChange={(event) => {
                  setLimit(event.target.value);
                  setDisplayLimit(100);
                }}
                aria-invalid={!amountValid}
              />
              {!amountValid && (
                <p className="text-xs text-destructive">
                  Enter a whole number from 1 to 10,000, or leave empty.
                </p>
              )}
            </div>
          )}
        </div>
        {datePreset === "custom" && (
          <div className="mx-5 mb-5 rounded-xl border bg-muted/20 p-4 sm:mx-6">
            <DateRangePicker
              label={view === "tasks" ? "Created range" : "Generated range"}
              value={{
                start: zonedDateKeyToDate(from, pickerTimeZone) ??
                  subDays(new Date(), 6),
                end: zonedDateKeyToDate(to, pickerTimeZone) ?? new Date(),
              }}
              onChange={(value) => {
                setFrom(zonedDateKey(value.start, pickerTimeZone));
                if (value.end) setTo(zonedDateKey(value.end, pickerTimeZone));
              }}
              precision="date"
              timeZone={pickerTimeZone}
            />
          </div>
        )}
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-3 sm:px-6"
          aria-live="polite"
        >
          <p className="text-sm text-muted-foreground">
            {view === "summaries"
              ? (
                !amountValid || !periodValid
                  ? "Choose valid filters"
                  : query.isFetching
                  ? "Counting matches…"
                  : query.isError
                  ? "Could not count matches"
                  : (
                    <>
                      <strong className="font-semibold text-foreground">
                        {data.objectCount.toLocaleString()} conversations
                      </strong>
                      <span className="mx-2">·</span>
                      {data.total.toLocaleString()} summaries match
                    </>
                  )
              )
              : view === "tasks"
              ? `${taskData.counts.total.toLocaleString()} tasks`
              : `${artifactData.total.toLocaleString()} outputs`}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={resetFilters}
          >
            <RotateCcw className="mr-2 h-3.5 w-3.5" />Reset
          </Button>
        </div>
        {view === "summaries" && (
          <div className="space-y-3 border-t border-border/60 bg-muted/20 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-2">
                <Label>Rerun with</Label>
                <ModelSelector
                  value={rerunTargetModel}
                  onChange={setRerunTargetModel}
                  providerValue={rerunTargetProviderId}
                  onSelectWithProvider={(_model, providerProfileId) =>
                    setRerunTargetProviderId(providerProfileId)}
                  placeholder="Choose a model"
                  prefetch
                />
              </div>
              <Button
                className="gap-2 rounded-lg"
                onClick={rerunSummaries}
                disabled={!canRerun}
              >
                <RefreshCw
                  className={`h-4 w-4 ${rerunPending ? "animate-spin" : ""}`}
                />
                {rerunPending ? "Queueing…" : "Rerun summaries"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {amount == null && !dateBounds
                ? "Set an amount or period to choose what to rerun."
                : "One new version per conversation. Originals are kept."}
            </p>
            {rerunResult && (
              <p role="status" className="rounded-lg bg-background p-3 text-sm">
                {rerunResult}
              </p>
            )}
          </div>
        )}
      </Card>

      {view === "summaries"
        ? (
          <>
            {query.isLoading && (
              <Card className="p-10 text-center text-muted-foreground">
                Loading summary history…
              </Card>
            )}
            {query.isError && (
              <Card className="border-destructive p-6 text-destructive">
                Failed to load summary history: {query.error instanceof Error
                  ? query.error.message
                  : "Unknown error"}
              </Card>
            )}
            {!query.isLoading && !query.isError && data.entries.length === 0 &&
              (
                <Card className="p-10 text-center">
                  <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
                  <h2 className="mt-3 font-semibold">
                    No saved summaries match
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Change the model or optional generation-date range.
                  </p>
                </Card>
              )}
            <div className="space-y-4">
              {data.entries.map((entry) => (
                <SummaryHistoryCard key={entry.id} entry={entry} />
              ))}
            </div>
            {data.total > data.entries.length && (
              <div className="flex items-center justify-between gap-3 py-2 text-sm text-muted-foreground">
                <span>
                  Showing {data.entries.length} of {data.total.toLocaleString()}
                  {" "}
                  matching summaries. Reruns include the full selection.
                </span>
                {displayLimit < 500 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDisplayLimit(Math.min(displayLimit + 100, 500))}
                  >
                    Show more
                  </Button>
                )}
              </div>
            )}
          </>
        )
        : view === "tasks"
        ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Card className="p-4">
                <p className="text-sm text-muted-foreground">All tasks</p>
                <p className="mt-1 text-2xl font-semibold">
                  {taskData.counts.total.toLocaleString()}
                </p>
              </Card>
              <Card className="p-4">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <p className="mt-2 text-sm text-muted-foreground">Successful</p>
                <p className="mt-1 text-2xl font-semibold">
                  {taskData.counts.completed.toLocaleString()}
                </p>
              </Card>
              <Card className="p-4">
                <CircleDashed className="h-4 w-4 text-amber-500" />
                <p className="mt-2 text-sm text-muted-foreground">Unfinished</p>
                <p className="mt-1 text-2xl font-semibold">
                  {taskData.counts.unfinished.toLocaleString()}
                </p>
              </Card>
              <Card className="p-4">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <p className="mt-2 text-sm text-muted-foreground">Failed</p>
                <p className="mt-1 text-2xl font-semibold">
                  {taskData.counts.failed.toLocaleString()}
                </p>
              </Card>
              <Card className="p-4">
                <Ban className="h-4 w-4 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Cancelled</p>
                <p className="mt-1 text-2xl font-semibold">
                  {taskData.counts.cancelled.toLocaleString()}
                </p>
              </Card>
            </div>

            {taskQuery.isLoading && (
              <Card className="p-10 text-center text-muted-foreground">
                Loading summarization tasks…
              </Card>
            )}
            {taskQuery.isError && (
              <Card className="border-destructive p-6 text-destructive">
                Failed to load task activity: {taskQuery.error instanceof Error
                  ? taskQuery.error.message
                  : "Unknown error"}
              </Card>
            )}
            {!taskQuery.isLoading && !taskQuery.isError &&
              taskData.entries.length === 0 && (
              <Card className="p-10 text-center">
                <ListChecks className="mx-auto h-10 w-10 text-muted-foreground" />
                <h2 className="mt-3 font-semibold">
                  No tasks match these filters
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Change the task state, model, or optional creation-date range.
                </p>
              </Card>
            )}
            <div className="space-y-4">
              {taskData.entries.map((task) => (
                <SummaryTaskCard key={task.id} task={task} />
              ))}
            </div>
          </>
        )
        : (
          <>
            {modelArtifactQuery.isLoading && (
              <Card className="p-10 text-center text-muted-foreground">
                Loading model-produced data…
              </Card>
            )}
            {modelArtifactQuery.isError && (
              <Card className="border-destructive p-6 text-destructive">
                Failed to load model outputs:{" "}
                {modelArtifactQuery.error instanceof Error
                  ? modelArtifactQuery.error.message
                  : "Unknown error"}
              </Card>
            )}
            {!modelArtifactQuery.isLoading && !modelArtifactQuery.isError &&
              artifactData.entries.length === 0 && (
              <Card className="p-10 text-center">
                <Cpu className="mx-auto h-10 w-10 text-muted-foreground" />
                <h2 className="mt-3 font-semibold">
                  No model outputs match these filters
                </h2>
              </Card>
            )}
            <div className="space-y-4">
              {artifactData.entries.map((entry) => (
                <ModelArtifactCard key={entry.id} entry={entry} />
              ))}
            </div>
          </>
        )}
    </div>
  );
}
