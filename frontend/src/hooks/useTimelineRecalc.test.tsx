import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHistogramCache } from "@/modules/histogram/useHistogramCache";
import { useTimelineRecalc } from "./useTimelineRecalc";
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => void>(),
}));
vi.mock(
  "./useWebSocket",
  () => ({
    useWebSocketSubscription: (
      channel: string,
      callback: (message: unknown) => void,
    ) => handlers.set(channel, callback),
  }),
);
vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));
const item = {
  id: "bin",
  start: new Date("2026-01-01T00:00:00Z"),
  end: new Date("2026-01-01T00:05:00Z"),
  stale: false,
  totals: { seconds: 300, transcriptions: { count: 1 } },
};
beforeEach(() => {
  handlers.clear();
  useHistogramCache.setState({
    data: { "5min": { loadedRanges: [], items: [item] } },
    scheduleInvalidation: vi.fn(),
  });
});
describe("Timeline processing updates", () => {
  it("refreshes on collection-only events and highlights only changed canonical bins", () => {
    const hook = renderHook(() => useTimelineRecalc());
    act(() =>
      handlers.get("mongo:histogram_5min")?.({
        event: "mongo.change",
        data: { collection: "histogram_5min" },
      })
    );
    expect(useHistogramCache.getState().scheduleInvalidation)
      .toHaveBeenCalledOnce();
    expect(hook.result.current.activeRanges).toHaveLength(0);
    act(() => useHistogramCache.setState({ data: {} }));
    act(() =>
      useHistogramCache.setState({
        data: {
          "5min": {
            loadedRanges: [],
            items: [{
              ...item,
              totals: { ...item.totals, transcriptions: { count: 2 } },
            }],
          },
        },
      })
    );
    expect(hook.result.current.activeRanges).toEqual([
      expect.objectContaining({
        key: "5min:bin",
        start: item.start,
        end: item.end,
      }),
    ]);
  });
});
