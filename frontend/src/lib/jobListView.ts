export type JobsListView = "operational" | "idle_auto";
export type JobListStatus =
  | "active"
  | "waiting"
  | "delayed"
  | "completed"
  | "failed"
  | "cancelled";

const DEFAULT_JOB_STATUSES: JobListStatus[] = [
  "active",
  "waiting",
  "delayed",
  "completed",
  "failed",
  "cancelled",
];

const DEFAULT_INTERNAL_JOB_TYPES = new Set(["mediaRecognition"]);
export const DEFAULT_JOBS_LIST_LIMIT = 200;

const JOBS_REFRESH_QUIET_MS = 200;
const JOBS_REFRESH_MAX_WAIT_MS = 1_000;

interface JobsInvalidationClient {
  invalidateQueries(filters: {
    queryKey: readonly unknown[];
    exact?: boolean;
    refetchType?: "active" | "none";
  }): unknown;
}

interface PendingJobsRefresh {
  queryKeys: Map<string, readonly unknown[]>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

const pendingJobsRefreshes = new WeakMap<object, PendingJobsRefresh>();

function flushJobsQueryRefreshes(
  client: JobsInvalidationClient & object,
  pending: PendingJobsRefresh,
): void {
  if (pendingJobsRefreshes.get(client) !== pending) return;
  if (pending.quietTimer) clearTimeout(pending.quietTimer);
  if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
  pendingJobsRefreshes.delete(client);

  // Inactive views only need to be stale for their next mount. Refetch the
  // exact active views that subscribed to the event instead of fanning one
  // completion out across every cached Jobs filter.
  void client.invalidateQueries({
    queryKey: ["jobs"],
    refetchType: "none",
  });
  for (const queryKey of pending.queryKeys.values()) {
    void client.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: "active",
    });
  }
}

/**
 * Batch WebSocket-driven Jobs refreshes per QueryClient. A quiet window
 * collapses bursts and the deadline preserves membership correctness during
 * a continuous event stream.
 */
export function scheduleJobsQueryRefresh(
  client: JobsInvalidationClient & object,
  queryKey: readonly unknown[],
  timing: { quietMs?: number; maxWaitMs?: number } = {},
): void {
  const quietMs = timing.quietMs ?? JOBS_REFRESH_QUIET_MS;
  const maxWaitMs = timing.maxWaitMs ?? JOBS_REFRESH_MAX_WAIT_MS;
  let pending = pendingJobsRefreshes.get(client);
  if (!pending) {
    pending = {
      queryKeys: new Map(),
      quietTimer: null,
      deadlineTimer: null,
    };
    pendingJobsRefreshes.set(client, pending);
    pending.deadlineTimer = setTimeout(
      () => flushJobsQueryRefreshes(client, pending!),
      maxWaitMs,
    );
  }

  pending.queryKeys.set(JSON.stringify(queryKey), [...queryKey]);
  if (pending.quietTimer) clearTimeout(pending.quietTimer);
  pending.quietTimer = setTimeout(
    () => flushJobsQueryRefreshes(client, pending!),
    quietMs,
  );
}

/**
 * Individual photo-recognition jobs are implementation details of one durable
 * recognition batch. Keep their WebSocket traffic out of the default Jobs
 * views; an explicit type filter remains available for diagnostics.
 */
export function shouldIncludeJobEvent(
  jobType: string,
  selectedTypes?: string[],
): boolean {
  if (selectedTypes?.length) return selectedTypes.includes(jobType);
  return !DEFAULT_INTERNAL_JOB_TYPES.has(jobType);
}

export function buildJobsListRequest(
  view: JobsListView,
  types?: string[],
  options: {
    statuses?: JobListStatus[];
    limit?: number;
    providerProfileId?: string;
    campaignId?: string;
  } = {},
) {
  return {
    action: "list" as const,
    view,
    limit: options.limit ?? DEFAULT_JOBS_LIST_LIMIT,
    statuses: options.statuses ?? DEFAULT_JOB_STATUSES,
    ...(types?.length ? { types } : {}),
    ...(options.providerProfileId
      ? { providerProfileId: options.providerProfileId }
      : {}),
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  };
}

export function shouldRefreshJobsViews(eventName: string): boolean {
  return eventName === "job.active" || eventName === "job.started" ||
    eventName === "job.waiting" || eventName === "job.delayed" ||
    eventName === "job.completed" || eventName === "job.failed" ||
    eventName === "job.cancelled" || eventName === "job.state";
}

/**
 * WebSocket event names describe what changed, not necessarily a persisted
 * lifecycle state. In particular, `job.progress` must never turn an active
 * job into a synthetic `progress` state and make it disappear from filters.
 */
export function resolveJobEventState(
  eventName: string,
  payloadState: string | undefined,
  currentState: string,
): string {
  if (payloadState) return payloadState;
  switch (eventName) {
    case "job.started":
    case "job.active":
      return "active";
    case "job.waiting":
      return "waiting";
    case "job.delayed":
      return "delayed";
    case "job.completed":
      return "completed";
    case "job.failed":
      return "failed";
    case "job.cancelled":
      return "cancelled";
    default:
      return currentState;
  }
}

export function getJobsListView(searchParams: URLSearchParams): JobsListView {
  return searchParams.get("view") === "empty" ? "idle_auto" : "operational";
}

export function withJobsListView(
  searchParams: URLSearchParams,
  view: JobsListView,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("hideEmpty");
  if (view === "idle_auto") next.set("view", "empty");
  else next.delete("view");
  return next;
}
