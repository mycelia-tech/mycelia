import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { callResource } from "@/lib/api";
import { FolderStreamControls } from "./FolderStreamControls";

const userEvent = (userEventLib as any).default || userEventLib;
vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
const request = vi.mocked(callResource);
const campaign = {
  _id: "68a000000000000000000003",
  relativePath: "archive",
  status: "scanning",
};
const status = {
  activeProfileId: "google",
  profiles: [{
    id: "google",
    name: "EU photos",
    enabled: true,
    providerType: "google-cloud",
  }],
};

describe("folder streaming controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("requires a cost preview and explicit total-ceiling confirmation before streaming", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    request.mockImplementation((_resource, input) =>
      Promise.resolve(
        input.action === "previewFolderStream"
          ? {
            previewId: "receipt",
            profileName: "EU photos",
            projectId: "project",
            location: "eu",
            authorizedGrossUsd: 50,
            allocatedGrossUsd: 0,
            perAssetGrossUsd: 0.0075,
            batchSize: 100,
            dailyGrossLimitUsd: 50,
            monthlyGrossLimitUsd: 300,
          }
          : { campaign: { ...campaign, streaming: { state: "running" } } },
      )
    );
    render(
      <FolderStreamControls
        campaign={campaign}
        status={status}
        onChange={onChange}
      />,
    );
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Import + Google" }));
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review cost" }));
    expect(request).toHaveBeenCalledWith("media-library", {
      action: "previewFolderStream",
      campaignId: campaign._id,
      profileId: "google",
      maxGrossUsd: 50,
      batchSize: 100,
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText(/covers future photos/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Confirm stream · max $50.00" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("media-library", {
      action: "confirmFolderStream",
      previewId: "receipt",
      consent: true,
    });
  });

  it("pause targets the stream, not local import or previously confirmed jobs", async () => {
    const user = userEvent.setup();
    request.mockResolvedValue({
      campaign: { ...campaign, streaming: { state: "paused" } },
    });
    render(
      <FolderStreamControls
        campaign={{
          ...campaign,
          streaming: {
            state: "running",
            allocatedGrossUsd: 1.5,
            authorizedGrossUsd: 50,
          },
        }}
        status={status}
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pause new batches" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("media-library", {
      action: "pauseFolderStream",
      campaignId: campaign._id,
      confirm: true,
    });
    expect(screen.getByText("$1.50 / $50.00 allocated")).toBeTruthy();
  });
});
