import { describe, expect, it } from "vitest";
import { scaleTime, zoomIdentity } from "d3";
import gregorianFormatter from "./formatters/gregorian";
import { layoutRulerLabels, rulerTicks } from "./ruler";

describe("timeline ruler", () => {
  it.each([
    ["minutes", "2026-01-01T00:00Z", "2026-01-01T00:05Z"],
    ["hours", "2026-01-01T00:00Z", "2026-01-02T00:00Z"],
    ["days", "2026-01-01T00:00Z", "2026-02-01T00:00Z"],
    ["months", "2026-01-01T00:00Z", "2027-01-01T00:00Z"],
    ["years", "2020-01-01T00:00Z", "2040-01-01T00:00Z"],
  ])("aligns %s labels and marks with the data scale", (_, start, end) => {
    const scale = scaleTime().domain([new Date(start), new Date(end)]).range([
      0,
      960,
    ]);
    const transform = zoomIdentity.translate(-100, 0).scale(1.25);
    const labels = gregorianFormatter(scale, transform, 960);
    const ticks = rulerTicks(scale, transform, 960, labels);
    expect(ticks.some((tick) => tick.major)).toBe(true);
    expect(ticks.some((tick) => !tick.major)).toBe(true);
    expect(ticks.length).toBeLessThan(100);
    for (const tick of ticks) {
      expect(tick.xOffset).toBeCloseTo(transform.rescaleX(scale)(tick.value));
      expect(tick.xOffset).toBeGreaterThanOrEqual(0);
      expect(tick.xOffset).toBeLessThanOrEqual(960);
    }
    for (const label of layoutRulerLabels(labels, 960)) {
      expect(ticks.some((tick) => tick.major && +tick.value === +label.value))
        .toBe(true);
      expect(label.segments.length).toBeGreaterThan(0);
    }
  });

  it("keeps long labels inside a narrow ruler without collisions", () => {
    const labels = [0, 40, 80, 160, 240, 320].map((xOffset) => ({
      value: new Date(xOffset * 1000),
      xOffset,
      segments: ["12:30:00", "GMT+5:30", "October 28", "2026"],
    }));
    const layout = layoutRulerLabels(labels, 320);
    expect(layout.length).toBeGreaterThan(0);
    for (let i = 0; i < layout.length; i++) {
      expect(layout[i].left).toBeGreaterThanOrEqual(0);
      expect(layout[i].left + layout[i].labelWidth).toBeLessThanOrEqual(320);
      if (i) {
        expect(layout[i].left).toBeGreaterThanOrEqual(
          layout[i - 1].left + layout[i - 1].labelWidth + 8,
        );
      }
    }
    expect(layoutRulerLabels(labels, 0)).toEqual([]);
  });

  it("shows clock times on January 1 instead of repeating only the year", () => {
    const scale = scaleTime().domain([
      new Date("2026-01-01T00:00Z"),
      new Date("2026-01-01T00:05Z"),
    ]).range([0, 960]);
    const labels = gregorianFormatter(scale, zoomIdentity, 960, {
      resolveTimeZone: () => "UTC",
    });
    expect(labels.every((label) => String(label.segments[0]).includes(":")))
      .toBe(true);
  });

  it("keeps calendar labels in a narrow month view", () => {
    const scale = scaleTime().domain([
      new Date("2026-01-01T04:00Z"),
      new Date("2026-01-30T04:00Z"),
    ]).range([0, 320]);
    const labels = gregorianFormatter(scale, zoomIdentity, 320, {
      resolveTimeZone: () => "UTC",
    });
    expect(layoutRulerLabels(labels, 320).length).toBeGreaterThan(0);
  });
});
