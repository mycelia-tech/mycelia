import {
  findTimelineRepairRanges,
  type TimelineCountSource,
} from "@/lib/jobs/timeline-recovery.ts";
import type {
  DensityCounts,
  DensityReceipt,
  getTimelineDensityMaintenance,
} from "./density-maintenance.ts";

type DensityMaintenance = Awaited<
  ReturnType<typeof getTimelineDensityMaintenance>
>;
type DensityIssue = {
  severity: "warning" | "error";
  code: string;
  message: string;
  action?: "repair_ranges" | "stale_only" | "resume_campaign";
  actionLabel?: string;
};
type DensitySource = {
  collection: TimelineCountSource;
  label: string;
  documents: number;
  histogramDocuments: number;
  difference: number;
};
type DailyComparison = {
  start: string;
  raw: DensityCounts;
  histogram: DensityCounts;
};
type RepairPlan = {
  ranges: Array<{
    start: string;
    end: string;
    days: number;
    differences: DensityCounts;
  }>;
  days: number;
};

export type DensityIntegritySnapshot = {
  checkedAt: string | null;
  auditStartedAt?: string;
  status: string;
  dailyComparisons?: DailyComparison[];
  sources: DensitySource[];
  histograms: Array<{ stale: number }>;
  currentStaleBuckets?: { untracked: number; pending: number };
  repairPlan: RepairPlan;
  issues: DensityIssue[];
  campaign?: unknown;
  bookkeeping?: unknown;
  lastBookkeepingRepair?: unknown;
  scope?: unknown;
  performance?: unknown;
  snapshot?: unknown;
  countsUpdatedAt?: string | null;
  auditStale?: boolean;
};

type DensityIntegrityOverlay =
  & Omit<
    DensityIntegritySnapshot,
    "dailyComparisons" | "status"
  >
  & {
    status: "not_checked" | "healthy" | "updating" | "needs_attention";
    maintenance: DensityMaintenance;
    countsUpdatedAt: string | null;
    auditStale: boolean;
  };

function time(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function hasUnverifiedCampaignFailure(
  value: unknown,
  auditStart: number | null,
): boolean {
  if (!value || typeof value !== "object") return false;
  const campaign = value as Record<string, unknown>;
  const status = String(campaign.status ?? "");
  const failed = status === "completed_with_errors" ||
    status === "paused_error" ||
    status === "missing" ||
    Number(campaign.missingJobs ?? 0) > 0 &&
      !["queued", "running", "recovering"].includes(status);
  if (!failed) return false;
  const timestampFields = [
    "finishedAt",
    "failedAt",
    "lastFailedAt",
    "updatedAt",
    "lastActivityAt",
  ];
  const failures = Array.isArray(campaign.failures)
    ? campaign.failures.filter((failure) =>
      failure && typeof failure === "object"
    )
    : [];
  const timestamps = [campaign, ...failures].flatMap((entry) =>
    timestampFields.flatMap((field) => {
      const timestamp = time(entry[field]);
      return timestamp === null ? [] : [timestamp];
    })
  );
  // Creation time cannot prove when a destructive batch failed. Missing dates
  // require conservative handling; unrelated daily receipts are not a full check.
  return auditStart === null || timestamps.length === 0 ||
    Math.max(...timestamps) >= auditStart;
}

function emptyReport(): DensityIntegritySnapshot {
  return {
    checkedAt: null,
    status: "not_checked",
    sources: [],
    histograms: [],
    repairPlan: { ranges: [], days: 0 },
    bookkeeping: {
      checked: false,
      terminalSequences: null,
      eligibleChunks: null,
      modifiedChunks: 0,
      applied: false,
    },
    lastBookkeepingRepair: null,
    campaign: null,
    issues: [],
    scope: {
      verifies: [],
      note: "No persisted Timeline integrity snapshot exists yet.",
    },
    performance: { totalMs: 0, stages: {} },
  };
}

/** Apply bounded verification receipts without presenting an old full audit as new. */
export function overlayTimelineDensityIntegrity(
  report: DensityIntegritySnapshot | null | undefined,
  receipts: readonly Pick<DensityReceipt, "start" | "counts" | "verifiedAt">[],
  pendingDayIds: readonly string[],
  maintenance: DensityMaintenance,
  latestCampaign?: unknown,
): DensityIntegrityOverlay {
  const stored = report ?? emptyReport();
  const { dailyComparisons, ...publicReport } = stored;
  const checkedAt = time(stored.checkedAt);
  const auditStart = time(stored.auditStartedAt) ?? checkedAt;
  const campaign = latestCampaign === undefined
    ? stored.campaign
    : latestCampaign;
  const unverifiedCampaignFailure = hasUnverifiedCampaignFailure(
    campaign,
    auditStart,
  );
  const hasBaseline = checkedAt !== null && Array.isArray(dailyComparisons);
  const pending = new Set(pendingDayIds.flatMap((id) => {
    const timestamp = time(id);
    return timestamp === null ? [] : [new Date(timestamp).toISOString()];
  }));
  // These values are read separately. Either read can reveal new pending work.
  const pendingDays = Math.max(maintenance.pendingDays, pending.size);
  const liveMaintenance: DensityMaintenance = {
    ...maintenance,
    pendingDays,
    state: pendingDays > 0 && maintenance.state === "idle"
      ? "updating"
      : maintenance.state,
  };
  const hasPending = pendingDays > 0 ||
    liveMaintenance.state === "updating" ||
    liveMaintenance.state === "retrying";
  let countsTime = time(stored.countsUpdatedAt) ?? checkedAt;
  let newerReceipts = false;
  const latestReceipts = new Map<string, {
    counts: DensityCounts;
    verifiedAt: number;
  }>();
  for (const receipt of receipts) {
    const verifiedAt = time(receipt.verifiedAt);
    const day = time(receipt.start);
    if (
      auditStart === null || verifiedAt === null || day === null ||
      verifiedAt < auditStart
    ) continue;
    newerReceipts = true;
    const key = new Date(day).toISOString();
    // Receipts are written before the revision acknowledgement. A pending day
    // can still have a newer source mutation, so its receipt is not current.
    if (!hasBaseline || pending.has(key)) continue;
    const previous = latestReceipts.get(key);
    if (!previous || verifiedAt > previous.verifiedAt) {
      latestReceipts.set(key, { counts: receipt.counts, verifiedAt });
    }
  }

  let sources = stored.sources.map((source) => ({ ...source }));
  let repairPlan = stored.repairPlan;
  const issues = stored.issues.filter((issue) =>
    issue.code !== "timeline_rebuild_campaign_failed" &&
    issue.code !== "timeline_density_maintenance_failed" &&
    !(stored.currentStaleBuckets && issue.code === "stale_histogram_buckets") &&
    !(hasBaseline && issue.code.startsWith("histogram_count_"))
  ).map((issue) => ({ ...issue }));
  if (hasBaseline) {
    const days = new Map(dailyComparisons!.map((day) => [day.start, day]));
    for (const [start, receipt] of latestReceipts) {
      days.set(start, {
        start,
        raw: { ...receipt.counts },
        histogram: { ...receipt.counts },
      });
      countsTime = Math.max(
        countsTime ?? receipt.verifiedAt,
        receipt.verifiedAt,
      );
    }
    const comparisons = [...days.values()];
    sources = sources.map((source) => {
      const documents = comparisons.reduce(
        (sum, day) => sum + day.raw[source.collection],
        0,
      );
      const histogramDocuments = comparisons.reduce(
        (sum, day) => sum + day.histogram[source.collection],
        0,
      );
      const untracked = comparisons.filter((day) =>
        !pending.has(day.start) &&
        day.raw[source.collection] !== day.histogram[source.collection]
      );
      if (untracked.length > 0) {
        issues.push({
          severity: "error",
          code: `histogram_count_${source.collection}`,
          message:
            `${source.label}: Timeline density differs from raw documents on ${untracked.length} day(s).`,
          action: "repair_ranges",
          actionLabel: "Repair affected dates",
        });
      }
      return {
        ...source,
        documents,
        histogramDocuments,
        difference: histogramDocuments - documents,
      };
    });
    const ranges = findTimelineRepairRanges(
      comparisons.map((day) => ({
        start: new Date(day.start),
        counts: day.raw,
      })),
      comparisons.map((day) => ({
        start: new Date(day.start),
        counts: day.histogram,
      })),
    ).map((range) => ({
      ...range,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    }));
    repairPlan = {
      ranges,
      days: ranges.reduce((sum, range) => sum + range.days, 0),
    };
  } else {
    // A legacy aggregate cannot identify which day a receipt supersedes.
    // Pending work must not erase its unresolved mismatch.
    for (const source of sources) {
      const code = `histogram_count_${source.collection}`;
      if (
        source.difference !== 0 && !issues.some((issue) => issue.code === code)
      ) {
        issues.push({
          severity: "error",
          code,
          message:
            `${source.label}: The last full check found a density difference of ${source.difference}.`,
          action: "repair_ranges",
          actionLabel: "Repair affected dates",
        });
      }
    }
  }

  const staleBuckets = stored.currentStaleBuckets?.untracked ??
    stored.histograms.reduce(
      (sum, row) => sum + row.stale,
      0,
    );
  if (
    staleBuckets > 0 &&
    !issues.some((issue) => issue.code === "stale_histogram_buckets")
  ) {
    issues.push({
      severity: "warning",
      code: "stale_histogram_buckets",
      message: stored.currentStaleBuckets
        ? `${staleBuckets} histogram bucket(s) remain stale outside pending maintenance.`
        : `${staleBuckets} histogram bucket(s) were stale in the full check.`,
      action: "stale_only",
      actionLabel: "Update stale ranges",
    });
  }
  if (liveMaintenance.state === "failed") {
    issues.push({
      severity: "error",
      code: "timeline_density_maintenance_failed",
      message: liveMaintenance.lastError ??
        "Automatic Timeline density maintenance failed.",
    });
  }
  if (unverifiedCampaignFailure) {
    issues.push({
      severity: "error",
      code: "timeline_rebuild_campaign_failed",
      message:
        "A failed or incomplete manual rebuild needs a later full check before density can be marked current.",
      action: "resume_campaign",
      actionLabel: "Review rebuild recovery",
    });
  }
  const unexplainedLegacyFailure = !hasBaseline &&
    stored.status === "needs_attention" && stored.issues.length === 0;
  const status = issues.length > 0 || unexplainedLegacyFailure
    ? "needs_attention"
    : hasPending
    ? "updating"
    : checkedAt === null
    ? "not_checked"
    : "healthy";
  const completedAt = time(liveMaintenance.lastCompletedAt);
  return {
    ...publicReport,
    campaign,
    status,
    sources,
    repairPlan,
    issues,
    maintenance: liveMaintenance,
    countsUpdatedAt: countsTime === null
      ? null
      : new Date(countsTime).toISOString(),
    auditStale: stored.auditStale === true || checkedAt !== null &&
        (hasPending || newerReceipts || unverifiedCampaignFailure ||
          auditStart !== null && completedAt !== null &&
            completedAt > auditStart),
  };
}
