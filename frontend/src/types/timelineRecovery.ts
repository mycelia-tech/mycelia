export type TimelineBookkeepingRepair = {
  checkedAt: string;
  terminalSequences: number;
  eligibleChunks: number;
  modifiedChunks: number;
  applied: boolean;
  durationMs: number;
  backfilled?: boolean;
  note: string;
};

export type TimelineIntegrityReport = {
  checkedAt: string | null;
  status: "not_checked" | "healthy" | "updating" | "needs_attention";
  countsUpdatedAt?: string | null;
  auditStale?: boolean;
  maintenance?: {
    state: "idle" | "updating" | "retrying" | "failed";
    pendingDays: number;
    lastCompletedAt: string | null;
    lastError: string | null;
    retryAt: string | null;
    oldestPendingAt: string | null;
  };
  sources: Array<{
    collection: "audio_chunks" | "transcriptions";
    label: string;
    documents: number;
    firstStart: string | null;
    lastStart: string | null;
    lastEnd: string | null;
    histogramDocuments: number;
    difference: number;
  }>;
  histograms: Array<{
    resolution: "5min" | "1hour" | "1day" | "1week";
    buckets: number;
    stale: number;
    firstStart: string | null;
    lastStart: string | null;
    totals: Record<"audio_chunks" | "transcriptions", number>;
  }>;
  repairPlan: {
    ranges: Array<{
      start: string;
      end: string;
      days: number;
      differences: Record<"audio_chunks" | "transcriptions", number>;
    }>;
    days: number;
  };
  bookkeeping: {
    checked: boolean;
    terminalSequences: number | null;
    eligibleChunks: number | null;
    modifiedChunks: number;
    applied: boolean;
  };
  lastBookkeepingRepair: null | Omit<TimelineBookkeepingRepair, "note">;
  campaign: null | {
    campaignId: string;
    workerType?: string;
    queue?: string;
    status:
      | "paused_legacy"
      | "paused"
      | "paused_error"
      | "queued"
      | "running"
      | "recovering"
      | "verifying"
      | "completed"
      | "completed_with_errors";
    plannedJobs: number;
    queuedJobs: number;
    missingJobs: number;
    active: number;
    waiting: number;
    delayed: number;
    completed: number;
    failed: number;
    cancelled: number;
    start: string | null;
    end: string | null;
    createdAt: string | null;
    finishedAt: string | null;
    failures: Array<{
      jobId?: string;
      batchIndex?: number;
      start: string | null;
      end: string | null;
      reason: string;
    }>;
    nextBatchIndex?: number | null;
    processedThrough?: string | null;
    activeJobId?: string | null;
    lastActivityAt?: string | null;
    blockingReason?: string | null;
    canResume?: boolean;
    canPause?: boolean;
    progress?: Record<string, unknown> | null;
    mode?: "affected_dates" | "selected_period" | "full";
    ranges?: Array<{ start: string; end: string }>;
  };
  issues: Array<{
    severity: "warning" | "error";
    code: string;
    message: string;
    action?: "repair_ranges" | "stale_only" | "resume_campaign";
    actionLabel?: string;
  }>;
  scope: {
    verifies: string[];
    note: string;
  };
  performance: {
    totalMs: number;
    stages: Record<string, number>;
    note?: string;
  };
  snapshot?: {
    state: "missing" | "ready" | "refreshing" | "stale" | "failed";
    asOf?: string;
    lastAttemptAt?: string;
    lastError?: string;
    operationId?: string;
  };
};
