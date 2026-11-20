import { describe, expect, it } from "vitest";
import { clampTimelineRange, paddedTimelineBounds } from "./timelineViewport";
import { calendarDateRange } from "@/components/timeline/TimelineDateJump";

describe("Timeline date navigation", () => {
  it("uses local midnights across daylight saving changes", () => {
    const range = calendarDateRange("2026-03-08", "day", "America/New_York")!;
    expect(range.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
  it("opens the Monday through Sunday week containing the date", () => {
    const range = calendarDateRange("2026-10-28", "week", "Asia/Tbilisi")!;
    expect(range.start.toISOString()).toBe("2026-10-25T20:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-11-01T20:00:00.000Z");
    expect(calendarDateRange("2026-02-31", "day", "UTC")).toBeUndefined();
  });
  it("stops panning at data boundaries without changing the zoom level", () => {
    const bounds = paddedTimelineBounds({
      start: new Date("2026-01-01"),
      end: new Date("2026-10-28"),
    })!;
    for (const value of ["1900-01-01", "2200-01-01"]) {
      const start = new Date(value);
      const range = clampTimelineRange(
        start,
        new Date(+start + 86400000),
        bounds,
      );
      expect(+range.start).toBeGreaterThanOrEqual(+bounds.start);
      expect(+range.end).toBeLessThanOrEqual(+bounds.end);
      expect(+range.end - +range.start).toBe(86400000);
    }
    const whole = clampTimelineRange(
      new Date("1900-01-01"),
      new Date("2200-01-01"),
      bounds,
    );
    expect(whole).toEqual(bounds);
  });
});
