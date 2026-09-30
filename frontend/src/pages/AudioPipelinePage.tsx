import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import {
  getMaximumAudioHours,
  MAX_AUDIO_CHUNK_SECONDS,
  normalizeAudioSourceFileStats,
} from "@/lib/audioPipelineStats";
import {
  getDiarizationCampaignProgressView,
  isOpenDiarizationCampaignStatus,
} from "@/lib/diarizationProgress";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EJSON } from "bson";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Gauge,
  Layers,
  MessageSquare,
  Mic,
  PauseCircle,
  RefreshCw,
  Timer,
  Trash2,
} from "lucide-react";
import { ServiceHealthBanner } from "@/components/ServiceHealthBanner";
import { AudioOperationsCard } from "@/components/AudioOperationsCard";
import { VoiceIdentityStatusCard } from "@/components/VoiceIdentityStatusCard";
import { useActionDialog } from "@/components/ActionDialogProvider";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface AudioSession {
  _id: string;
  start?: Date;
  lastActivityAt?: Date;
  path?: string;
  sourceKind: string;
  ingested: boolean;
  ingestionError?: string;
  client_id?: string;
  device?: string;
  metadata?: {
    format?: string;
    rate?: number;
    width?: number;
    channels?: number;
    source?: string;
    codec?: string;
  };
  processing_status?: string;
  chunks: {
    total: number;
    vadProcessed: number;
    withSpeech: number;
  };
  sequences: Array<{
    _id: string;
    state: string;
    chunk_count: number;
    fromIndex: number;
    toIndex: number;
    updatedAt?: Date;
    error?: string;
  }>;
  transcriptions: number;
  conversationChunks: Array<{
    _id: string;
    state: string;
    mode?: string;
    transcriptionCount: number;
    totalTextLength: number;
    start?: Date;
    end?: Date;
    updatedAt?: Date;
    error?: string;
    emptyReason?: string;
    segmentsFound?: number;
    conversationsCreated?: number;
  }>;
  transcriptionDetails: Array<{
    _id: string;
    start: Date;
    end: Date;
    text: string;
  }>;
  conversations: Array<{
    _id: string;
    name: string;
    icon?: { text?: string };
    timeRanges?: Array<{ start: string; end: string }>;
    createdAt?: Date;
  }>;
}

interface PipelineStats {
  warnings?: string[];
  totalSessions: number;
  totalChunks: number;
  chunksVadProcessed: number;
  chunksAwaitingVad: number;
  vadProcessedLast15Minutes: number;
  vadRatePerMinute: number;
  vadEtaSeconds?: number;
  vadLastProcessedAt?: Date;
  vadJobs: {
    active: number;
    waiting: number;
    delayed: number;
    completed: number;
    failed: number;
    cancelled: number;
    latestFailure?: string;
    latestFailureAt?: Date;
    recentFailures: Array<{
      id: string;
      failedAt?: Date;
      reason?: string;
    }>;
  };
  sequencesReady: number;
  sequencesProcessing: number;
  sequencesError: number;
  transcriptionPendingChunks: number;
  transcriptionPendingMaximumHours: number;
  convChunksReady: number;
  convChunksProcessing: number;
  convChunksError: number;
  totalConversations: number;
  sourceFiles: {
    total: number;
    ingested: number;
    pending: number;
    blocked: number;
    errors: number;
    byKind: Array<{ kind: string; count: number }>;
  };
  diarizationCampaign: DiarizationCampaignStats | null;
  stages: PipelineStage[];
  recentJobs: PipelineJob[];
}

interface DiarizationCampaignStats {
  campaignId: string;
  status: string;
  updatedAt?: Date;
  processedChunks: number;
  totalChunks: number | null;
  pendingChunks: number | null;
  processedSequences: number;
  segmentsCreated: number;
  errorCount: number;
  chunksPerSecond: number | null;
  rateStatus: "live" | "aggregate" | "warming" | "legacy";
  rateSampleCount: number;
  sampledLanes: number;
  activeRateJobCount: number;
  activeRateReportingJobCount: number;
  activeRateLaneCount: number;
  usefulAudioRealtimeMultiple: number | null;
  rateWindowSeconds: number | null;
  successfulSequences: number;
  skippedSequences: number;
  recordingLeaseBusyOriginals?: number;
  recordingLeaseSkippedSequences?: number;
  chunkClaimSkips?: number;
  skipRatio?: number | null;
  leaseSkipRatio?: number | null;
  claimSkipRatio: number | null;
  stageTimingsMs?: Record<
    string,
    { count: number; total: number; avg: number; max: number }
  >;
  etaSeconds: number | null;
  batchNumber: number | null;
  estimatedBatches: number | null;
  totalEstimated: boolean;
}

interface DiarizationLiveStatus {
  checkedAt: Date;
  warnings: string[];
  campaign: DiarizationCampaignStats | null;
  jobs: {
    available: boolean;
    active: number | null;
    waiting: number | null;
    delayed: number | null;
    stalePersistedJobs: number;
    activeLanes: string[];
  };
  capacity: {
    available: boolean;
    status: string;
    enabledRoutes: number | null;
    enabledSlots: number | null;
    healthyRoutes: number | null;
    healthySlots: number | null;
    worker: {
      running: boolean;
      effectiveConcurrency: number;
    };
  };
}

interface RecentSourcePage {
  items: Array<{
    id: string;
    start?: Date;
    updatedAt?: Date;
    path?: string;
    sourceKind: string;
    ingested: boolean;
    ingestionError?: string;
    clientId?: string;
    device?: string;
    metadata?: AudioSession["metadata"];
    processingStatus?: string;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}

interface PipelineStage {
  type: string;
  label: string;
  backlog: number;
  backlogStatus?: "exact" | "estimated" | "exists" | "unavailable";
  backlogAsOf?: Date;
  errors: number;
  paused: boolean;
  active: number;
  waiting: number;
  delayed: number;
  failed: number;
  latestJob?: {
    id: string;
    state: string;
    updatedAt?: Date;
    failedReason?: string;
  };
}

interface PipelineJob {
  id: string;
  type: string;
  state: string;
  createdAt?: Date;
  updatedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  failedReason?: string;
}

const DEFAULT_SESSION_LIMIT = 10;
const TRANSCRIPT_STAGE_TYPES = new Set([
  "ingestion",
  "vad",
  "transcription_sequence_creator",
  "transcription",
  "conversation_chunk_creator",
  "conversation_extractor_merged",
  "summarization",
]);

function formatEta(seconds?: number): string {
  if (!seconds || seconds <= 0) return "Unavailable";
  if (seconds < 60) return "Less than a minute";
  if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return `About ${hours}h${minutes ? ` ${minutes}m` : ""}`;
}

function stageState(stage: PipelineStage): {
  label: string;
  className: string;
} {
  if (stage.paused && stage.backlog > 0) {
    return { label: "Blocked · paused", className: "text-red-600" };
  }
  if (stage.active > 0) {
    return { label: `${stage.active} running`, className: "text-blue-600" };
  }
  const queued = stage.waiting + stage.delayed;
  if (queued > 0) {
    return { label: `${queued} queued`, className: "text-amber-600" };
  }
  if (stage.errors > 0) {
    return { label: `${stage.errors} errors`, className: "text-red-600" };
  }
  if (stage.backlogStatus === "unavailable") {
    return { label: "Backlog unavailable", className: "text-muted-foreground" };
  }
  if (stage.backlog > 0) {
    return { label: "Waiting for worker", className: "text-amber-600" };
  }
  return { label: "Caught up", className: "text-green-600" };
}

function stageBacklogValue(stage: PipelineStage): string {
  if (stage.backlogStatus === "unavailable") return "—";
  if (stage.backlogStatus === "exists") return "Work remains";
  const count = stage.backlog.toLocaleString();
  return stage.backlogStatus === "estimated" ? `≈${count}` : count;
}

function stageBacklogLabel(stage: PipelineStage): string {
  if (stage.backlogStatus === "unavailable") return "backlog unavailable";
  if (stage.backlogStatus === "exists") return "exact count deferred";
  if (stage.backlogStatus === "estimated") {
    return stage.backlogAsOf
      ? `estimated · updated ${formatDistanceToNow(stage.backlogAsOf)} ago`
      : "estimated items waiting";
  }
  return "items waiting";
}

function formatWorkerType(type: string): string {
  return type.replaceAll("_", " ");
}

export function PipelineDetailSection({
  title,
  summary,
  icon,
  children,
  defaultOpen = false,
  testId,
}: {
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  testId: string;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-md border bg-background/60"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50"
          data-testid={testId}
        >
          <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
            {icon}
            <span>{title}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {summary}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-3 py-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function AudioPipelinePage() {
  const { confirmAction } = useActionDialog();
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    new Set(),
  );
  const [sourceDetails, setSourceDetails] = useState<
    Record<string, Partial<AudioSession>>
  >({});
  const [sourceDetailErrors, setSourceDetailErrors] = useState<
    Record<string, string>
  >({});
  const [loadingSourceDetails, setLoadingSourceDetails] = useState<Set<string>>(
    new Set(),
  );
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);

  const {
    data: sessionsData,
    error: pipelineError,
    isError,
    isFetching,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["audio-pipeline-stats"],
    queryFn: async ({ signal }) => {
      // Use the new aggregated pipeline endpoint
      const requestController = new AbortController();
      const cancelRequest = () => requestController.abort(signal.reason);
      signal.addEventListener("abort", cancelRequest, { once: true });
      const timeoutId = setTimeout(
        () => requestController.abort(),
        15_000,
      );

      let response: Response;
      try {
        response = await fetch(
          `${api.baseURL}/api/audio/pipeline?includeSources=false`,
          {
            headers: {
              "Authorization": `Bearer ${await api.getJWT()}`,
            },
            signal: requestController.signal,
          },
        );
      } catch (error) {
        if (requestController.signal.aborted && !signal.aborted) {
          throw new Error(
            "Pipeline statistics took longer than 15 seconds. The database is busy; diarization continues in the background.",
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", cancelRequest);
      }

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Failed to fetch pipeline data (${response.status})${
            detail ? `: ${detail}` : ""
          }`,
        );
      }

      const data = await response.json();

      // Deserialize EJSON (handles BSON date format { $date: "..." })
      const deserialized = EJSON.deserialize(data);

      // Convert any remaining date strings to Date objects
      const sessions: AudioSession[] = deserialized.sessions.map((s: any) => ({
        ...s,
        start: s.start
          ? (s.start instanceof Date ? s.start : new Date(s.start))
          : undefined,
        lastActivityAt: s.lastActivityAt
          ? (s.lastActivityAt instanceof Date
            ? s.lastActivityAt
            : new Date(s.lastActivityAt))
          : undefined,
        sequences: s.sequences.map((seq: any) => ({
          ...seq,
          updatedAt: seq.updatedAt
            ? (seq.updatedAt instanceof Date
              ? seq.updatedAt
              : new Date(seq.updatedAt))
            : undefined,
        })),
        conversationChunks: s.conversationChunks.map((c: any) => ({
          ...c,
          start: c.start
            ? (c.start instanceof Date ? c.start : new Date(c.start))
            : undefined,
          end: c.end
            ? (c.end instanceof Date ? c.end : new Date(c.end))
            : undefined,
          updatedAt: c.updatedAt
            ? (c.updatedAt instanceof Date
              ? c.updatedAt
              : new Date(c.updatedAt))
            : undefined,
        })),
        transcriptionDetails: s.transcriptionDetails.map((t: any) => ({
          ...t,
          start: t.start instanceof Date ? t.start : new Date(t.start),
          end: t.end instanceof Date ? t.end : new Date(t.end),
        })),
        conversations: s.conversations.map((c: any) => ({
          ...c,
          createdAt: c.createdAt
            ? (c.createdAt instanceof Date
              ? c.createdAt
              : new Date(c.createdAt))
            : undefined,
        })),
      }));

      const rawStats = deserialized.stats as PipelineStats;
      const stats: PipelineStats = {
        ...rawStats,
        sourceFiles: normalizeAudioSourceFileStats(
          rawStats.sourceFiles,
          rawStats.totalSessions,
        ),
        diarizationCampaign: rawStats.diarizationCampaign
          ? {
            ...rawStats.diarizationCampaign,
            updatedAt: rawStats.diarizationCampaign.updatedAt
              ? new Date(rawStats.diarizationCampaign.updatedAt)
              : undefined,
          }
          : null,
        vadLastProcessedAt: rawStats.vadLastProcessedAt
          ? new Date(rawStats.vadLastProcessedAt)
          : undefined,
        vadJobs: {
          ...rawStats.vadJobs,
          latestFailureAt: rawStats.vadJobs.latestFailureAt
            ? new Date(rawStats.vadJobs.latestFailureAt)
            : undefined,
          recentFailures: (rawStats.vadJobs.recentFailures ?? []).map(
            (failure) => ({
              ...failure,
              failedAt: failure.failedAt
                ? new Date(failure.failedAt)
                : undefined,
            }),
          ),
        },
        stages: (rawStats.stages ?? []).map((stage) => ({
          ...stage,
          backlogAsOf: stage.backlogAsOf
            ? new Date(stage.backlogAsOf)
            : undefined,
          latestJob: stage.latestJob
            ? {
              ...stage.latestJob,
              updatedAt: stage.latestJob.updatedAt
                ? new Date(stage.latestJob.updatedAt)
                : undefined,
            }
            : undefined,
        })),
        recentJobs: (rawStats.recentJobs ?? []).map((job) => ({
          ...job,
          createdAt: job.createdAt ? new Date(job.createdAt) : undefined,
          updatedAt: job.updatedAt ? new Date(job.updatedAt) : undefined,
          startedAt: job.startedAt ? new Date(job.startedAt) : undefined,
          finishedAt: job.finishedAt ? new Date(job.finishedAt) : undefined,
        })),
      };

      return {
        sessions,
        hasMore: deserialized.hasMore,
        stats,
      };
    },
    retry: false,
    enabled: false,
    // This endpoint contains exact corpus-wide counters. Keep refresh manual so
    // an open dashboard cannot become a recurring Mongo workload.
    refetchInterval: false,
  });

  const liveStatusQuery = useQuery({
    queryKey: ["audio-pipeline-live"],
    queryFn: async ({ signal }): Promise<DiarizationLiveStatus> => {
      const response = await fetch(`${api.baseURL}/api/audio/pipeline/live`, {
        headers: { "Authorization": `Bearer ${await api.getJWT()}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Live diarization status failed (${response.status})`);
      }
      const result = EJSON.deserialize(
        await response.json(),
      ) as DiarizationLiveStatus;
      return {
        ...result,
        checkedAt: new Date(result.checkedAt),
        campaign: result.campaign
          ? {
            ...result.campaign,
            updatedAt: result.campaign.updatedAt
              ? new Date(result.campaign.updatedAt)
              : undefined,
          }
          : null,
      };
    },
    refetchInterval: () =>
      document.visibilityState === "visible" ? 5_000 : false,
    staleTime: 3_000,
    retry: 1,
  });

  const recentSourcesQuery = useInfiniteQuery({
    queryKey: ["audio-pipeline-recent-sources"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<RecentSourcePage> => {
      const params = new URLSearchParams({
        limit: String(DEFAULT_SESSION_LIMIT),
      });
      if (pageParam) params.set("cursor", pageParam);
      const response = await fetch(
        `${api.baseURL}/api/audio/pipeline/sources?${params.toString()}`,
        {
          headers: { "Authorization": `Bearer ${await api.getJWT()}` },
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Recent sources failed (${response.status})`);
      }
      const page = EJSON.deserialize(await response.json()) as RecentSourcePage;
      return {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          start: item.start ? new Date(item.start) : undefined,
          updatedAt: item.updatedAt ? new Date(item.updatedAt) : undefined,
        })),
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading) {
      setLoadingTimedOut(false);
      return;
    }
    const timeout = globalThis.setTimeout(
      () => setLoadingTimedOut(true),
      16_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [isLoading]);

  const recentSourceItems =
    recentSourcesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const sessions: AudioSession[] = recentSourceItems.map((source) => ({
    _id: source.id,
    start: source.start,
    lastActivityAt: source.updatedAt,
    path: source.path,
    sourceKind: source.sourceKind,
    ingested: source.ingested,
    ingestionError: source.ingestionError,
    client_id: source.clientId,
    device: source.device,
    metadata: source.metadata,
    processing_status: source.processingStatus,
    chunks: { total: 0, vadProcessed: 0, withSpeech: 0 },
    sequences: [],
    transcriptions: 0,
    conversationChunks: [],
    transcriptionDetails: [],
    conversations: [],
    ...(sourceDetails[source.id] ?? {}),
  }));
  const hasMoreSessions = recentSourcesQuery.hasNextPage;

  // Stats are now included in the sessions data
  const stats = sessionsData?.stats;
  const diarizationCampaign = liveStatusQuery.data?.campaign ??
    stats?.diarizationCampaign ?? null;
  const diarizationCampaignView = diarizationCampaign
    ? getDiarizationCampaignProgressView(diarizationCampaign)
    : null;
  const diarizationCampaignOpen = diarizationCampaign
    ? isOpenDiarizationCampaignStatus(diarizationCampaign.status)
    : false;
  const diarizationStage = stats?.stages?.find((stage) =>
    stage.type === "diarization"
  );
  const liveDiarizationJobs = liveStatusQuery.data?.jobs;
  const activeDiarizationJobs = liveDiarizationJobs?.active ?? null;
  const queuedDiarizationJobs = liveDiarizationJobs?.available
    ? (liveDiarizationJobs.waiting ?? 0) + (liveDiarizationJobs.delayed ?? 0)
    : null;
  const vadCompletion = stats?.totalChunks
    ? Math.min((stats.chunksVadProcessed / stats.totalChunks) * 100, 100)
    : 0;
  const queuedVadJobs = (stats?.vadJobs?.waiting ?? 0) +
    (stats?.vadJobs?.delayed ?? 0);
  const vadMaximumAudioHours = getMaximumAudioHours(
    stats?.chunksAwaitingVad ?? 0,
  );
  const transcriptStages =
    stats?.stages?.filter((stage) => TRANSCRIPT_STAGE_TYPES.has(stage.type)) ??
      [];
  const activeStages = transcriptStages.filter((stage) => stage.active > 0);
  const blockedStages = stats?.stages?.filter(
    (stage) =>
      TRANSCRIPT_STAGE_TYPES.has(stage.type) && stage.paused &&
      stage.backlog > 0,
  ) ?? [];
  const stagesWithErrors = transcriptStages.filter((stage) => stage.errors > 0);
  const pipelineHealth = !stats && !isFetching && !isError
    ? "idle"
    : (isError || loadingTimedOut) && !stats
    ? "error"
    : !stats
    ? "loading"
    : blockedStages.length > 0
    ? "blocked"
    : activeStages.length > 0
    ? "processing"
    : stagesWithErrors.length > 0
    ? "attention"
    : "idle";

  const clearFailedVadMutation = useMutation({
    mutationFn: async () => {
      return await api.callResource("jobs", {
        action: "clear_failed",
        workerType: "vad",
      }) as { deletedCount?: number };
    },
    onSuccess: async (result) => {
      await refetch();
      toast.success(
        `Cleared ${result.deletedCount ?? 0} failed VAD job record(s).`,
      );
    },
    onError: (error) => {
      console.error("Failed to clear VAD error history:", error);
      toast.error("Failed to clear VAD error history.");
    },
  });

  const handleClearFailedVad = async () => {
    const failedCount = stats?.vadJobs.failed ?? 0;
    if (failedCount === 0) return;

    if (
      await confirmAction({
        title: `Clear ${failedCount} failed VAD job record(s)?`,
        description:
          "This permanently removes only failed VAD history. Active, waiting, delayed, completed, and other worker jobs are not changed. New VAD failures will appear here normally.",
        actionLabel: "Clear failed history",
        destructive: true,
      })
    ) {
      clearFailedVadMutation.mutate();
    }
  };

  const loadSourceDetails = async (id: string) => {
    setLoadingSourceDetails((current) => new Set(current).add(id));
    setSourceDetailErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const response = await fetch(
        `${api.baseURL}/api/audio/pipeline/sources/${id}/details`,
        { headers: { "Authorization": `Bearer ${await api.getJWT()}` } },
      );
      if (!response.ok) {
        throw new Error(`Source details failed (${response.status})`);
      }
      const details = EJSON.deserialize(await response.json()) as any;
      setSourceDetails((current) => ({
        ...current,
        [id]: {
          chunks: details.chunks,
          sequences: (details.sequences ?? []).map((sequence: any) => ({
            ...sequence,
            updatedAt: sequence.updatedAt
              ? new Date(sequence.updatedAt)
              : undefined,
          })),
          transcriptions: details.transcriptions?.count ?? 0,
          transcriptionDetails: (details.transcriptions?.preview ?? []).map(
            (transcription: any) => ({
              _id: transcription.id,
              start: new Date(transcription.start),
              end: new Date(transcription.end),
              text: transcription.text,
            }),
          ),
          conversationChunks: (details.conversationChunks ?? []).map(
            (chunk: any) => ({
              ...chunk,
              start: chunk.start ? new Date(chunk.start) : undefined,
              end: chunk.end ? new Date(chunk.end) : undefined,
              updatedAt: chunk.updatedAt
                ? new Date(chunk.updatedAt)
                : undefined,
            }),
          ),
          conversations: (details.conversations ?? []).map(
            (conversation: any) => ({
              ...conversation,
              createdAt: conversation.createdAt
                ? new Date(conversation.createdAt)
                : undefined,
            }),
          ),
        },
      }));
      if ((details.warnings?.length ?? 0) > 0) {
        toast.warning(
          "Some source details timed out; loaded the available sections.",
        );
      }
    } catch (error) {
      setSourceDetailErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLoadingSourceDetails((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleSession = (id: string) => {
    const opening = !expandedSessions.has(id);
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    if (opening && !sourceDetails[id] && !loadingSourceDetails.has(id)) {
      void loadSourceDetails(id);
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case "completed":
        return "bg-green-500/10 text-green-500";
      case "ready":
      case "waiting":
        return "bg-blue-500/10 text-blue-500";
      case "processing":
      case "active":
      case "counting":
      case "running":
      case "delayed":
        return "bg-yellow-500/10 text-yellow-500";
      case "error":
      case "failed":
        return "bg-red-500/10 text-red-500";
      case "interrupted":
      case "completed_with_errors":
        return "bg-amber-500/10 text-amber-600";
      case "empty":
        return "bg-gray-500/10 text-gray-500";
      default:
        return "bg-gray-500/10 text-gray-500";
    }
  };

  const getStageProgress = (session: AudioSession) => {
    const stages = [
      {
        name: "Chunks",
        done: session.chunks.total > 0,
        count: session.chunks.total,
      },
      {
        name: "VAD",
        done: session.chunks.vadProcessed === session.chunks.total &&
          session.chunks.total > 0,
        count: session.chunks.vadProcessed,
      },
      {
        name: "Sequences",
        done: session.sequences.length > 0,
        count: session.sequences.length,
      },
      {
        name: "Transcribed",
        done: session.transcriptions > 0,
        count: session.transcriptions,
      },
      {
        name: "Conv Chunks",
        done: session.conversationChunks.length > 0,
        count: session.conversationChunks.length,
      },
      {
        name: "Conversations",
        done: session.conversations.length > 0,
        count: session.conversations.length,
      },
    ];
    return stages;
  };

  const resetSequence = async (sequenceId: string) => {
    await api.callResource("mongo", {
      action: "updateOne",
      collection: "transcription_sequences",
      query: { _id: { $oid: sequenceId } },
      update: { $set: { state: "ready", updatedAt: new Date() } },
    });
    refetch();
  };

  return (
    <div
      className="container mx-auto p-6 space-y-6"
      data-testid="audio-pipeline-page"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audio Pipeline</h1>
          <p className="text-muted-foreground">
            Source imports, voice activity, transcription and speaker processing
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="refresh-btn"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Calculate current stats
          </Button>
        </div>
      </div>

      <ServiceHealthBanner />
      <AudioOperationsCard onCalculate={refetch} calculating={isFetching} />

      <Card
        className={pipelineHealth === "idle" || pipelineHealth === "loading"
          ? "border-muted bg-muted/10"
          : pipelineHealth === "error"
          ? "border-red-500/50 bg-red-500/5"
          : pipelineHealth === "blocked"
          ? "border-red-500/50 bg-red-500/5"
          : pipelineHealth === "processing"
          ? "border-blue-500/40 bg-blue-500/5"
          : pipelineHealth === "attention"
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-green-500/30 bg-green-500/5"}
        data-testid="pipeline-health"
      >
        <CardContent className="flex flex-col justify-between gap-4 pt-6 md:flex-row md:items-center">
          <div className="flex items-start gap-3">
            {pipelineHealth === "idle"
              ? <RefreshCw className="mt-0.5 h-5 w-5 text-muted-foreground" />
              : pipelineHealth === "loading"
              ? <RefreshCw className="mt-0.5 h-5 w-5 animate-spin" />
              : pipelineHealth === "error"
              ? <AlertCircle className="mt-0.5 h-5 w-5 text-red-600" />
              : pipelineHealth === "blocked"
              ? <PauseCircle className="mt-0.5 h-5 w-5 text-red-600" />
              : pipelineHealth === "processing"
              ? (
                <Activity className="mt-0.5 h-5 w-5 animate-pulse text-blue-600" />
              )
              : pipelineHealth === "attention"
              ? <AlertCircle className="mt-0.5 h-5 w-5 text-amber-600" />
              : <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-600" />}
            <div>
              <p className="font-semibold capitalize">
                {pipelineHealth === "idle"
                  ? "Pipeline snapshot not calculated"
                  : `Pipeline ${pipelineHealth}`}
              </p>
              <p className="text-sm text-muted-foreground">
                {pipelineHealth === "idle"
                  ? "Use Calculate current stats to run the exact dashboard queries."
                  : pipelineHealth === "loading"
                  ? "Loading source, backlog, worker, and job state."
                  : pipelineHealth === "error"
                  ? pipelineError instanceof Error
                    ? pipelineError.message
                    : "Pipeline statistics are not responding. Diarization continues independently; retry this dashboard."
                  : blockedStages.length > 0
                  ? `${blockedStages.map((stage) => stage.label).join(", ")} ${
                    blockedStages.length === 1 ? "is" : "are"
                  } paused with work waiting.`
                  : activeStages.length > 0
                  ? `${activeStages.map((stage) => stage.label).join(", ")} ${
                    activeStages.length === 1 ? "is" : "are"
                  } processing now.`
                  : stagesWithErrors.length > 0
                  ? "No worker is active and some stages need attention."
                  : "No stage has queued work or a current error."}
              </p>
            </div>
          </div>
          <Link
            to="/jobs"
            className="text-sm font-medium text-primary hover:underline"
          >
            Open all jobs →
          </Link>
        </CardContent>
      </Card>

      {(stats?.warnings?.length ?? 0) > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium text-amber-800">
            Some counters are temporarily unavailable
          </p>
          <p className="text-muted-foreground">
            The database stopped expensive dashboard scans to protect running
            workers. Refresh later; job execution is unaffected.
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Transcript pipeline</CardTitle>
          <CardDescription>
            Source ingestion through conversation summaries. Speaker processing
            is tracked separately below because it creates independent
            generations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
            {(stats?.stages ?? [])
              .filter((stage) => TRANSCRIPT_STAGE_TYPES.has(stage.type))
              .map((stage, index) => {
                const state = stageState(stage);
                return (
                  <div
                    key={stage.type}
                    className="relative rounded-lg border bg-muted/20 p-3"
                    data-testid={`pipeline-stage-${stage.type}`}
                  >
                    {index > 0 && (
                      <ChevronRight className="absolute -left-3 top-1/2 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-background text-muted-foreground xl:block" />
                    )}
                    <p className="text-xs font-medium text-muted-foreground">
                      {index + 1}. {stage.label}
                    </p>
                    <p className="mt-2 text-2xl font-semibold">
                      {stageBacklogValue(stage)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {stageBacklogLabel(stage)}
                    </p>
                    <p
                      className={`mt-2 text-xs font-medium ${state.className}`}
                    >
                      {state.label}
                    </p>
                    {stage.latestJob && (
                      <Link
                        to={`/jobs/${stage.latestJob.id}`}
                        className="mt-2 block truncate text-[11px] text-primary hover:underline"
                      >
                        Latest: {stage.latestJob.state}
                      </Link>
                    )}
                  </div>
                );
              })}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="diarization-campaign">
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Mic className="h-5 w-5 text-primary" />
                Speaker diarization
              </CardTitle>
              <CardDescription className="mt-1">
                Current historical backfill: progress, rolling throughput and
                available GPU capacity.
              </CardDescription>
            </div>
            {diarizationCampaign && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={getStateColor(diarizationCampaign.status)}>
                  {diarizationCampaign.status.replaceAll("_", " ")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {diarizationCampaign.updatedAt
                    ? `Campaign updated ${
                      formatDistanceToNow(diarizationCampaign.updatedAt)
                    } ago`
                    : "Update time unavailable"}
                  {diarizationCampaign.rateStatus === "live" &&
                      liveStatusQuery.data?.checkedAt
                    ? ` · speed checked ${
                      formatDistanceToNow(liveStatusQuery.data.checkedAt)
                    } ago`
                    : ""}
                </span>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {diarizationCampaign && diarizationCampaignView
            ? (
              <>
                <div className="space-y-2">
                  {diarizationCampaign.totalChunks != null && (
                    <Progress
                      value={diarizationCampaignView.percent}
                      className="h-3"
                    />
                  )}
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <span>{diarizationCampaignView.progressLabel}</span>
                    {diarizationCampaignOpen &&
                      diarizationCampaignView.etaLabel && (
                      <span>{diarizationCampaignView.etaLabel}</span>
                    )}
                  </div>
                  {diarizationCampaign.totalEstimated && (
                    <p className="text-xs text-muted-foreground">
                      Total is estimated and is refined as jobs complete.
                    </p>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    [
                      "Rolling speed (≤5 min)",
                      diarizationCampaign.chunksPerSecond != null
                        ? `${
                          (diarizationCampaign.chunksPerSecond * 60).toFixed(1)
                        } chunks/min`
                        : "Warming up",
                      "text-foreground",
                    ],
                    [
                      "Useful realtime",
                      diarizationCampaign.usefulAudioRealtimeMultiple != null
                        ? `${
                          diarizationCampaign.usefulAudioRealtimeMultiple
                            .toFixed(1)
                        }×`
                        : "—",
                      "text-foreground",
                    ],
                    [
                      "Active / queued",
                      liveDiarizationJobs?.available
                        ? `${activeDiarizationJobs ?? 0} / ${
                          queuedDiarizationJobs ?? 0
                        }`
                        : "Unavailable",
                      "text-foreground",
                    ],
                    [
                      "Ready / enabled slots",
                      liveStatusQuery.data?.capacity.available
                        ? `${
                          liveStatusQuery.data.capacity.healthySlots ?? 0
                        } / ${liveStatusQuery.data.capacity.enabledSlots ?? 0}`
                        : "Unavailable",
                      "text-foreground",
                    ],
                    [
                      "Errors",
                      diarizationCampaign.errorCount,
                      diarizationCampaign.errorCount > 0
                        ? "text-red-500"
                        : "text-foreground",
                    ],
                  ].map(([label, value, className]) => (
                    <div key={label} className="rounded-lg bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className={`mt-1 text-xl font-semibold ${className}`}>
                        {typeof value === "number"
                          ? value.toLocaleString()
                          : value}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border bg-muted/20 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs">
                      Campaign {diarizationCampaign.campaignId}
                    </span>
                    <Link
                      to="/jobs?type=diarization"
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Manage diarization jobs
                    </Link>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    A campaign is one durable historical backfill, not one
                    container or one job. Each bounded job keeps this ID; a
                    successful job schedules the next batch, while the
                    five-minute watchdog resumes the same campaign after a
                    broken chain. In Jobs, Pause prevents new batches and lets
                    active work finish; Resume continues this campaign. Route
                    switches and slot counts control how many jobs run in
                    parallel.
                  </p>
                </div>
              </>
            )
            : liveStatusQuery.isLoading
            ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Loading live diarization status…
              </div>
            )
            : liveStatusQuery.isError
            ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm">
                Live diarization status is unavailable. Jobs continue
                independently.
              </div>
            )
            : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No global diarization backfill campaign has been recorded yet.
                Current backlog: {diarizationStage
                  ? stageBacklogValue(diarizationStage)
                  : "not calculated"}; active / queued jobs:{" "}
                {liveDiarizationJobs?.available
                  ? `${activeDiarizationJobs ?? 0} / ${
                    queuedDiarizationJobs ?? 0
                  }`
                  : "unavailable"}.
              </div>
            )}
        </CardContent>
      </Card>

      <VoiceIdentityStatusCard />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle>Audio sources</CardTitle>
            <CardDescription>
              Every source type, not only legacy websocket recordings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 lg:grid-cols-2 xl:grid-cols-5">
              {[
                ["Total", stats?.sourceFiles?.total],
                ["Ingested", stats?.sourceFiles?.ingested],
                ["Pending", stats?.sourceFiles?.pending],
                ["Blocked", stats?.sourceFiles?.blocked],
                ["Errors", stats?.sourceFiles?.errors],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-xl font-semibold">
                    {typeof value === "number" ? value.toLocaleString() : "—"}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {(stats?.sourceFiles?.byKind ?? []).map((source) => (
                <Badge key={source.kind} variant="outline">
                  {source.kind}: {source.count.toLocaleString()}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest pipeline jobs</CardTitle>
            <CardDescription>
              This activity can belong to older recordings, so it is shown
              separately from recently added sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(stats?.recentJobs ?? []).slice(0, 6).map((job) => (
              <Link
                key={job.id}
                to={`/jobs/${job.id}`}
                className="flex items-center justify-between gap-4 rounded-md border p-2.5 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium capitalize">
                    {formatWorkerType(job.type)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {job.updatedAt
                      ? formatDistanceToNow(job.updatedAt, { addSuffix: true })
                      : "time unavailable"}
                  </p>
                </div>
                <Badge className={getStateColor(job.state)}>{job.state}</Badge>
              </Link>
            ))}
            {(stats?.recentJobs?.length ?? 0) === 0 && (
              <p className="py-5 text-center text-sm text-muted-foreground">
                {stats
                  ? "No pipeline jobs recorded yet."
                  : "Calculate current stats to load job history."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pipeline Stats */}
      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AudioWaveform className="h-5 w-5 text-primary" />
                VAD processing
              </CardTitle>
              <CardDescription className="mt-1">
                Coverage of every audio chunk currently stored in Mycelia. The
                total can increase while ingestion is still creating chunks.
              </CardDescription>
            </div>
            <Badge
              variant={!stats
                ? "outline"
                : stats.chunksAwaitingVad > 0
                ? "secondary"
                : "outline"}
            >
              {!stats
                ? "Not calculated"
                : stats.chunksAwaitingVad > 0
                ? `${stats.chunksAwaitingVad.toLocaleString()} remaining`
                : "Up to date"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                {stats
                  ? `${stats.chunksVadProcessed.toLocaleString()} of ${stats.totalChunks.toLocaleString()} chunks processed`
                  : "Coverage not calculated"}
              </span>
              <span className="font-medium">
                {stats ? `${vadCompletion.toFixed(1)}%` : "—"}
              </span>
            </div>
            <Progress value={vadCompletion} className="h-3" />
            {stats && (
              <p className="text-xs text-muted-foreground">
                Remaining upper bound:{" "}
                {stats.chunksAwaitingVad.toLocaleString()} chunks ×{" "}
                {MAX_AUDIO_CHUNK_SECONDS} sec ={" "}
                {vadMaximumAudioHours.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })} hours of audio
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Total chunks</p>
              <p className="mt-1 text-xl font-semibold">
                {stats ? stats.totalChunks.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">VAD completed</p>
              <p className="mt-1 text-xl font-semibold text-green-600">
                {stats ? stats.chunksVadProcessed.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                Still awaiting VAD
              </p>
              <p className="mt-1 text-xl font-semibold text-amber-600">
                {stats ? stats.chunksAwaitingVad.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Activity className="h-3 w-3" /> Active / queued jobs
              </p>
              <p className="mt-1 text-xl font-semibold">
                {stats ? `${stats.vadJobs.active} / ${queuedVadJobs}` : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Gauge className="h-3 w-3" /> Recent speed
              </p>
              <p className="mt-1 text-xl font-semibold">
                {stats ? `${stats.vadRatePerMinute.toFixed(1)}/min` : "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                last 15 minutes
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" /> Audio left (maximum)
              </p>
              <p className="mt-1 text-xl font-semibold">
                {stats
                  ? `${
                    vadMaximumAudioHours.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  }h`
                  : "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                assumes {MAX_AUDIO_CHUNK_SECONDS}s per chunk
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Timer className="h-3 w-3" /> Estimated wall time
              </p>
              <p className="mt-1 text-sm font-semibold">
                {!stats
                  ? "Not calculated"
                  : stats.chunksAwaitingVad === 0
                  ? "Complete"
                  : formatEta(stats.vadEtaSeconds)}
              </p>
            </div>
          </div>

          {(stats?.vadJobs?.failed ?? 0) > 0 && (
            <details className="rounded-lg border border-destructive/40 bg-destructive/5">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-destructive">
                {stats?.vadJobs.failed.toLocaleString()} failed VAD job(s)
                {stats?.vadJobs.latestFailureAt
                  ? ` — latest ${
                    format(
                      stats.vadJobs.latestFailureAt,
                      "MMM d, yyyy · HH:mm:ss",
                    )
                  }`
                  : ""}
              </summary>
              <div className="space-y-3 border-t border-destructive/30 px-4 py-3">
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                  <p className="text-xs text-muted-foreground">
                    Showing the five most recent failures. Clearing removes only
                    failed VAD history.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={clearFailedVadMutation.isPending}
                    onClick={handleClearFailedVad}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {clearFailedVadMutation.isPending
                      ? "Clearing…"
                      : "Clear failed VAD history"}
                  </Button>
                </div>

                <div className="space-y-2">
                  {(stats?.vadJobs.recentFailures ?? []).map((failure) => (
                    <div
                      key={failure.id}
                      className="rounded-md border border-destructive/20 bg-background/60 p-3"
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span>
                          {failure.failedAt
                            ? format(failure.failedAt, "MMM d, yyyy · HH:mm:ss")
                            : "Failure time unavailable"}
                        </span>
                        {failure.failedAt && (
                          <span>
                            ({formatDistanceToNow(failure.failedAt, {
                              addSuffix: true,
                            })})
                          </span>
                        )}
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                        {failure.reason || "No error message was stored."}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                Transcription backlog
              </CardTitle>
              <CardDescription className="mt-1">
                Speech-positive chunks that are not transcribed and are not
                currently claimed by an STT worker.
              </CardDescription>
            </div>
            <Badge
              variant={stats && stats.transcriptionPendingChunks > 0
                ? "secondary"
                : "outline"}
            >
              {!stats
                ? "Not calculated"
                : stats.transcriptionPendingChunks > 0
                ? `${stats.transcriptionPendingChunks.toLocaleString()} pending`
                : "Up to date"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Pending chunks</p>
              <p className="mt-1 text-xl font-semibold text-amber-600">
                {stats
                  ? stats.transcriptionPendingChunks.toLocaleString()
                  : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" /> Audio left (maximum)
              </p>
              <p className="mt-1 text-xl font-semibold">
                {stats
                  ? `${
                    stats.transcriptionPendingMaximumHours.toLocaleString(
                      undefined,
                      {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      },
                    )
                  }h`
                  : "—"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                assumes {MAX_AUDIO_CHUNK_SECONDS}s per chunk
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Sequences ready</p>
              <p className="mt-1 text-xl font-semibold">
                {stats ? stats.sequencesReady.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">
                Sequences processing / errors
              </p>
              <p className="mt-1 text-xl font-semibold">
                {stats ? stats.sequencesProcessing.toLocaleString() : "—"} /
                {" "}
                <span
                  className={(stats?.sequencesError ?? 0) > 0
                    ? "text-red-500"
                    : undefined}
                >
                  {stats ? stats.sequencesError.toLocaleString() : "—"}
                </span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Seq Ready</CardTitle>
            <Clock className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.sequencesReady ?? "-"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Seq Processing
            </CardTitle>
            <RefreshCw className="h-4 w-4 text-yellow-500 animate-spin" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.sequencesProcessing ?? "-"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Seq Errors</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.sequencesError ?? "-"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conv Chunks</CardTitle>
            <Layers className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.convChunksReady ?? "-"}
              {(stats?.convChunksProcessing ?? 0) > 0 && (
                <span className="text-sm font-normal text-yellow-500 ml-1">
                  +{stats?.convChunksProcessing}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversations</CardTitle>
            <MessageSquare className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.totalConversations ?? "-"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions List */}
      <Card>
        <CardHeader>
          <CardTitle>Recent source files</CardTitle>
          <CardDescription>
            Ordered by source ingestion, retry, or source-record update—not by
            downstream processing. Details load only when a row is opened.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {recentSourcesQuery.isError
            ? (
              <div className="space-y-3 p-8 text-center text-muted-foreground">
                <p>
                  Recent source metadata is unavailable. Corpus statistics and
                  background workers are unaffected.
                </p>
                <Button
                  variant="outline"
                  onClick={() => void recentSourcesQuery.refetch()}
                >
                  Retry sources
                </Button>
              </div>
            )
            : recentSourcesQuery.isLoading
            ? (
              <div className="p-8 text-center text-muted-foreground">
                Loading recent source files…
              </div>
            )
            : !sessions?.length
            ? (
              <div className="p-8 text-center text-muted-foreground">
                No audio sources found
              </div>
            )
            : (
              <div className="divide-y">
                {sessions?.map((session) => (
                  <Collapsible
                    key={session._id}
                    open={expandedSessions.has(session._id)}
                    onOpenChange={() => toggleSession(session._id)}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className="flex cursor-pointer flex-col gap-4 p-4 hover:bg-muted/50 xl:flex-row xl:items-center xl:justify-between"
                        data-testid={`session-row-${session._id}`}
                      >
                        <div className="flex items-center gap-4">
                          <Mic className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {session.start
                                ? format(session.start, "MMM d, HH:mm:ss")
                                : session.path?.split("/").pop() ||
                                  "Recording time unavailable"}
                              <Badge variant="outline" className="font-normal">
                                {session.sourceKind}
                              </Badge>
                              <Badge
                                className={session.ingestionError
                                  ? "bg-red-500/10 text-red-600"
                                  : session.ingested
                                  ? "bg-green-500/10 text-green-600"
                                  : "bg-amber-500/10 text-amber-600"}
                              >
                                {session.ingestionError
                                  ? "ingestion error"
                                  : session.ingested
                                  ? "ingested"
                                  : "pending"}
                              </Badge>
                              {session.client_id && (
                                <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded">
                                  {session.device || session.client_id}
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {session.metadata?.codec ||
                                session.metadata?.format || "unknown"}{" "}
                              {session.metadata?.rate}Hz &middot;{" "}
                              {session.lastActivityAt
                                ? `source updated ${
                                  formatDistanceToNow(session.lastActivityAt, {
                                    addSuffix: true,
                                  })
                                } · `
                                : ""}
                              <span className="font-mono text-xs">
                                {session._id.substring(0, 8)}
                              </span>
                            </div>
                            {session.path && (
                              <div
                                className="max-w-xl truncate text-xs text-muted-foreground"
                                title={session.path}
                              >
                                {session.path}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex w-full items-center gap-6 overflow-x-auto pb-1 xl:w-auto xl:pb-0">
                          {/* Pipeline stages mini-view */}
                          <div className="flex items-center gap-2">
                            {sourceDetails[session._id]
                              ? getStageProgress(session).map((stage, i) => (
                                <div
                                  key={stage.name}
                                  className="flex items-center gap-1"
                                >
                                  {i > 0 && (
                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                  )}
                                  <div
                                    className={`text-xs px-2 py-0.5 rounded ${
                                      stage.done
                                        ? "bg-green-500/10 text-green-600"
                                        : "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {stage.name}: {stage.count.toLocaleString()}
                                  </div>
                                </div>
                              ))
                              : (
                                <Badge variant="outline">
                                  Open for downstream details
                                </Badge>
                              )}
                          </div>
                          <ChevronRight
                            className={`h-5 w-5 text-muted-foreground transition-transform ${
                              expandedSessions.has(session._id)
                                ? "rotate-90"
                                : ""
                            }`}
                          />
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      {loadingSourceDetails.has(session._id) && (
                        <div className="border-t px-4 py-3 text-sm text-muted-foreground">
                          Loading bounded downstream details…
                        </div>
                      )}
                      {sourceDetailErrors[session._id] && (
                        <div className="flex items-center justify-between gap-3 border-t border-red-500/30 bg-red-500/5 px-4 py-3 text-sm">
                          <span>{sourceDetailErrors[session._id]}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void loadSourceDetails(session._id)}
                          >
                            Retry details
                          </Button>
                        </div>
                      )}
                      <div
                        className={`px-4 pb-3 pt-2 bg-muted/30 space-y-3 ${
                          sourceDetails[session._id] ? "" : "hidden"
                        }`}
                      >
                        <PipelineDetailSection
                          title="Ingestion"
                          summary={session.ingestionError
                            ? "Error"
                            : session.ingested
                            ? "Complete"
                            : "Pending"}
                          icon={<Mic className="h-3 w-3" />}
                          defaultOpen={Boolean(session.ingestionError)}
                          testId={`session-${session._id}-ingestion`}
                        >
                          <div className="space-y-2 text-xs">
                            <p className="break-all font-mono text-muted-foreground">
                              {session.path || "No local source path"}
                            </p>
                            {session.ingestionError
                              ? (
                                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-600">
                                  {session.ingestionError}
                                </pre>
                              )
                              : (
                                <p
                                  className={session.ingested
                                    ? "text-green-600"
                                    : "text-amber-600"}
                                >
                                  {session.ingested
                                    ? "Source audio was ingested successfully."
                                    : "Source audio is waiting for ingestion."}
                                </p>
                              )}
                          </div>
                        </PipelineDetailSection>

                        <PipelineDetailSection
                          title="Audio chunks & VAD"
                          summary={`${session.chunks.vadProcessed.toLocaleString()} / ${session.chunks.total.toLocaleString()} processed · ${session.chunks.withSpeech.toLocaleString()} speech`}
                          icon={<AudioWaveform className="h-3 w-3" />}
                          testId={`session-${session._id}-vad`}
                        >
                          <div className="flex flex-wrap items-center gap-4 text-xs">
                            <span className="text-muted-foreground">
                              Chunks:{" "}
                              <span className="font-medium text-foreground">
                                {session.chunks.total.toLocaleString()}
                              </span>
                            </span>
                            <span className="text-muted-foreground">
                              VAD:{" "}
                              <span className="font-medium text-foreground">
                                {session.chunks.vadProcessed.toLocaleString()}
                              </span>
                              {session.chunks.total > 0 && (
                                <span className="ml-1">
                                  ({Math.round(
                                    (session.chunks.vadProcessed /
                                      session.chunks.total) * 100,
                                  )}%)
                                </span>
                              )}
                            </span>
                            <span className="text-muted-foreground">
                              Speech:{" "}
                              <span className="font-medium text-foreground">
                                {session.chunks.withSpeech.toLocaleString()}
                              </span>
                            </span>
                            {session.chunks.total > 0 && (
                              <Progress
                                value={(session.chunks.vadProcessed /
                                  session.chunks.total) * 100}
                                className="h-1.5 min-w-24 flex-1"
                              />
                            )}
                          </div>
                        </PipelineDetailSection>

                        {/* Sequences - compact inline */}
                        {session.sequences.length > 0 && (
                          <PipelineDetailSection
                            title="Transcription sequences"
                            summary={`${session.sequences.length.toLocaleString()} sequence(s)`}
                            icon={<Layers className="h-3 w-3 text-blue-500" />}
                            testId={`session-${session._id}-sequences`}
                          >
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              {session.sequences.map((seq) => (
                                <div
                                  key={seq._id}
                                  className="flex items-center gap-1"
                                >
                                  <Badge
                                    className={`${
                                      getStateColor(seq.state)
                                    } text-xs py-0 px-1.5`}
                                  >
                                    {seq.state}
                                  </Badge>
                                  <span className="font-mono text-muted-foreground">
                                    [{seq.fromIndex}-{seq.toIndex}]
                                  </span>
                                  {(seq.state === "error" ||
                                    seq.state === "processing") && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-5 px-1 text-xs"
                                      onClick={() => resetSequence(seq._id)}
                                    >
                                      ↻
                                    </Button>
                                  )}
                                </div>
                              ))}
                              {session.sequences.some((s) => s.error) && (
                                <span className="text-red-500 text-xs">
                                  Error: {session.sequences.find((s) =>
                                    s.error
                                  )?.error?.slice(0, 50)}...
                                </span>
                              )}
                            </div>
                          </PipelineDetailSection>
                        )}

                        {/* Transcriptions - compact list */}
                        {session.transcriptionDetails.length > 0 && (
                          <PipelineDetailSection
                            title="Transcriptions"
                            summary={`${session.transcriptions.toLocaleString()} total`}
                            icon={<FileText className="h-3 w-3" />}
                            testId={`session-${session._id}-transcriptions`}
                          >
                            <div className="max-h-64 space-y-1 overflow-y-auto">
                              {session.transcriptionDetails.map((t) => (
                                <div
                                  key={t._id}
                                  className="flex gap-2 text-xs bg-background rounded px-2 py-1"
                                >
                                  <Link
                                    to={`/timeline?start=${t.start.getTime()}&end=${t.end.getTime()}`}
                                    className="text-muted-foreground hover:underline whitespace-nowrap shrink-0"
                                  >
                                    {format(t.start, "HH:mm:ss")}
                                  </Link>
                                  <span className="text-foreground truncate">
                                    {t.text || (
                                      <span className="italic text-muted-foreground">
                                        (no text)
                                      </span>
                                    )}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {session.transcriptions >
                                session.transcriptionDetails.length && (
                              <p className="mt-2 text-[11px] text-muted-foreground">
                                Showing the first {session.transcriptionDetails
                                  .length.toLocaleString()} of {session
                                  .transcriptions.toLocaleString()}.
                              </p>
                            )}
                          </PipelineDetailSection>
                        )}

                        {/* Conversation Chunks - compact inline */}
                        {session.conversationChunks.length > 0 && (
                          <PipelineDetailSection
                            title="Conversation chunks"
                            summary={`${session.conversationChunks.length.toLocaleString()} chunk(s)`}
                            icon={
                              <Layers className="h-3 w-3 text-purple-500" />
                            }
                            testId={`session-${session._id}-conversation-chunks`}
                          >
                            <div className="max-h-80 overflow-y-auto flex flex-wrap gap-1">
                              {session.conversationChunks.map((chunk) => (
                                <div
                                  key={chunk._id}
                                  className="flex items-center gap-1 bg-background rounded px-2 py-0.5 text-xs"
                                >
                                  <Badge
                                    className={`${
                                      getStateColor(chunk.state)
                                    } text-xs py-0 px-1`}
                                  >
                                    {chunk.state}
                                  </Badge>
                                  {chunk.start && chunk.end && (
                                    <Link
                                      to={`/timeline?start=${chunk.start.getTime()}&end=${chunk.end.getTime()}`}
                                      className="hover:underline text-primary"
                                    >
                                      {format(chunk.start, "HH:mm")}
                                    </Link>
                                  )}
                                  {chunk.conversationsCreated !== undefined &&
                                    chunk.conversationsCreated > 0 && (
                                    <span className="text-green-500">
                                      →{chunk.conversationsCreated}
                                    </span>
                                  )}
                                  {chunk.error && (
                                    <span
                                      className="text-red-500"
                                      title={chunk.error}
                                    >
                                      ⚠
                                    </span>
                                  )}
                                  {chunk.emptyReason && (
                                    <span
                                      className="text-yellow-500"
                                      title={chunk.emptyReason}
                                    >
                                      ∅
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </PipelineDetailSection>
                        )}

                        {/* Conversations - 2 column grid */}
                        {session.conversations.length > 0 && (
                          <PipelineDetailSection
                            title="Parsed conversations"
                            summary={`${session.conversations.length.toLocaleString()} conversation(s)`}
                            icon={
                              <MessageSquare className="h-3 w-3 text-green-500" />
                            }
                            testId={`session-${session._id}-conversations`}
                          >
                            <div className="grid max-h-[32rem] gap-2 overflow-y-auto sm:grid-cols-2">
                              {session.conversations.map((conv) => {
                                const start = conv.timeRanges?.[0]?.start
                                  ? new Date(conv.timeRanges[0].start)
                                  : null;
                                const end = conv.timeRanges?.[0]?.end
                                  ? new Date(conv.timeRanges[0].end)
                                  : null;
                                const durationMs = start && end
                                  ? end.getTime() - start.getTime()
                                  : 0;
                                const durationMins = Math.round(
                                  durationMs / 60000,
                                );

                                return (
                                  <div
                                    key={conv._id}
                                    className="flex items-start gap-2 bg-background rounded-lg p-2 hover:bg-muted transition-colors"
                                  >
                                    {conv.icon?.text && (
                                      <span className="text-lg shrink-0">
                                        {conv.icon.text}
                                      </span>
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <Link
                                        to={`/objects/${conv._id}`}
                                        className="text-sm font-medium text-primary hover:underline block truncate"
                                      >
                                        {conv.name}
                                      </Link>
                                      {start && (
                                        <Link
                                          to={`/timeline?start=${start.getTime()}&end=${
                                            end?.getTime() || start.getTime()
                                          }`}
                                          className="text-xs text-muted-foreground hover:underline flex items-center gap-1"
                                        >
                                          <span>
                                            {format(start, "MMM d, HH:mm")}
                                          </span>
                                          {durationMins > 0 && (
                                            <span className="text-muted-foreground">
                                              • {durationMins}m
                                            </span>
                                          )}
                                        </Link>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </PipelineDetailSection>
                        )}

                        {/* Empty states - inline */}
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          {session.sequences.length === 0 && (
                            <span>
                              No sequences{session.chunks.withSpeech === 0 &&
                                session.chunks.vadProcessed > 0 &&
                                " (no speech)"}
                            </span>
                          )}
                          {session.transcriptionDetails.length === 0 &&
                            session.sequences.length > 0 && (
                            <span>No transcriptions</span>
                          )}
                          {session.conversations.length === 0 &&
                            session.transcriptions > 0 && (
                            <span>
                              No conversations{session.conversationChunks.some(
                                (c) => c.state === "empty",
                              ) && " (empty chunks)"}
                            </span>
                          )}
                          <span className="font-mono text-[10px] ml-auto">
                            {session._id}
                          </span>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
                {hasMoreSessions && (
                  <div className="p-4 border-t">
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={recentSourcesQuery.isFetchingNextPage}
                      onClick={() => void recentSourcesQuery.fetchNextPage()}
                      data-testid="load-more-sessions"
                    >
                      {recentSourcesQuery.isFetchingNextPage
                        ? "Loading…"
                        : "Load more source files"}
                    </Button>
                  </div>
                )}
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
