import { useEffect, useMemo, useSyncExternalStore } from "react";
import { callResource } from "@/lib/api";

interface Transcript {
  _id: string;
  segments: { text: string; start: number; end: number }[];
  start: Date;
  end: Date;
}

export const useTranscripts = (cursorDate: Date | null) => {
  const transcripts = useSyncExternalStore(subscribe, snapshot, snapshot);

  const bucketMs = 5000;
  const bucketKey = useMemo(() => {
    if (!cursorDate) return null;
    return Math.floor(cursorDate.getTime() / bucketMs) * bucketMs;
  }, [cursorDate]);

  useEffect(() => {
    if (!cursorDate || bucketKey === null) return;
    if (inFlightBuckets.has(bucketKey)) return;
    if (lastFetchedBucket !== null && bucketKey === lastFetchedBucket) return;

    const requestGeneration = generation;
    const controller = new AbortController();
    inFlightBuckets.set(bucketKey, controller);

    const delta = 25 * 60 * 1000;
    const startTime = new Date(cursorDate.getTime() - delta);
    const endTime = new Date(cursorDate.getTime() + delta);

    callResource("mongo", {
      action: "find",
      collection: "transcriptions",
      query: {
        start: {
          $gte: startTime,
          $lte: endTime,
        },
        segments: { $exists: true },
      },
      options: { limit: 50, sort: { start: 1 } },
    }, { signal: controller.signal })
      .then((data) => {
        if (
          requestGeneration !== generation || controller.signal.aborted ||
          !Array.isArray(data)
        ) return;
        cachedTranscripts = data;
        lastFetchedBucket = bucketKey;
        notify();
      })
      .catch((error) => {
        if (requestGeneration === generation && !controller.signal.aborted) {
          console.error("Failed to get transcripts:", error);
        }
      })
      .finally(() => {
        if (inFlightBuckets.get(bucketKey) === controller) {
          inFlightBuckets.delete(bucketKey);
        }
      });
  }, [bucketKey, cursorDate]);

  return { transcripts };
};

let cachedTranscripts: Transcript[] = [];
let lastFetchedBucket: number | null = null;
let generation = 0;
const inFlightBuckets = new Map<number, AbortController>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => cachedTranscripts;
const notify = () => {
  for (const listener of listeners) listener();
};

/** Clear account data and reject responses from the previous session. */
export function resetTranscriptCache() {
  generation++;
  for (const controller of inFlightBuckets.values()) controller.abort();
  inFlightBuckets.clear();
  cachedTranscripts = [];
  lastFetchedBucket = null;
  notify();
}
