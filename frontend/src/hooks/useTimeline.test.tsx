import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeline } from "./useTimeline.ts";
import { useTimelineRange } from "@/stores/timelineRange";
import {
  MAX_TIMELINE_SPAN,
  normalizeTimelineRange,
} from "@/lib/timelineViewport";

let resize: ResizeObserverCallback;
let timeline: ReturnType<typeof useTimeline>;
function Harness() {
  timeline = useTimeline();
  return (
    <div ref={timeline.containerRef}>
      <svg
        data-testid="track"
        className="zoomable"
        width={timeline.width}
        height={100}
      />
    </div>
  );
}
function range() {
  const { start, end } = useTimelineRange.getState();
  return [+start, +end];
}
function visibleRange() {
  return timeline.transform.rescaleX(timeline.timeScale).domain().map(Number);
}

describe("Timeline navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    useTimelineRange.getState().setRange(
      new Date("2026-10-01"),
      new Date("2026-10-28"),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("zooms with ordinary wheel scrolling inside the timeline", () => {
    const { getByTestId } = render(<Harness />);
    const before = range();
    fireEvent.wheel(getByTestId("track"), { deltaY: -100 });
    act(() => vi.advanceTimersByTime(40));
    expect(range()[1] - range()[0]).toBeLessThan(before[1] - before[0]);
    fireEvent.wheel(getByTestId("track"), {
      deltaY: -100,
      ctrlKey: true,
      clientX: 400,
    });
    act(() => vi.advanceTimersByTime(40));
    expect(range()[1] - range()[0]).toBeLessThan(before[1] - before[0]);
    expect(visibleRange()[0]).toBeCloseTo(range()[0], -1);
  });

  it("preserves the interval across repeated resizes after zooming", () => {
    render(<Harness />);
    act(() =>
      timeline.zoomTo(
        new Date("2026-10-15T10:00Z"),
        new Date("2026-10-15T12:00Z"),
      )
    );
    const before = range();
    for (const width of [500, 1100, 300, 800]) {
      act(() =>
        resize(
          [{ contentRect: { width } } as ResizeObserverEntry],
          {} as ResizeObserver,
        )
      );
      expect(range()).toEqual(before);
      expect(visibleRange()[0]).toBeCloseTo(before[0], -1);
      expect(visibleRange()[1]).toBeCloseTo(before[1], -1);
    }
  });

  it("pans the time interval when a track is dragged", () => {
    const { getByTestId } = render(<Harness />);
    const view = getByTestId("track").ownerDocument.defaultView!;
    const before = range();
    const dispatch = (
      target: Element | Window,
      type: string,
      clientX: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: 20,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
      });
      // Vitest's Window proxy is rejected by jsdom's UIEvent constructor.
      Object.defineProperty(event, "view", { value: view });
      fireEvent(target, event);
    };
    dispatch(getByTestId("track"), "mousedown", 400);
    dispatch(view, "mousemove", 500);
    dispatch(view, "mouseup", 500);
    act(() => vi.advanceTimersByTime(40));
    expect(range()[0]).toBeLessThan(before[0]);
    expect(range()[1] - range()[0]).toBe(before[1] - before[0]);
  });

  it("bounds extreme wheel zoom and still allows zooming back in", () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.wheel(getByTestId("track"), {
      deltaY: 100000,
      ctrlKey: true,
      clientX: 400,
    });
    act(() => vi.advanceTimersByTime(200));
    expect(range()[1] - range()[0]).toBeLessThanOrEqual(MAX_TIMELINE_SPAN);
    const wide = range()[1] - range()[0];
    fireEvent.wheel(getByTestId("track"), {
      deltaY: -50,
      ctrlKey: true,
      clientX: 400,
    });
    act(() => vi.advanceTimersByTime(200));
    expect(range()[1] - range()[0]).toBeLessThan(wide);
  });

  it("recovers the reported broken URL range and preserves other query parameters", () => {
    window.history.replaceState({ idx: 2 }, "", "/timeline?profileId=example");
    act(() =>
      useTimelineRange.getState().setRange(
        new Date(-8609314235031913),
        new Date(8531943744193076),
      )
    );
    expect(range()[1] - range()[0]).toBe(30 * 86_400_000);
    expect(new Date(range()[0]).getFullYear()).toBeGreaterThan(2020);
    expect(new URLSearchParams(location.search).get("profileId")).toBe(
      "example",
    );
    expect(history.state.idx).toBe(2);
    for (const [start, end] of [[NaN, 1], [1, NaN], [10, 1], [1, 1]]) {
      const safe = normalizeTimelineRange(new Date(start), new Date(end));
      expect(Number.isFinite(+safe.start) && +safe.end > +safe.start).toBe(
        true,
      );
    }
  });
});
