import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { callResource } from "@/lib/api";
import { MediaResultPanel } from "./MediaResultPanel";
vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));

describe("stored photo results", () => {
  it("reviews old Google results without inference or credential checks", async () => {
    vi.mocked(callResource).mockResolvedValue({
      run: {
        providerSnapshot: { name: "Old Google", providerType: "google-cloud" },
      },
      visual: { visualUnderstanding: { shortCaption: "Earlier description" } },
    });
    render(
      <MediaResultPanel
        detail={{
          asset: { _id: "111111111111111111111111", currentRunId: "new" },
          visual: {
            visualUnderstanding: { shortCaption: "Current description" },
          },
          runs: [{
            _id: "old",
            state: "ready",
            providerSnapshot: { name: "Old Google" },
          }],
        }}
      />,
    );
    expect(callResource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "View version" }));
    await screen.findByText("Earlier description");
    expect(callResource).toHaveBeenCalledExactlyOnceWith("media", {
      action: "getAnalysisRun",
      assetId: "111111111111111111111111",
      runId: "old",
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to current" }));
    expect(screen.getByText("Current description")).toBeInTheDocument();
  });
});
