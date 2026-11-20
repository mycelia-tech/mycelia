import { create } from "zustand";
import {
  defaultTimelineRange,
  normalizeTimelineRange,
} from "@/lib/timelineViewport";

export interface TimelineRangeStore {
  start: Date;
  end: Date;
  setStart: (start: Date) => void;
  setEnd: (end: Date) => void;
  setRange: (start: Date, end: Date) => void;
  reset: () => void;
  duration: number;
  center: Date;
}

function updateURLParams(start: Date, end: Date) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("start", String(+start));
  url.searchParams.set("end", String(+end));
  window.history.replaceState(window.history.state, "", url);
}

function initialRange() {
  if (typeof window === "undefined") return defaultTimelineRange();
  const params = new URLSearchParams(window.location.search);
  if (!params.has("start") && !params.has("end")) return defaultTimelineRange();
  const fallback = defaultTimelineRange();
  const range = normalizeTimelineRange(
    params.has("start")
      ? new Date(Number(params.get("start")))
      : fallback.start,
    params.has("end") ? new Date(Number(params.get("end"))) : fallback.end,
  );
  updateURLParams(range.start, range.end);
  return range;
}

export const useTimelineRange = create<TimelineRangeStore>((set, get) => ({
  ...initialRange(),
  setStart: (start) => get().setRange(start, get().end),
  setEnd: (end) => get().setRange(get().start, end),
  setRange: (start, end) => {
    const range = normalizeTimelineRange(start, end);
    if (+get().start !== +range.start || +get().end !== +range.end) set(range);
    updateURLParams(range.start, range.end);
  },
  reset: () => {
    const range = defaultTimelineRange();
    get().setRange(range.start, range.end);
  },
  get center() {
    return new Date((+get().start + +get().end) / 2);
  },
  get duration() {
    return +get().end - +get().start;
  },
}));
