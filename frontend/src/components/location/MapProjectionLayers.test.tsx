// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  MapRouteDetailResponse,
  RecordedLocationTrack,
} from "@/types/location";
import { RouteProjectionLayer } from "./MapProjectionLayers";
vi.mock("react-leaflet", () => ({
  Polyline: ({ positions, pathOptions, children }: any) => (
    <div
      data-testid="line"
      data-points={JSON.stringify(positions)}
      data-style={JSON.stringify(pathOptions)}
    >
      {children}
    </div>
  ),
  Tooltip: ({ children }: any) => <span>{children}</span>,
  CircleMarker: () => null,
  Marker: () => null,
  useMap: vi.fn(),
}));
vi.mock("./LocationMap.tsx", () => ({ formatDurationShort: () => "1 h" }));
afterEach(cleanup);
const data = {
  fragments: [
    {
      id: "a",
      trackId: "track",
      fragmentIndex: 0,
      path: [[1, 2], [1.01, 2.01]],
      pointCount: 2,
    },
    {
      id: "b",
      trackId: "track",
      fragmentIndex: 1,
      path: [[8, 9], [8.01, 9.01]],
      pointCount: 2,
    },
  ],
  connectors: [{
    _id: "gap",
    reason: "silence",
    distanceM: 100000,
    from: { coordinates: [1.01, 2.01] },
    to: { coordinates: [8, 9] },
  }],
  conflicts: [],
} as unknown as MapRouteDetailResponse;
it("source colours use separated projected geometry, never the raw line across a gap", () => {
  const source = {
    _id: "track",
    style: { color: "#112233" },
    path: [[1, 2], [1.01, 2.01], [8, 9], [8.01, 9.01]],
  } as RecordedLocationTrack;
  render(
    <RouteProjectionLayer
      data={data}
      showConnectors={false}
      sourceTracks={[source]}
    />,
  );
  const lines = screen.getAllByTestId("line");
  expect(lines).toHaveLength(2);
  expect(lines.map((line) => JSON.parse(line.getAttribute("data-points")!)))
    .toEqual([[[2, 1], [2.01, 1.01]], [[9, 8], [9.01, 8.01]]]);
  expect(JSON.parse(lines[0].getAttribute("data-style")!).color).toBe(
    "#112233",
  );
  expect(screen.queryByText(/Recording gap/)).toBeNull();
});
it("opt-in gaps are thin faded dashed links and labelled as unknown routes", () => {
  render(<RouteProjectionLayer data={data} showConnectors />);
  const lines = screen.getAllByTestId("line");
  expect(lines).toHaveLength(3);
  const recorded = JSON.parse(lines[0].getAttribute("data-style")!);
  const gap = JSON.parse(lines[2].getAttribute("data-style")!);
  expect(gap.opacity).toBeLessThan(recorded.opacity / 2);
  expect(gap.weight).toBeLessThan(recorded.weight);
  expect(gap.dashArray).toBeTruthy();
  expect(screen.getByText(/Recording gap — route unknown/)).toBeTruthy();
});
