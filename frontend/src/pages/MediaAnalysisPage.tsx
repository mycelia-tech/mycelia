import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Images,
  LayoutGrid,
  List,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import { DateRangePicker } from "@/components/DateRangePicker";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { cn } from "@/lib/utils";
import { getMediaRecognitionBatchProgress } from "@/lib/mediaRecognitionBatchProgress";
import { zonedDateKey, zonedDateKeyToDate } from "@/lib/datePicker";
import { resolveDefaultTimeZone } from "@/lib/timeZones";
import { useSettingsStore } from "@/stores/settingsStore";
import { AuthenticatedMediaImage } from "@/components/media/AuthenticatedMediaImage";
import { MediaSectionNav } from "@/components/media/MediaSectionNav";
import { MediaHint } from "@/components/media/MediaHint";
import { MediaResultPanel } from "@/components/media/MediaResultPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type InventoryFilter =
  | "all"
  | "unprocessed"
  | "processing"
  | "ready"
  | "needs_attention"
  | "ignored";
type PlacementFilter = "all" | "missing_time" | "missing_location";
type RecognitionTask = "visual-understanding" | "ocr";
type SelectionMode = "explicit" | "all_matching";
type MediaSortBy =
  | "capturedAt"
  | "createdAt"
  | "fileName"
  | "status"
  | "byteLength"
  | "updatedAt";
const RECOGNITION_TASKS: RecognitionTask[] = [
  "visual-understanding",
  "ocr",
];

interface Filters {
  providerProfileId?: string;
  importCampaignId?: string;
  inventoryFilter: InventoryFilter;
  placement: PlacementFilter;
  query: string;
  capturedFrom: string;
  capturedTo: string;
}

interface Asset {
  currentRunId?: string;
  _id: unknown;
  fileName: string;
  status: string;
  byteLength?: number;
  thumbnailUrl?: string;
  previewUrl?: string;
  preview?: { fileId?: unknown };
  capturedAt?: string | Date;
  location?: { latitude: number; longitude: number };
  safeError?: string;
  source?: { relativePath?: string };
  storageMode?: string;
  managedOriginal?: { fileId?: unknown };
  metadata?: Record<string, unknown>;
  inventory?: {
    shortCaption?: string;
    ocrPageCount?: number;
    annotationCount?: number;
  };
  recognitionIgnoredAt?: string | Date;
}

interface Batch {
  _id: unknown;
  status: string;
  profileName?: string;
  requestedTasks?: RecognitionTask[];
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  coordinatorJobId?: unknown;
  updatedAt?: string | Date;
  createdAt?: string | Date;
}

const PAGE_SIZE = 100;
const ACTIVE_BATCH_STATES = new Set(["queued", "running", "paused"]);
const PROCESSABLE_STATES = new Set([
  "staged",
  "failed",
  "budget_blocked",
  "recognition_disabled",
]);

interface SingleAssetEligibility {
  eligible: boolean;
  title: string;
  description: string;
}

function idOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "$oid" in value) {
    return String((value as { $oid: unknown }).$oid);
  }
  return String(value ?? "");
}

function parsedInventoryFilter(value: string | null): InventoryFilter {
  if (
    value === "unprocessed" || value === "processing" || value === "ready" ||
    value === "needs_attention" || value === "ignored"
  ) return value;
  return "all";
}

function parsedPlacement(value: string | null): PlacementFilter {
  if (value === "missing_time" || value === "missing_location") return value;
  return "all";
}

function captureDateBoundary(
  value: string,
  timeZone: string,
  end = false,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const boundary = zonedDateKeyToDate(value, timeZone);
  if (!boundary) return undefined;
  if (!end) return boundary.toISOString();

  const [year, month, day] = value.split("-").map(Number);
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextKey = [
    nextCalendarDay.getUTCFullYear(),
    String(nextCalendarDay.getUTCMonth() + 1).padStart(2, "0"),
    String(nextCalendarDay.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const nextBoundary = zonedDateKeyToDate(nextKey, timeZone);
  return nextBoundary
    ? new Date(nextBoundary.getTime() - 1).toISOString()
    : undefined;
}

function recognitionFilterRequest(filters: Filters, timeZone: string) {
  const capturedFrom = captureDateBoundary(filters.capturedFrom, timeZone);
  const capturedTo = captureDateBoundary(filters.capturedTo, timeZone, true);
  return {
    inventoryFilter: filters.inventoryFilter,
    ...(filters.providerProfileId
      ? { providerProfileId: filters.providerProfileId }
      : {}),
    ...(filters.importCampaignId
      ? { importCampaignId: filters.importCampaignId }
      : {}),
    placement: filters.placement,
    ...(filters.query ? { query: filters.query } : {}),
    ...(capturedFrom ? { capturedFrom } : {}),
    ...(capturedTo ? { capturedTo } : {}),
  };
}

function filterRequest(filters: Filters, timeZone: string) {
  return {
    ...recognitionFilterRequest(filters, timeZone),
    kind: "image",
  };
}

function filterKey(filters: Filters, timeZone: string): string {
  return JSON.stringify(filterRequest(filters, timeZone));
}

function hasRetainedOriginal(asset: Asset): boolean {
  return (asset.storageMode === "managed_original" &&
    Boolean(asset.managedOriginal?.fileId)) ||
    (asset.storageMode === "external_reference" &&
      Boolean(asset.source?.relativePath));
}

function hasRecognitionPreview(asset: Asset): boolean {
  return Boolean(asset.preview?.fileId);
}

function isBatchSelectableAsset(asset: Asset, reanalyze = false): boolean {
  return (!asset.currentRunId || reanalyze) &&
    (PROCESSABLE_STATES.has(asset.status) ||
      (reanalyze && asset.status === "ready")) &&
    hasRetainedOriginal(asset) &&
    hasRecognitionPreview(asset);
}

function formattedDate(value: unknown): string {
  if (!value) return "Time not set";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "Time not set";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusTone(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ready" || status === "completed") return "default";
  if (
    status === "failed" || status === "budget_blocked" ||
    status === "source_missing" || status === "source_changed" ||
    status === "completed_with_errors"
  ) return "destructive";
  if (
    status === "queued" || status === "running" ||
    status === "processing" || status === "paused"
  ) return "secondary";
  return "outline";
}

function resultCopy(asset: Asset): string {
  return asset.inventory?.shortCaption ?? asset.safeError ??
    (asset.status === "ready"
      ? "Analysis is ready"
      : "No visual description yet");
}

function singleAssetEligibility(
  asset: Asset,
  reanalyze = false,
): SingleAssetEligibility {
  if ((asset.status === "ready" || asset.currentRunId) && !reanalyze) {
    return {
      eligible: false,
      title: "Photo analysis is already ready",
      description:
        "Ready photos are skipped by recognition batches. Stored provider results and history are shown below; a missing visual description is not queued again while this photo remains ready.",
    };
  }
  if (asset.status === "queued" || asset.status === "processing") {
    return {
      eligible: false,
      title: "Description is already in progress",
      description:
        "This photo is already queued or processing, so it cannot be added to another recognition batch.",
    };
  }
  if (asset.status === "source_missing") {
    return {
      eligible: false,
      title: "Original photo is unavailable",
      description: asset.safeError ??
        "The mounted original cannot be found. Restore it at the imported path before requesting a description.",
    };
  }
  if (asset.status === "source_changed") {
    return {
      eligible: false,
      title: "Original photo changed",
      description: asset.safeError ??
        "The file at the mounted path no longer matches the imported photo. Sync the folder again before requesting a description.",
    };
  }
  if (
    !PROCESSABLE_STATES.has(asset.status) &&
    !(reanalyze && asset.status === "ready")
  ) {
    return {
      eligible: false,
      title: "Photo is not eligible for analysis",
      description:
        "Its current state is not accepted by a new recognition batch.",
    };
  }
  if (!hasRetainedOriginal(asset)) {
    return {
      eligible: false,
      title: "No retained original is available",
      description:
        "This record has a preview but no managed original or mounted-file reference that recognition can read.",
    };
  }
  if (!hasRecognitionPreview(asset)) {
    return {
      eligible: false,
      title: "Photo preview is unavailable",
      description:
        "The derived preview was deleted or is missing. Rebuild it from the retained original before requesting analysis.",
    };
  }
  return {
    eligible: true,
    title: "Ready to review one photo",
    description:
      "Only this photo is selected. Reviewing creates a local receipt and verifies the original; it does not call the provider.",
  };
}

export default function MediaAnalysisPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultTimeZone = useSettingsStore((state) => state.defaultTimeZone);
  const timeZone = resolveDefaultTimeZone(defaultTimeZone);
  const inventoryFilterParam = searchParams.get("status");
  const reanalyze = searchParams.get("reanalyze") === "1";
  const providerFilter = searchParams.get("provider") ?? "";
  const importFilter = searchParams.get("import") ?? "";
  const placementParam = searchParams.get("placement");
  const queryParam = searchParams.get("query");
  const capturedFromParam = searchParams.get("from");
  const capturedToParam = searchParams.get("to");
  const filters = useMemo<Filters>(() => ({
    providerProfileId: providerFilter,
    importCampaignId: importFilter,
    inventoryFilter: parsedInventoryFilter(inventoryFilterParam),
    placement: parsedPlacement(placementParam),
    query: queryParam?.trim() ?? "",
    capturedFrom: capturedFromParam ?? "",
    capturedTo: capturedToParam ?? "",
  }), [
    providerFilter,
    importFilter,
    capturedFromParam,
    capturedToParam,
    inventoryFilterParam,
    placementParam,
    queryParam,
  ]);
  const currentFilterKey = useMemo(
    () => filterKey(filters, timeZone),
    [filters, timeZone],
  );
  const captureRange = useMemo(() => {
    const start = zonedDateKeyToDate(filters.capturedFrom, timeZone);
    if (!start) return undefined;
    const end = zonedDateKeyToDate(filters.capturedTo, timeZone) ?? undefined;
    return { start, ...(end ? { end } : {}) };
  }, [filters.capturedFrom, filters.capturedTo, timeZone]);
  const captureEndOnly = !filters.capturedFrom
    ? zonedDateKeyToDate(filters.capturedTo, timeZone)
    : null;
  const viewMode = searchParams.get("view") === "table" ? "table" : "grid";
  const requestedSort = searchParams.get("sort") as MediaSortBy | null;
  const sortBy: MediaSortBy = requestedSort && [
      "capturedAt",
      "createdAt",
      "fileName",
      "status",
      "byteLength",
      "updatedAt",
    ].includes(requestedSort)
    ? requestedSort
    : "capturedAt";
  const sortDirection = searchParams.get("direction") === "asc"
    ? "asc"
    : "desc";
  const selectedAssetId = searchParams.get("assetId") ?? "";
  const selectRequested = searchParams.get("select") === "1";
  const bulkSelectionRequested = searchParams.get("selection") === "all";
  const requestedAssetIds = useMemo(
    () =>
      (searchParams.get("assetIds") ?? "").split(",").filter((value) =>
        /^[a-f\d]{24}$/i.test(value)
      ),
    [searchParams],
  );

  const [queryDraft, setQueryDraft] = useState(filters.query);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string>();
  const cursorRef = useRef<string | undefined>(undefined);
  const loadedAssetCountRef = useRef(0);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const requestActiveRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loadedFilterKey, setLoadedFilterKey] = useState("");

  const [status, setStatus] = useState<any>();
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [batches, setBatches] = useState<Batch[]>([]);
  const batchSignatureRef = useRef("");
  const [batchError, setBatchError] = useState<string>();

  const [selectionMode, setSelectionMode] = useState<SelectionMode>("explicit");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [profileId, setProfileId] = useState("");
  const [preview, setPreview] = useState<any>();
  const [previewReceiptContextKey, setPreviewReceiptContextKey] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [batchAction, setBatchAction] = useState("");
  const [detail, setDetail] = useState<any>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingAllMatchingFilterKey, setPendingAllMatchingFilterKey] =
    useState("");
  const autoSelectionRef = useRef("");
  const bulkSelectionRef = useRef("");
  const reviewBatchButtonRef = useRef<HTMLButtonElement>(null);
  const sortedSelectedIds = useMemo(
    () => Array.from(selectedIds).sort(),
    [selectedIds],
  );
  const previewSelection = useMemo(() => {
    const shared = {
      ...recognitionFilterRequest(filters, timeZone),
      ...(reanalyze ? { reanalyze: true } : {}),
    };
    return selectionMode === "all_matching"
      ? { mode: "all_matching" as const, ...shared }
      : {
        mode: "explicit" as const,
        ...shared,
        assetIds: sortedSelectedIds,
      };
  }, [filters, selectionMode, sortedSelectedIds, timeZone, reanalyze]);
  const previewRequestContextKey = useMemo(
    () =>
      JSON.stringify({
        filterKey: currentFilterKey,
        selection: previewSelection,
        profileId,
      }),
    [currentFilterKey, previewSelection, profileId],
  );
  const previewRequestGenerationRef = useRef(0);
  const latestPreviewRequestContextRef = useRef(previewRequestContextKey);
  const latestPreviewFilterKeyRef = useRef(currentFilterKey);

  useLayoutEffect(() => {
    latestPreviewRequestContextRef.current = previewRequestContextKey;
    latestPreviewFilterKeyRef.current = currentFilterKey;
    previewRequestGenerationRef.current += 1;
    setPreview(undefined);
    setPreviewReceiptContextKey("");
    setPreviewing(false);
  }, [previewRequestContextKey]);

  const currentPreview = previewReceiptContextKey === previewRequestContextKey
    ? preview
    : undefined;

  useEffect(() => setQueryDraft(filters.query), [filters.query]);

  const updateParams = useCallback((changes: Record<string, string>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        const defaultValue = key === "status" || key === "placement"
          ? "all"
          : key === "view"
          ? "grid"
          : "";
        if (!value || value === defaultValue) next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const updateFilters = useCallback((changes: Record<string, string>) => {
    setPendingAllMatchingFilterKey("");
    updateParams(changes);
  }, [updateParams]);

  const loadAssets = useCallback(async (
    options: { append?: boolean; background?: boolean } = {},
  ) => {
    const append = Boolean(options.append);
    if (options.background && requestActiveRef.current) return;
    const cursor = append ? cursorRef.current : undefined;
    if (append && !cursor) return;
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    requestActiveRef.current = true;
    if (!options.background) {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setLoadError(undefined);
    }
    try {
      const loadAssetPage = (pageCursor?: string, limit = PAGE_SIZE) =>
        callResource("media", {
          action: "listAssets",
          limit,
          ...filterRequest(filters, timeZone),
          sortBy,
          sortDirection,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        }, { signal: controller.signal });
      const loadRefreshedPrefix = async () => {
        const target = loadedAssetCountRef.current > 0
          ? loadedAssetCountRef.current
          : PAGE_SIZE;
        const refreshed: Asset[] = [];
        let refreshCursor: string | undefined;
        let total = 0;
        do {
          const page = await loadAssetPage(
            refreshCursor,
            Math.min(500, Math.max(1, target - refreshed.length)),
          );
          refreshed.push(...((page.assets ?? []) as Asset[]));
          total = Number(page.total ?? total);
          refreshCursor = page.nextCursor ? String(page.nextCursor) : undefined;
        } while (refreshCursor && refreshed.length < target);
        return { assets: refreshed, total, nextCursor: refreshCursor };
      };
      const result = options.background
        ? await loadRefreshedPrefix()
        : await loadAssetPage(cursor);
      if (generation !== generationRef.current) return;
      const page = (result.assets ?? []) as Asset[];
      if (append) loadedAssetCountRef.current += page.length;
      else loadedAssetCountRef.current = page.length;
      setAssets((current) => {
        if (!append) {
          return page;
        }
        const merged = new Map<string, Asset>();
        for (const asset of current.concat(page)) {
          merged.set(idOf(asset._id), asset);
        }
        const next = Array.from(merged.values());
        return next;
      });
      const next = result.nextCursor ? String(result.nextCursor) : undefined;
      cursorRef.current = next;
      setNextCursor(next);
      setTotal(Number(result.total ?? page.length));
      setLoadedFilterKey(currentFilterKey);
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) return;
      if (generation !== generationRef.current) return;
      if (!options.background) {
        setLoadError(
          error instanceof Error ? error.message : "Photo inventory failed",
        );
      }
    } finally {
      if (generation === generationRef.current) {
        requestActiveRef.current = false;
        if (!options.background) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }
  }, [currentFilterKey, filters, sortBy, sortDirection, timeZone]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(
        await callResource("media-library", { action: "summary" }) ?? {},
      );
    } catch {
      // The filtered list remains useful without optional summary counters.
    }
  }, []);

  const loadBatches = useCallback(async () => {
    try {
      const result = await callResource("media-library", {
        action: "listRecognitionBatches",
        limit: 8,
      });
      const next = (result.batches ?? []) as Batch[];
      setBatches(next);
      setBatchError(undefined);
      const signature = JSON.stringify(next.map((batch) => ({
        id: idOf(batch._id),
        status: batch.status,
        counts: batch.counts,
        updatedAt: batch.updatedAt,
      })));
      if (
        batchSignatureRef.current && batchSignatureRef.current !== signature
      ) {
        void loadAssets({ background: true });
        void loadSummary();
      }
      batchSignatureRef.current = signature;
    } catch (error) {
      setBatchError(
        error instanceof Error ? error.message : "Batch status unavailable",
      );
    }
  }, [loadAssets, loadSummary]);

  useEffect(() => {
    cursorRef.current = undefined;
    loadedAssetCountRef.current = 0;
    setAssets([]);
    setTotal(0);
    setNextCursor(undefined);
    setLoadedFilterKey("");
    setSelectionMode("explicit");
    setSelectedIds(new Set());
    setPreview(undefined);
    void loadAssets();
    return () => abortRef.current?.abort();
  }, [loadAssets]);

  useEffect(() => {
    if (!pendingAllMatchingFilterKey) return;
    if (pendingAllMatchingFilterKey !== currentFilterKey) return;
    if (loadError) {
      setPendingAllMatchingFilterKey("");
      return;
    }
    if (loading || loadedFilterKey !== pendingAllMatchingFilterKey) return;
    setSelectionMode(total > 0 ? "all_matching" : "explicit");
    setSelectedIds(new Set());
    setPreview(undefined);
    setPendingAllMatchingFilterKey("");
  }, [
    currentFilterKey,
    loadError,
    loadedFilterKey,
    loading,
    pendingAllMatchingFilterKey,
    total,
  ]);

  useEffect(() => {
    void callResource("media", { action: "photoSettings" }).then(setStatus)
      .catch(
        (error) =>
          toast.error(
            error instanceof Error ? error.message : "Media settings failed",
          ),
      );
    void loadSummary();
    void loadBatches();
  }, [loadBatches, loadSummary]);

  const hasActiveBatch = batches.some((batch) =>
    ACTIVE_BATCH_STATES.has(batch.status)
  );
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (globalThis.document?.visibilityState === "hidden") return;
      void loadBatches();
      if (!hasActiveBatch) {
        void loadAssets({ background: true });
        void loadSummary();
      }
    }, hasActiveBatch ? 3_000 : 15_000);
    return () => globalThis.clearInterval(timer);
  }, [hasActiveBatch, loadAssets, loadBatches, loadSummary]);

  const profiles = useMemo(
    () =>
      status?.enabled
        ? (status.profiles ?? []).filter((entry: any) => entry.enabled)
        : [],
    [status],
  );
  useEffect(() => {
    setProfileId((current) => {
      if (profiles.some((entry: any) => entry.id === current)) return current;
      const active = profiles.find((entry: any) =>
        entry.id === status?.activeProfileId
      );
      return String(active?.id ?? profiles[0]?.id ?? "");
    });
  }, [profiles, status?.activeProfileId]);
  const selectedProfile = profiles.find((entry: any) => entry.id === profileId);

  useEffect(() => {
    if (!selectedAssetId) {
      setDetail(undefined);
      return;
    }
    let current = true;
    setDetail(undefined);
    setDetailLoading(true);
    callResource("media", { action: "getAsset", assetId: selectedAssetId })
      .then((result) => current && setDetail(result))
      .catch((error) => {
        if (current) {
          toast.error(
            error instanceof Error ? error.message : "Photo details failed",
          );
        }
      })
      .finally(() => current && setDetailLoading(false));
    return () => {
      current = false;
    };
  }, [selectedAssetId]);

  useEffect(() => {
    if (!selectRequested || !selectedAssetId) {
      autoSelectionRef.current = "";
      return;
    }
    setSelectionMode("explicit");
    setSelectedIds(new Set());
    setPreview(undefined);
    autoSelectionRef.current = "";
  }, [selectRequested, selectedAssetId]);

  useEffect(() => {
    if (!selectRequested || !selectedAssetId || !detail?.asset) return;
    if (idOf(detail.asset._id) !== selectedAssetId) return;
    const selectionKey = `${selectedAssetId}:select=1:reanalyze=${reanalyze}`;
    if (autoSelectionRef.current === selectionKey) return;
    autoSelectionRef.current = selectionKey;
    const eligibility = singleAssetEligibility(
      detail.asset as Asset,
      reanalyze,
    );
    setSelectionMode("explicit");
    setSelectedIds(
      eligibility.eligible ? new Set([selectedAssetId]) : new Set(),
    );
    setPreview(undefined);
  }, [detail, selectRequested, selectedAssetId, reanalyze]);

  const scopeReady = loadedFilterKey === currentFilterKey && !loading &&
    !loadError;

  useEffect(() => {
    if (!scopeReady) return;
    const key = bulkSelectionRequested
      ? `all:${currentFilterKey}:${total}`
      : requestedAssetIds.length > 0
      ? `ids:${requestedAssetIds.join(",")}`
      : "";
    if (!key || bulkSelectionRef.current === key) return;
    bulkSelectionRef.current = key;
    setSelectionMode(bulkSelectionRequested ? "all_matching" : "explicit");
    setSelectedIds(
      bulkSelectionRequested ? new Set() : new Set(requestedAssetIds),
    );
    setPreview(undefined);
  }, [
    bulkSelectionRequested,
    currentFilterKey,
    requestedAssetIds,
    scopeReady,
    total,
  ]);

  const processableAssets = assets.filter((asset) =>
    isBatchSelectableAsset(asset, reanalyze)
  );
  const selectedCount = selectionMode === "all_matching"
    ? total
    : selectedIds.size;

  const clearSelection = () => {
    setSelectionMode("explicit");
    setSelectedIds(new Set());
    setPreview(undefined);
  };

  const toggleAsset = (assetId: string, checked: boolean) => {
    setSelectionMode("explicit");
    setPreview(undefined);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(assetId);
      else next.delete(assetId);
      return next;
    });
  };

  const selectAllMatchingForReview = () => {
    const targetFilters: Filters = {
      ...filters,
      inventoryFilter: reanalyze ? filters.inventoryFilter : "unprocessed",
    };
    const targetFilterKey = filterKey(targetFilters, timeZone);
    setSelectedIds(new Set());
    setPreview(undefined);

    if (
      targetFilterKey === currentFilterKey &&
      targetFilterKey === loadedFilterKey && scopeReady
    ) {
      setSelectionMode(total > 0 ? "all_matching" : "explicit");
      return;
    }

    setSelectionMode("explicit");
    setPendingAllMatchingFilterKey(targetFilterKey);
    updateParams({ status: targetFilters.inventoryFilter });
  };

  const previewBatch = async () => {
    if (!scopeReady || !profileId || selectedCount === 0) return;
    const requestGeneration = ++previewRequestGenerationRef.current;
    const requestContextKey = previewRequestContextKey;
    const requestFilterKey = currentFilterKey;
    const requestProfileId = profileId;
    const requestSelection = previewSelection;
    const isCurrentRequest = () =>
      requestGeneration === previewRequestGenerationRef.current &&
      requestContextKey === latestPreviewRequestContextRef.current &&
      requestFilterKey === latestPreviewFilterKeyRef.current;
    setPreviewing(true);
    try {
      const result = await callResource("media-library", {
        action: "previewRecognitionBatch",
        profileId: requestProfileId,
        requestedTasks: RECOGNITION_TASKS,
        selection: requestSelection,
      });
      if (!isCurrentRequest()) return;
      setPreview(result);
      setPreviewReceiptContextKey(requestContextKey);
      const reserved = Number(result.reservedByActiveBatchCount ?? 0);
      toast.success(
        "Prepared " + Number(result.eligibleCount ?? 0) +
          " exact photo(s); no provider call yet" +
          (reserved > 0 ? ` · ${reserved} already in another batch` : ""),
      );
    } catch (error) {
      if (!isCurrentRequest()) return;
      toast.error(
        error instanceof Error ? error.message : "Analysis preview failed",
      );
    } finally {
      if (isCurrentRequest()) setPreviewing(false);
    }
  };

  const setSelectionIgnored = async (ignored: boolean) => {
    if (!scopeReady || selectedCount === 0) return;
    if (
      !globalThis.confirm(
        ignored
          ? `Ignore ${selectedCount} selected photo(s) for future analysis? Existing results and files stay unchanged.`
          : `Return ${selectedCount} selected photo(s) to normal processing selection?`,
      )
    ) return;
    setBatchAction(ignored ? "ignore-selection" : "restore-selection");
    try {
      const result = await callResource("media-library", {
        action: "setRecognitionIgnored",
        selection: previewSelection,
        ignored,
        confirm: true,
      });
      toast.success(
        `${ignored ? "Ignored" : "Returned"} ${
          Number(result.updated ?? 0)
        } photo(s)`,
      );
      clearSelection();
      await Promise.all([loadAssets(), loadSummary()]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Selection update failed",
      );
    } finally {
      setBatchAction("");
    }
  };

  const confirmBatch = async () => {
    if (!currentPreview?.previewId) return;
    setConfirming(true);
    try {
      const result = await callResource("media-library", {
        action: "confirmRecognitionBatch",
        previewId: idOf(currentPreview.previewId),
        consent: true,
      });
      setPreview(undefined);
      clearSelection();
      if (result.batch) {
        setBatches((current) =>
          [
            result.batch,
            ...current.filter((entry) =>
              idOf(entry._id) !== idOf(result.batch._id)
            ),
          ].slice(0, 8)
        );
      }
      toast.success("Analysis batch queued; the library stays available");
      await Promise.all([loadAssets(), loadSummary(), loadBatches()]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Batch confirmation failed",
      );
    } finally {
      setConfirming(false);
    }
  };

  const changeBatch = async (
    batch: Batch,
    action: "cancelRecognitionBatch",
  ) => {
    const key = idOf(batch._id) + ":" + action;
    setBatchAction(key);
    try {
      await callResource("media-library", {
        action,
        batchId: idOf(batch._id),
        confirm: true,
      });
      await loadBatches();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Batch action failed",
      );
    } finally {
      setBatchAction("");
    }
  };

  const openAsset = (assetId: string) => updateParams({ assetId, select: "" });
  const closeAsset = () => updateParams({ assetId: "", select: "" });
  const selectedIndex = assets.findIndex((asset) =>
    idOf(asset._id) === selectedAssetId
  );
  const detailEligibility = detail?.asset
    ? singleAssetEligibility(detail.asset as Asset, reanalyze)
    : undefined;

  const continueToBatchReview = () => {
    closeAsset();
    globalThis.setTimeout(() => {
      reviewBatchButtonRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "center",
      });
      reviewBatchButtonRef.current?.focus();
    }, 0);
  };

  const assetCheckbox = (asset: Asset) => {
    const assetId = idOf(asset._id);
    return (
      <Checkbox
        aria-label={"Select " + asset.fileName}
        checked={selectionMode === "all_matching"
          ? isBatchSelectableAsset(asset, reanalyze)
          : selectedIds.has(assetId)}
        disabled={!scopeReady ||
          !(isBatchSelectableAsset(asset, reanalyze) ||
            asset.recognitionIgnoredAt) ||
          selectionMode === "all_matching"}
        onCheckedChange={(checked) => toggleAsset(assetId, checked === true)}
      />
    );
  };

  const metrics = [
    ["Photos", summary.all ?? total, Images],
    ["Ready", summary.ready ?? 0, CheckCircle2],
    ["Needs attention", summary.needsAttention ?? 0, AlertTriangle],
    ["Missing location", summary.missingLocation ?? 0, MapPin],
  ] as const;

  return (
    <div className="container mx-auto space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Sparkles className="h-6 w-6 text-primary" />Analysis
          </h1>
          <MediaSectionNav />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh photo analysis"
            title="Refresh"
            onClick={() => {
              void loadAssets();
              void loadSummary();
              void loadBatches();
            }}
          >
            <RefreshCw
              className={cn("h-4 w-4", loading && "animate-spin")}
            />
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/timeline">Timeline</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/map">Map</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/photo-analysis">Photo analysis settings</Link>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-muted/20 px-3 py-2">
        {metrics.map(([label, value, Icon]) => (
          <div key={label} className="flex items-center gap-2 text-sm">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">{Number(value)}</span>
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      <Card>
        <nav
          aria-label="Analysis views"
          className="flex flex-wrap gap-1 px-3 pt-3"
        >
          {([["unprocessed", "To analyze"], ["ready", "Results"], [
            "needs_attention",
            "Needs attention",
          ]] as const).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filters.inventoryFilter === value
                ? "secondary"
                : "ghost"}
              onClick={() => updateFilters({ status: value })}
            >
              {label}
            </Button>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          <select
            aria-label="Result provider"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={providerFilter}
            onChange={(event) =>
              updateFilters({ provider: event.target.value })}
          >
            <option value="">All result providers</option>
            {(status?.profiles ?? []).map((entry: any) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
          <select
            aria-label="Import batch"
            className="h-9 max-w-80 rounded-md border bg-background px-2 text-sm"
            value={importFilter}
            onChange={(event) => updateFilters({ import: event.target.value })}
          >
            <option value="">All imports</option>
            {(status?.importBatches ?? []).map((entry: any) => (
              <option key={idOf(entry._id)} value={idOf(entry._id)}>
                {entry.relativePath ?? "Import"} ·{" "}
                {formattedDate(entry.createdAt)}
              </option>
            ))}
          </select>
        </div>
        <CardHeader className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <CardTitle className="text-base">Photos</CardTitle>
              <MediaHint label="About analysis filters">
                Filters and sorting are stored in the URL. Batch review verifies
                originals and shows the exact eligible count and maximum cost
                before any provider call.
              </MediaHint>
            </div>
            <div className="inline-flex rounded-md border p-0.5">
              <Button
                size="icon"
                className="h-8 w-8"
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                aria-label="Grid view"
                aria-pressed={viewMode === "grid"}
                onClick={() => updateParams({ view: "grid" })}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                className="h-8 w-8"
                variant={viewMode === "table" ? "secondary" : "ghost"}
                aria-label="Table view"
                aria-pressed={viewMode === "table"}
                onClick={() => updateParams({ view: "table" })}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-3 pt-0">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 p-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" />
              Batch current filters
              <MediaHint label="About selecting all matching photos">
                Selects every matching unprocessed photo across all server
                pages, not only the loaded page. No provider is called until you
                review and confirm the exact batch.
              </MediaHint>
            </div>
            <Button
              size="sm"
              className="shrink-0"
              aria-label="Select all matching for review"
              disabled={!scopeReady ||
                Boolean(pendingAllMatchingFilterKey) ||
                (filters.inventoryFilter === "unprocessed" && total === 0)}
              onClick={selectAllMatchingForReview}
            >
              {pendingAllMatchingFilterKey && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Select all matches
            </Button>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.3fr_repeat(4,minmax(0,0.7fr))]">
            <form
              className="space-y-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                updateFilters({ query: queryDraft.trim() });
              }}
            >
              <Label htmlFor="analysis-search">Search</Label>
              <div className="flex gap-2">
                <Input
                  id="analysis-search"
                  aria-label="Search imported photos"
                  value={queryDraft}
                  onChange={(event) => setQueryDraft(event.target.value)}
                  placeholder="Filename or imported source path"
                />
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Apply photo search"
                >
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </form>
            <div className="space-y-1.5">
              <Label htmlFor="analysis-status">Status</Label>
              <select
                id="analysis-status"
                aria-label="Status"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={filters.inventoryFilter}
                onChange={(event) =>
                  updateFilters({ status: event.target.value })}
              >
                <option value="all">Any status</option>
                <option value="unprocessed">Unprocessed</option>
                <option value="processing">Queued / processing</option>
                <option value="ready">Ready</option>
                <option value="needs_attention">Needs attention</option>
                <option value="ignored">Ignored</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="analysis-placement">Placement</Label>
              <select
                id="analysis-placement"
                aria-label="Placement"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={filters.placement}
                onChange={(event) =>
                  updateFilters({ placement: event.target.value })}
              >
                <option value="all">Any placement</option>
                <option value="missing_time">Missing time</option>
                <option value="missing_location">Missing location</option>
              </select>
            </div>
            <div className="space-y-1.5 lg:col-span-2">
              {captureEndOnly
                ? (
                  <div
                    role="group"
                    aria-labelledby="analysis-captured-through-label"
                    className="space-y-2"
                  >
                    <Label id="analysis-captured-through-label">
                      Captured through
                    </Label>
                    <DateTimePicker
                      value={captureEndOnly}
                      precision="date"
                      timeZone={timeZone}
                      onChange={(value) => {
                        if (value) {
                          updateFilters({ to: zonedDateKey(value, timeZone) });
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      No start date
                    </p>
                  </div>
                )
                : (
                  <DateRangePicker
                    label="Captured from / to"
                    placeholder="Any capture date"
                    precision="date"
                    allowOpenEnd
                    value={captureRange}
                    onChange={(value) =>
                      updateFilters({
                        from: zonedDateKey(value.start, timeZone),
                        to: value.end ? zonedDateKey(value.end, timeZone) : "",
                      })}
                  />
                )}
              {(filters.capturedFrom || filters.capturedTo) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => updateFilters({ from: "", to: "" })}
                >
                  Clear capture dates
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-label={`Select loaded (${processableAssets.length})`}
                disabled={!scopeReady || processableAssets.length === 0}
                onClick={() => {
                  setSelectionMode("explicit");
                  setSelectedIds(
                    new Set(
                      processableAssets.map((asset) => idOf(asset._id)),
                    ),
                  );
                  setPreview(undefined);
                }}
              >
                Page ({processableAssets.length})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={selectedCount === 0}
                onClick={clearSelection}
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!scopeReady || selectedCount === 0 ||
                  Boolean(batchAction)}
                onClick={() => void setSelectionIgnored(
                  filters.inventoryFilter !== "ignored",
                )}
              >
                {filters.inventoryFilter === "ignored" ? "Return" : "Ignore"}
              </Button>
              <Badge variant="secondary">
                {selectionMode === "all_matching"
                  ? total + " selected"
                  : selectedIds.size + " selected"}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Analysis provider"
                className="h-9 min-w-[220px] rounded-md border bg-background px-3 text-sm"
                value={profileId}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  setPreview(undefined);
                }}
              >
                <option value="">Choose provider</option>
                {profiles.map((entry: any) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={reanalyze}
                  onChange={(event) => {
                    clearSelection();
                    updateParams({
                      reanalyze: event.target.checked ? "1" : "",
                    });
                  }}
                />Reanalyze ready photos
              </label>
              <MediaHint label="About the analysis package">
                {selectedProfile?.providerType !== "google-cloud"
                  ? `Descriptions and visible text use the selected model. External pricing may be unknown. Reanalysis retains the previous successful result.`
                  : "Google batches use Vertex visual understanding and embedding plus strict-EU Vision OCR. Global Vision labels and objects stay off."}
              </MediaHint>
              <Button
                ref={reviewBatchButtonRef}
                size="sm"
                aria-label={`Review analysis batch (${selectedCount})`}
                disabled={!scopeReady || previewing || !profileId ||
                  selectedCount === 0}
                onClick={previewBatch}
              >
                {previewing
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Sparkles className="mr-2 h-4 w-4" />}
                Review batch ({selectedCount})
              </Button>
            </div>
          </div>

          {hasActiveBatch && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Badge variant="outline">Batch running</Badge>
              <MediaHint label="About the active batch">
                Existing batches continue in the background. You can keep
                browsing and prepare another exact selection.
              </MediaHint>
            </div>
          )}

          {currentPreview && (
            <div className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="font-medium">Exact provider preview</div>
                <div className="text-sm text-muted-foreground">
                  {Number(currentPreview.eligibleCount ?? 0)}{" "}
                  eligible photo(s) · {currentPreview.costKnown === false
                    ? "cost unknown — provider charges may apply; no monetary ceiling enforced"
                    : `maximum $${
                      Number(currentPreview.authorizedGrossUsd ?? 0).toFixed(2)
                    }`} · no provider call yet
                </div>
                {currentPreview.profile?.endpoint && (
                  <div className="mt-1 break-all text-sm">
                    {currentPreview.profile.endpoint} ·{" "}
                    {currentPreview.profile.model} ·{" "}
                    {currentPreview.profile.language} · up to{" "}
                    {currentPreview.profile.maxOutputTokens} output tokens/photo
                  </div>
                )}
                {Number(currentPreview.missingOriginalCount ?? 0) > 0 && (
                  <div className="text-sm text-amber-700 dark:text-amber-300">
                    {Number(currentPreview.missingOriginalCount)} selected{" "}
                    original(s){" "}
                    could not be read and were excluded. No provider call was
                    made.
                  </div>
                )}
                {Number(currentPreview.reservedByActiveBatchCount ?? 0) > 0 && (
                  <div className="text-sm text-amber-700 dark:text-amber-300">
                    {Number(currentPreview.reservedByActiveBatchCount)}{" "}
                    matching photo(s){" "}
                    are already reserved by another active batch and were
                    excluded.
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    setPreview(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={confirming ||
                    Number(currentPreview.eligibleCount ?? 0) === 0}
                  onClick={confirmBatch}
                >
                  {confirming && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}Confirm exact batch
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {assets.length} of {total} matching photo(s)</span>
            {loading && assets.length > 0 && (
              <span>
                <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />
                Updating…
              </span>
            )}
          </div>

          {loadError && (
            <div className="flex items-center justify-between rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
              <span>{loadError}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadAssets()}
              >
                Retry
              </Button>
            </div>
          )}

          {loading && assets.length === 0
            ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-52 animate-pulse rounded-lg bg-muted"
                  />
                ))}
              </div>
            )
            : assets.length === 0
            ? (
              <div className="rounded-xl border border-dashed p-10 text-center">
                <Images className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <div className="font-medium">No photos match these filters</div>
                <Button asChild variant="outline" className="mt-4">
                  <Link to="/media">Open import & library</Link>
                </Button>
              </div>
            )
            : viewMode === "grid"
            ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {assets.map((asset) => {
                  const assetId = idOf(asset._id);
                  return (
                    <article
                      key={assetId}
                      className={cn(
                        "group overflow-hidden rounded-lg border bg-card transition hover:border-primary/40 hover:shadow-sm",
                        selectionMode === "explicit" &&
                          selectedIds.has(assetId) &&
                          "border-primary ring-1 ring-primary",
                      )}
                    >
                      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
                        <button
                          type="button"
                          className="h-full w-full"
                          aria-label={"Open " + asset.fileName}
                          onClick={() => openAsset(assetId)}
                        >
                          <AuthenticatedMediaImage
                            path={asset.thumbnailUrl}
                            alt={asset.fileName}
                            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                          />
                        </button>
                        <div className="absolute left-2 top-2 rounded bg-background/90 p-1 shadow">
                          {assetCheckbox(asset)}
                        </div>
                        <Badge
                          className="absolute right-2 top-2"
                          variant={statusTone(asset.status)}
                        >
                          {asset.status}
                          {asset.recognitionIgnoredAt ? " · ignored" : ""}
                        </Badge>
                      </div>
                      <div className="space-y-1.5 p-3">
                        <div className="truncate font-medium">
                          {asset.fileName}
                        </div>
                        <p className="line-clamp-1 text-sm text-muted-foreground">
                          {resultCopy(asset)}
                        </p>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>{formattedDate(asset.capturedAt)}</span>
                          <span>{asset.location ? "GPS" : "No GPS"}</span>
                          {Number(asset.inventory?.ocrPageCount ?? 0) > 0 && (
                            <span>OCR {asset.inventory?.ocrPageCount}</span>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )
            : (
              <div className="overflow-x-auto rounded-md border">
                <Table className="text-sm">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <span className="sr-only">Select</span>
                      </TableHead>
                      {([
                        ["fileName", "Photo"],
                        ["capturedAt", "Captured"],
                        ["status", "Status"],
                      ] as Array<[MediaSortBy, string]>).map(([key, label]) => (
                        <TableHead key={key}>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="-ml-3"
                            onClick={() =>
                              updateParams({
                                sort: key,
                                direction: sortBy === key &&
                                    sortDirection === "asc"
                                  ? "desc"
                                  : "asc",
                              })}
                          >
                            {label}
                            <ArrowUpDown className="ml-2 h-3.5 w-3.5" />
                          </Button>
                        </TableHead>
                      ))}
                      <TableHead>Analysis result</TableHead>
                      <TableHead className="text-right">View</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assets.map((asset) => {
                      const assetId = idOf(asset._id);
                      return (
                        <TableRow key={assetId}>
                          <TableCell className="py-2">
                            {assetCheckbox(asset)}
                          </TableCell>
                          <TableCell className="py-2">
                            <div className="flex min-w-[210px] items-center gap-2">
                              <AuthenticatedMediaImage
                                path={asset.thumbnailUrl}
                                alt={asset.fileName}
                                className="h-10 w-10 rounded border object-cover"
                              />
                              <div>
                                <div className="max-w-[260px] truncate font-medium">
                                  {asset.fileName}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {(Number(asset.byteLength ?? 0) / 1_000_000)
                                    .toFixed(2)} MB
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-2 text-xs">
                            {formattedDate(asset.capturedAt)}
                          </TableCell>
                          <TableCell className="py-2">
                            <Badge variant={statusTone(asset.status)}>
                              {asset.status}
                              {asset.recognitionIgnoredAt ? " · ignored" : ""}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[340px] py-2">
                            <div className="line-clamp-1">
                              {resultCopy(asset)}
                            </div>
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              aria-label={`Open details for ${asset.fileName}`}
                              title="Open details"
                              onClick={() => openAsset(assetId)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadAssets({ append: true })}
              >
                {loadingMore && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}Load next {PAGE_SIZE}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Analysis batches</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Active batches refresh every three seconds without locking this
                workspace.
              </p>
            </div>
            {hasActiveBatch && <Badge variant="secondary">Live</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {batchError && (
            <div className="text-sm text-destructive">{batchError}</div>
          )}
          {batches.length === 0
            ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No recognition batches yet.
              </div>
            )
            : batches.map((batch) => {
              const batchId = idOf(batch._id);
              const progress = getMediaRecognitionBatchProgress(batch);
              const coordinatorJobId = idOf(batch.coordinatorJobId);
              const failed = Number(batch.counts?.failed ?? 0);
              return (
                <div key={batchId} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant={statusTone(batch.status)}>
                          {batch.status}
                        </Badge>
                        <span className="font-medium">
                          {batch.profileName ?? "Recognition provider"}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {(batch.requestedTasks ?? []).join(" + ") ||
                          "Stored task selection"}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {coordinatorJobId && (
                        <Button size="sm" variant="ghost" asChild>
                          <Link
                            to={`/jobs/${encodeURIComponent(coordinatorJobId)}`}
                            aria-label={`Open coordinator job for analysis batch ${batchId}`}
                          >
                            Open batch job
                          </Link>
                        </Button>
                      )}
                      {ACTIVE_BATCH_STATES.has(batch.status) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(batchAction)}
                          onClick={() =>
                            void changeBatch(batch, "cancelRecognitionBatch")}
                        >
                          {batchAction === batchId + ":cancelRecognitionBatch"
                            ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            )
                            : <Square className="mr-2 h-3.5 w-3.5" />}
                          Stop new calls
                        </Button>
                      )}
                      {failed > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            updateParams({
                              status: "needs_attention",
                              assetId: "",
                            });
                            clearSelection();
                            toast.info(
                              "Review the failed photos as a new exact batch with a new cost ceiling",
                            );
                          }}
                        >
                          <RefreshCw className="mr-2 h-3.5 w-3.5" />Review{" "}
                          {failed} in a new batch
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{progress.done} terminal of {progress.total}</span>
                      <span>{progress.percent.toFixed(1)}%</span>
                    </div>
                    <Progress
                      value={progress.percent}
                      className="h-2"
                      aria-label={`Analysis batch ${batchId} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.percent}
                      aria-valuetext={`${progress.done} of ${progress.total} photos complete`}
                    />
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {Object.entries(batch.counts ?? {})
                        .filter(([, count]) =>
                          Number(count) > 0
                        )
                        .map(([label, count]) => (
                          <span key={label}>{label} {count}</span>
                        ))}
                    </div>
                  </div>
                </div>
              );
            })}
        </CardContent>
      </Card>

      <Sheet
        open={Boolean(selectedAssetId)}
        onOpenChange={(open) => !open && closeAsset()}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl lg:max-w-2xl">
          <SheetHeader
            className={detail?.asset && !detailLoading ? "pr-8" : "sr-only"}
          >
            <SheetTitle>
              {detail?.asset?.fileName ?? "Photo details"}
            </SheetTitle>
            <SheetDescription>
              {detail?.asset?.source?.relativePath ??
                detail?.asset?.storageMode ??
                "Loading imported photo details"}
            </SheetDescription>
          </SheetHeader>
          {detailLoading
            ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-7 w-7 animate-spin" />
              </div>
            )
            : detail?.asset
            ? (
              <div className="space-y-5">
                <AuthenticatedMediaImage
                  path={detail.asset.previewUrl ?? detail.asset.thumbnailUrl}
                  alt={detail.asset.fileName}
                  className="max-h-[52vh] w-full rounded-xl border bg-muted object-contain"
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={statusTone(detail.asset.status)}>
                      {detail.asset.status}
                    </Badge>
                    <Badge variant="outline">
                      {formattedDate(detail.asset.capturedAt)}
                    </Badge>
                    <Badge variant="outline">
                      {detail.asset.location ? "GPS available" : "No GPS"}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    {detail.asset.kind === "image" && (
                      <>
                        {detail.asset.location && (
                          <Button asChild size="sm" variant="outline">
                            <Link
                              to={`/map?photoAssetId=${idOf(detail.asset._id)}`}
                            >
                              Map
                            </Link>
                          </Button>
                        )}
                        {detail.asset.capturedAt && (
                          <Button asChild size="sm" variant="outline">
                            <Link
                              to={`/timeline?photoAssetId=${
                                idOf(detail.asset._id)
                              }`}
                            >
                              Timeline
                            </Link>
                          </Button>
                        )}
                        {(detail.asset.currentRunId ||
                          detail.asset.status === "ready") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              updateParams({
                                reanalyze: "1",
                                select: "1",
                                status: "all",
                              })}
                          >
                            Reanalyze
                          </Button>
                        )}
                      </>
                    )}
                    {isBatchSelectableAsset(detail.asset as Asset, reanalyze) &&
                      (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setSelectionMode("explicit");
                            setSelectedIds((current) =>
                              new Set(current).add(idOf(detail.asset._id))
                            );
                            setPreview(undefined);
                            closeAsset();
                          }}
                        >
                          Select this photo
                        </Button>
                      )}
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label="Previous loaded photo"
                      disabled={selectedIndex <= 0}
                      onClick={() =>
                        openAsset(idOf(assets[selectedIndex - 1]?._id))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label="Next loaded photo"
                      disabled={selectedIndex < 0 ||
                        selectedIndex >= assets.length - 1}
                      onClick={() =>
                        openAsset(idOf(assets[selectedIndex + 1]?._id))}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {selectRequested && detailEligibility && (
                  <section
                    className={cn(
                      "space-y-3 rounded-xl border p-4",
                      detailEligibility.eligible
                        ? "border-primary/40 bg-primary/5"
                        : "border-amber-500/40 bg-amber-500/5",
                    )}
                    aria-label="Single photo description request"
                  >
                    <div className="flex items-start gap-3">
                      {detailEligibility.eligible
                        ? <Sparkles className="mt-0.5 h-5 w-5 text-primary" />
                        : (
                          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />
                        )}
                      <div className="space-y-1">
                        <div className="font-semibold">
                          {detailEligibility.title}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {detailEligibility.description}
                        </p>
                      </div>
                    </div>
                    {detailEligibility.eligible && (
                      <div className="space-y-2">
                        <Button
                          className="w-full sm:w-auto"
                          disabled={!profileId}
                          onClick={continueToBatchReview}
                        >
                          <Sparkles className="mr-2 h-4 w-4" />
                          Continue to Review analysis batch (1)
                        </Button>
                        {!profileId && (
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            Enable an analysis provider in Settings before
                            preparing the local review.
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                )}
                <MediaResultPanel detail={detail} />
              </div>
            )
            : (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Photo details are unavailable.
              </div>
            )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
