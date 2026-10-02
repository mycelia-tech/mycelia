import { expect } from "@std/expect";
import { overlayTimelineDensityIntegrity } from "./density-integrity.ts";
import type { DensityReceipt } from "./density-maintenance.ts";

const first = "2026-08-19T00:00:00.000Z";
const second = "2026-08-21T00:00:00.000Z";
const third = "2026-08-23T00:00:00.000Z";
const counts = (audio_chunks: number, transcriptions = 0) => ({
  audio_chunks,
  transcriptions,
});
const idle = {
  state: "idle" as const,
  pendingDays: 0,
  lastCompletedAt: null,
  oldestPendingAt: null,
  lastError: null,
  retryAt: null,
};
const issue = (code: string) => ({
  severity: "error" as const,
  code,
  message: code,
});
const baseline = () => ({
  checkedAt: "2026-09-01T00:01:00.000Z",
  auditStartedAt: "2026-09-01T00:00:00.000Z",
  status: "needs_attention",
  sources: [
    {
      collection: "audio_chunks" as const,
      label: "Audio",
      documents: 8,
      histogramDocuments: 8,
      difference: 0,
      firstStart: first,
    },
    {
      collection: "transcriptions" as const,
      label: "Transcriptions",
      documents: 0,
      histogramDocuments: 0,
      difference: 0,
    },
  ],
  histograms: [{
    resolution: "1day",
    stale: 0,
    totals: counts(8),
    firstStart: first,
  }],
  dailyComparisons: [
    { start: first, raw: counts(4), histogram: counts(2) },
    { start: second, raw: counts(4), histogram: counts(6) },
  ],
  repairPlan: { ranges: [], days: 0 },
  issues: [issue("timeline_rebuild_campaign_failed")],
  campaign: {
    status: "completed_with_errors",
    finishedAt: "2026-08-31T23:00:00.000Z",
  },
});
const receipt = (
  start: string,
  audio: number,
  verifiedAt = "2026-09-01T01:00:00.000Z",
): Pick<DensityReceipt, "start" | "counts" | "verifiedAt"> => ({
  start: new Date(start),
  counts: counts(audio),
  verifiedAt: new Date(verifiedAt),
});

Deno.test("density overlay keeps untracked mismatches visible while tracked days update", () => {
  const result = overlayTimelineDensityIntegrity(baseline(), [], [first], idle);
  expect(result.status).toBe("needs_attention");
  expect(result.sources[0].difference).toBe(0);
  expect(result.repairPlan.days).toBe(2);
  expect(result.issues.map((entry) => entry.code)).toEqual([
    "histogram_count_audio_chunks",
  ]);
  expect(result.maintenance.pendingDays).toBe(1);
  const pendingOnly = overlayTimelineDensityIntegrity(baseline(), [], [
    first,
    second,
  ], idle);
  expect(pendingOnly.status).toBe("updating");
  expect(pendingOnly.issues).toEqual([]);
  expect(pendingOnly.maintenance.state).toBe("updating");
});

Deno.test("density receipts clear only verified dates and preserve the full audit tables", () => {
  const report = baseline();
  const result = overlayTimelineDensityIntegrity(
    report,
    [
      receipt(first, 7),
      receipt(second, 4, "2026-08-31T23:59:59.000Z"),
      receipt(third, 3),
    ],
    [],
    idle,
  );
  expect(result.sources[0]).toMatchObject({
    documents: 14,
    histogramDocuments: 16,
    difference: 2,
    firstStart: first,
  });
  expect(result.repairPlan.ranges.map((range) => range.start)).toEqual([
    second,
  ]);
  expect(result.status).toBe("needs_attention");
  expect(result.countsUpdatedAt).toBe("2026-09-01T01:00:00.000Z");
  expect(result.auditStale).toBe(true);
  expect(result.histograms).toEqual(report.histograms);
  expect(result).not.toHaveProperty("dailyComparisons");
  expect(report.dailyComparisons[0].histogram.audio_chunks).toBe(2);
  const racing = overlayTimelineDensityIntegrity(report, [receipt(first, 7)], [
    first,
  ], idle);
  expect(racing.sources[0]).toMatchObject({
    documents: 8,
    histogramDocuments: 8,
  });
  expect(racing.status).toBe("needs_attention");
  const caughtUp = overlayTimelineDensityIntegrity(
    report,
    [receipt(first, 7), receipt(second, 4)],
    [],
    idle,
  );
  expect(caughtUp.status).toBe("healthy");
  expect(caughtUp.repairPlan.days).toBe(0);
  expect(caughtUp.campaign).toEqual(report.campaign);
});

Deno.test("legacy density audits retain unresolved mismatches despite pending work and receipts", () => {
  const { dailyComparisons: _baseline, ...legacy } = baseline();
  legacy.sources[0] = {
    ...legacy.sources[0],
    histogramDocuments: 5,
    difference: -3,
  };
  legacy.issues.push(issue("histogram_count_audio_chunks"));
  const result = overlayTimelineDensityIntegrity(legacy, [receipt(first, 7)], [
    first,
  ], idle);
  expect(result.status).toBe("needs_attention");
  expect(result.sources[0].difference).toBe(-3);
  expect(result.issues.map((entry) => entry.code)).toEqual([
    "histogram_count_audio_chunks",
  ]);
  expect(result.countsUpdatedAt).toBe(legacy.checkedAt);
});

Deno.test("verified density receipts preserve stale flags and other genuine errors", () => {
  const report = baseline();
  report.histograms[0].stale = 1;
  report.issues.push(issue("histogram_unreadable"));
  const result = overlayTimelineDensityIntegrity(
    report,
    [receipt(first, 4), receipt(second, 4)],
    [],
    idle,
  );
  expect(result.status).toBe("needs_attention");
  expect(result.issues.map((entry) => entry.code)).toEqual([
    "histogram_unreadable",
    "stale_histogram_buckets",
  ]);
  expect(result.repairPlan.days).toBe(0);
});

Deno.test("missing density audits expose pending and failed maintenance without claiming healthy", () => {
  const missing = overlayTimelineDensityIntegrity(null, [], [], idle);
  expect(missing.status).toBe("not_checked");
  expect(missing.bookkeeping).toMatchObject({ checked: false, applied: false });
  expect(missing.sources).toEqual([]);
  expect(missing.histograms).toEqual([]);
  expect(
    overlayTimelineDensityIntegrity(null, [receipt(first, 4)], [first], idle)
      .status,
  ).toBe("updating");
  const failed = overlayTimelineDensityIntegrity(null, [], [], {
    ...idle,
    state: "failed",
    lastError: "verification failed",
  });
  expect(failed.status).toBe("needs_attention");
  expect(failed.issues.map((entry) => entry.code)).toEqual([
    "timeline_density_maintenance_failed",
  ]);
});

Deno.test("a manual campaign failure after the audit stays visible until a later exact check", () => {
  const report = baseline();
  report.status = "healthy";
  report.issues = [];
  report.dailyComparisons = report.dailyComparisons.map((day) => ({
    ...day,
    histogram: { ...day.raw },
  }));
  const failedCampaign = {
    status: "paused_error",
    finishedAt: "2026-09-01T01:00:00.000Z",
    lastActivityAt: "2026-09-01T01:05:00.000Z",
  };
  const failed = overlayTimelineDensityIntegrity(
    report,
    [receipt(third, 3, "2026-09-01T02:00:00.000Z")],
    [],
    idle,
    failedCampaign,
  );
  expect(failed.status).toBe("needs_attention");
  expect(failed.issues).toMatchObject([{
    code: "timeline_rebuild_campaign_failed",
    action: "resume_campaign",
  }]);
  expect(failed.auditStale).toBe(true);
  expect(failed.campaign).toEqual(failedCampaign);

  const rechecked = overlayTimelineDensityIntegrity(
    {
      ...report,
      auditStartedAt: "2026-09-01T03:00:00.000Z",
      checkedAt: "2026-09-01T03:01:00.000Z",
    },
    [],
    [],
    idle,
    failedCampaign,
  );
  expect(rechecked.status).toBe("healthy");
  expect(rechecked.issues).toEqual([]);
  expect(rechecked.auditStale).toBe(false);
});

Deno.test("campaign failures without dated verification stay conservative while expected continuations remain normal", () => {
  const report = baseline();
  report.status = "healthy";
  report.issues = [];
  report.dailyComparisons = [];
  for (
    const campaign of [
      { status: "completed_with_errors" },
      { status: "paused", missingJobs: 1 },
      { status: "paused_error", lastActivityAt: "2026-09-02T00:00:00.000Z" },
    ]
  ) {
    expect(
      overlayTimelineDensityIntegrity(report, [], [], idle, campaign).status,
    )
      .toBe("needs_attention");
  }
  const missingAudit = overlayTimelineDensityIntegrity(null, [], [], idle, {
    status: "completed_with_errors",
    finishedAt: "2026-08-31T23:00:00.000Z",
  });
  expect(missingAudit.status).toBe("needs_attention");
  expect(missingAudit.issues[0].code).toBe("timeline_rebuild_campaign_failed");
  for (const status of ["queued", "running", "recovering"]) {
    expect(
      overlayTimelineDensityIntegrity(report, [], [], idle, {
        status,
        missingJobs: 2,
      }).issues,
    ).toEqual([]);
  }
});

Deno.test("current stale evidence clears only warnings covered by completed or pending maintenance", () => {
  const report = baseline();
  report.histograms[0].stale = 3;
  report.issues.push(issue("stale_histogram_buckets"));
  const verified = [receipt(first, 4), receipt(second, 4)];
  const refreshed = overlayTimelineDensityIntegrity(
    {
      ...report,
      currentStaleBuckets: { untracked: 0, pending: 0 },
    },
    verified,
    [],
    idle,
  );
  expect(refreshed.status).toBe("healthy");
  expect(refreshed.issues).toEqual([]);
  expect(refreshed.histograms).toEqual(report.histograms);
  const untracked = overlayTimelineDensityIntegrity(
    {
      ...report,
      currentStaleBuckets: { untracked: 1, pending: 2 },
    },
    verified,
    [first, second],
    idle,
  );
  expect(untracked.status).toBe("needs_attention");
  expect(untracked.issues.map((entry) => entry.code)).toEqual([
    "stale_histogram_buckets",
  ]);
  const pendingOnly = overlayTimelineDensityIntegrity(
    {
      ...report,
      currentStaleBuckets: { untracked: 0, pending: 2 },
    },
    verified,
    [first, second],
    idle,
  );
  expect(pendingOnly.status).toBe("updating");
  expect(pendingOnly.issues).toEqual([]);
  expect(overlayTimelineDensityIntegrity(report, verified, [], idle).status)
    .toBe("needs_attention");
});
