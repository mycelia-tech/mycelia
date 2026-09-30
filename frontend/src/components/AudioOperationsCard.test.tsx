import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  type AudioOperations,
  AudioOperationsView,
} from "./AudioOperationsCard";

function fixture(): AudioOperations {
  return {
    checkedAt: new Date(),
    host: {
      reachable: true,
      status: "degraded",
      automatic: true,
      appleVoiceMemosMode: "staged",
      lastCycle: {
        status: "degraded",
        finishedAt: new Date().toISOString(),
        ingestion: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          remaining: 0,
          cached_errors: 143,
        },
      },
      staging: {
        status: "available",
        published_at_utc: "2026-01-01T00:00:00Z",
        staged_audio_files: 22,
      },
    },
    recentImports: [],
    snapshot: null,
    queues: { ingestion: { available: true, active: 0, waiting: 0 } },
    warnings: [],
  };
}
function mount(data = fixture(), error?: string) {
  const actions = { onCheck: vi.fn(), onRun: vi.fn(), onCalculate: vi.fn() };
  render(
    <MemoryRouter>
      <AudioOperationsView
        data={data}
        checking={false}
        running={false}
        calculating={false}
        error={error}
        {...actions}
      />
    </MemoryRouter>,
  );
  return actions;
}

describe("Audio operations overview", () => {
  it("distinguishes a running degraded daemon from unknown audio counts and old staging", () => {
    const actions = mount();
    expect(screen.getByText("Running · needs attention")).toBeTruthy();
    expect(screen.getByText("Staging is more than 24 hours old")).toBeTruthy();
    expect(
      within(screen.getByTestId("operations-vad")).getAllByText("—").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Scan staging now" }));
    expect(actions.onRun).toHaveBeenCalledOnce();
    expect(actions.onCalculate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Update audio counts" }),
    );
    expect(actions.onCalculate).toHaveBeenCalledOnce();
  });
  it("does not label a failed refresh as live and disables a duplicate scan", () => {
    const data = fixture();
    data.queues.ingestion.active = 1;
    mount(data, "Network unavailable");
    expect(screen.getByText("Status is stale")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Scan staging now" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });
});
