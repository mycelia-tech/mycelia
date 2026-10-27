import { useEffect, useRef } from "react";
import { useWebSocketSubscription } from "./useWebSocket";

export interface MongoChange {
  collection: string;
  documentId: string;
  operationType: string;
  changedFields?: string[];
}
/** Coalesce notification bursts. Documents are always fetched through the authorized API. */
export function useMongoChanges(
  channel: string,
  onChanges: (changes: MongoChange[]) => void | Promise<void>,
) {
  const callback = useRef(onChanges);
  callback.current = onChanges;
  const running = useRef(false);
  const alive = useRef(true);
  const pending = useRef(new Map<string, MongoChange>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      pending.current.clear();
    };
  }, [channel]);
  const schedule = () => {
    if (
      !alive.current || running.current || timer.current !== undefined ||
      !pending.current.size
    ) return;
    timer.current = setTimeout(async () => {
      timer.current = undefined;
      running.current = true;
      const changes = [...pending.current.values()];
      pending.current.clear();
      try {
        await callback.current(changes);
      } finally {
        running.current = false;
        schedule();
      }
    }, 200);
  };
  useWebSocketSubscription(channel, (message) => {
    const change = message.data;
    if (
      message.event !== "mongo.change" ||
      typeof change?.collection !== "string" ||
      typeof change?.documentId !== "string"
    ) return;
    const key = `${change.collection}:${change.documentId}`;
    const previous = pending.current.get(key);
    pending.current.set(key, {
      ...change,
      operationType: previous && previous.operationType !== "update"
        ? previous.operationType
        : change.operationType,
      changedFields: [
        ...new Set([
          ...(previous?.changedFields ?? []),
          ...(change.changedFields ?? []),
        ]),
      ],
    });
    schedule();
  });
}
