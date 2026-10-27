import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { callResource } from "@/lib/api";

export interface HistogramItem {
  _id: { $oid: string } | string;
  start: Date;
  end?: Date;
  topics?: unknown[];
}

interface TopicsState {
  items: HistogramItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  fetchInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

const PAGE_SIZE = 50;
const MAX_KEEP = 400;
const DEBOUNCE_MS = 300;

const seenIds = new Set<string>();
let lastLoadMs = 0;
let generation = 0;

function getIdKey(item: HistogramItem): string {
  return typeof item._id === "string" ? item._id : JSON.stringify(item._id);
}

async function fetchPage(beforeStart: Date | null): Promise<HistogramItem[]> {
  const query: Record<string, unknown> = { topics: { $exists: true, $ne: [] } };
  if (beforeStart) query.start = { $lt: beforeStart };
  const result = await callResource("mongo", {
    action: "find",
    collection: "histogram_5min",
    query,
    options: { sort: { start: -1 }, limit: PAGE_SIZE },
  });
  return result as HistogramItem[];
}

export const useTopicsStore = create<TopicsState>()(
  devtools((set, get) => ({
    items: [],
    loading: false,
    loadingMore: false,
    error: null,

    reset: () => {
      generation++;
      seenIds.clear();
      lastLoadMs = 0;
      set({ items: [], loading: false, loadingMore: false, error: null });
    },

    fetchInitial: async () => {
      if (get().loading || get().items.length > 0) return;
      const requestGeneration = generation;
      set({ loading: true, error: null });
      try {
        const firstPage = await fetchPage(null);
        if (requestGeneration !== generation) return;
        const deduped: HistogramItem[] = [];
        for (const it of firstPage) {
          const key = getIdKey(it);
          if (!seenIds.has(key)) {
            seenIds.add(key);
            deduped.push(it);
          }
        }
        set({ items: deduped });
      } catch (err) {
        if (requestGeneration !== generation) return;
        set({
          error: err instanceof Error ? err.message : "Failed to fetch topics",
        });
      } finally {
        if (requestGeneration === generation) set({ loading: false });
      }
    },

    loadMore: async () => {
      if (get().loadingMore) return;
      const requestGeneration = generation;
      const now = Date.now();
      if (now - lastLoadMs < DEBOUNCE_MS) return;
      lastLoadMs = now;

      const items = get().items;
      if (items.length === 0) {
        // If nothing loaded yet, fall back to initial fetch
        await get().fetchInitial();
        return;
      }

      const oldest = items[items.length - 1];
      const beforeStart = new Date(oldest.start);

      set({ loadingMore: true });
      try {
        const page = await fetchPage(beforeStart);
        if (requestGeneration !== generation) return;
        if (page.length === 0) return;
        const merged: HistogramItem[] = [...get().items];
        for (const it of page) {
          const key = getIdKey(it);
          if (!seenIds.has(key)) {
            seenIds.add(key);
            merged.push(it);
          }
        }
        const trimmed = merged.length > MAX_KEEP
          ? merged.slice(0, MAX_KEEP)
          : merged;
        set({ items: trimmed });
      } finally {
        if (requestGeneration === generation) set({ loadingMore: false });
      }
    },
  }), { name: "topics-store" }),
);
