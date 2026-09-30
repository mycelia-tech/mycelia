import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { EJSON } from "bson";
import { Activity, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface QueueStatus {
  available: boolean;
  active?: number;
  waiting?: number;
  delayed?: number;
  paused?: number;
}
export interface AudioOperations {
  checkedAt: Date | string;
  host: {
    reachable: boolean;
    status: string;
    automatic?: boolean;
    intervalSeconds?: number;
    batchSize?: number;
    appleVoiceMemosMode?: string;
    currentCycle?: { startedAt: string; phase: string } | null;
    nextCheckAt?: string | null;
    lastCycle?: {
      status: string;
      finishedAt?: string;
      error?: string;
      sources?: Array<
        {
          source: string;
          status: string;
          discovered?: number;
          error?: string;
          warning?: string;
        }
      >;
      ingestion?: {
        attempted: number;
        succeeded: number;
        failed: number;
        remaining: number;
        cached_errors: number;
      };
    };
    staging?: {
      status: string;
      published_at_utc?: string;
      staged_audio_files?: number;
      not_before?: string;
      error?: string;
    } | null;
    error?: string;
  };
  recentImports:
    | Array<
      {
        id: string;
        name: string;
        recordedAt?: Date | string;
        importedAt: Date | string;
      }
    >
    | null;
  snapshot: {
    state: string;
    asOf?: Date | string;
    lastAttemptAt?: Date | string;
    warning?: string;
    data?: {
      sourceFiles: { pending: number; blocked: number; errors: number };
      vadPending: number;
      vadProcessed: number;
      transcriptionPendingChunks: number;
      sequencesReady: number;
      sequencesProcessing: number;
      sequencesError: number;
    };
  } | null;
  queues: Record<string, QueueStatus>;
  warnings: string[];
}

function time(value?: Date | string | null) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString();
}

function count(value?: number | null) {
  return value == null ? "—" : value.toLocaleString();
}

function QueueLine({ queue }: { queue?: QueueStatus }) {
  if (!queue?.available) {
    return (
      <p className="text-xs text-muted-foreground">Job queue unavailable</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Jobs: {count(queue.active)} active ·{" "}
      {count((queue.waiting ?? 0) + (queue.delayed ?? 0) + (queue.paused ?? 0))}
      {" "}
      queued
    </p>
  );
}

export function AudioOperationsView(
  { data, checking, calculating, running, error, onCheck, onCalculate, onRun }:
    {
      data?: AudioOperations;
      checking: boolean;
      calculating: boolean;
      running: boolean;
      error?: string;
      onCheck: () => void;
      onCalculate: () => void;
      onRun: () => void;
    },
) {
  const host = data?.host;
  const snapshot = data?.snapshot;
  const counts = snapshot?.data;
  const ingestion = host?.lastCycle?.ingestion;
  const staging = host?.staging;
  const stagingOld = staging?.published_at_utc &&
    Date.now() - new Date(staging.published_at_utc).getTime() > 86400_000;
  const checkOld = data &&
    Date.now() - new Date(data.checkedAt).getTime() > 60_000;
  const cycleOld = host?.lastCycle?.finishedAt && !host.currentCycle &&
    Date.now() - new Date(host.lastCycle.finishedAt).getTime() >
      Math.max(60, (host.intervalSeconds ?? 10) * 3) * 1000;
  const status = !data
    ? "Checking service"
    : error || checkOld
    ? "Status is stale"
    : !host?.reachable
    ? "Service unavailable"
    : host.currentCycle
    ? "Import running"
    : cycleOld
    ? "No recent cycle"
    : host.status === "healthy"
    ? "Service running"
    : host.status === "starting"
    ? "Starting"
    : "Running · needs attention";
  return (
    <Card className="min-w-0" data-testid="audio-operations">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />Audio processing overview
            </CardTitle>
            <CardDescription className="mt-2">
              Import → voice activity (VAD) → transcription. Live checks and
              saved audio counts.
            </CardDescription>
          </div>
          <Badge
            variant={error || cycleOld || !host?.reachable ||
                host.status === "degraded"
              ? "destructive"
              : "secondary"}
          >
            {status}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onCheck}
            disabled={checking}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`}
            />Check service
          </Button>
          <Button
            size="sm"
            onClick={onRun}
            disabled={running || !host?.reachable ||
              (data?.queues.ingestion?.active ?? 0) > 0 ||
              (data?.queues.ingestion?.waiting ?? 0) > 0 ||
              (data?.queues.ingestion?.delayed ?? 0) > 0 ||
              (data?.queues.ingestion?.paused ?? 0) > 0}
          >
            {running ? "Queuing scan…" : "Scan staging now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onCalculate}
            disabled={calculating}
          >
            {calculating ? "Calculating…" : "Update audio counts"}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to="/jobs">Open jobs</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Service checked: {time(data?.checkedAt)} · Audio counts:{" "}
          {time(snapshot?.asOf)} (saved snapshot)
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {(error || host?.error || host?.lastCycle?.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || host?.error || host?.lastCycle?.error}
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <div
            className="rounded-lg border p-4"
            data-testid="operations-ingestion"
          >
            <p className="font-medium">1. Audio import</p>
            <p className="mt-2 text-3xl font-semibold">
              {count(ingestion?.remaining ?? counts?.sourceFiles.pending)}
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              files waiting for import
            </p>
            <QueueLine queue={data?.queues.ingestion} />
            <p className="mt-2 text-xs">
              Cached source errors:{" "}
              {count(ingestion?.cached_errors ?? counts?.sourceFiles.errors)}
              {" "}
              · Blocked: {count(counts?.sourceFiles.blocked)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Cached errors require a targeted retry; they are excluded from the
              normal scan.
            </p>
          </div>
          <div className="rounded-lg border p-4" data-testid="operations-vad">
            <p className="font-medium">2. Voice activity · VAD</p>
            <p className="mt-2 text-3xl font-semibold">
              {count(counts?.vadPending)}
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              audio chunks awaiting VAD
            </p>
            <QueueLine queue={data?.queues.vad} />
            <p className="mt-2 text-xs">
              Processed chunks: {count(counts?.vadProcessed)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Checks which audio contains speech.
            </p>
          </div>
          <div
            className="rounded-lg border p-4"
            data-testid="operations-transcription"
          >
            <p className="font-medium">3. Transcription</p>
            <p className="mt-2 text-3xl font-semibold">
              {count(counts?.transcriptionPendingChunks)}
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              speech chunks awaiting transcription
            </p>
            <QueueLine queue={data?.queues.transcription} />
            <p className="mt-2 text-xs">
              Sequences: {count(counts?.sequencesReady)} ready ·{" "}
              {count(counts?.sequencesProcessing)} processing ·{" "}
              {count(counts?.sequencesError)} errors
            </p>
          </div>
        </div>
        {!counts && (
          <p className="text-sm text-muted-foreground">
            No complete audio counts yet. “—” means unknown. Use Update audio
            counts to calculate them once.
          </p>
        )}
        {snapshot?.warning && (
          <p className="text-sm text-amber-700">
            {snapshot.warning} Last attempt: {time(snapshot.lastAttemptAt)}
          </p>
        )}
        {data?.warnings.map((warning) => (
          <p key={warning} className="text-sm text-amber-700">{warning}</p>
        ))}
        <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Last completed scan</dt>
            <dd className="mt-1">{time(host?.lastCycle?.finishedAt)}</dd>
            <dd className="text-xs text-muted-foreground">
              {host?.currentCycle
                ? `Now: ${host.currentCycle.phase}`
                : host?.lastCycle?.status ?? "Not reported"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Automatic scan</dt>
            <dd className="mt-1">
              {host?.intervalSeconds
                ? `${host.intervalSeconds}s after each cycle`
                : "Interval not reported"}
            </dd>
            <dd className="text-xs text-muted-foreground">
              Up to {host?.batchSize ?? "—"} files per cycle ·{" "}
              {host?.appleVoiceMemosMode ?? "unknown"} mode
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Latest successful import</dt>
            <dd className="mt-1">
              {time(data?.recentImports?.[0]?.importedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              Voice Memos staging published
            </dt>
            <dd className="mt-1">{time(staging?.published_at_utc)}</dd>
            <dd className="text-xs text-muted-foreground">
              {count(staging?.staged_audio_files)} staged files
            </dd>
          </div>
        </dl>
        {host?.lastCycle?.sources?.filter((source) =>
          source.error || source.warning
        ).map((source) => (
          <p key={source.source} className="text-sm text-destructive">
            {source.source}: {source.error || source.warning}
          </p>
        ))}
        {host?.appleVoiceMemosMode === "staged" && (
          <div
            className={`rounded-lg border p-4 text-sm ${
              stagingOld ? "border-amber-500/50 bg-amber-500/5" : "bg-muted/20"
            }`}
          >
            <p className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" />
              {stagingOld
                ? "Staging is more than 24 hours old"
                : "Voice Memos refresh is manual"}
            </p>
            <p className="mt-2 text-muted-foreground">
              Scan staging now imports the local published copy. To include
              newer Apple recordings, run this from the repository in your
              trusted Terminal with the archive disk connected:
            </p>
            <code className="mt-3 block overflow-x-auto rounded bg-background p-2 text-xs">
              bash scripts/refresh-voice-memos-staging.sh --apply
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              The script verifies the archive and publishes local audio plus
              metadata. Automatic scanning then picks them up. No Full Disk
              Access for uv is needed. Cutoff: {time(staging?.not_before)}.
            </p>
            {staging?.error && (
              <p className="mt-2 text-destructive">{staging.error}</p>
            )}
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            Last five imported files
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b">
                  <th className="p-2">File</th>
                  <th className="p-2">Recorded</th>
                  <th className="p-2">Imported</th>
                </tr>
              </thead>
              <tbody>
                {data?.recentImports?.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="p-2">{item.name}</td>
                    <td className="p-2 whitespace-nowrap">
                      {time(item.recordedAt)}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {time(item.importedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.recentImports?.length === 0 && (
            <p className="mt-2 text-muted-foreground">
              No import timestamps recorded.
            </p>
          )}
        </details>
        <p className="text-xs text-muted-foreground">
          Live service and job queues refresh every 15 seconds while visible.
          Corpus counts update only on request and retain their calculation
          time.
        </p>
      </CardContent>
    </Card>
  );
}

export function AudioOperationsCard(
  { onCalculate, calculating }: {
    onCalculate: () => Promise<unknown>;
    calculating: boolean;
  },
) {
  const query = useQuery({
    queryKey: ["audio-operations"],
    queryFn: async ({ signal }) => {
      const response = await api.fetchRaw("/api/audio/pipeline/operations", {
        signal,
      });
      if (!response.ok) {
        throw new Error(`Audio status unavailable (${response.status})`);
      }
      return EJSON.deserialize(await response.json()) as AudioOperations;
    },
    refetchInterval: () =>
      document.visibilityState === "visible" ? 15_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: false,
  });
  const run = useMutation({
    mutationFn: () =>
      api.callResource("jobs", {
        action: "enqueue",
        data: { type: "ingestion", limit: 20 },
      }),
    onSuccess: () => {
      toast.success("Staging scan queued. Follow its progress in Jobs.");
      void query.refetch();
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not queue ingestion",
      ),
  });
  return (
    <AudioOperationsView
      data={query.data}
      checking={query.isFetching}
      calculating={calculating}
      running={run.isPending}
      error={query.error?.message}
      onCheck={() => {
        void query.refetch();
      }}
      onRun={() => run.mutate()}
      onCalculate={() => {
        void onCalculate().then(() => query.refetch());
      }}
    />
  );
}
