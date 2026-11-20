// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import {
  DEFAULT_MAP_ROUTE_DISPLAY,
  useSettingsStore,
} from "@/stores/settingsStore";
import MapExperiencePage from "./MapExperiencePage";

const mocks = vi.hoisted(() => ({
  flyTo: vi.fn(),
  setRange: vi.fn(),
  useLocationSegments: vi.fn(),
  locationAtData: undefined as
    | undefined
    | { point: { loc: { coordinates: [number, number] } } },
}));

vi.mock("react-leaflet", () => ({
  useMap: () => ({ getZoom: () => 2, flyTo: mocks.flyTo }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  callResource: vi.fn(),
}));

vi.mock("@/stores/timelineRange", () => ({
  useTimelineRange: () => ({
    start: new Date("2026-08-01T00:00:00.000Z"),
    end: new Date("2026-08-02T00:00:00.000Z"),
    setRange: mocks.setRange,
  }),
}));

vi.mock("@/hooks/useLocationQueries", () => ({
  useLocationImportSources: () => ({ data: [] }),
  useLocationSourceFiles: () => ({ data: undefined }),
  useLocationAt: () => ({
    data: mocks.locationAtData,
    isLoading: false,
  }),
  useLocationConflicts: () => ({ data: { total: 0 } }),
  useLocationLiveUpdates: vi.fn(),
  useLocationMetadataConflicts: () => ({ data: { total: 0 } }),
  useLocationRouteConflicts: () => ({ data: { total: 0 } }),
  useLocationSegments: mocks.useLocationSegments,
  useLocationStatus: () => ({ data: { geonamesReady: true } }),
  useMapDensity: () => ({
    data: undefined,
    isFetching: false,
    isLoading: false,
  }),
  useMapRouteDetail: () => ({
    data: undefined,
    isFetching: false,
    isLoading: false,
  }),
  useMapTimelineSummary: () => ({ data: undefined }),
  useRecordedLocationTracks: () => ({ data: { tracks: [] } }),
  useSavedPlaces: () => ({ data: { places: [] } }),
}));

vi.mock("@/components/location/LocationMap", () => ({
  formatDurationShort: () => "0m",
  LocationMap: (props: {
    children?: React.ReactNode;
    fitToSegments?: boolean;
    fitRequestKey?: number;
  }) => (
    <section
      data-testid="location-map"
      data-fit-to-segments={String(props.fitToSegments)}
      data-fit-request-key={String(props.fitRequestKey)}
    >
      {props.children}
    </section>
  ),
}));

vi.mock("@/components/location/PhotoClustersLayer", () => ({
  PhotoClustersLayer: (props: {
    focusedAssetId?: string;
    onFocusedAssetClose?: () => void;
  }) => (
    <section data-testid="photo-layer">
      <output data-testid="focused-photo-id">
        {props.focusedAssetId ?? "none"}
      </output>
      {props.focusedAssetId && (
        <button type="button" onClick={props.onFocusedAssetClose}>
          Close focused photo
        </button>
      )}
    </section>
  ),
}));

vi.mock("@/components/location/MapProjectionLayers", () => ({
  ConversationDensityLayer: () => null,
  PresenceDensityLayer: () => null,
  RouteProjectionLayer: () => <div data-testid="projected-route-layer" />,
}));
vi.mock("@/components/location/ConversationMapPanel", () => ({
  ConversationMapPanel: () => null,
}));
vi.mock("@/components/location/MapTimeNavigator", () => ({
  MapTimeNavigator: () => null,
}));
vi.mock("@/components/location/ImportTracksDialog", () => ({
  ImportTracksDialog: () => null,
}));
vi.mock("@/components/location/LocationSourceLayers", () => ({
  RecordedTracksLayer: () => null,
  SavedPlacesLayer: () => null,
}));
vi.mock("@/components/location/LocationConflictReviewDialog", () => ({
  LocationConflictReviewDialog: () => null,
}));
vi.mock("@/components/location/AssignLocationDialog", () => ({
  AssignLocationDialog: () => null,
}));
vi.mock("@/components/location/GeotagsSheet", () => ({
  GeotagsSheet: () => null,
}));

function LocationProbe() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  return (
    <output data-testid="location-state">
      {[
        params.get("photoAssetId") ?? "none",
        params.get("start") ?? "none",
        params.get("end") ?? "none",
        params.get("layers") ?? "none",
      ].join("|")}
    </output>
  );
}

describe("Map photo focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locationAtData = undefined;
    mocks.useLocationSegments.mockReturnValue({
      data: { segments: [] },
      isLoading: false,
    });
    history.replaceState(
      {},
      "",
      "/map?photoAssetId=photo-1&start=100&end=200&layers=routes",
    );
  });

  it("remembers edited gap limits for a new map and respects shared limits for the current view", async () => {
    const previous = useSettingsStore.getState().mapRouteDisplay;
    const previousStorage = useSettingsStore.persist.getOptions().storage;
    const values = new Map<string, string>();
    useSettingsStore.persist.setOptions({
      storage: createJSONStorage(() => ({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      })),
    });
    const renderMap = () =>
      render(
        <BrowserRouter>
          <MapExperiencePage />
        </BrowserRouter>,
      );
    try {
      useSettingsStore.getState().setMapRouteDisplay(DEFAULT_MAP_ROUTE_DISPLAY);
      history.replaceState({}, "", "/map?layers=routes&gapMin=1");
      const linkedMap = renderMap();
      fireEvent.click(screen.getByRole("button", { name: "Map settings" }));
      const distance = screen.getByLabelText<HTMLSelectElement>(
        "Gap distance threshold",
      );
      const time = screen.getByLabelText<HTMLSelectElement>(
        "Gap time threshold",
      );
      expect([distance.value, time.value]).toEqual(["100", "1"]);
      fireEvent.change(distance, { target: { value: "50" } });
      expect(new URLSearchParams(location.search).get("gapM")).toBe("50");
      linkedMap.unmount();

      await useSettingsStore.persist.rehydrate();
      history.replaceState({}, "", "/map?layers=routes");
      renderMap();
      fireEvent.click(screen.getByRole("button", { name: "Map settings" }));
      expect(
        screen.getByLabelText<HTMLSelectElement>("Gap distance threshold")
          .value,
      ).toBe("50");
      expect(
        screen.getByLabelText<HTMLSelectElement>("Gap time threshold").value,
      )
        .toBe("2");
    } finally {
      act(() => useSettingsStore.getState().setMapRouteDisplay(previous));
      useSettingsStore.persist.setOptions({ storage: previousStorage });
    }
  });

  it("hides source-coloured routes with Routes and enables routes for gap display", async () => {
    history.replaceState({}, "", "/map?layers=routes,sourceTracks");
    render(
      <BrowserRouter>
        <MapExperiencePage />
      </BrowserRouter>,
    );
    expect(screen.getByTestId("projected-route-layer")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Routes", exact: true }),
    );
    expect(screen.queryByTestId("projected-route-layer")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Source colours" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(screen.queryByRole("checkbox", { name: "Show recording gaps" }))
      .toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Map settings" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show recording gaps" }),
    );
    expect(screen.getByTestId("projected-route-layer")).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(location.search).get("layers")).toContain(
        "connectors",
      )
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Show recording gaps" }),
    );
    expect(screen.getByTestId("projected-route-layer")).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(location.search).get("layers")).toBe("routes")
    );
  });

  it("opens the photo layer, suppresses the competing fit, and clears only the focus", async () => {
    render(
      <BrowserRouter>
        <MapExperiencePage />
        <LocationProbe />
      </BrowserRouter>,
    );

    expect(screen.getByTestId("focused-photo-id").textContent).toContain(
      "photo-1",
    );
    expect(
      screen.getByTestId("location-map").getAttribute(
        "data-fit-to-segments",
      ),
    ).toBe("false");
    await waitFor(() =>
      expect(new URLSearchParams(location.search).get("layers")).toBe(
        "routes,photos",
      )
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Close focused photo",
    }));

    await waitFor(() =>
      expect(screen.getByTestId("location-state").textContent).toContain(
        "none|100|200|routes,photos",
      )
    );
    expect(screen.getByTestId("photo-layer")).toBeTruthy();
    expect(
      screen.getByTestId("location-map").getAttribute(
        "data-fit-to-segments",
      ),
    ).toBe("false");
  });

  it("clears the focused photo when the Photos layer is disabled", async () => {
    render(
      <BrowserRouter>
        <MapExperiencePage />
        <LocationProbe />
      </BrowserRouter>,
    );

    await waitFor(() =>
      expect(new URLSearchParams(location.search).get("layers")).toBe(
        "routes,photos",
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));

    await waitFor(() =>
      expect(screen.getByTestId("location-state").textContent).toContain(
        "none|100|200|routes",
      )
    );
    expect(screen.queryByTestId("photo-layer")).toBeNull();
  });

  it("loads segments only for Presence or an on-demand fit in a routes view", async () => {
    history.replaceState(
      {},
      "",
      "/map?lat=46.948&lng=7.4474&z=15.25&layers=routes",
    );
    const page = (
      <BrowserRouter>
        <MapExperiencePage />
      </BrowserRouter>
    );
    const view = render(page);
    expect(mocks.useLocationSegments.mock.lastCall?.[2].enabled).toBe(false);

    expect(
      screen.getByTestId("location-map").getAttribute(
        "data-fit-to-segments",
      ),
    ).toBe("false");
    expect(
      screen.getByTestId("location-map").getAttribute("data-fit-request-key"),
    ).toBe("0");

    const fitButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Fit selected data",
    });
    mocks.useLocationSegments.mockReturnValue({
      data: { segments: [] },
      isLoading: false,
      isPlaceholderData: true,
    });
    fireEvent.click(fitButton);
    expect(mocks.useLocationSegments.mock.lastCall?.[2].enabled).toBe(true);
    expect(fitButton.disabled).toBe(true);
    expect(
      screen.getByTestId("location-map").getAttribute("data-fit-request-key"),
    ).toBe("0");

    mocks.useLocationSegments.mockReturnValue({
      data: { segments: [] },
      isLoading: false,
      isPlaceholderData: false,
    });
    view.rerender(
      <BrowserRouter>
        <MapExperiencePage />
      </BrowserRouter>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("location-map").getAttribute(
          "data-fit-to-segments",
        ),
      ).toBe("true")
    );
    expect(
      screen.getByTestId("location-map").getAttribute("data-fit-request-key"),
    ).toBe("1");
    expect(fitButton.disabled).toBe(false);
    expect(mocks.useLocationSegments.mock.lastCall?.[2].enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Presence" }));
    expect(mocks.useLocationSegments.mock.lastCall?.[2].enabled).toBe(true);
  });

  it("does not let an at cursor override a focused photo viewport", async () => {
    mocks.locationAtData = {
      point: { loc: { coordinates: [7.4474, 46.948] } },
    };
    history.replaceState(
      {},
      "",
      "/map?photoAssetId=photo-1&at=150&layers=photos",
    );
    render(
      <BrowserRouter>
        <MapExperiencePage />
      </BrowserRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("focused-photo-id").textContent).toContain(
        "photo-1",
      )
    );
    expect(mocks.flyTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: "Close focused photo",
    }));
    await waitFor(() =>
      expect(new URLSearchParams(location.search).get("photoAssetId"))
        .toBeNull()
    );
    expect(mocks.flyTo).not.toHaveBeenCalled();
  });
});
