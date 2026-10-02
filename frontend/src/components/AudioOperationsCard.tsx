import type { ReactNode } from "react";
import { FolderAudioImport } from "./FolderAudioImport";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { EJSON } from "bson";
import { Activity, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    folderSource?: { path: string; automatic: boolean } | null;
    currentCycle?: { startedAt: string; phase: string } | null;
    nextCheckAt?: string | null;
    lastCycle?: {
      status: string;
      folder?: string | null;
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
  {
    data,
    checking,
    calculating,
    running,
    error,
    onCheck,
    onCalculate,
    onRun,
    folderContent,
  }: {
    data?: AudioOperations;
    folderContent?: ReactNode;
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
  const checkOld = data &&
    Date.now() - new Date(data.checkedAt).getTime() > 60_000;
  const cycleOld = host?.lastCycle?.finishedAt && !host.currentCycle &&
    Date.now() - new Date(host.lastCycle.finishedAt).getTime() >
      Math.max(60, (host.intervalSeconds ?? 10) * 3) * 1000;
  const accessBlocked = host?.lastCycle?.sources?.some((source) =>
    source.source === "apple_voicememos" &&
    /operation not permitted|permission denied/i.test(source.error ?? "")
  );
  const status = !data
    ? "Checking service"
    : error || checkOld
    ? "Status is stale"
    : !host?.reachable
    ? "Service unavailable"
    : accessBlocked
    ? "Folder access needed"
    : host.currentCycle
    ? "Scan running"
    : cycleOld
    ? "No recent cycle"
    : host.status === "healthy"
    ? "Service running"
    : host.status === "starting"
    ? "Starting"
    : "Running · needs attention";
  return (
    <Card className="min-w-0" data-testid="audio-operations">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Activity className="h-5 w-5" />Audio import
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">Voice Memos app</h3>
            <Badge variant="secondary">Separate Mac application</Badge>
            <p className="text-sm text-muted-foreground">
              Open Mycelia Voice Memos Bridge to choose and import recordings.
            </p>
            <Dialog>
              <DialogTrigger asChild>
                <Button>
                  <Download className="mr-2 h-4 w-4" />Import Voice Memos…
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Import from Voice Memos</DialogTitle>
                  <DialogDescription>
                    Start in the Mac app. Follow processing here after import.
                  </DialogDescription>
                </DialogHeader>
                <ol className="list-decimal space-y-4 pl-5 text-sm">
                  <li>
                    <strong>Open Mycelia Voice Memos Bridge</strong>{" "}
                    on this Mac.
                  </li>
                  <li>
                    <strong>Choose source folder…</strong>, then select the
                    Voice Memos <strong>Recordings</strong>{" "}
                    folder. Choose a date range and click{" "}
                    <strong>Scan library</strong>.
                  </li>
                  <li>
                    Click{" "}
                    <strong>Import pending</strong>. Keep Bridge open until the
                    import finishes.
                  </li>
                </ol>
                <p className="text-sm text-muted-foreground">
                  Already imported recordings are skipped. Failed recordings
                  have a separate Retry failed action.
                </p>
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">
                    Build, launch and setup on macOS
                  </summary>
                  <div className="mt-3 space-y-3 text-muted-foreground">
                    <p>
                      Open Terminal and go to your Mycelia repository. The
                      commands below use{" "}
                      <code>~/repo/mycelia</code>; change it if your checkout is
                      elsewhere.
                    </p>
                    <p className="font-medium text-foreground">1. Build once</p>
                    <p>
                      Requires macOS 13+ and Xcode Command Line Tools. Before
                      rebuilding, choose{" "}
                      <strong>Quit Voice Memos Bridge</strong>{" "}
                      from the app menu.
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground"><code>{`cd ~/repo/mycelia
bash scripts/build-voice-memos-bridge.sh`}</code></pre>
                    <p className="font-medium text-foreground">
                      2. Launch anytime
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground"><code>{`cd ~/repo/mycelia
open 'build/voice-memos-bridge/Mycelia Voice Memos Bridge.app'`}</code></pre>
                    <p>
                      Or open the app in Finder:{" "}
                      <strong>
                        Mycelia folder → build → voice-memos-bridge → Mycelia
                        Voice Memos Bridge.app
                      </strong>. Rebuild after app changes.
                    </p>
                    <p className="font-medium text-foreground">
                      Install in Applications
                    </p>
                    <p>
                      Quit Bridge first, then copy it and open from
                      Applications:
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground"><code>{`cd ~/repo/mycelia
ditto 'build/voice-memos-bridge/Mycelia Voice Memos Bridge.app' '/Applications/Mycelia Voice Memos Bridge.app'
open '/Applications/Mycelia Voice Memos Bridge.app'`}</code></pre>
                    <p>
                      Keep the Mycelia repository in place; the app uses its
                      importer scripts. Copy again after rebuilding.
                    </p>
                    <p className="font-medium text-foreground">
                      3. Connect the importer
                    </p>
                    <p>
                      If the app says the importer is unavailable, use{" "}
                      <strong>Importer setup… → Copy command</strong>{" "}
                      and run that command in Terminal. Import requires uv,
                      ffmpeg/ffprobe and a running Mycelia backend.
                    </p>
                    <p>
                      For new recordings to import while Bridge stays open,
                      enable <strong>Automatic import</strong> in Bridge.
                    </p>
                  </div>
                </details>
              </DialogContent>
            </Dialog>
          </section>
          <section className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">Import from a folder</h3>
            <p className="text-sm text-muted-foreground">
              Uses the background daemon. No Mac app build required.
            </p>
            {folderContent}
          </section>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">Last import:</span>{" "}
            {time(data?.recentImports?.[0]?.importedAt)}
          </p>
          <p>
            <span className="text-muted-foreground">Last scan:</span>{" "}
            {time(host?.lastCycle?.finishedAt)}
          </p>
        </div>
        {(error || checkOld) && (
          <p role="alert" className="text-sm text-destructive">
            Status could not be refreshed. Open diagnostics to retry.
          </p>
        )}
        <details
          data-testid="audio-diagnostics"
          className="rounded-lg border p-3 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            Import diagnostics
          </summary>
          <div className="mt-3 space-y-4">
            <p className="text-xs text-muted-foreground">
              Background daemon: {status}
            </p>
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
                disabled={running || checking || !!error || !!checkOld ||
                  !!cycleOld || !host?.reachable || !!host.currentCycle ||
                  accessBlocked ||
                  (data?.queues.ingestion?.active ?? 0) > 0 ||
                  (data?.queues.ingestion?.waiting ?? 0) > 0 ||
                  (data?.queues.ingestion?.delayed ?? 0) > 0 ||
                  (data?.queues.ingestion?.paused ?? 0) > 0}
              >
                {running
                  ? "Queuing…"
                  : host?.appleVoiceMemosMode === "staged"
                  ? "Scan local copy"
                  : "Scan configured sources"}
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
                  Cached source errors: {count(
                    ingestion?.cached_errors ?? counts?.sourceFiles.errors,
                  )} · Blocked: {count(counts?.sourceFiles.blocked)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Cached errors require a targeted retry; they are excluded from
                  the normal scan.
                </p>
              </div>
              <div
                className="rounded-lg border p-4"
                data-testid="operations-vad"
              >
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
                No complete audio counts yet. “—” means unknown. Use Update
                audio counts to calculate them once.
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
                <dt className="text-muted-foreground">
                  Latest successful import
                </dt>
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
              (source.error || source.warning) &&
              !(source.source === "apple_voicememos" &&
                /operation not permitted|permission denied/i.test(
                  source.error ?? "",
                ))
            ).map((source) => (
              <p key={source.source} className="text-sm text-destructive">
                {source.source}: {source.error || source.warning}
              </p>
            ))}
          </div>
        </details>
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
      toast.success("Source scan queued. Follow its progress in Jobs.");
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
      folderContent={<FolderAudioImport host={query.data?.host} />}
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
