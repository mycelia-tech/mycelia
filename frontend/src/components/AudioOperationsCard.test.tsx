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
  it("keeps diagnostics closed and runs a local-copy scan only when requested", () => {
    const actions = mount();
    expect(screen.getByText("Background daemon: Running · needs attention"))
      .toBeTruthy();
    expect(screen.getByTestId("audio-diagnostics")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Import diagnostics"));
    expect(
      within(screen.getByTestId("operations-vad")).getAllByText("—").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Scan local copy" }));
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
    expect(screen.getByText("Background daemon: Status is stale")).toBeTruthy();
    fireEvent.click(screen.getByText("Import diagnostics"));
    expect(
      screen.getByRole("button", { name: "Scan local copy" }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });

  it("guides blocked Voice Memos access through Bridge without queuing a broken scan", () => {
    const data = fixture();
    data.host.appleVoiceMemosMode = "live";
    data.host.lastCycle!.sources = [{
      source: "apple_voicememos",
      status: "failed",
      error: "Operation not permitted",
    }];
    const actions = mount(data);
    expect(screen.getByText("Separate Mac application")).toBeInTheDocument();
    expect(screen.getByText("Import from a folder")).toBeInTheDocument();
    expect(screen.queryByText("Operation not permitted")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Import Voice Memos…" }),
    );
    const guide = screen.getByRole("dialog");
    expect(within(guide).getByText("Open Mycelia Voice Memos Bridge"))
      .toBeInTheDocument();
    expect(within(guide).getByText("Scan library")).toBeInTheDocument();
    expect(within(guide).getByText("Import pending")).toBeInTheDocument();
    expect(actions.onRun).not.toHaveBeenCalled();
    fireEvent.click(within(guide).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByText("Import diagnostics"));
    expect(screen.getByRole("button", { name: "Scan configured sources" }))
      .toBeDisabled();
  });
});
