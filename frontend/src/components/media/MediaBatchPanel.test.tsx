import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as userEventLib from "@testing-library/user-event";
import * as api from "@/lib/api";
import { MediaBatchPanel } from "./MediaBatchPanel";

const userEvent = (userEventLib as any).default || userEventLib;

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
const mockCallResource = vi.mocked(api.callResource);

const status = {
  enabled: true,
  activeProfileId: "google-cloud-media",
  profiles: [{
    id: "google-cloud-media",
    name: "Google Cloud EU Photo Knowledge",
    enabled: true,
    providerType: "google-cloud",
  }],
};

function renderPanel(onInventoryChanged = vi.fn()) {
  return {
    onInventoryChanged,
    ...render(
      <MemoryRouter>
        <MediaBatchPanel
          status={status}
          onInventoryChanged={onInventoryChanged}
        />
      </MemoryRouter>,
    ),
  };
}

describe("MediaBatchPanel mounted-folder sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
  });

  it("keeps available folders selectable and shows discovery without a false percentage", async () => {
    const user = userEvent.setup();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listMountedFolders") {
        return Promise.resolve({
          listing: {
            currentPath: ".",
            folders: [
              { name: "local-photos", relativePath: "local-photos" },
              {
                name: "external-photos",
                relativePath: "external-photos",
                unavailableReason: "Disk unavailable — reconnect and refresh",
              },
            ],
          },
        });
      }
      if (
        input.action === "getActiveFolderCampaign" ||
        input.action === "getFolderCampaign"
      ) {
        return Promise.resolve({
          campaign: {
            _id: "68a000000000000000000004",
            relativePath: "local-photos",
            status: "queued",
            counts: { total: 21_042 },
            progress: {
              stage: "inventory",
              processed: 21_042,
              total: 21_042,
              totalKnown: false,
              percent: 0,
              remaining: 0,
              currentPath: "local-photos/2026",
              message: "Discovering files and folders locally",
            },
          },
        });
      }
      return Promise.resolve({});
    });
    renderPanel();
    expect(await screen.findByText("21042 files discovered")).toBeTruthy();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.getByText(/Total and ETA available after discovery/))
      .toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Choose mounted folder" }),
    );
    expect(
      screen.getByRole("button", { name: /external-photos/ }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "local-photos" }).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
  });

  it("scans the mounted root by default and shows durable progress", async () => {
    const user = userEvent.setup();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listMountedFolders") {
        return Promise.resolve({
          listing: {
            currentPath: ".",
            folders: [{ name: "900-photos", relativePath: "900-photos" }],
          },
        });
      }
      if (input.action === "getActiveFolderCampaign") {
        return Promise.resolve({ campaign: null });
      }
      if (input.action === "startFolderScan") {
        return Promise.resolve({
          campaign: {
            _id: "68a000000000000000000003",
            relativePath: ".",
            status: "scanning",
            counts: {
              total: 904,
              pending: 775,
              processing: 1,
              ready: 24,
              unsupported: 103,
            },
            reusedHashCount: 24,
            progress: {
              stage: "metadata_scan",
              processed: 25,
              total: 801,
              remaining: 776,
              percent: 3.1,
              filesPerSecond: 1.6,
              etaSeconds: 485,
              chunkSize: 25,
              message:
                "Reading metadata and hashes locally; Google is not used",
              nextStep: "Review the report and confirm the local import",
              lastProgressAt: new Date().toISOString(),
            },
          },
        });
      }
      return Promise.resolve({});
    });
    renderPanel();

    expect(await screen.findByText("Folder sync")).toBeTruthy();
    expect(screen.getByText("Local import folder")).toBeTruthy();
    expect(screen.queryByText("Mounted folders")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Process all with Google Cloud/i }),
    ).toBeNull();
    await user.click(screen.getByRole("button", {
      name: "Scan selected folder recursively",
    }));

    expect(mockCallResource).toHaveBeenCalledWith("media-library", {
      action: "startFolderScan",
      relativePath: ".",
    });
    expect(await screen.findByText(/25 of 801 supported files checked/))
      .toBeTruthy();
    expect(screen.getByText(/about 9 min remaining/)).toBeTruthy();
    expect(screen.getByText(/pending 775/)).toBeTruthy();
    expect(screen.getByText(/ready 24/)).toBeTruthy();
    expect(screen.getByText(/reused SHA 24/)).toBeTruthy();
  });

  it("requires selecting a disk before scanning connected sources", async () => {
    const user = userEvent.setup();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listMountedFolders") {
        return Promise.resolve({
          listing: input.relativePath === "."
            ? {
              currentPath: ".",
              folders: [{ name: "Connected disks", relativePath: "disks" }],
            }
            : {
              currentPath: "disks",
              parentPath: ".",
              folders: [],
              scanUnavailableReason:
                "Choose a disk or a folder before scanning",
            },
        });
      }
      return Promise.resolve({ campaign: null });
    });
    renderPanel();
    await user.click(
      await screen.findByRole("button", { name: "Choose mounted folder" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Connected disks" }),
    );
    expect(await screen.findByText("Choose a disk or a folder before scanning"))
      .toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Scan selected folder recursively" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "startFolderScan"
      ),
    ).toBe(false);
  });

  it("chooses a visible mounted subfolder without typing a path", async () => {
    const user = userEvent.setup();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listMountedFolders") {
        return Promise.resolve({
          listing: input.relativePath === "."
            ? {
              currentPath: ".",
              folders: [{ name: "Trips", relativePath: "Trips" }],
            }
            : { currentPath: "Trips", parentPath: ".", folders: [] },
        });
      }
      if (input.action === "getActiveFolderCampaign") {
        return Promise.resolve({ campaign: null });
      }
      if (input.action === "startFolderScan") {
        return Promise.resolve({
          campaign: {
            _id: "68a000000000000000000004",
            relativePath: "Trips",
            status: "queued",
            counts: {},
          },
        });
      }
      return Promise.resolve({});
    });
    renderPanel();

    await user.click(
      await screen.findByRole("button", { name: "Choose mounted folder" }),
    );
    await user.click(await screen.findByRole("button", { name: "Trips" }));
    expect(screen.getByLabelText("Selected mounted folder").textContent)
      .toContain("Trips");
    await user.click(screen.getByRole("button", {
      name: "Scan selected folder recursively",
    }));

    expect(mockCallResource).toHaveBeenCalledWith("media-library", {
      action: "startFolderScan",
      relativePath: "Trips",
    });
  });

  it("refreshes inventory once for each campaign progress transition", async () => {
    const user = userEvent.setup();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listMountedFolders") {
        return Promise.resolve({
          listing: { currentPath: ".", folders: [] },
        });
      }
      if (input.action === "getActiveFolderCampaign") {
        return Promise.resolve({ campaign: null });
      }
      if (input.action === "startFolderScan") {
        return Promise.resolve({
          campaign: {
            _id: "campaign-1",
            relativePath: ".",
            status: "preview_ready",
            updatedAt: "2026-08-26T10:00:00.000Z",
            counts: { total: 2, pending: 2 },
          },
        });
      }
      if (input.action === "confirmFolderCampaign") {
        return Promise.resolve({
          campaign: {
            _id: "campaign-1",
            relativePath: ".",
            status: "importing",
            updatedAt: "2026-08-26T10:00:01.000Z",
            counts: { total: 2, imported: 1, pending: 1 },
          },
        });
      }
      return Promise.resolve({});
    });
    const onInventoryChanged = vi.fn();
    renderPanel(onInventoryChanged);

    await user.click(
      await screen.findByRole("button", {
        name: "Scan selected folder recursively",
      }),
    );
    await waitFor(() => expect(onInventoryChanged).toHaveBeenCalledTimes(1));
    await user.click(
      await screen.findByRole("button", { name: "Confirm local import" }),
    );

    await waitFor(() => expect(onInventoryChanged).toHaveBeenCalledTimes(2));
    expect(mockCallResource).toHaveBeenCalledWith("media-library", {
      action: "confirmFolderCampaign",
      campaignId: "campaign-1",
      confirm: true,
    });
  });
});
