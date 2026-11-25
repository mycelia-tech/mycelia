import { RequestError } from "@/components/RequestError";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { callResource } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  Cog,
  Pause,
  Play,
  RefreshCw,
  Settings,
  XCircle,
} from "lucide-react";
import type { JobsDashboard, WorkerCatalogEntry } from "@/types/jobsDashboard";

interface WorkerStatus {
  paused: boolean;
}

const WorkersPage = () => {
  const [workers, setWorkers] = useState<WorkerCatalogEntry[]>([]);
  const [schemas, setSchemas] = useState<Record<string, any>>({});
  const [workerStatuses, setWorkerStatuses] = useState<
    Record<string, WorkerStatus>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<
    { message: string; workerType: string; wasPaused: boolean } | null
  >(null);
  const [actionStatus, setActionStatus] = useState("");
  const [togglingWorker, setTogglingWorker] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      if (workers.length === 0) setLoading(true);
      const dashboard = await callResource("jobs", {
        action: "get_jobs_dashboard",
      }) as JobsDashboard;
      setWorkers(dashboard.catalog.workers || []);
      setSchemas(dashboard.catalog.schemas || {});
      setWorkerStatuses(dashboard.runtime.workers || {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch workers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const toggleWorkerPause = async (
    workerType: string,
    currentlyPaused: boolean,
  ) => {
    if (togglingWorker) return;
    setTogglingWorker(workerType);
    setActionError(null);
    setActionStatus("");
    try {
      await callResource("jobs", {
        action: currentlyPaused ? "resume_worker" : "pause_worker",
        workerType,
      });
      setWorkerStatuses((prev) => ({
        ...prev,
        [workerType]: { ...prev[workerType], paused: !currentlyPaused },
      }));
      setActionStatus(
        `${workerType} ${currentlyPaused ? "resumed" : "paused"}.`,
      );
    } catch (err) {
      setActionError({
        message: err instanceof Error
          ? err.message
          : "Could not change worker state.",
        workerType,
        wasPaused: currentlyPaused,
      });
    } finally {
      setTogglingWorker(null);
    }
  };

  const getSchemaFieldCount = (schema: Record<string, unknown>): number => {
    const properties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    if (!properties) return 0;
    return Object.keys(properties).filter((key) => key !== "type").length;
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Workers</h2>
          <p className="text-muted-foreground">
            Configure background job workers and their default settings.
          </p>
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">Loading workers...</p>
        </div>
      </div>
    );
  }

  if (error && workers.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Workers</h2>
          <p className="text-muted-foreground">
            Configure background job workers and their default settings.
          </p>
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-red-500">Error: {error}</p>
          <Button variant="outline" className="mt-4" onClick={fetchData}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const discoveredWorkers = workers.filter((worker) =>
    worker.availability === "ready" ||
    worker.availability === "daemon-managed"
  );
  const unavailableWorkers = workers.filter((worker) =>
    worker.availability !== "ready" &&
    worker.availability !== "daemon-managed"
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Workers</h2>
          <p className="text-muted-foreground">
            Configure background job workers and their default settings.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-600"
        >
          Showing the last worker catalog snapshot. Refresh failed: {error}
        </div>
      )}

      {actionError && (
        <RequestError
          title="Worker state was not changed"
          message={actionError.message}
          onRetry={() => {
            void toggleWorkerPause(
              actionError.workerType,
              actionError.wasPaused,
            );
          }}
          pending={Boolean(togglingWorker)}
        />
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {actionStatus}
      </p>
      {/* Active Workers */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Cog className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Active Workers</h3>
          <Badge variant="secondary">{discoveredWorkers.length}</Badge>
        </div>

        {discoveredWorkers.length === 0
          ? (
            <Card className="p-6 text-center text-muted-foreground">
              No workers are currently active. Start the backend worker process
              to see available workers.
            </Card>
          )
          : (
            <div className="grid gap-2">
              {discoveredWorkers.map((worker) => {
                const status = workerStatuses[worker.type];
                const isPaused = status?.paused ?? false;
                const fieldCount = getSchemaFieldCount(
                  schemas[worker.type]?.input || {},
                );
                const isToggling = togglingWorker === worker.type;

                return (
                  <Card
                    key={worker.type}
                    className={`p-3.5 transition-colors ${
                      isPaused
                        ? "border-amber-500/50 bg-amber-500/5"
                        : "bg-card"
                    }`}
                  >
                    <div className="flex flex-col items-stretch gap-3 @2xl/settings:flex-row @2xl/settings:items-center @2xl/settings:justify-between">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {isPaused
                          ? (
                            <Pause className="w-5 h-5 text-amber-500 shrink-0" />
                          )
                          : (
                            <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                          )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="font-medium">{worker.label}</h4>
                            {isPaused && (
                              <Badge
                                variant="outline"
                                className="text-xs text-amber-600 border-amber-500/50"
                              >
                                Paused
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                            <span
                              className="basis-full break-words"
                              title={worker.description}
                            >
                              {worker.description}
                            </span>
                            <span>{fieldCount} configurable fields</span>
                            <Badge variant="outline" className="text-xs">
                              {worker.availability}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 self-end @2xl/settings:self-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            toggleWorkerPause(worker.type, isPaused)}
                          disabled={Boolean(togglingWorker) ||
                            !worker.capabilities.pause}
                          aria-label={`${
                            isPaused ? "Resume" : "Pause"
                          } ${worker.label}`}
                          title={isPaused ? "Resume worker" : "Pause worker"}
                        >
                          {isToggling
                            ? <RefreshCw className="w-4 h-4 animate-spin" />
                            : isPaused
                            ? <Play className="w-4 h-4" />
                            : <Pause className="w-4 h-4" />}
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/settings/workers/${worker.type}`}>
                            <Settings className="w-4 h-4 mr-2" />
                            Configure
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
      </div>

      {/* Unavailable Workers */}
      {unavailableWorkers.length > 0 && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <XCircle className="w-5 h-5 text-muted-foreground" />
              <h3 className="text-lg font-semibold text-muted-foreground">
                Previously Seen Workers
              </h3>
              <Badge variant="outline">{unavailableWorkers.length}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              These workers were registered but are not currently running.
            </p>
            <div className="grid gap-3">
              {unavailableWorkers.map((worker) => (
                <Card
                  key={worker.type}
                  className="p-3.5"
                >
                  <div className="flex flex-col items-stretch gap-3 @2xl/settings:flex-row @2xl/settings:items-center @2xl/settings:justify-between">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <XCircle className="w-5 h-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <h4 className="font-medium">{worker.label}</h4>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                          <span className="basis-full break-words" title={worker.description}>
                            {worker.description}
                          </span>
                          <span>{worker.availability}</span>
                        </div>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="self-end" asChild>
                      <Link to={`/settings/workers/${worker.type}`} aria-label={`Configure ${worker.label}`}>
                        <Settings className="size-4" />
                        Configure
                      </Link>
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WorkersPage;
