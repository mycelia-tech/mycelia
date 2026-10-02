import { useEffect, useMemo } from "react";
import { getResolutionForDuration, RESOLUTION_TO_MS } from "@/lib/resolution";
import { type HistogramItem, useHistogramCache } from "./useHistogramCache";
import { useWebSocketSubscription } from "@/hooks/useWebSocket";

export type { HistogramItem };

export function useHistogramItems(start: Date, end: Date) {
  const {
    data,
    generation,
    fetchMissingRanges,
    indexByResolution,
    scheduleInvalidation,
  } = useHistogramCache();

  const duration = end.getTime() - start.getTime();
  const resolution = getResolutionForDuration(duration);

  const binSize = RESOLUTION_TO_MS[resolution];
  const queryStart = start.getTime() - duration - binSize;
  const queryEnd = end.getTime() + duration + binSize;

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchMissingRanges(resolution, queryStart, queryEnd);
    }, 300);
    return () => clearTimeout(timer);
  }, [generation, resolution, queryStart, queryEnd, fetchMissingRanges]);

  const onHistogramChange = (message: any) => {
    if (
      message.event === "resync_required" ||
      message.event === "mongo.change" &&
        message.data?.collection?.startsWith("histogram_")
    ) scheduleInvalidation();
  };
  // These are exact server channels; a burst across resolutions and mounted
  // consumers shares one cache invalidation and refreshes each current viewport.
  useWebSocketSubscription("mongo:histogram_5min", onHistogramChange);
  useWebSocketSubscription("mongo:histogram_1hour", onHistogramChange);
  useWebSocketSubscription("mongo:histogram_1day", onHistogramChange);
  useWebSocketSubscription("mongo:histogram_1week", onHistogramChange);

  const filteredItems = useMemo(() => {
    const idx = indexByResolution[resolution];
    if (!idx) {
      return data[resolution]?.items ?? [];
    }
    idx.tsDim.filterRange([queryStart, queryEnd]);
    const rows = idx.tsDim.top(Infinity) as HistogramItem[];
    idx.tsDim.filterAll();
    return rows;
  }, [
    resolution,
    indexByResolution[resolution]?.cf,
    data[resolution]?.items,
    queryStart,
    queryEnd,
  ]);

  return {
    items: filteredItems,
    resolution,
  };
}
