// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  buildJobsListRequest,
  getJobsListView,
  resolveJobEventState,
  scheduleJobsQueryRefresh,
  shouldIncludeJobEvent,
  shouldRefreshJobsViews,
  withJobsListView,
} from "./jobListView";

describe("jobs list views", () => {
  it("uses the operational view by default", () => {
    expect(getJobsListView(new URLSearchParams())).toBe("operational");
  });

  it("round-trips the Empty view through the URL", () => {
    const empty = withJobsListView(
      new URLSearchParams("type=transcription&hideEmpty=true"),
      "idle_auto",
    );
    expect(empty.toString()).toBe("type=transcription&view=empty");
    expect(getJobsListView(empty)).toBe("idle_auto");

    const operational = withJobsListView(empty, "operational");
    expect(operational.toString()).toBe("type=transcription");
    expect(getJobsListView(operational)).toBe("operational");
  });

  it("sends the selected server-side view with the jobs request", () => {
    expect(buildJobsListRequest("idle_auto", ["transcription"])).toMatchObject({
      action: "list",
      view: "idle_auto",
      limit: 200,
      types: ["transcription"],
    });
    expect(buildJobsListRequest("operational")).not.toHaveProperty("types");
  });

  it("refreshes lifecycle transitions but not progress-only events", () => {
    expect(shouldRefreshJobsViews("job.completed")).toBe(true);
    expect(shouldRefreshJobsViews("job.active")).toBe(true);
    expect(shouldRefreshJobsViews("job.state")).toBe(true);
    expect(shouldRefreshJobsViews("job.progress")).toBe(false);
    expect(shouldRefreshJobsViews("job.failed")).toBe(true);
  });

  it("supports a compact active-only request for the global status badge", () => {
    expect(buildJobsListRequest("operational", undefined, {
      statuses: ["active", "waiting", "delayed"],
      limit: 200,
    })).toMatchObject({
      statuses: ["active", "waiting", "delayed"],
      limit: 200,
    });
  });

  it("sends an indexed provider filter to the jobs resource", () => {
    expect(buildJobsListRequest("operational", ["diarization"], {
      providerProfileId: "gpu-legacy",
    })).toMatchObject({
      types: ["diarization"],
      providerProfileId: "gpu-legacy",
      limit: 200,
    });
  });

  it("sends a campaign filter for Timeline rebuild tracking", () => {
    expect(buildJobsListRequest("operational", ["histRecalculation"], {
      campaignId: "6a84b87878391add0d82e6aa",
    })).toMatchObject({
      types: ["histRecalculation"],
      campaignId: "6a84b87878391add0d82e6aa",
    });
  });

  it("does not turn progress events into a fake lifecycle state", () => {
    expect(resolveJobEventState("job.progress", undefined, "active")).toBe(
      "active",
    );
    expect(resolveJobEventState("job.started", undefined, "waiting")).toBe(
      "active",
    );
    expect(resolveJobEventState("job.completed", undefined, "active")).toBe(
      "completed",
    );
    expect(resolveJobEventState("job.progress", "active", "waiting")).toBe(
      "active",
    );
  });

  it("hides photo child events by default but keeps explicit diagnostics", () => {
    expect(shouldIncludeJobEvent("mediaRecognition")).toBe(false);
    expect(shouldIncludeJobEvent("mediaRecognitionBatch")).toBe(true);
    expect(
      shouldIncludeJobEvent("mediaRecognition", ["mediaRecognition"]),
    ).toBe(true);
    expect(
      shouldIncludeJobEvent("mediaRecognition", ["transcription"]),
    ).toBe(false);
  });

  it("coalesces lifecycle refreshes and targets only active exact views", () => {
    vi.useFakeTimers();
    try {
      const invalidateQueries = vi.fn();
      const client = { invalidateQueries };
      const operational = ["jobs", "operational", "all-types"];
      const idle = ["jobs", "idle_auto", "all-types"];

      scheduleJobsQueryRefresh(client, operational);
      scheduleJobsQueryRefresh(client, operational);
      scheduleJobsQueryRefresh(client, idle);

      vi.advanceTimersByTime(199);
      expect(invalidateQueries).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(invalidateQueries).toHaveBeenCalledTimes(3);
      expect(invalidateQueries).toHaveBeenNthCalledWith(1, {
        queryKey: ["jobs"],
        refetchType: "none",
      });
      expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
        queryKey: operational,
        exact: true,
        refetchType: "active",
      });
      expect(invalidateQueries).toHaveBeenNthCalledWith(3, {
        queryKey: idle,
        exact: true,
        refetchType: "active",
      });
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("flushes a continuous lifecycle stream within the maximum wait", () => {
    vi.useFakeTimers();
    try {
      const invalidateQueries = vi.fn();
      const client = { invalidateQueries };
      const queryKey = ["jobs", "operational"];

      scheduleJobsQueryRefresh(client, queryKey);
      for (let index = 0; index < 6; index++) {
        vi.advanceTimersByTime(150);
        scheduleJobsQueryRefresh(client, queryKey);
      }
      expect(invalidateQueries).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(invalidateQueries).toHaveBeenCalledTimes(2);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
