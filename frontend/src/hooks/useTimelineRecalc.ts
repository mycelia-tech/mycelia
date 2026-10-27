import { useEffect, useRef, useState } from "react";
import { useWebSocketSubscription } from "./useWebSocket";
import {
  type HistogramItem,
  useHistogramCache,
} from "@/modules/histogram/useHistogramCache";
import type { Resolution } from "@/lib/resolution";

interface ActiveRange {
  resolution: string;
  start: Date;
  end: Date;
  addedAt: number;
  key: string;
}
interface Snapshot {
  reference: HistogramItem[];
  items: Map<string, string>;
  start: number;
  end: number;
}
/** Collection-only events trigger canonical refetches. Highlight only confirmed changed bins. */
export function useTimelineRecalc() {
  const [activeRanges, setActiveRanges] = useState<ActiveRange[]>([]);
  const data = useHistogramCache((state) => state.data);
  const pending = useRef(new Map<Resolution, Snapshot>());
  const onChange = (
    message: { event?: string; data?: { collection?: string } },
  ) => {
    if (
      message.event !== "mongo.change" && message.event !== "resync_required"
    ) return;
    const cache = useHistogramCache.getState();
    for (
      const resolution of ["5min", "1hour", "1day", "1week"] as Resolution[]
    ) {
      if (
        message.event !== "resync_required" &&
        message.data?.collection !== `histogram_${resolution}`
      ) continue;
      const items = cache.data[resolution]?.items;
      if (items?.length && !pending.current.has(resolution)) {
        pending.current.set(resolution, {
          reference: items,
          items: new Map(
            items.map((item) => [item.id, JSON.stringify(item.totals)]),
          ),
          start: Math.min(
            ...items.map((item) => new Date(item.start).getTime()),
          ),
          end: Math.max(...items.map((item) => new Date(item.end).getTime())),
        });
      }
    }
    cache.scheduleInvalidation();
  };
  useWebSocketSubscription("mongo:histogram_5min", onChange);
  useWebSocketSubscription("mongo:histogram_1hour", onChange);
  useWebSocketSubscription("mongo:histogram_1day", onChange);
  useWebSocketSubscription("mongo:histogram_1week", onChange);
  useEffect(() => {
    const ranges: ActiveRange[] = [];
    for (const [resolution, before] of pending.current) {
      const items = data[resolution]?.items;
      if (!items?.length || items === before.reference) continue;
      for (const item of items) {
        const start = new Date(item.start), end = new Date(item.end);
        if (
          start.getTime() < before.start || start.getTime() >= before.end ||
          before.items.get(item.id) === JSON.stringify(item.totals)
        ) continue;
        ranges.push({
          resolution,
          start,
          end,
          addedAt: Date.now(),
          key: `${resolution}:${item.id}`,
        });
      }
      pending.current.delete(resolution);
    }
    if (ranges.length) {
      setActiveRanges((previous) => [
        ...previous.filter((range) =>
          !ranges.some((next) => next.key === range.key)
        ),
        ...ranges,
      ]);
    }
  }, [data]);
  useEffect(() => {
    const timer = setInterval(
      () =>
        setActiveRanges((previous) =>
          previous.filter((range) => Date.now() - range.addedAt < 10_000)
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return { activeRanges };
}
