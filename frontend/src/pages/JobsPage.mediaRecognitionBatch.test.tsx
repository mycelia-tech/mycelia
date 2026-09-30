import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { JobInfo } from "@/types/jobs";
import { JobProgressCell } from "./JobsPage";

function batchJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "67b3297ec5a24d45ec005001",
    type: "mediaRecognitionBatch",
    data: { batchId: "67b3297ec5a24d45ec005002" },
    state: "active",
    progress: {
      stage: "processing",
      processed: 25,
      total: 100,
      percent: 25,
      pending: 59,
      queued: 12,
      processing: 4,
      ready: 24,
      failed: 1,
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("mediaRecognitionBatch Jobs progress", () => {
  it("shows discovered files without a percentage while folder totals are unknown", () => {
    render(
      <MemoryRouter>
        <JobProgressCell
          job={batchJob({
            type: "mediaFolderImport",
            progress: {
              stage: "inventory",
              totalKnown: false,
              processed: 21_042,
              total: 21_042,
              percent: 0,
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("21042 files discovered")).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
  });
  it("renders one accessible aggregate progress card", () => {
    render(
      <MemoryRouter>
        <JobProgressCell job={batchJob()} />
      </MemoryRouter>,
    );

    const progress = screen.getByRole("progressbar", {
      name: "Photo analysis batch progress",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
    expect(progress.getAttribute("aria-valuetext")).toBe(
      "25 of 100 photos complete",
    );
    expect(screen.getByText("25/100 photos complete")).toBeTruthy();
    expect(screen.getByText("pending 59")).toBeTruthy();
    expect(screen.getByText("queued 12")).toBeTruthy();
    expect(screen.getByText("processing 4")).toBeTruthy();
    expect(screen.getByText("failed 1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open photo analysis" })
        .getAttribute("href"),
    ).toBe("/media/analysis");
  });

  it("falls back to the stored terminal result", () => {
    render(
      <MemoryRouter>
        <JobProgressCell
          job={batchJob({
            state: "completed",
            progress: {},
            result: {
              counts: { total: 4, ready: 3, failed: 1 },
              progress: { stage: "completed" },
            },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("4/4 photos complete")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });
});
