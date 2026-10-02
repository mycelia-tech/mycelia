import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callResourceMock, listeners } = vi.hoisted(() => ({
  callResourceMock: vi.fn(),
  listeners: new Map<string, Set<(event: unknown) => void>>(),
}));

vi.mock("@/lib/api", () => ({ callResource: callResourceMock }));
vi.mock("@/lib/websocket", () => ({
  wsClient: {
    subscribe: (channel: string, callback: (event: unknown) => void) => {
      const callbacks = listeners.get(channel) ?? new Set();
      callbacks.add(callback);
      listeners.set(channel, callbacks);
      return () => callbacks.delete(callback);
    },
  },
}));

import { useHistogramCache } from "./useHistogramCache";
import { useHistogramItems } from "./useHistogramItems";

const start = new Date("2026-09-30T12:00:00.000Z");
const end = new Date("2026-09-30T13:00:00.000Z");

function buckets(count: number) {
  return [{
    _id: "bucket-1",
    start,
    stale: false,
    totals: { audio_chunks: { count } },
  }];
}

function emit(event = "mongo.change") {
  for (const resolution of ["5min", "1hour", "1day", "1week"]) {
    const channel = `mongo:histogram_${resolution}`;
    for (const callback of listeners.get(channel) ?? []) {
      callback({
        channel,
        event,
        data: { collection: `histogram_${resolution}` },
      });
    }
  }
}

async function flushRefresh() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

describe("Histogram live viewport refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callResourceMock.mockReset();
    useHistogramCache.getState().invalidateAll();
  });

  afterEach(() => {
    cleanup();
    useHistogramCache.getState().invalidateAll();
    listeners.clear();
    vi.useRealTimers();
  });

  it.each(["mongo.change", "resync_required"])(
    "refetches the unchanged bounded viewport once for a burst of %s events",
    async (event) => {
      callResourceMock.mockResolvedValueOnce(buckets(2)).mockResolvedValue(
        buckets(9),
      );
      const { result } = renderHook(() => useHistogramItems(start, end));
      await flushRefresh();
      expect(result.current.items[0]?.totals.audio_chunks?.count).toBe(2);

      act(() => {
        emit(event);
        emit(event);
      });
      await flushRefresh();

      expect(callResourceMock).toHaveBeenCalledTimes(2);
      expect(callResourceMock.mock.calls[1][1]).toEqual({
        action: "find",
        collection: "histogram_5min",
        query: {
          start: {
            $gte: new Date("2026-09-30T10:55:00.000Z"),
            $lt: new Date("2026-09-30T14:05:00.000Z"),
          },
        },
        options: { sort: { start: 1 } },
      });
      expect(result.current.items[0]?.totals.audio_chunks?.count).toBe(9);
    },
  );

  it("ignores a response from before invalidation even when abort arrives too late", async () => {
    let resolveOld!: (value: ReturnType<typeof buckets>) => void;
    const old = new Promise<ReturnType<typeof buckets>>((resolve) => {
      resolveOld = resolve;
    });
    callResourceMock.mockReturnValueOnce(old).mockResolvedValueOnce(buckets(9));
    const { result } = renderHook(() => useHistogramItems(start, end));
    await flushRefresh();
    const oldSignal = callResourceMock.mock.calls[0][2]?.signal;

    act(() => {
      emit();
    });
    await flushRefresh();
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.items[0]?.totals.audio_chunks?.count).toBe(9);

    await act(async () => {
      resolveOld(buckets(2));
      await old;
    });
    expect(result.current.items[0]?.totals.audio_chunks?.count).toBe(9);
    expect(useHistogramCache.getState().inFlightRequests).toEqual({});
  });
});
