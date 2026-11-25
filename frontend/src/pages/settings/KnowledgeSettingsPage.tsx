import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Cpu,
  Database,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  RefreshCw,
  Search,
  Server,
  TimerReset,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { useActionDialog } from "@/components/ActionDialogProvider";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  normalizeSourceCounts,
  ragApi,
  ragCanonicalRoute,
  type RagChunk,
  ragChunks,
  type RagChunksResponse,
  type RagEncoderContract,
  ragErrorMessage,
  type RagSourceCount,
  type RagStatus,
} from "@/lib/rag";

const CHUNK_KINDS = [
  { value: "all", label: "All kinds" },
  { value: "transcription", label: "Transcription" },
  { value: "message", label: "Message" },
  { value: "object", label: "Object" },
  { value: "media_visual_description", label: "Media description" },
];

const ACTIVE_STATES = new Set(["building", "catching_up", "reconciling"]);

type Operation = "rebuild" | "reconcile" | "pause" | "resume";

function formatNumber(value?: number): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat().format(value);
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function stateBadgeVariant(state: string): BadgeProps["variant"] {
  if (["ready", "active", "healthy"].includes(state)) return "default";
  if (["error", "failed", "unavailable"].includes(state)) {
    return "destructive";
  }
  return "secondary";
}

function statusState(status: RagStatus | null): string {
  return status?.state ?? status?.lifecycle ?? status?.projection?.state ??
    "unknown";
}

function statusActiveProjectionId(
  status: RagStatus | null,
): string | null | undefined {
  if (!status) return undefined;
  if (status.activeProjectionId !== undefined) {
    return status.activeProjectionId;
  }
  return status.projection?.id ?? null;
}

function qdrantState(status: RagStatus | null): string {
  if (status?.qdrant?.status) return status.qdrant.status;
  if (status?.qdrant?.reachable === true) return "reachable";
  if (status?.qdrant?.reachable === false) return "unavailable";
  if (status?.qdrant?.healthy === true) return "healthy";
  if (status?.qdrant?.healthy === false) return "unavailable";
  return status?.service?.qdrant ?? status?.service?.status ?? "unknown";
}

function progressPercent(status: RagStatus | null): number | null {
  const progress = status?.progress;
  if (!progress) return null;
  if (progress.percent != null && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(100, progress.percent));
  }
  if (progress.totalSources && progress.processedSources != null) {
    return Math.max(
      0,
      Math.min(100, progress.processedSources / progress.totalSources * 100),
    );
  }
  if (progress.total && progress.processed != null) {
    return Math.max(
      0,
      Math.min(100, progress.processed / progress.total * 100),
    );
  }
  return null;
}

function statusSources(status: RagStatus | null): RagSourceCount[] {
  return status?.sources ?? normalizeSourceCounts(status?.sourceCounts);
}

function chunkSource(chunk: RagChunk) {
  return {
    pointId: chunk.pointId ?? chunk.id ?? "—",
    kind: chunk.source?.kind ?? chunk.kind ?? "—",
    collection: chunk.source?.collection,
    sourceId: chunk.source?.id ?? chunk.sourceId ?? "—",
    title: chunk.source?.title,
    uri: chunk.source?.uri ?? chunk.canonicalUri,
    occurredAt: chunk.source?.start ?? chunk.occurredAt,
    end: chunk.source?.end,
    index: chunk.chunk?.index ?? chunk.chunkIndex ?? "—",
    hash: chunk.chunk?.contentHash ?? chunk.contentHash,
  };
}

function SourceLink({
  uri,
  start,
  end,
}: {
  uri: string;
  start?: string;
  end?: string;
}) {
  const canonicalRoute = ragCanonicalRoute(uri, { start, end });
  if (canonicalRoute) {
    return (
      <Link
        to={canonicalRoute}
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        Source <ExternalLink className="h-3 w-3" />
      </Link>
    );
  }
  if (/^https?:\/\//i.test(uri)) {
    return (
      <a
        href={uri}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        Source <ExternalLink className="h-3 w-3" />
      </a>
    );
  }
  return <span className="font-mono text-xs">{uri}</span>;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Database;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 truncate text-lg font-semibold" title={value}>
            {value}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function shortFingerprint(value?: string | null): string {
  return value ? value.slice(0, 12) : "—";
}

function loadedLabel(value?: boolean | null): string {
  if (value === true) return "loaded";
  if (value === false) return "not loaded";
  return "not reported";
}

function EncoderContractDetails({
  contract,
  fallbackModel,
  fallbackDimensions,
}: {
  contract?: RagEncoderContract;
  fallbackModel?: string;
  fallbackDimensions?: number;
}) {
  const model = contract?.model ?? fallbackModel;
  const dimensions = contract?.dimensions ?? fallbackDimensions;

  return (
    <>
      <p
        className="mt-1 truncate font-mono text-xs text-muted-foreground"
        title={model}
      >
        {model ?? "Model not reported"}
      </p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        revision {contract?.modelRevision ?? "—"} · normalization{` `}
        {contract?.normalization ?? "—"} · dimensions {dimensions ?? "—"}
      </p>
      <p
        className="mt-1 truncate text-xs text-muted-foreground"
        title={contract?.artifactRepo}
      >
        artifact {contract?.artifactRepo ?? "—"}
      </p>
      <p
        className="mt-1 truncate text-xs text-muted-foreground"
        title={contract?.tokenizer.id}
      >
        tokenizer {contract?.tokenizer.id ?? "—"}@
        {contract?.tokenizer.revision ?? "—"}
      </p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        instructions doc:{contract?.instructions.document.id ?? "—"}@
        {shortFingerprint(contract?.instructions.document.fingerprint)} · query:
        {contract?.instructions.query.id ?? "—"}@
        {shortFingerprint(contract?.instructions.query.fingerprint)}
      </p>
    </>
  );
}

function InferenceStatusCard({
  status,
  loading,
}: {
  status: RagStatus | null;
  loading: boolean;
}) {
  const inference = status?.inference;
  const projection = status?.projection;
  const contract = inference?.contract;
  const pending = loading && !status;
  const executor = inference?.executor;
  const executorKind = executor?.kind ?? "unknown";
  const executorLabel = executor?.label ?? "Not reported";
  const reranker = inference?.reranker;
  const rerankerEnabled = reranker?.enabled;
  const compatible = inference?.activeProjectionCompatible;
  const compatibilityLabel = !inference
    ? "Compatibility not reported"
    : compatible === true
    ? "Projection compatible"
    : compatible === false
    ? "Projection mismatch"
    : "Compatibility not checked";

  return (
    <Card data-testid="rag-inference-status">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              Inference pipeline
            </CardTitle>
            <CardDescription className="mt-1">
              {inference
                ? (
                  <>
                    Profile{" "}
                    <span className="font-mono">{inference.profileId}</span>
                    {` · contract v${inference.contractVersion} · fingerprint `}
                    <span
                      className="font-mono"
                      title={inference.embeddingSpaceFingerprint}
                    >
                      {shortFingerprint(inference.embeddingSpaceFingerprint)}
                    </span>
                  </>
                )
                : "Current embedding path; detailed contract is not reported by this runtime."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              {inference?.profileId === "fastembed-minilm-bm25-v1"
                ? "Stage 1 baseline"
                : inference
                ? "Versioned profile"
                : "Inference not reported"}
            </Badge>
            <Badge
              variant={executorKind === "remote" ? "default" : "secondary"}
            >
              {executorKind === "remote"
                ? "Remote execution"
                : executorKind === "local"
                ? "Local execution"
                : "Execution unknown"}
            </Badge>
            <Badge variant={rerankerEnabled ? "default" : "secondary"}>
              {rerankerEnabled === true
                ? "Reranker enabled"
                : rerankerEnabled === false
                ? "Reranker disabled"
                : "Reranker not reported"}
            </Badge>
            <Badge variant={compatible === false ? "destructive" : "secondary"}>
              {compatibilityLabel}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0 rounded-md border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">
              Dense embeddings
            </dt>
            <dd className="mt-1 font-medium">
              {pending
                ? "Loading…"
                : `${
                  contract?.dense.provider ?? "Provider not reported"
                } · ${executorKind}`}
            </dd>
            <EncoderContractDetails
              contract={contract?.dense}
              fallbackModel={projection?.denseModel ??
                projection?.embeddingModel}
              fallbackDimensions={projection?.denseDimensions ??
                projection?.vectorSize}
            />
          </div>
          <div className="min-w-0 rounded-md border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">
              Sparse retrieval
            </dt>
            <dd className="mt-1 font-medium">
              {pending
                ? "Loading…"
                : `${
                  contract?.sparse.provider ?? "Provider not reported"
                } · ${executorKind}`}
            </dd>
            <EncoderContractDetails
              contract={contract?.sparse}
              fallbackModel={projection?.sparseModel}
            />
          </div>
          <div className="min-w-0 rounded-md border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">Reranker</dt>
            <dd className="mt-1 font-medium">
              {rerankerEnabled === true
                ? "Enabled"
                : rerankerEnabled === false
                ? "Disabled"
                : "Not reported"}
            </dd>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {rerankerEnabled === true
                ? [reranker?.provider, reranker?.model, reranker?.modelRevision]
                  .filter(Boolean).join(" · ") || "Details not reported"
                : rerankerEnabled === false
                ? "No reranker is invoked for this profile"
                : "Runtime did not report reranker status"}
            </p>
          </div>
          <div className="min-w-0 rounded-md border bg-muted/20 p-3">
            <dt className="text-xs text-muted-foreground">Executor</dt>
            <dd className="mt-1 font-medium">
              {pending ? "Loading…" : executorLabel}
            </dd>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {executorKind} · {executor?.transport ?? "not reported"}{" "}
              · dense{` `}
              {loadedLabel(executor?.denseLoaded)} · sparse{` `}
              {loadedLabel(executor?.sparseLoaded)}
            </p>
            {!executor
              ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Remote executor: not reported
                </p>
              )
              : executor.remoteExecutor
              ? (
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  Remote executor: {executor.remoteExecutor.label}
                </p>
              )
              : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Remote executor: not configured
                </p>
              )}
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

export default function KnowledgeSettingsPage() {
  const { confirmAction } = useActionDialog();
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [chunksResponse, setChunksResponse] = useState<
    RagChunksResponse | null
  >(null);
  const [chunksLoading, setChunksLoading] = useState(true);
  const [chunksError, setChunksError] = useState<string | null>(null);
  const [draftKind, setDraftKind] = useState("all");
  const [draftSourceId, setDraftSourceId] = useState("");
  const [chunkKind, setChunkKind] = useState("all");
  const [chunkSourceId, setChunkSourceId] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [offset, setOffset] = useState(0);
  const statusControllerRef = useRef<AbortController | null>(null);
  const chunksControllerRef = useRef<AbortController | null>(null);
  const previousActiveProjectionIdRef = useRef<
    string | null | undefined
  >(undefined);
  const activeProjectionId = statusActiveProjectionId(status);

  const loadStatus = useCallback(async (showSpinner = true) => {
    statusControllerRef.current?.abort();
    const controller = new AbortController();
    statusControllerRef.current = controller;
    if (showSpinner) setStatusLoading(true);
    try {
      const next = await ragApi.status(controller.signal);
      setStatus(next);
      setStatusError(null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setStatusError(ragErrorMessage(caught));
    } finally {
      if (statusControllerRef.current === controller) {
        statusControllerRef.current = null;
        setStatusLoading(false);
      }
    }
  }, []);

  const loadChunks = useCallback(async (expectedProjectionId: string) => {
    chunksControllerRef.current?.abort();
    const controller = new AbortController();
    chunksControllerRef.current = controller;
    setChunksLoading(true);
    try {
      const next = await ragApi.listChunks({
        kind: chunkKind === "all" ? undefined : chunkKind,
        sourceId: chunkSourceId || undefined,
        limit: pageSize,
        offset,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setChunksResponse(next);
      if (next.projectionId !== expectedProjectionId) {
        setChunksError(
          `Chunk response belongs to projection ${next.projectionId}, but status reports ${expectedProjectionId}. Refreshing active projection status.`,
        );
        void loadStatus(false);
      } else {
        setChunksError(null);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      setChunksError(ragErrorMessage(caught));
      setChunksResponse(null);
    } finally {
      if (chunksControllerRef.current === controller) {
        chunksControllerRef.current = null;
        setChunksLoading(false);
      }
    }
  }, [chunkKind, chunkSourceId, loadStatus, offset, pageSize]);

  useEffect(() => {
    void loadStatus();
    return () => statusControllerRef.current?.abort();
  }, [loadStatus]);

  useEffect(() => {
    const projectionChanged = previousActiveProjectionIdRef.current !==
      activeProjectionId;
    previousActiveProjectionIdRef.current = activeProjectionId;

    if (projectionChanged) {
      chunksControllerRef.current?.abort();
      setChunksResponse(null);
      setChunksError(null);
      if (offset !== 0) {
        setOffset(0);
        return;
      }
    }

    if (!activeProjectionId) {
      setChunksLoading(false);
      return;
    }

    void loadChunks(activeProjectionId);
    return () => chunksControllerRef.current?.abort();
  }, [activeProjectionId, loadChunks, offset]);

  const state = statusState(status);

  useEffect(() => {
    if (!ACTIVE_STATES.has(state)) return;
    const timer = globalThis.setInterval(() => void loadStatus(false), 5_000);
    return () => globalThis.clearInterval(timer);
  }, [loadStatus, state]);

  const runOperation = async (nextOperation: Operation) => {
    if (nextOperation === "rebuild") {
      const confirmed = await confirmAction({
        title: "Rebuild the Qdrant projection?",
        description:
          "This creates a new blue/green projection from canonical Mycelia data. The active projection stays searchable until the replacement is ready, but the rebuild can use significant CPU, disk, and embedding time.",
        actionLabel: "Start rebuild",
        destructive: true,
      });
      if (!confirmed) return;
    }

    setOperation(nextOperation);
    try {
      if (nextOperation === "rebuild") await ragApi.rebuild();
      if (nextOperation === "reconcile") await ragApi.reconcile();
      if (nextOperation === "pause") await ragApi.pause();
      if (nextOperation === "resume") await ragApi.resume();
      toast.success(
        nextOperation === "rebuild"
          ? "Knowledge projection rebuild started"
          : nextOperation === "reconcile"
          ? "Reconciliation started"
          : nextOperation === "pause"
          ? "Indexer paused"
          : "Indexer resumed",
      );
      await loadStatus(false);
    } catch (caught) {
      toast.error(`${nextOperation} failed`, {
        description: ragErrorMessage(caught),
      });
    } finally {
      setOperation(null);
    }
  };

  const applyChunkFilters = () => {
    const nextSourceId = draftSourceId.trim();
    if (
      draftKind === chunkKind && nextSourceId === chunkSourceId && offset === 0
    ) {
      if (activeProjectionId) void loadChunks(activeProjectionId);
      return;
    }
    setOffset(0);
    setChunkKind(draftKind);
    setChunkSourceId(nextSourceId);
  };

  const chunksProjectionMatches = !chunksResponse || !activeProjectionId ||
    chunksResponse.projectionId === activeProjectionId;
  const verifiedChunksResponse = chunksProjectionMatches
    ? chunksResponse
    : null;
  const chunks = useMemo(
    () => verifiedChunksResponse ? ragChunks(verifiedChunksResponse) : [],
    [verifiedChunksResponse],
  );
  const total = verifiedChunksResponse?.total;
  const hasPrevious = offset > 0;
  const hasNext = chunksResponse?.hasMore ??
    (total != null
      ? offset + chunks.length < total
      : chunks.length === pageSize);
  const firstRow = chunks.length > 0 ? offset + 1 : 0;
  const lastRow = offset + chunks.length;
  const projection = status?.activeProjectionId === null
    ? null
    : status?.projection;
  const candidate = status?.candidateProjection ??
    (status?.activeProjectionId === null ? status?.projection : null);
  const activeProjectionState = projection?.state ?? "ready";
  const percent = progressPercent(status);
  const sources = statusSources(status);
  const qdrant = qdrantState(status);
  const chunkCount = status?.qdrant?.pointsCount ??
    status?.progress?.indexedChunks ??
    status?.counts?.chunks ?? status?.counts?.points ?? status?.qdrant?.points;
  const sourceDocumentCount = sources.reduce(
    (sum, source) => sum + (source.documents ?? source.sources ?? 0),
    0,
  );
  const sourceLagValues = sources.flatMap((source) => {
    const value = source.changeStream?.lagSeconds ?? source.lagSeconds;
    return value == null ? [] : [value];
  });
  const lagSeconds = status?.lag?.seconds ??
    (sourceLagValues.length > 0 ? Math.max(...sourceLagValues) : null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Knowledge index
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect and operate the independent Qdrant projection. MongoDB
            remains canonical; this index can be reconciled or rebuilt.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/search">
              <Search className="mr-2 h-4 w-4" />
              Open search
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => void loadStatus()}
            disabled={statusLoading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${statusLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {statusError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="font-medium">Could not read RAG status</p>
            <p className="mt-1 text-muted-foreground">{statusError}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void loadStatus()}>
            Retry
          </Button>
        </div>
      )}

      {(status?.degraded || state === "degraded" || state === "error" ||
        status?.qdrant?.reachable === false) && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium text-amber-700 dark:text-amber-400">
              Knowledge retrieval is degraded
            </p>
            <p className="mt-1 text-muted-foreground">
              Check Qdrant connectivity, projection errors, and change-stream
              lag below. Lexical mode may still be available independently.
            </p>
          </div>
        </div>
      )}

      {status?.warnings && status.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            Runtime warnings
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {status.warnings.map((warning, index) => (
              <li key={`${warning}:${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <InferenceStatusCard status={status} loading={statusLoading} />

      <div
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-busy={statusLoading}
      >
        <MetricCard
          label="Lifecycle"
          value={statusLoading && !status ? "Loading…" : state}
          detail={status?.paused || state === "paused"
            ? "Indexer is paused"
            : "Projection lifecycle"}
          icon={ACTIVE_STATES.has(state) ? CircleDashed : CheckCircle2}
        />
        <MetricCard
          label="Qdrant"
          value={qdrant}
          detail={status?.qdrant?.collection
            ? `collection ${status.qdrant.collection}`
            : status?.qdrant?.version
            ? `version ${status.qdrant.version}`
            : "Vector database health"}
          icon={Server}
        />
        <MetricCard
          label="Indexed chunks"
          value={formatNumber(chunkCount)}
          detail={`${formatNumber(sourceDocumentCount)} canonical documents`}
          icon={Database}
        />
        <MetricCard
          label="Update lag"
          value={formatDuration(lagSeconds)}
          detail={status?.authMode
            ? `Mongo mode: ${status.authMode}`
            : "Incremental update freshness"}
          icon={TimerReset}
        />
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                Active projection
                {projection && (
                  <Badge variant={stateBadgeVariant(activeProjectionState)}>
                    {activeProjectionState}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-2">
                Blue/green rebuilds keep the current collection active until the
                new projection is ready for atomic activation.
              </CardDescription>
            </div>
            {status?.updatedAt && (
              <span className="text-xs text-muted-foreground">
                Updated {formatDate(status.updatedAt)}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {projection
            ? (
              <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
                {[
                  ["Projection ID", projection.id],
                  ["Fingerprint", projection.fingerprint],
                  ["Generation", projection.generation],
                  [
                    "Collection",
                    projection.collectionName ?? projection.collection,
                  ],
                  [
                    "Dense model",
                    projection.denseModel ?? projection.embeddingModel,
                  ],
                  [
                    "Dense dimensions",
                    projection.denseDimensions ?? projection.vectorSize,
                  ],
                  ["Sparse model", projection.sparseModel],
                  [
                    "Model fingerprint",
                    projection.modelFingerprint ??
                      projection.embeddingFingerprint,
                  ],
                  [
                    "Chunker",
                    projection.chunkerFingerprint ?? projection.chunkerVersion,
                  ],
                  ["Source schema", projection.sourceSchemaFingerprint],
                  ["Created", formatDate(projection.createdAt)],
                  ["Activated", formatDate(projection.activatedAt)],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="min-w-0 rounded-md border bg-muted/20 p-3"
                  >
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">
                      {value == null || value === "" ? "—" : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )
            : (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No active projection exists yet. Start a rebuild to materialize
                one.
              </div>
            )}

          {candidate && candidate.id !== projection?.id && (
            <div
              className="space-y-3 rounded-md border border-dashed border-primary/40 bg-primary/5 p-4"
              data-testid="rag-candidate-projection"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">Candidate projection</p>
                <Badge
                  variant={stateBadgeVariant(candidate.state || state)}
                >
                  {candidate.state || state}
                </Badge>
              </div>
              <dl className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                {[
                  ["Projection ID", candidate.id],
                  [
                    "Collection",
                    candidate.collectionName ?? candidate.collection,
                  ],
                  ["Fingerprint", candidate.fingerprint],
                  ["Build started", formatDate(candidate.buildStartedAt)],
                ].map(([label, value]) => (
                  <div key={String(label)} className="min-w-0">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-all font-mono">
                      {value == null || value === "" ? "—" : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              {candidate.error && (
                <p className="text-sm text-destructive">{candidate.error}</p>
              )}
            </div>
          )}

          {status?.progress && (
            <div className="space-y-2 rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">
                  {status.progress.phase || "Projection progress"}
                </span>
                <span className="text-muted-foreground">
                  {formatNumber(
                    status.progress.processedSources ??
                      status.progress.processed,
                  )} / {formatNumber(
                    status.progress.totalSources ?? status.progress.total,
                  )} sources
                  {percent != null ? ` · ${Math.round(percent)}%` : ""}
                </span>
              </div>
              {percent != null && <Progress value={percent} />}
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {status.progress.currentSource ||
                    `${formatNumber(status.progress.indexedChunks)} indexed · ${
                      formatNumber(status.progress.failedSources)
                    } failed`}
                </span>
                <span>{formatDate(status.progress.updatedAt)}</span>
              </div>
            </div>
          )}

          {status?.operation && (
            <div className="rounded-md border p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {status.operation.type || "Index operation"}
                  </span>
                  <Badge
                    variant={stateBadgeVariant(
                      status.operation.state || "unknown",
                    )}
                  >
                    {status.operation.state || "unknown"}
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  Started {formatDate(status.operation.startedAt)}
                </span>
              </div>
              {status.operation.reason && (
                <p className="mt-2 text-muted-foreground">
                  {status.operation.reason}
                </p>
              )}
              {status.operation.error && (
                <p className="mt-2 text-destructive">
                  {status.operation.error}
                </p>
              )}
            </div>
          )}

          {status?.qdrant?.capabilities && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                Qdrant capabilities:
              </span>
              {[
                ["dense", status.qdrant.capabilities.dense],
                ["sparse", status.qdrant.capabilities.sparse],
                ["hybrid RRF", status.qdrant.capabilities.hybridRrf],
                ["payload filters", status.qdrant.capabilities.filters],
              ].map(([label, supported]) => (
                <Badge
                  key={String(label)}
                  variant={supported ? "outline" : "secondary"}
                >
                  {label}
                  {supported ? "" : " unavailable"}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Projection controls</CardTitle>
          <CardDescription>
            Pause incremental updates, reconcile canonical sources, or build a
            fresh versioned projection. These actions never mutate canonical
            Mongo records.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {status?.paused || state === "paused"
            ? (
              <Button
                onClick={() => void runOperation("resume")}
                disabled={operation != null}
              >
                {operation === "resume"
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Play className="mr-2 h-4 w-4" />}
                Resume updates
              </Button>
            )
            : (
              <Button
                variant="outline"
                onClick={() => void runOperation("pause")}
                disabled={operation != null}
              >
                {operation === "pause"
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Pause className="mr-2 h-4 w-4" />}
                Pause updates
              </Button>
            )}
          <Button
            variant="outline"
            onClick={() => void runOperation("reconcile")}
            disabled={operation != null || ACTIVE_STATES.has(state)}
          >
            {operation === "reconcile"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <RefreshCcw className="mr-2 h-4 w-4" />}
            Reconcile
          </Button>
          <Button
            variant="destructive"
            onClick={() => void runOperation("rebuild")}
            disabled={operation != null || ACTIVE_STATES.has(state)}
          >
            {operation === "rebuild"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Wrench className="mr-2 h-4 w-4" />}
            Rebuild projection
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source coverage and freshness</CardTitle>
          <CardDescription>
            Per-source materialization counts, durable change-stream position,
            and reconciliation state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sources.length === 0
            ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                Source coverage has not been reported yet.
              </div>
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Documents</TableHead>
                    <TableHead className="text-right">Indexed</TableHead>
                    <TableHead className="text-right">Chunks</TableHead>
                    <TableHead>Change stream</TableHead>
                    <TableHead>Lag</TableHead>
                    <TableHead>Last reconcile</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sources.map((source) => {
                    const sourceState = source.changeStream?.state ??
                      (source.error ? "error" : "unknown");
                    return (
                      <TableRow key={source.kind}>
                        <TableCell className="font-medium">
                          <p>{source.kind}</p>
                          {source.collection && (
                            <p className="mt-1 text-xs font-normal text-muted-foreground">
                              {source.collection}
                            </p>
                          )}
                          {source.lastCheckpoint && (
                            <p
                              className="mt-1 max-w-40 truncate font-mono text-xs font-normal text-muted-foreground"
                              title={source.lastCheckpoint}
                            >
                              {source.lastCheckpoint}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(source.documents ?? source.sources)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(
                            source.indexedDocuments ?? source.indexed,
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(source.chunks)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={stateBadgeVariant(sourceState)}>
                            {sourceState}
                          </Badge>
                          {source.changeStream?.resumeTokenPresent === false &&
                            (
                              <span className="ml-2 text-xs text-amber-600">
                                no checkpoint
                              </span>
                            )}
                        </TableCell>
                        <TableCell>
                          {formatDuration(
                            source.changeStream?.lagSeconds ??
                              source.lagSeconds,
                          )}
                        </TableCell>
                        <TableCell>
                          {formatDate(source.lastReconciledAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {(status?.errors?.length || status?.qdrant?.error ||
        sources.some((source) => source.error || source.changeStream?.error)) &&
        (
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Projection errors
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {status?.errors?.map((item, index) => (
                <div
                  key={`${item.code || "error"}:${index}`}
                  className="rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">
                      {item.code || item.kind || "Index error"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(item.at)}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{item.message}</p>
                </div>
              ))}
              {status?.qdrant?.error && (
                <div className="rounded-md border p-3 text-sm">
                  <span className="font-medium">Qdrant</span>
                  <p className="mt-1 text-muted-foreground">
                    {status.qdrant.error}
                  </p>
                </div>
              )}
              {sources.filter((source) =>
                source.error || source.changeStream?.error
              )
                .map((source) => (
                  <div
                    key={`source:${source.kind}`}
                    className="rounded-md border p-3 text-sm"
                  >
                    <span className="font-medium">{source.kind}</span>
                    <p className="mt-1 text-muted-foreground">
                      {source.error || source.changeStream?.error}
                    </p>
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

      <Card>
        <CardHeader>
          <CardTitle>Inspect indexed chunks</CardTitle>
          <CardDescription>
            Read projection payloads and follow their canonical source links.
            This view does not edit Qdrant points directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 @3xl/settings:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <div className="space-y-2">
              <Label htmlFor="chunk-kind">Kind</Label>
              <Select value={draftKind} onValueChange={setDraftKind}>
                <SelectTrigger id="chunk-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHUNK_KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>
                      {kind.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="chunk-source-id">Canonical source ID</Label>
              <Input
                id="chunk-source-id"
                value={draftSourceId}
                onChange={(event) => setDraftSourceId(event.target.value)}
                placeholder="Optional exact source ID"
              />
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={applyChunkFilters}>
                Apply filters
              </Button>
            </div>
          </div>

          {chunksResponse && (
            <div
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              data-testid="rag-chunks-projection"
            >
              <Badge
                variant={chunksProjectionMatches ? "outline" : "destructive"}
                className="font-mono font-normal"
              >
                chunks projection {chunksResponse.projectionId}
              </Badge>
              {activeProjectionId && (
                <span className="font-mono">
                  active {activeProjectionId}
                </span>
              )}
            </div>
          )}

          {chunksError && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-medium">Could not inspect chunks</p>
              <p className="mt-1 text-muted-foreground">{chunksError}</p>
            </div>
          )}

          <div className="rounded-md border" aria-busy={chunksLoading}>
            {chunksLoading
              ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                  Loading indexed chunks…
                </div>
              )
              : !activeProjectionId
              ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No active projection exists yet. Build one before inspecting
                  chunks.
                </div>
              )
              : chunks.length === 0
              ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No chunks match these filters.
                </div>
              )
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">Point / chunk</TableHead>
                      <TableHead className="w-36">Kind</TableHead>
                      <TableHead>Text</TableHead>
                      <TableHead className="w-56">Canonical source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {chunks.map((chunk, index) => {
                      const source = chunkSource(chunk);
                      return (
                        <TableRow key={`${source.pointId}:${index}`}>
                          <TableCell className="align-top">
                            <p
                              className="max-w-36 truncate font-mono text-xs"
                              title={source.pointId}
                            >
                              {source.pointId}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              chunk {String(source.index)}
                            </p>
                            {source.hash && (
                              <p
                                className="mt-1 max-w-36 truncate font-mono text-xs text-muted-foreground"
                                title={source.hash}
                              >
                                {source.hash}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline">{source.kind}</Badge>
                            {source.collection && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.collection}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-5">
                              {chunk.text}
                            </p>
                            {source.occurredAt && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {formatDate(source.occurredAt)}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            {source.title && (
                              <p className="mb-1 font-medium">{source.title}</p>
                            )}
                            <p
                              className="mb-2 max-w-52 truncate font-mono"
                              title={source.sourceId}
                            >
                              {source.sourceId}
                            </p>
                            {source.uri && (
                              <SourceLink
                                uri={source.uri}
                                start={source.occurredAt}
                                end={source.end}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                {firstRow}–{lastRow}
                {total != null ? ` of ${formatNumber(total)}` : ""}
              </span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  setOffset(0);
                }}
              >
                <SelectTrigger
                  className="h-8 w-24"
                  aria-label="Chunks per page"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[25, 50, 100, 200].map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!hasPrevious || chunksLoading}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasNext || chunksLoading ||
                  offset + pageSize > 10_000}
                onClick={() => setOffset(offset + pageSize)}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">
          Separate future integrations:
        </strong>{" "}
        Mem0 and other memory layers are intentionally not managed here. This
        page is limited to the rebuildable Qdrant search projection. A dedicated
        read-only MongoDB user and authorization migration are also planned as a
        separate, tested rollout; current runtime mode:{" "}
        {status?.authMode || "unknown"}.
      </div>
    </div>
  );
}
