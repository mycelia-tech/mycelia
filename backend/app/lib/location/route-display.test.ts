import { expect } from "@std/expect";
import { splitDisplayRuns } from "./route-projection.server.ts";
import type { RoutePoint } from "./route-projection.ts";

Deno.test("map gaps use adjacent original fixes, even when timestamps are missing", () => {
  const point = (index: number, lng: number, seconds?: number): RoutePoint => ({
    index,
    coordinates: [lng, 0],
    ...(seconds === undefined ? {} : { ts: new Date(seconds * 1000) }),
  });
  const points = [
    point(0, -0.01, 0), // Outside the selected dates.
    point(1, 0, 60),
    point(2, 0.001, 61),
    point(3, 0.005, 62), // 445 m, despite the short interval.
    point(4, 0.006, 63),
    point(5, 0.007, 190), // 127 seconds, despite the short distance.
    point(6, 0.008, 191),
    point(7, 0.012), // Untimed geometry still uses the distance threshold.
    point(8, 0.013),
  ];
  const options = {
    id: "route",
    start: new Date(60_000),
    end: new Date(200_000),
    distanceM: 300,
    durationMs: 120_000,
  };
  const strict = splitDisplayRuns(points, options);
  expect(strict.runs.map((run) => run.map((p) => p.index))).toEqual([
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
  ]);
  expect(strict.connectors.map(({ reason }) => reason)).toEqual([
    "distance_threshold",
    "time_threshold",
    "distance_threshold",
  ]);
  const relaxed = splitDisplayRuns(points, {
    ...options,
    distanceM: 500,
    durationMs: 180_000,
  });
  expect(relaxed.runs.map((run) => run.map((p) => p.index))).toEqual([
    [1, 2, 3, 4, 5, 6, 7, 8],
  ]);
  expect(relaxed.connectors).toEqual([]);
});
