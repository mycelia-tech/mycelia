import { useCallback, useEffect, useRef, useState } from "react";
import { callResource } from "@/lib/api";
import { toast } from "sonner";

export type InventoryFilter =
  | "all"
  | "unprocessed"
  | "processing"
  | "ready"
  | "errors"
  | "ignored";
export type MediaSortBy =
  | "capturedAt"
  | "createdAt"
  | "fileName"
  | "status"
  | "byteLength"
  | "updatedAt";
type MediaInventoryOptions = {
  inventoryFilter: InventoryFilter;
  placementFilter: "all" | "missing_time" | "missing_location";
  sortBy: MediaSortBy;
  sortDirection: "asc" | "desc";
};

/** Owns inventory pagination and background refresh; callers own selection and asset actions. */
export function useMediaInventory(
  { inventoryFilter, placementFilter, sortBy, sortDirection }:
    MediaInventoryOptions,
  onReset: () => void,
) {
  const [status, setStatus] = useState<any>();
  const [assets, setAssets] = useState<any[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string>();
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryRefreshing, setInventoryRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>();
  const inventoryRequestGeneration = useRef(0);
  const inventoryRequestActive = useRef(false);
  const nextCursorRef = useRef<string | undefined>(undefined);
  const loadedAssetCountRef = useRef(0);

  const load = useCallback(async (
    options: { append?: boolean; silent?: boolean } = {},
  ) => {
    if (options.silent && inventoryRequestActive.current) return;
    const generation = ++inventoryRequestGeneration.current;
    const cursor = options.append ? nextCursorRef.current : undefined;
    if (options.append && !cursor) return;
    inventoryRequestActive.current = true;
    if (!options.silent) setInventoryLoading(true);
    setInventoryRefreshing(true);
    try {
      const backendFilter = inventoryFilter === "errors"
        ? "needs_attention"
        : inventoryFilter;
      const loadAssetPage = (pageCursor?: string, limit = 100) =>
        callResource("media", {
          action: "listAssets",
          limit,
          inventoryFilter: backendFilter,
          placement: placementFilter,
          sortBy,
          sortDirection,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        });
      const loadRefreshedPrefix = async () => {
        const target = loadedAssetCountRef.current > 0
          ? loadedAssetCountRef.current
          : 100;
        const refreshed: any[] = [];
        let refreshCursor: string | undefined;
        let total = 0;
        do {
          const page = await loadAssetPage(
            refreshCursor,
            Math.min(500, Math.max(1, target - refreshed.length)),
          );
          refreshed.push(...(page.assets ?? []));
          total = Number(page.total ?? total);
          refreshCursor = page.nextCursor ? String(page.nextCursor) : undefined;
        } while (refreshCursor && refreshed.length < target);
        return { assets: refreshed, total, nextCursor: refreshCursor };
      };
      const [nextStatus, nextAssets] = await Promise.all([
        callResource("media", { action: "status" }),
        options.silent ? loadRefreshedPrefix() : loadAssetPage(cursor),
      ]);
      if (generation !== inventoryRequestGeneration.current) return;
      setStatus(nextStatus);
      if (options.append) {
        loadedAssetCountRef.current += (nextAssets.assets ?? []).length;
      } else {
        loadedAssetCountRef.current = (nextAssets.assets ?? []).length;
      }
      setAssets((current) => {
        if (!options.append) {
          return nextAssets.assets ?? [];
        }
        const byId = new Map(
          [...current, ...(nextAssets.assets ?? [])].map((asset: any) => [
            String(asset._id),
            asset,
          ]),
        );
        const merged = [...byId.values()];
        return merged;
      });
      nextCursorRef.current = nextAssets.nextCursor;
      setNextCursor(nextAssets.nextCursor);
      setAssetTotal(Number(nextAssets.total ?? nextAssets.assets?.length ?? 0));
      setLastUpdatedAt(new Date());
    } catch (error) {
      if (generation !== inventoryRequestGeneration.current) return;
      toast.error(
        error instanceof Error ? error.message : "Failed to load Media Library",
      );
    } finally {
      if (generation === inventoryRequestGeneration.current) {
        inventoryRequestActive.current = false;
        setInventoryLoading(false);
        setInventoryRefreshing(false);
      }
    }
  }, [inventoryFilter, placementFilter, sortBy, sortDirection]);

  useEffect(() => {
    nextCursorRef.current = undefined;
    loadedAssetCountRef.current = 0;
    setNextCursor(undefined);
    onReset();
    void load();
  }, [load, onReset]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (globalThis.document?.visibilityState === "visible") {
        void load({ silent: true });
      }
    };
    const timer = globalThis.setInterval(refreshWhenVisible, 5_000);
    globalThis.document?.addEventListener(
      "visibilitychange",
      refreshWhenVisible,
    );
    return () => {
      globalThis.clearInterval(timer);
      globalThis.document?.removeEventListener(
        "visibilitychange",
        refreshWhenVisible,
      );
    };
  }, [load]);

  return {
    status,
    assets,
    assetTotal,
    nextCursor,
    inventoryLoading,
    inventoryRefreshing,
    lastUpdatedAt,
    load,
  };
}
