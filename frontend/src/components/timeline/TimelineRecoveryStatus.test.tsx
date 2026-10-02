import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { TimelineIntegrityReport } from "@/types/timelineRecovery";
import { TimelineRecoveryStatus } from "./TimelineRecoveryStatus";

function reportFixture(): TimelineIntegrityReport {
  return {
    checkedAt: "2026-09-29T08:00:00.000Z",
    status: "healthy",
    countsUpdatedAt: "2026-09-30T09:00:00.000Z",
    auditStale: true,
    maintenance: {
      state: "idle",
      pendingDays: 0,
      lastCompletedAt: "2026-09-30T09:00:00.000Z",
      lastError: null,
      retryAt: null,
      oldestPendingAt: "2026-09-30T09:05:00.000Z",
    },
    sources: [],
    histograms: [],
    repairPlan: { ranges: [], days: 0 },
    bookkeeping: {
      checked: true,
      terminalSequences: 1,
      eligibleChunks: 0,
      modifiedChunks: 0,
      applied: false,
    },
    lastBookkeepingRepair: null,
    campaign: null,
    issues: [],
    scope: { verifies: [], note: "" },
    performance: { totalMs: 1, stages: {} },
    snapshot: { state: "ready" },
  };
}

function mount(report: TimelineIntegrityReport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["timeline-integrity-report"], report);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TimelineRecoveryStatus />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("TimelineRecoveryStatus", () => {
  it("hides a healthy timeline even when an older audit and repair history exist", () => {
    const report = reportFixture();
    report.lastBookkeepingRepair = {
      checkedAt: report.checkedAt!,
      terminalSequences: 58163,
      eligibleChunks: 16374,
      modifiedChunks: 16374,
      applied: true,
      durationMs: 10,
    };
    const { container } = mount(report);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not treat an unchecked timeline as incomplete", () => {
    const report = reportFixture();
    report.status = "not_checked";
    report.checkedAt = null;
    const { container } = mount(report);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a compact update notice and removes it when maintenance finishes", async () => {
    const report = reportFixture();
    report.status = "updating";
    report.maintenance!.state = "updating";
    report.maintenance!.pendingDays = 2;
    const { container, client } = mount(report);

    expect(screen.getByRole("status")).toHaveClass("border-blue-500/30");
    expect(screen.getByText("Timeline is updating.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Jobs" }))
      .toHaveAttribute("href", "/jobs#timeline-integrity");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Full check|Counts updated|2 day/)).toBeNull();

    await act(async () => {
      client.setQueryData(["timeline-integrity-report"], reportFixture());
    });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("keeps scheduled retries in the same compact update notice", () => {
    const report = reportFixture();
    report.maintenance!.pendingDays = 2;
    report.maintenance!.state = "retrying";
    report.maintenance!.retryAt = "2026-09-30T09:06:00.000Z";
    mount(report);

    expect(screen.getByText("Timeline is updating.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("border-blue-500/30");
    expect(screen.queryByText(/Next retry|needs attention/)).toBeNull();
  });

  it("keeps real issues visible during maintenance and leaves their details in Jobs", () => {
    const report = reportFixture();
    report.status = "needs_attention";
    report.maintenance!.state = "updating";
    report.maintenance!.pendingDays = 2;
    report.issues = [{
      severity: "error",
      code: "invalid_source_dates",
      message: "Some source records have invalid dates.",
    }];
    mount(report);

    expect(screen.getByText("Timeline needs attention.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("border-amber-500/30");
    expect(screen.queryByText(report.issues[0].message)).toBeNull();
    expect(screen.getByRole("link", { name: "Open Jobs" }))
      .toHaveAttribute("href", "/jobs#timeline-integrity");
  });

  it.each(
    [
      ["running", "Timeline is updating."],
      ["verifying", "Timeline recovery needs verification."],
    ] as const,
  )(
    "shows unfinished %s recovery without its detailed controls",
    (status, message) => {
      const report = reportFixture();
      report.campaign = {
        campaignId: "campaign-1",
        status,
        plannedJobs: 118,
        queuedJobs: 118,
        missingJobs: 0,
        active: 0,
        waiting: 0,
        delayed: 0,
        completed: 118,
        failed: 0,
        cancelled: 0,
        start: null,
        end: null,
        createdAt: null,
        finishedAt: null,
        failures: [],
      };
      mount(report);

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Jobs" }))
        .toHaveAttribute("href", "/jobs#timeline-integrity");
      expect(screen.queryByText(/118|batches/)).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});
