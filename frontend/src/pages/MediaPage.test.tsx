import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  type NavigateFunction,
  useLocation,
  useNavigate,
} from "react-router-dom";
import * as userEventLib from "@testing-library/user-event";
import * as api from "@/lib/api";
import MediaPage from "./MediaPage";

const userEvent = (userEventLib as any).default || userEventLib;

vi.mock("@/lib/api", () => ({
  callResource: vi.fn(),
  apiClient: { postForm: vi.fn() },
}));
vi.mock("@/components/media/AuthenticatedMediaImage", () => ({
  AuthenticatedMediaImage: (props: any) => <img {...props} />,
}));
vi.mock("@/components/media/LazyAuthenticatedMediaImage", () => ({
  LazyAuthenticatedMediaImage: ({
    containerClassName: _containerClassName,
    path,
    ...props
  }: any) => <img src={path} {...props} />,
}));
vi.mock("@/components/media/MediaEventsPanel", () => ({
  MediaEventsPanel: ({ candidateAssetIds }: any) => (
    <div data-testid="event-candidates">{candidateAssetIds.join(",")}</div>
  ),
}));
vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const OpenChangeContext = React.createContext<(open: boolean) => void>(
    () => {},
  );
  return {
    Dialog: ({ children, onOpenChange, open }: any) =>
      open
        ? (
          <OpenChangeContext.Provider value={onOpenChange}>
            {children}
          </OpenChangeContext.Provider>
        )
        : null,
    DialogContent: ({ children, className }: any) => {
      const onOpenChange = React.useContext(OpenChangeContext);
      return (
        <div
          aria-labelledby="media-page-test-dialog-title"
          className={className}
          role="dialog"
        >
          {children}
          <button
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            Close
          </button>
        </div>
      );
    },
    DialogDescription: ({ children, className }: any) => (
      <p className={className}>{children}</p>
    ),
    DialogHeader: ({ children, className }: any) => (
      <div className={className}>{children}</div>
    ),
    DialogTitle: ({ children, className }: any) => (
      <h2 className={className} id="media-page-test-dialog-title">
        {children}
      </h2>
    ),
  };
});

const mockCallResource = vi.mocked(api.callResource);
const mockPostForm = vi.mocked(api.apiClient.postForm);

const baseAsset = {
  _id: "asset-1",
  fileName: "photo.jpg",
  kind: "image",
  status: "staged",
  storageMode: "managed_original",
  managedOriginal: { bucket: "media_originals", fileId: "file-1" },
  source: { relativePath: "photo.jpg" },
  thumbnailUrl: "/api/files/thumb",
  previewUrl: "/api/files/preview",
  byteLength: 2_000_000,
  metadata: {},
};

function defaultResourceResponse(input: any) {
  if (input.action === "status") {
    return Promise.resolve({
      enabled: true,
      sourceConfigured: true,
      activeProfileId: undefined,
      profiles: [],
    });
  }
  if (input.action === "listAssets") {
    return Promise.resolve({ assets: [], total: 0 });
  }
  if (input.action === "listMountedFolders") {
    return Promise.resolve({
      listing: { currentPath: ".", folders: [] },
    });
  }
  if (input.action === "getActiveFolderCampaign") {
    return Promise.resolve({ campaign: null });
  }
  return Promise.resolve({});
}

function renderMediaPage(initialEntry = "/media") {
  const navigation: { current?: NavigateFunction } = {};
  const rendered = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MediaPage />
      <LocationProbe navigation={navigation} />
    </MemoryRouter>,
  );
  return {
    ...rendered,
    navigate: (to: string) => {
      if (!navigation.current) throw new Error("Router is not ready");
      navigation.current(to, { replace: true });
    },
  };
}

function LocationProbe(
  { navigation }: { navigation: { current?: NavigateFunction } },
) {
  const location = useLocation();
  navigation.current = useNavigate();
  return (
    <output data-testid="media-location">
      {location.pathname + location.search}
    </output>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("MediaPage consolidated library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallResource.mockImplementation((_resource, input) =>
      defaultResourceResponse(input)
    );
  });

  it("shows one mounted-folder picker and routes recognition to analysis", async () => {
    renderMediaPage();

    expect(await screen.findByText("Folder sync")).toBeTruthy();
    expect(screen.getAllByText("Folder sync")).toHaveLength(1);
    expect(screen.queryByText("Mounted folders")).toBeNull();
    expect(screen.queryByLabelText("Relative folder or file path")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Analyze mounted path" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Process all with Google Cloud/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Process selected/i }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Photo analysis" }).getAttribute(
        "href",
      ),
    ).toBe("/media/analysis");
    expect(
      (screen.getByLabelText("Choose files") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("offers a sortable table and sends all matching photos to processing", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 801 });
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage("/media?view=table");

    expect(await screen.findByRole("table")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Photo" }));
    await waitFor(() =>
      expect(mockCallResource).toHaveBeenCalledWith(
        "media",
        expect.objectContaining({
          action: "listAssets",
          sortBy: "fileName",
          sortDirection: "asc",
        }),
      )
    );
    await user.click(
      screen.getByRole("button", { name: "Select all matching (801)" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Process selection" }),
    );
    expect(screen.getByTestId("media-location").textContent).toBe(
      "/media/analysis?view=table&selection=all",
    );
  });

  it("can ignore an explicit processing selection without deleting it", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 1 });
      }
      if (input.action === "setRecognitionIgnored") {
        return Promise.resolve({ success: true, updated: 1 });
      }
      return defaultResourceResponse(input);
    });
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderMediaPage();

    await user.click(await screen.findByLabelText("Select photo.jpg"));
    await user.click(
      screen.getByRole("button", { name: "Ignore for processing" }),
    );
    await waitFor(() =>
      expect(mockCallResource).toHaveBeenCalledWith("media-library", {
        action: "setRecognitionIgnored",
        selection: {
          mode: "explicit",
          inventoryFilter: "all",
          placement: "all",
          assetIds: ["asset-1"],
        },
        ignored: true,
        confirm: true,
      })
    );
    confirm.mockRestore();
  });

  it("uploads locally and refreshes the gallery after confirmation", async () => {
    let confirmed = false;
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({
          assets: confirmed ? [{ ...baseAsset, fileName: "garden.jpg" }] : [],
          total: confirmed ? 1 : 0,
        });
      }
      if (input.action === "confirmImport") {
        confirmed = true;
        return Promise.resolve({
          created: [{ assetId: "asset-1", jobId: null }],
        });
      }
      return defaultResourceResponse(input);
    });
    mockPostForm.mockResolvedValue({
      importId: "upload-import-1",
      storageMode: "managed_original",
      grossEstimateUsd: 0,
      provider: { name: "Metadata only", providerType: "none" },
      requestedTasks: [],
      items: [{
        fileName: "garden.jpg",
        kind: "image",
        byteLength: 1024,
        pageCount: 1,
        estimatedGrossUsd: 0,
        sha256: "a".repeat(64),
        thumbnailUrl: "/api/files/upload-thumb",
      }],
    });
    const user = userEvent.setup();
    renderMediaPage();

    await user.upload(
      await screen.findByLabelText("Choose files"),
      new File([new Uint8Array([1, 2, 3])], "garden.jpg", {
        type: "image/jpeg",
      }),
    );

    expect(await screen.findByText("Review local import")).toBeTruthy();
    expect(screen.getByText("Managed original")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Confirm local import" }),
    );

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "confirmImport",
        importId: "upload-import-1",
        consent: true,
        queueRecognition: false,
      });
    });
    expect(
      await screen.findByRole("button", { name: "Open garden.jpg" }),
    ).toBeTruthy();
  });

  it("does not let an older filter response replace the current results", async () => {
    let resolveReady: ((value: any) => void) | undefined;
    let resolveUnprocessed: ((value: any) => void) | undefined;
    const readyRequest = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const unprocessedRequest = new Promise((resolve) => {
      resolveUnprocessed = resolve;
    });

    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        if (input.inventoryFilter === "ready") return readyRequest;
        if (input.inventoryFilter === "unprocessed") {
          return unprocessedRequest;
        }
        return Promise.resolve({ assets: [], total: 0 });
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage();

    await screen.findByText("No media matches these filters.");
    await user.selectOptions(
      screen.getByLabelText("Processing status"),
      "ready",
    );
    await waitFor(() => expect(resolveReady).toBeTypeOf("function"));
    await user.selectOptions(
      screen.getByLabelText("Processing status"),
      "unprocessed",
    );
    await waitFor(() => expect(resolveUnprocessed).toBeTypeOf("function"));

    await act(async () => {
      resolveUnprocessed?.({
        assets: [{ ...baseAsset, fileName: "unprocessed.jpg" }],
        total: 1,
      });
    });
    expect(
      await screen.findByRole("button", { name: "Open unprocessed.jpg" }),
    ).toBeTruthy();

    await act(async () => {
      resolveReady?.({
        assets: [{
          ...baseAsset,
          fileName: "ready.jpg",
          status: "ready",
        }],
        total: 1,
      });
    });
    expect(
      screen.getByRole("button", { name: "Open unprocessed.jpg" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open ready.jpg" }),
    ).toBeNull();
  });

  it("keeps loaded pages and their tail cursor during a background refresh", async () => {
    const secondAsset = {
      ...baseAsset,
      _id: "asset-2",
      fileName: "second.jpg",
    };
    const thirdAsset = {
      ...baseAsset,
      _id: "asset-3",
      fileName: "third.jpg",
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        if (input.cursor === "cursor-1") {
          return Promise.resolve({
            assets: [secondAsset],
            total: 3,
            nextCursor: "cursor-2",
          });
        }
        if (input.cursor === "cursor-2") {
          return Promise.resolve({ assets: [thirdAsset], total: 3 });
        }
        return Promise.resolve({
          assets: [{ ...baseAsset, status: "ready" }],
          total: 3,
          nextCursor: "cursor-1",
        });
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage();

    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("button", { name: "Open second.jpg" }),
    ).toBeTruthy();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open second.jpg" }))
        .toBeTruthy()
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("button", { name: "Open third.jpg" }),
    ).toBeTruthy();
    expect(mockCallResource).toHaveBeenCalledWith("media", {
      action: "listAssets",
      limit: 100,
      inventoryFilter: "all",
      placement: "all",
      cursor: "cursor-2",
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("opens gallery details in a dialog and keeps selection for photo events", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: {
            ...baseAsset,
            capturedAt: "2024-04-05T12:00:00.000Z",
            location: { latitude: 41.7, longitude: -8.1 },
          },
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage();

    await user.click(
      await screen.findByLabelText("Select photo.jpg"),
    );
    expect(screen.getByTestId("event-candidates").textContent).toContain(
      "asset-1",
    );
    await user.click(screen.getByRole("button", { name: "Open photo.jpg" }));

    const dialog = await screen.findByRole("dialog", { name: "photo.jpg" });
    expect(dialog).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Get description" }).getAttribute(
        "href",
      ),
    ).toBe("/media/analysis?assetId=asset-1&select=1");
    expect(
      screen.getByRole("link", { name: "Show on Map" }).getAttribute("href"),
    ).toBe("/map?photoAssetId=asset-1");
    expect(
      screen.getByRole("link", { name: "Show on Timeline" }).getAttribute(
        "href",
      ),
    ).toBe("/timeline?photoAssetId=asset-1");
    expect(
      screen.queryByRole("button", {
        name: "Review managed original deletion",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Storage & deletion…" }),
    );
    expect(
      (screen.getByRole("button", {
        name: "Review managed original deletion",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      screen.getByText(
        /Mounted originals remain read-only/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Manual Timeline / Map placement")).toBeTruthy();
  });

  it("keeps general analysis but hides photo-only actions for a PDF", async () => {
    const pdfAsset = {
      ...baseAsset,
      fileName: "document.pdf",
      kind: "pdf",
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [pdfAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: pdfAsset,
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });

    renderMediaPage("/media?assetId=asset-1");

    expect(
      await screen.findByRole("dialog", { name: "document.pdf" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Get description" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open in Photo analysis" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open in Analysis" }).getAttribute(
        "href",
      ),
    ).toBe("/media/analysis?assetId=asset-1");
    expect(screen.queryByRole("link", { name: "Show on Map" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Show on Timeline" })).toBeNull();
  });

  it("preserves assetId deep links in the same dialog viewer", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: baseAsset,
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });

    const user = userEvent.setup();
    renderMediaPage("/media?assetId=asset-1");

    expect(
      await screen.findByRole("dialog", { name: "photo.jpg" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Provider analysis status").textContent)
      .toContain("Not processed");
    expect(screen.getByText(/Local preview and metadata only/i)).toBeTruthy();
    expect(mockCallResource).toHaveBeenCalledWith("media", {
      action: "getAsset",
      assetId: "asset-1",
    });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "photo.jpg" })).toBeNull()
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByTestId("media-location").textContent).toBe("/media");
    expect(
      mockCallResource.mock.calls.filter(([, input]) =>
        input.action === "getAsset"
      ),
    ).toHaveLength(1);
  });

  it("identifies the active Google result and its stored projections", async () => {
    const readyAsset = {
      ...baseAsset,
      status: "ready",
      currentRunId: "run-google",
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [readyAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: readyAsset,
          visual: {
            visualUnderstanding: {
              shortCaption: "A coastal landscape",
              description: "A view of the coast.",
              scene: {
                summary: "Coast",
                environment: "outdoor",
                placeType: "coast",
                timeOfDay: "day",
              },
              peopleCount: 0,
              possibleEvent: null,
              confidence: 0.9,
              objects: [],
              activities: [],
              keywords: ["coast"],
              warnings: [],
            },
          },
          pages: [{ _id: "page-1", pageNumber: 1, text: "Sign" }],
          annotations: [{ _id: "annotation-1", type: "label", label: "sea" }],
          runs: [{
            _id: "run-google",
            state: "ready",
            providerSnapshot: {
              providerType: "google-cloud",
              name: "Google Cloud EU Photo Knowledge",
            },
            provenance: {
              providerType: "google-cloud",
              service: "Vertex AI + Cloud Vision",
              location: "europe-west4 / eu",
              modelVersion: "visual-model",
            },
          }],
        });
      }
      return defaultResourceResponse(input);
    });

    renderMediaPage("/media?assetId=asset-1");

    const providerStatus = await screen.findByLabelText(
      "Provider analysis status",
    );
    expect(providerStatus.textContent).toContain("Google Cloud result");
    expect(providerStatus.textContent).toContain(
      "Google Cloud EU Photo Knowledge",
    );
    expect(providerStatus.textContent).toContain("description available");
    expect(providerStatus.textContent).toContain("OCR 1");
    expect(
      screen.getByRole("link", {
        name: "Open in Photo analysis",
      }).getAttribute("href"),
    ).toBe("/media/analysis?assetId=asset-1");
    expect(screen.queryByRole("link", { name: "Get description" })).toBeNull();
  });

  it("opens ready OCR-only photos as analysis history instead of promising a description", async () => {
    const readyOcrAsset = {
      ...baseAsset,
      status: "ready",
      currentRunId: "run-ocr",
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [readyOcrAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: readyOcrAsset,
          pages: [{ _id: "page-1", pageNumber: 1, text: "Receipt" }],
          annotations: [],
          runs: [{ _id: "run-ocr", state: "ready" }],
        });
      }
      return defaultResourceResponse(input);
    });

    renderMediaPage("/media?assetId=asset-1");

    expect(
      (await screen.findByRole("link", {
        name: "Open in Photo analysis",
      })).getAttribute("href"),
    ).toBe("/media/analysis?assetId=asset-1");
    expect(screen.queryByRole("link", { name: "Get description" })).toBeNull();
  });

  it("does not promise a description when a staged photo has no retained original", async () => {
    const previewOnlyAsset = {
      ...baseAsset,
      storageMode: "preview_only",
      managedOriginal: undefined,
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [previewOnlyAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: previewOnlyAsset,
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });

    renderMediaPage("/media?assetId=asset-1");

    expect(
      (await screen.findByRole("link", {
        name: "Open in Photo analysis",
      })).getAttribute("href"),
    ).toBe("/media/analysis?assetId=asset-1");
    expect(screen.queryByRole("link", { name: "Get description" })).toBeNull();
  });

  it("explains mounted storage behind one storage and deletion entrypoint", async () => {
    const mountedAsset = {
      ...baseAsset,
      storageMode: "external_reference",
      managedOriginal: undefined,
      source: { relativePath: "900-photos/trip/photo.jpg" },
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [mountedAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: mountedAsset,
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });

    const user = userEvent.setup();
    renderMediaPage("/media?assetId=asset-1");

    expect(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Forget mounted original reference",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Storage & deletion…" }),
    );

    expect(
      screen.getByRole("button", { name: "Remove from Mycelia" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/original file in the mounted folder is never deleted/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/later folder sync can import it again/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Remove from Mycelia",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "Delete Mycelia previews",
    })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Review managed original deletion",
      }),
    ).toBeNull();

    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    await user.click(
      screen.getByRole("button", { name: "Remove from Mycelia" }),
    );
    await waitFor(() =>
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "deleteDerived",
        assetId: "asset-1",
        target: "asset_record",
        confirm: true,
      })
    );
    confirm.mockRestore();
  });

  it("locks every storage mutation while recognition reserves the asset", async () => {
    const reservedAsset = {
      ...baseAsset,
      storageMode: "external_reference",
      managedOriginal: undefined,
      source: { relativePath: "900-photos/private.jpg" },
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [reservedAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: reservedAsset,
          recognitionReservation: {
            state: "active",
            batchId: "batch-1",
            batch: {
              status: "running",
              profileName: "Google Cloud EU Photo Knowledge",
            },
          },
          pages: [],
          annotations: [],
          runs: [{ _id: "run-1", state: "failed" }],
        });
      }
      return defaultResourceResponse(input);
    });

    const user = userEvent.setup();
    renderMediaPage("/media?assetId=asset-1");
    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );

    expect(
      screen.getByText("Storage changes are temporarily locked"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Current state: running · active/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "View active batch and stop new calls",
      }).getAttribute("href"),
    ).toBe("/media/analysis");
    expect(
      (screen.getByRole("button", {
        name: "Remove from Mycelia",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByText("Advanced: reset provider analysis"));
    expect(
      (screen.getByRole("button", {
        name: "Reset derived analysis",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "deleteDerived" ||
        input.action === "previewOriginalDeletion"
      ),
    ).toBe(false);
  });

  it("locks managed-original review while recognition reserves the asset", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: baseAsset,
          recognitionReservation: {
            state: "active",
            batchId: "batch-1",
            batch: { status: "running" },
          },
          pages: [],
          annotations: [],
          runs: [{ _id: "run-1", state: "ready" }],
        });
      }
      return defaultResourceResponse(input);
    });

    const user = userEvent.setup();
    renderMediaPage("/media?assetId=asset-1");
    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );

    expect(
      (screen.getByRole("button", {
        name: "Review managed original deletion",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "previewOriginalDeletion"
      ),
    ).toBe(false);
  });

  it("distinguishes a forgotten mounted reference from a deleted managed original", async () => {
    const forgottenReferenceAsset = {
      ...baseAsset,
      storageMode: "preview_only",
      managedOriginal: undefined,
      source: undefined,
      sourceReferenceForgottenAt: "2026-08-26T03:00:00.000Z",
      originalDeletionReceipt: undefined,
    };
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [forgottenReferenceAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: forgottenReferenceAsset,
          pages: [],
          annotations: [],
          runs: [],
        });
      }
      return defaultResourceResponse(input);
    });

    renderMediaPage("/media?assetId=asset-1");

    expect(
      await screen.findByText(/mounted original reference was forgotten/i),
    ).toBeTruthy();
    expect(screen.getByText(/preview_only · no retained original/i))
      .toBeTruthy();
    expect(screen.getByText(/mounted file was not deleted/i)).toBeTruthy();
    expect(
      screen.queryByText(/Mycelia-managed original was permanently deleted/i),
    ).toBeNull();
  });

  it("discards a late deletion preview after switching from asset A to B", async () => {
    const assetA = { ...baseAsset, _id: "asset-a", fileName: "a.jpg" };
    const assetB = { ...baseAsset, _id: "asset-b", fileName: "b.jpg" };
    const pendingPreview = deferred<any>();
    const pendingCancellation = deferred<{ success: true }>();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [assetA, assetB], total: 2 });
      }
      if (input.action === "getAsset") {
        const asset = input.assetId === "asset-a" ? assetA : assetB;
        return Promise.resolve({
          asset,
          pages: [],
          annotations: [],
          runs: [{ _id: `run-${asset._id}`, state: "ready" }],
        });
      }
      if (
        input.action === "previewOriginalDeletion" &&
        input.assetId === "asset-a"
      ) {
        return pendingPreview.promise;
      }
      if (input.action === "cancelOriginalDeletionPreview") {
        return pendingCancellation.promise;
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    const page = renderMediaPage("/media?assetId=asset-a");

    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "previewOriginalDeletion",
        assetId: "asset-a",
      });
    });

    act(() => page.navigate("/media?assetId=asset-b"));
    expect(await screen.findByRole("dialog", { name: "b.jpg" })).toBeTruthy();

    await act(async () => {
      pendingPreview.resolve({
        assetId: "asset-a",
        canDelete: true,
        deletionPreviewId: "preview-a",
        previewReady: true,
        analysisReady: true,
      });
      await pendingPreview.promise;
    });

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "cancelOriginalDeletionPreview",
        deletionPreviewId: "preview-a",
      });
    });
    act(() => page.navigate("/media?assetId=asset-a"));
    await waitFor(() => {
      expect(
        mockCallResource.mock.calls.filter(([, input]) =>
          input.action === "getAsset" && input.assetId === "asset-a"
        ),
      ).toHaveLength(2);
    });
    expect(await screen.findByRole("dialog", { name: "a.jpg" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Storage & deletion…" }),
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", {
          name: "Review managed original deletion",
        }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    await act(async () => {
      pendingCancellation.resolve({ success: true });
      await pendingCancellation.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", {
          name: "Review managed original deletion",
        }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(
      mockCallResource.mock.calls.some(([, input]) =>
        input.action === "confirmOriginalDeletion"
      ),
    ).toBe(false);
  });

  it("discards a late deletion preview after closing the asset", async () => {
    const assetA = { ...baseAsset, _id: "asset-a", fileName: "a.jpg" };
    const pendingPreview = deferred<any>();
    const pendingCancellation = deferred<{ success: true }>();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [assetA], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: assetA,
          pages: [],
          annotations: [],
          runs: [{ _id: "run-a", state: "ready" }],
        });
      }
      if (input.action === "previewOriginalDeletion") {
        return pendingPreview.promise;
      }
      if (input.action === "cancelOriginalDeletionPreview") {
        return pendingCancellation.promise;
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    const page = renderMediaPage("/media?assetId=asset-a");

    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "previewOriginalDeletion",
        assetId: "asset-a",
      });
    });
    await user.click(screen.getByRole("button", { name: "Close details" }));

    await act(async () => {
      pendingPreview.resolve({
        assetId: "asset-a",
        canDelete: true,
        deletionPreviewId: "preview-a",
        previewReady: true,
        analysisReady: true,
      });
      await pendingPreview.promise;
    });

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "cancelOriginalDeletionPreview",
        deletionPreviewId: "preview-a",
      });
    });
    await act(async () => {
      pendingCancellation.resolve({ success: true });
      await pendingCancellation.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("media-location").textContent).toBe("/media");
    });
    expect(screen.queryByRole("dialog", { name: "a.jpg" })).toBeNull();
    act(() => page.navigate("/media?assetId=asset-a"));
    await waitFor(() => {
      expect(
        mockCallResource.mock.calls.filter(([, input]) =>
          input.action === "getAsset" && input.assetId === "asset-a"
        ),
      ).toHaveLength(2);
    });
    expect(await screen.findByRole("dialog", { name: "a.jpg" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Storage & deletion…" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Storage & deletion…" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    });
    expect(screen.queryByText("Original deletion preview")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Permanently delete managed original",
      }),
    ).toBeNull();
    expect(
      (screen.getByRole("button", {
        name: "Review managed original deletion",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("releases a displayed deletion review on close before allowing another review", async () => {
    const assetA = { ...baseAsset, _id: "asset-a", fileName: "a.jpg" };
    const pendingCancellation = deferred<{ success: true }>();
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [assetA], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: assetA,
          pages: [],
          annotations: [],
          runs: [{ _id: "run-a", state: "ready" }],
        });
      }
      if (input.action === "previewOriginalDeletion") {
        return Promise.resolve({
          assetId: "asset-a",
          canDelete: true,
          deletionPreviewId: "preview-a",
          previewReady: true,
          analysisReady: true,
        });
      }
      if (input.action === "cancelOriginalDeletionPreview") {
        return pendingCancellation.promise;
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    const page = renderMediaPage("/media?assetId=asset-a");

    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Permanently delete managed original",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "cancelOriginalDeletionPreview",
        deletionPreviewId: "preview-a",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("media-location").textContent).toBe("/media");
      expect(screen.queryByRole("dialog", { name: "a.jpg" })).toBeNull();
    });
    act(() => page.navigate("/media?assetId=asset-a"));
    await waitFor(() => {
      expect(
        mockCallResource.mock.calls.filter(([, input]) =>
          input.action === "getAsset" && input.assetId === "asset-a"
        ),
      ).toHaveLength(2);
    });
    expect(await screen.findByRole("dialog", { name: "a.jpg" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Storage & deletion…" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Storage & deletion…" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        (screen.getByRole("button", {
          name: "Review managed original deletion",
        }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
    expect(
      screen.queryByRole("button", {
        name: "Permanently delete managed original",
      }),
    ).toBeNull();

    await act(async () => {
      pendingCancellation.resolve({ success: true });
      await pendingCancellation.promise;
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", {
          name: "Review managed original deletion",
        }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  it("keeps a managed-original review open when cancellation fails", async () => {
    mockCallResource.mockImplementation((_resource, input) => {
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [baseAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: baseAsset,
          pages: [],
          annotations: [],
          runs: [{ _id: "run-1", state: "ready" }],
        });
      }
      if (input.action === "previewOriginalDeletion") {
        return Promise.resolve({
          canDelete: true,
          deletionPreviewId: "deletion-preview-1",
          byteLength: baseAsset.byteLength,
          previewReady: true,
          analysisReady: true,
        });
      }
      if (input.action === "cancelOriginalDeletionPreview") {
        return Promise.reject(new Error("Cancellation could not be saved"));
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage("/media?assetId=asset-1");

    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Cancel original deletion review",
      }),
    );

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "cancelOriginalDeletionPreview",
        deletionPreviewId: "deletion-preview-1",
      });
    });
    expect(
      screen.getByRole("button", {
        name: "Permanently delete managed original",
      }),
    ).toBeTruthy();
  });

  it("keeps the preview-and-confirm guard for managed-original deletion", async () => {
    let deleted = false;
    mockCallResource.mockImplementation((_resource, input) => {
      const currentAsset = {
        ...baseAsset,
        storageMode: deleted ? "preview_only" : "managed_original",
        managedOriginal: deleted ? undefined : baseAsset.managedOriginal,
        originalDeletionReceipt: deleted
          ? { receiptId: "receipt-1", deletedAt: new Date().toISOString() }
          : undefined,
      };
      if (input.action === "listAssets") {
        return Promise.resolve({ assets: [currentAsset], total: 1 });
      }
      if (input.action === "getAsset") {
        return Promise.resolve({
          asset: currentAsset,
          pages: [],
          annotations: [],
          runs: [{ _id: "run-1", state: "ready" }],
        });
      }
      if (input.action === "previewOriginalDeletion") {
        return Promise.resolve({
          canDelete: true,
          deletionPreviewId: "deletion-preview-1",
          byteLength: baseAsset.byteLength,
          previewReady: true,
          analysisReady: true,
        });
      }
      if (input.action === "confirmOriginalDeletion") {
        deleted = true;
        return Promise.resolve({ success: true, storageMode: "preview_only" });
      }
      return defaultResourceResponse(input);
    });
    const user = userEvent.setup();
    renderMediaPage();

    await user.click(
      await screen.findByRole("button", { name: "Open photo.jpg" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Storage & deletion…" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    expect(mockCallResource).toHaveBeenCalledWith("media", {
      action: "previewOriginalDeletion",
      assetId: "asset-1",
    });
    await user.click(
      screen.getByRole("button", {
        name: "Cancel original deletion review",
      }),
    );
    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "cancelOriginalDeletionPreview",
        deletionPreviewId: "deletion-preview-1",
      });
    });
    expect(
      screen.queryByRole("button", {
        name: "Permanently delete managed original",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: "Review managed original deletion",
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Permanently delete managed original",
      }),
    );

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("media", {
        action: "confirmOriginalDeletion",
        deletionPreviewId: "deletion-preview-1",
        confirm: true,
      });
    });
    expect(
      await screen.findByText(
        /Mycelia-managed original was permanently deleted/i,
      ),
    )
      .toBeTruthy();
  });
});
