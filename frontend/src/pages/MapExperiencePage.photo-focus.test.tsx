// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MapExperiencePage from "./MapExperiencePage";

const mocks = vi.hoisted(() => ({
  flyTo: vi.fn(),
  setRange: vi.fn(),
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
  useLocationAt: () => ({
    data: mocks.locationAtData,
    isLoading: false,
  }),
  useLocationConflicts: () => ({ data: { total: 0 } }),
  useLocationLiveUpdates: vi.fn(),
  useLocationMetadataConflicts: () => ({ data: { total: 0 } }),
  useLocationRouteConflicts: () => ({ data: { total: 0 } }),
  useLocationSegments: () => ({
    data: { segments: [] },
    isLoading: false,
  }),
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
  RouteProjectionLayer: () => null,
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
    history.replaceState(
      {},
      "",
      "/map?photoAssetId=photo-1&start=100&end=200&layers=routes",
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

  it("preserves an explicit viewport until Fit selected data is requested", async () => {
    history.replaceState(
      {},
      "",
      "/map?lat=46.948&lng=7.4474&z=15.25&layers=routes",
    );
    render(
      <BrowserRouter>
        <MapExperiencePage />
      </BrowserRouter>,
    );

    expect(
      screen.getByTestId("location-map").getAttribute(
        "data-fit-to-segments",
      ),
    ).toBe("false");
    expect(
      screen.getByTestId("location-map").getAttribute("data-fit-request-key"),
    ).toBe("0");

    fireEvent.click(screen.getByRole("button", {
      name: "Fit selected data",
    }));

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
