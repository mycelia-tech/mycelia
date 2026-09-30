import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "@/lib/api";
import { useTrackVisibilityStore } from "@/stores/trackVisibilityStore";
import TimelinePage from "./TimelinePage";

vi.hoisted(() => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() {
        return entries.size;
      },
    },
  });
});

const mocks = vi.hoisted(() => ({
  zoomTo: vi.fn(),
  setRange: vi.fn(),
  fetchTimeZones: vi.fn(),
  clearObjectSelection: vi.fn(),
  clearTimeSelection: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { callResource: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));
vi.mock("@/hooks/useTimeline", () => ({
  useTimeline: () => ({
    containerRef: vi.fn(),
    dimensions: { width: 800, height: 100 },
    transform: {},
    timeScale: vi.fn(),
    width: 800,
    zoomTo: mocks.zoomTo,
  }),
}));
vi.mock("@/stores/timelineRange", () => ({
  useTimelineRange: () => ({
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-02T00:00:00.000Z"),
    setRange: mocks.setRange,
  }),
}));
vi.mock("@/modules/objects/useObjects", () => ({
  useObjectsStore: (selector: (state: any) => unknown) =>
    selector({ objects: [] }),
}));
vi.mock("@/stores/objectSelectionStore", () => ({
  useObjectSelectionStore: () => ({
    clearSelection: mocks.clearObjectSelection,
    selectedIds: new Set(),
  }),
}));
vi.mock("@/stores/timelineSelectionStore", () => ({
  useTimelineSelectionStore: () => ({
    selection: {},
    clearSelection: mocks.clearTimeSelection,
  }),
}));
vi.mock("@/stores/spanningObjectsStore", () => ({
  useSpanningObjectsStore: (selector: (state: any) => unknown) =>
    selector({ spanningObjects: [], ongoingObjects: [] }),
}));
vi.mock("@/stores/timelineTimeZoneStore", () => ({
  useTimelineTimeZoneStore: (selector: (state: any) => unknown) =>
    selector({ fetchForRange: mocks.fetchTimeZones }),
}));
vi.mock("@/hooks/useTimelineTimeZone", () => ({
  useTimelineTimeZone: () => ({ resolveTimeZone: () => "UTC" }),
}));
vi.mock("@/components/timeline/MultiTrackTimeline", () => ({
  MultiTrackTimeline: (props: any) => (
    <section aria-label="Timeline tracks">
      {props.focusedPhoto && (
        <>
          <output data-testid="focused-photo">
            {props.focusedPhoto.item.fileName} ·
            {props.focusedPhoto.capturedAt ? "placed" : "unplaced"} ·
            {props.focusedPhoto.item.shortCaption ?? "no description"}
          </output>
          <button type="button" onClick={props.onFocusedPhotoDismiss}>
            Dismiss focused photo
          </button>
        </>
      )}
    </section>
  ),
}));
vi.mock("@/components/timeline/TimelineHeader", () => ({
  TimelineHeader: () => null,
}));
vi.mock("@/components/timeline/SelectedObjectsPanel", () => ({
  SelectedObjectsPanel: () => null,
}));
vi.mock("@/components/timeline/controls/TrackVisibilityPanel", () => ({
  TrackVisibilityPanel: () => null,
}));
vi.mock("@/components/location/LocationSelectionPanel", () => ({
  LocationSelectionPanel: () => null,
}));
vi.mock("@/components/timeline/TimelineRecoveryStatus", () => ({
  TimelineRecoveryStatus: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
}));

const mockCallResource = vi.mocked(apiModule.api.callResource);

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

function renderTimeline(entry: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[entry]}>
        <TimelinePage />
        <LocationProbe />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("Timeline photo deep link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTrackVisibilityStore.setState({ visibleTracks: ["objects"] });
  });

  it("loads one owner-scoped asset, focuses its time, and clears the URL on close", async () => {
    mockCallResource.mockResolvedValue({
      asset: {
        _id: "asset-1",
        kind: "image",
        fileName: "lake.jpg",
        status: "ready",
        capturedAt: "2026-08-12T11:22:33.000Z",
      },
      visual: {
        visualUnderstanding: { shortCaption: "Two people near a lake" },
      },
    });

    renderTimeline("/timeline?photoAssetId=asset-1");

    expect((await screen.findByTestId("focused-photo")).textContent).toContain(
      "lake.jpg ·placed ·Two people near a lake",
    );
    expect(mockCallResource).toHaveBeenCalledWith("media", {
      action: "getAsset",
      assetId: "asset-1",
    });
    expect(mockCallResource).toHaveBeenCalledTimes(2);
    expect(mocks.zoomTo).toHaveBeenCalledTimes(1);
    expect(
      useTrackVisibilityStore.getState().visibleTracks.filter((trackId) =>
        trackId === "photos"
      ),
    ).toHaveLength(1);
    const [start, end] = mocks.zoomTo.mock.calls[0] as [Date, Date];
    expect(start.toISOString()).toBe("2026-08-12T11:17:33.000Z");
    expect(end.toISOString()).toBe("2026-08-12T11:27:33.000Z");

    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss focused photo",
    }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "/timeline?start=1785542400000&end=1785628800000",
      )
    );
  });

  it("opens an unplaced photo without zooming or inventing a time", async () => {
    mockCallResource.mockResolvedValue({
      asset: {
        _id: "asset-2",
        kind: "image",
        fileName: "missing-time.jpg",
        status: "staged",
      },
    });

    renderTimeline("/timeline?photoAssetId=asset-2");

    expect((await screen.findByTestId("focused-photo")).textContent).toContain(
      "missing-time.jpg ·unplaced ·no description",
    );
    expect(mocks.zoomTo).not.toHaveBeenCalled();
    expect(useTrackVisibilityStore.getState().visibleTracks).toContain(
      "photos",
    );
  });

  it("rejects a non-image asset opened through a photo deep link", async () => {
    mockCallResource.mockResolvedValue({
      asset: {
        _id: "document-1",
        kind: "pdf",
        fileName: "scan.pdf",
        capturedAt: "2026-08-12T11:22:33.000Z",
      },
    });

    renderTimeline("/timeline?photoAssetId=document-1");

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Photo could not be opened on the Timeline",
      )
    );
    expect(screen.queryByTestId("focused-photo")).toBeNull();
    expect(mocks.zoomTo).not.toHaveBeenCalled();
  });
});
