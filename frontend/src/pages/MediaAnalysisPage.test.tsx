import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import * as userEventLib from "@testing-library/user-event";
import * as api from "@/lib/api";
import MediaAnalysisPage from "./MediaAnalysisPage";

const userEvent = (userEventLib as any).default || userEventLib;
const settings = vi.hoisted(() => ({ defaultTimeZone: "UTC" }));

vi.mock("@/lib/api", () => ({
  callResource: vi.fn(),
}));
vi.mock("@/components/media/AuthenticatedMediaImage", () => ({
  AuthenticatedMediaImage: (props: any) => <img {...props} />,
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: (selector: (state: typeof settings) => unknown) =>
    selector(settings),
}));

const mockCallResource = vi.mocked(api.callResource);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const status = {
  enabled: true,
  activeProfileId: "google-media",
  profiles: [{
    id: "google-media",
    name: "Google EU Photo Knowledge",
    providerType: "google-cloud",
    enabled: true,
  }],
};

const stagedAssets = [{
  _id: "111111111111111111111111",
  fileName: "first.jpg",
  status: "staged",
  thumbnailUrl: "/thumb/first",
  preview: { fileId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
  storageMode: "external_reference",
  source: { relativePath: "900-photos/first.jpg" },
  inventory: {},
}, {
  _id: "222222222222222222222222",
  fileName: "second.jpg",
  status: "staged",
  thumbnailUrl: "/thumb/second",
  preview: { fileId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
  storageMode: "external_reference",
  source: { relativePath: "900-photos/second.jpg" },
  inventory: {},
}];

const hundredStagedAssets = Array.from({ length: 100 }, (_, index) => ({
  _id: (index + 1).toString(16).padStart(24, "0"),
  fileName: `photo-${String(index + 1).padStart(3, "0")}.jpg`,
  status: "staged",
  thumbnailUrl: `/thumb/photo-${index + 1}`,
  preview: { fileId: (index + 101).toString(16).padStart(24, "0") },
  storageMode: "external_reference",
  source: { relativePath: `900-photos/photo-${index + 1}.jpg` },
  inventory: {},
}));

function renderPage(initialEntry = "/media/analysis") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MediaAnalysisPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="analysis-location">{location.search}</div>;
}

function baseResponse(resource: string, input: any) {
  if (resource === "media" && input.action === "photoSettings") {
    return Promise.resolve(status);
  }
  if (resource === "media-library" && input.action === "summary") {
    return Promise.resolve({
      all: 801,
      ready: 12,
      needsAttention: 2,
      missingTime: 4,
      missingLocation: 5,
    });
  }
  if (
    resource === "media-library" &&
    input.action === "listRecognitionBatches"
  ) {
    return Promise.resolve({ batches: [] });
  }
  return undefined;
}

describe("MediaAnalysisPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.defaultTimeZone = "UTC";
  });

  it("opens an explicit library handoff in the sortable table", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 2, assets: stagedAssets });
      }
      return Promise.resolve({});
    });
    const ids = stagedAssets.map((asset) => asset._id).join(",");
    renderPage(`/media/analysis?view=table&assetIds=${ids}`);

    expect(await screen.findByRole("table")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());
    expect(mockCallResource).toHaveBeenCalledWith(
      "media",
      expect.objectContaining({
        action: "listAssets",
        sortBy: "capturedAt",
        sortDirection: "desc",
      }),
      expect.any(Object),
    );
  });

  it("requires explicit reanalysis for ready photos and shows unknown external cost", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "media" && input.action === "photoSettings") {
        return Promise.resolve({
          enabled: true,
          activeProfileId: "local",
          profiles: [{
            id: "local",
            name: "Local vision",
            providerType: "openai-compatible",
            enabled: true,
          }],
        });
      }
      const base = baseResponse(resource, input);
      if (base) return base;
      if (input.action === "listAssets") {
        return Promise.resolve({
          total: 1,
          assets: [{
            ...stagedAssets[0],
            status: "failed",
            currentRunId: "old-success",
          }],
        });
      }
      if (input.action === "previewRecognitionBatch") {
        return Promise.resolve({
          previewId: "333333333333333333333333",
          eligibleCount: 1,
          costKnown: false,
          authorizedGrossUsd: 0,
          profile: {
            endpoint: "http://local.test/v1",
            model: "vision-test",
            maxOutputTokens: 1600,
            language: "Russian",
          },
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage("/media/analysis?status=ready");
    const photo = await screen.findByRole("checkbox", {
      name: "Select first.jpg",
    });
    expect(photo).toBeDisabled();
    expect(screen.getByRole("link", { name: "Photo analysis settings" }))
      .toHaveAttribute("href", "/settings/photo-analysis");
    await user.click(
      screen.getByRole("checkbox", { name: "Reanalyze ready photos" }),
    );
    await waitFor(() => expect(photo).toBeEnabled());
    await user.click(photo);
    await user.click(
      screen.getByRole("button", { name: "Review analysis batch (1)" }),
    );
    await screen.findByText(/cost unknown/);
    expect(screen.getByText(/no monetary ceiling enforced/))
      .toBeInTheDocument();
    expect(screen.getByText(/http:\/\/local.test\/v1.*vision-test.*1600/))
      .toBeInTheDocument();
    expect(mockCallResource).toHaveBeenCalledWith(
      "media-library",
      expect.objectContaining({
        action: "previewRecognitionBatch",
        selection: expect.objectContaining({
          reanalyze: true,
          inventoryFilter: "ready",
        }),
      }),
    );
    expect(screen.queryByText(/maximum \$0.00/)).not.toBeInTheDocument();
  });

  it("does not let a stale filter response replace the newest result", async () => {
    const allResponse = deferred<any>();
    const readyResponse = deferred<any>();
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return input.inventoryFilter === "ready"
          ? readyResponse.promise
          : allResponse.promise;
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(mockCallResource).toHaveBeenCalledWith(
        "media",
        expect.objectContaining({
          action: "listAssets",
          inventoryFilter: "all",
        }),
        expect.any(Object),
      )
    );
    await user.selectOptions(screen.getByLabelText("Status"), "ready");
    await waitFor(() =>
      expect(mockCallResource).toHaveBeenCalledWith(
        "media",
        expect.objectContaining({
          action: "listAssets",
          inventoryFilter: "ready",
        }),
        expect.any(Object),
      )
    );

    readyResponse.resolve({
      total: 1,
      assets: [{
        _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
        fileName: "ready-new.jpg",
        status: "ready",
        inventory: { shortCaption: "Newest response" },
      }],
    });
    expect(await screen.findByText("ready-new.jpg")).toBeTruthy();

    allResponse.resolve({
      total: 1,
      assets: [{
        _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
        fileName: "stale-old.jpg",
        status: "staged",
      }],
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(screen.queryByText("stale-old.jpg")).toBeNull();
    expect(screen.getByText("ready-new.jpg")).toBeTruthy();
  });

  it("does not allow stale selection while a changed filter is loading or failed", async () => {
    const readyResponse = deferred<any>();
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return input.inventoryFilter === "ready"
          ? readyResponse.promise
          : Promise.resolve({ total: 2, assets: stagedAssets });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();

    expect(
      (await screen.findByRole("button", {
        name: "Select loaded (2)",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.selectOptions(screen.getByLabelText("Status"), "ready");

    await waitFor(() => {
      expect(screen.queryByText("first.jpg")).toBeNull();
      expect(
        (screen.getByRole("button", {
          name: "Select loaded (0)",
        }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", {
          name: "Select all matching for review",
        }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    readyResponse.reject(new Error("Filtered inventory failed"));
    expect(await screen.findByText("Filtered inventory failed")).toBeTruthy();
    expect(
      (screen.getByRole("button", {
        name: "Select all matching for review",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Review analysis batch (0)",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("applies capture-date boundaries in the configured timezone", async () => {
    settings.defaultTimeZone = "Asia/Yerevan";
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 2, assets: stagedAssets });
      }
      return Promise.resolve({});
    });

    renderPage(
      "/media/analysis?status=unprocessed&from=2026-08-26&to=2026-08-26",
    );

    await screen.findByText("first.jpg");
    expect(mockCallResource).toHaveBeenCalledWith(
      "media",
      expect.objectContaining({
        action: "listAssets",
        capturedFrom: "2026-08-25T20:00:00.000Z",
        capturedTo: "2026-08-26T19:59:59.999Z",
      }),
      expect.any(Object),
    );
  });

  it("turns every date-filtered unprocessed match into one durable preview and confirmation", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return input.inventoryFilter === "unprocessed"
          ? Promise.resolve({ total: 196, assets: hundredStagedAssets })
          : Promise.resolve({
            total: 1,
            assets: [{ ...stagedAssets[0], status: "ready" }],
          });
      }
      if (
        resource === "media-library" &&
        input.action === "previewRecognitionBatch"
      ) {
        return Promise.resolve({
          previewId: "333333333333333333333333",
          eligibleCount: 190,
          missingOriginalCount: 6,
          authorizedGrossUsd: 1.43,
        });
      }
      if (
        resource === "media-library" &&
        input.action === "confirmRecognitionBatch"
      ) {
        return Promise.resolve({
          batch: {
            _id: "444444444444444444444444",
            status: "queued",
            profileName: "Google EU Photo Knowledge",
            requestedTasks: ["visual-understanding", "ocr"],
            counts: { total: 190, pending: 190 },
          },
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage(
      "/media/analysis?status=ready&placement=missing_location&from=2020-01-01&to=2023-12-31",
    );

    await screen.findByText("first.jpg");
    expect(screen.getByText("Captured from / to")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "About selecting all matching photos",
      }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Select all matching for review" }),
    );
    expect(await screen.findByText("196 selected")).toBeTruthy();
    expect(screen.getByText("Showing 100 of 196 matching photo(s)"))
      .toBeTruthy();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe(
      "unprocessed",
    );
    expect(
      mockCallResource.mock.calls.some(([resource, input]) =>
        resource === "media" && input.action === "listAssets" &&
        input.inventoryFilter === "unprocessed" &&
        input.capturedFrom === "2020-01-01T00:00:00.000Z" &&
        input.capturedTo === "2023-12-31T23:59:59.999Z"
      ),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Review analysis batch (196)" }),
    );

    await waitFor(() => {
      const previewCalls = mockCallResource.mock.calls.filter(([, input]) =>
        input.action === "previewRecognitionBatch"
      );
      expect(previewCalls).toHaveLength(1);
      expect(previewCalls[0]).toEqual([
        "media-library",
        {
          action: "previewRecognitionBatch",
          profileId: "google-media",
          requestedTasks: ["visual-understanding", "ocr"],
          selection: {
            mode: "all_matching",
            inventoryFilter: "unprocessed",
            placement: "missing_location",
            capturedFrom: "2020-01-01T00:00:00.000Z",
            capturedTo: "2023-12-31T23:59:59.999Z",
          },
        },
      ]);
    });

    await user.click(
      await screen.findByRole("button", { name: "Confirm exact batch" }),
    );
    await waitFor(() => {
      const confirmCalls = mockCallResource.mock.calls.filter(([, input]) =>
        input.action === "confirmRecognitionBatch"
      );
      expect(confirmCalls).toEqual([[
        "media-library",
        {
          action: "confirmRecognitionBatch",
          previewId: "333333333333333333333333",
          consent: true,
        },
      ]]);
    });
    expect(
      mockCallResource.mock.calls.some(([, input]) => input.action === "retry"),
    ).toBe(false);
  });

  it("excludes preview-deleted records from the loaded batch selection", async () => {
    const previewDeleted = {
      ...stagedAssets[0],
      preview: undefined,
    };
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({
          total: 2,
          assets: [previewDeleted, stagedAssets[1]],
        });
      }
      if (
        resource === "media-library" &&
        input.action === "previewRecognitionBatch"
      ) {
        return Promise.resolve({
          previewId: "333333333333333333333333",
          eligibleCount: 1,
          authorizedGrossUsd: 0.01,
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();

    const previewDeletedCheckbox = await screen.findByRole("checkbox", {
      name: "Select first.jpg",
    });
    expect((previewDeletedCheckbox as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("checkbox", {
        name: "Select second.jpg",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Select loaded (1)" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Review analysis batch (1)" }),
    );

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith(
        "media-library",
        expect.objectContaining({
          action: "previewRecognitionBatch",
          selection: expect.objectContaining({
            mode: "explicit",
            assetIds: ["222222222222222222222222"],
          }),
        }),
      );
    });
  });

  it.each(["filter", "selection", "profile"] as const)(
    "discards a late exact preview after the %s changes",
    async (changedScope) => {
      const previewResponse = deferred<any>();
      const statusWithAlternateProfile = {
        ...status,
        profiles: [
          ...status.profiles,
          {
            id: "self-media",
            name: "Local Photo Knowledge",
            providerType: "self-hosted",
            enabled: true,
          },
        ],
      };
      mockCallResource.mockImplementation((resource, input) => {
        if (resource === "media" && input.action === "photoSettings") {
          return Promise.resolve(statusWithAlternateProfile);
        }
        const base = baseResponse(resource, input);
        if (base) return base;
        if (resource === "media" && input.action === "listAssets") {
          return Promise.resolve({
            total: 2,
            assets: input.inventoryFilter === "ready"
              ? stagedAssets.map((asset) => ({ ...asset, status: "ready" }))
              : stagedAssets,
          });
        }
        if (
          resource === "media-library" &&
          input.action === "previewRecognitionBatch"
        ) {
          return previewResponse.promise;
        }
        return Promise.resolve({});
      });
      const user = userEvent.setup();
      renderPage("/media/analysis?status=unprocessed");

      await user.click(
        await screen.findByRole("button", { name: "Select loaded (2)" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Review analysis batch (2)" }),
      );
      await waitFor(() => {
        expect(
          mockCallResource.mock.calls.filter(([, input]) =>
            input.action === "previewRecognitionBatch"
          ),
        ).toHaveLength(1);
      });

      if (changedScope === "filter") {
        await user.selectOptions(screen.getByLabelText("Status"), "ready");
        await waitFor(() =>
          expect(
            (screen.getByLabelText("Status") as HTMLSelectElement).value,
          ).toBe("ready")
        );
      } else if (changedScope === "selection") {
        await user.click(
          screen.getByRole("checkbox", { name: "Select first.jpg" }),
        );
        expect(
          screen.getByRole("button", {
            name: "Review analysis batch (1)",
          }),
        ).toBeTruthy();
      } else {
        await user.selectOptions(
          screen.getByLabelText("Analysis provider"),
          "self-media",
        );
        expect(
          (screen.getByLabelText("Analysis provider") as HTMLSelectElement)
            .value,
        ).toBe("self-media");
      }

      await act(async () => {
        previewResponse.resolve({
          previewId: "333333333333333333333333",
          eligibleCount: 2,
          authorizedGrossUsd: 0.02,
        });
        await previewResponse.promise;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      });

      expect(screen.queryByText("Exact provider preview")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Confirm exact batch" }),
      ).toBeNull();
      expect(
        mockCallResource.mock.calls.some(([, input]) =>
          input.action === "confirmRecognitionBatch"
        ),
      ).toBe(false);
    },
  );

  it("keeps filters and a new selection available while another batch runs", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (
        resource === "media-library" &&
        input.action === "listRecognitionBatches"
      ) {
        return Promise.resolve({
          batches: [{
            _id: "555555555555555555555555",
            status: "running",
            profileName: "Google EU Photo Knowledge",
            requestedTasks: ["visual-understanding", "ocr"],
            counts: { total: 300, ready: 120, processing: 8, pending: 172 },
          }],
        });
      }
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 2, assets: stagedAssets });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Batch running")).toBeTruthy();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).disabled)
      .toBe(
        false,
      );
    expect(
      (screen.getByLabelText("Search imported photos") as HTMLInputElement)
        .disabled,
    ).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Select loaded (2)" }),
    );
    expect(
      (screen.getByRole("button", {
        name: "Review analysis batch (2)",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", {
        name: "Open first.jpg",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("can select one processable photo from a deep-linked detail sheet", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 0, assets: [] });
      }
      if (resource === "media" && input.action === "getAsset") {
        return Promise.resolve({
          asset: stagedAssets[0],
          pages: [],
          runs: [],
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage("/media/analysis?assetId=111111111111111111111111");

    await user.click(
      await screen.findByRole("button", { name: "Select this photo" }),
    );

    expect(
      screen.getByRole("button", { name: "Review analysis batch (1)" }),
    ).toBeTruthy();
  });

  it("preselects exactly one eligible deep-linked photo without preparing a preview", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 2, assets: stagedAssets });
      }
      if (resource === "media" && input.action === "getAsset") {
        return Promise.resolve({
          asset: stagedAssets[0],
          pages: [],
          runs: [],
        });
      }
      if (
        resource === "media-library" &&
        input.action === "previewRecognitionBatch"
      ) {
        return Promise.resolve({
          previewId: "333333333333333333333333",
          eligibleCount: 1,
          authorizedGrossUsd: 0.01,
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage(
      "/media/analysis?assetId=111111111111111111111111&select=1",
    );

    expect(
      await screen.findByText("Ready to review one photo"),
    ).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(
      mockCallResource.mock.calls.filter(([, input]) =>
        input.action === "previewRecognitionBatch"
      ),
    ).toHaveLength(0);

    await user.click(
      screen.getByRole("button", {
        name: "Continue to Review analysis batch (1)",
      }),
    );
    const reviewButton = await screen.findByRole("button", {
      name: "Review analysis batch (1)",
    });
    await waitFor(() => expect(document.activeElement).toBe(reviewButton));
    expect(screen.getByTestId("analysis-location").textContent).toBe("");
    await user.click(reviewButton);

    await waitFor(() => {
      const previewCalls = mockCallResource.mock.calls.filter(([, input]) =>
        input.action === "previewRecognitionBatch"
      );
      expect(previewCalls).toEqual([[
        "media-library",
        expect.objectContaining({
          action: "previewRecognitionBatch",
          selection: expect.objectContaining({
            mode: "explicit",
            assetIds: ["111111111111111111111111"],
          }),
        }),
      ]]);
    });
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "confirmRecognitionBatch"
      ),
    ).toBe(false);
  });

  it("does not preselect a deep-linked photo whose sanitized preview was deleted", async () => {
    const previewDeleted = {
      ...stagedAssets[0],
      preview: undefined,
    };
    mockCallResource.mockImplementation((resource, input) => {
      const base = baseResponse(resource, input);
      if (base) return base;
      if (resource === "media" && input.action === "listAssets") {
        return Promise.resolve({ total: 1, assets: [previewDeleted] });
      }
      if (resource === "media" && input.action === "getAsset") {
        return Promise.resolve({ asset: previewDeleted, pages: [], runs: [] });
      }
      return Promise.resolve({});
    });
    renderPage(
      "/media/analysis?assetId=111111111111111111111111&select=1",
    );

    expect(await screen.findByText("Photo preview is unavailable"))
      .toBeTruthy();
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue to Review analysis batch (1)",
      }),
    ).toBeNull();
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "previewRecognitionBatch" ||
        input.action === "confirmRecognitionBatch"
      ),
    ).toBe(false);
  });

  it.each([
    {
      status: "ready",
      title: "Photo analysis is already ready",
    },
    {
      status: "source_missing",
      title: "Original photo is unavailable",
    },
  ])(
    "does not preselect a $status deep-linked photo",
    async ({ status: assetStatus, title }) => {
      const asset = {
        ...stagedAssets[0],
        status: assetStatus,
        safeError: assetStatus === "source_missing"
          ? "The original photo is not available at its mounted reference"
          : undefined,
      };
      mockCallResource.mockImplementation((resource, input) => {
        const base = baseResponse(resource, input);
        if (base) return base;
        if (resource === "media" && input.action === "listAssets") {
          return Promise.resolve({ total: 1, assets: [asset] });
        }
        if (resource === "media" && input.action === "getAsset") {
          return Promise.resolve({ asset, pages: [], runs: [] });
        }
        return Promise.resolve({});
      });
      renderPage(
        "/media/analysis?assetId=111111111111111111111111&select=1",
      );

      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText("0 selected")).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: "Continue to Review analysis batch (1)",
        }),
      ).toBeNull();
      expect(
        mockCallResource.mock.calls.some(([, input]) =>
          input.action === "previewRecognitionBatch" ||
          input.action === "confirmRecognitionBatch"
        ),
      ).toBe(false);
    },
  );
});
