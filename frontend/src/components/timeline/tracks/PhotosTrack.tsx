import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import type { TrackConfig, TrackRenderProps } from "@/types/tracks";
import { useTimelineRange } from "@/stores/timelineRange";
import { callResource } from "@/lib/api";
import { AuthenticatedMediaImage } from "@/components/media/AuthenticatedMediaImage";
import {
  type PhotoCollectionItem,
  PhotoCollectionSheet,
} from "@/components/media/PhotoCollectionSheet";
import type { PhotoTimelineFocus } from "@/lib/photoTimelineDeepLink";
import { BaseTrack } from "./BaseTrack";

export const PHOTOS_CONFIG: TrackConfig = {
  id: "photos",
  label: "Photos",
  description: "Imported photo times; all statuses, with density fallback",
  defaultVisible: true,
  defaultHeight: 48,
  color: "#f97316",
};

const STATUS_COLOR: Record<string, string> = {
  staged: "#94a3b8",
  queued: "#f59e0b",
  processing: "#3b82f6",
  ready: "#22c55e",
  failed: "#ef4444",
  budget_blocked: "#ef4444",
  recognition_disabled: "#a855f7",
  source_missing: "#ef4444",
  source_changed: "#ef4444",
};

const MARKER_DIAMETER_PX = 26;
const MARKER_GROUP_DISTANCE_PX = MARKER_DIAMETER_PX + 4;
const PHOTO_SHEET_PAGE_SIZE = 100;

type TimelineResolution = "hour" | "day" | "month";

interface TimelinePhotoItem extends PhotoCollectionItem {
  capturedAt: string | Date;
}

interface TimelinePhotoBucket {
  start: string | Date;
  count: number;
  statuses?: Record<string, number>;
}

interface TimelinePhotoData {
  mode: "items" | "density";
  total: number;
  unplacedTimeCount: number;
  resolution?: TimelineResolution;
  items?: TimelinePhotoItem[];
  buckets?: TimelinePhotoBucket[];
}

interface PhotoMarkerGroup {
  x: number;
  items: TimelinePhotoItem[];
}

interface PhotoSheetState {
  key: string;
  kind: "markers" | "bucket" | "focus";
  title: string;
  description?: string;
  items: PhotoCollectionItem[];
  total: number;
  loading: boolean;
  nextCursor?: string;
  bucketStart?: Date;
  bucketEnd?: Date;
  error?: string;
}

export interface PhotosTrackProps extends Omit<TrackRenderProps, "items"> {
  items?: TrackRenderProps["items"];
  focusedPhoto?: PhotoTimelineFocus;
  onFocusedPhotoDismiss?: () => void;
}

function validDate(value: string | Date): Date | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function photoDensityBucketEnd(
  startValue: string | Date,
  resolution: TimelineResolution,
): Date | undefined {
  const start = validDate(startValue);
  if (!start) return undefined;
  const end = new Date(start);
  if (resolution === "hour") end.setUTCHours(end.getUTCHours() + 1);
  else if (resolution === "day") end.setUTCDate(end.getUTCDate() + 1);
  else {
    end.setUTCFullYear(end.getUTCFullYear(), end.getUTCMonth() + 1, 1);
    end.setUTCHours(0, 0, 0, 0);
  }
  return end;
}

export function groupTimelinePhotoMarkers(
  items: TimelinePhotoItem[],
  xFor: (date: Date) => number,
  width: number,
  distancePx = MARKER_GROUP_DISTANCE_PX,
): PhotoMarkerGroup[] {
  const positioned = items.flatMap((item) => {
    const capturedAt = validDate(item.capturedAt);
    if (!capturedAt) return [];
    const x = xFor(capturedAt);
    return Number.isFinite(x) && x >= -MARKER_DIAMETER_PX &&
        x <= width + MARKER_DIAMETER_PX
      ? [{ item, x }]
      : [];
  }).sort((left, right) => left.x - right.x);

  const groups: Array<PhotoMarkerGroup & { lastX: number; xTotal: number }> =
    [];
  for (const positionedItem of positioned) {
    const current = groups[groups.length - 1];
    if (current && positionedItem.x - current.lastX < distancePx) {
      current.items.push(positionedItem.item);
      current.lastX = positionedItem.x;
      current.xTotal += positionedItem.x;
      current.x = current.xTotal / current.items.length;
    } else {
      groups.push({
        x: positionedItem.x,
        xTotal: positionedItem.x,
        lastX: positionedItem.x,
        items: [positionedItem.item],
      });
    }
  }
  return groups.map(({ x, items }) => ({ x, items }));
}

function isActivationKey(event: KeyboardEvent<SVGGElement>): boolean {
  return event.key === "Enter" || event.key === " ";
}

function formattedPhotoRange(items: TimelinePhotoItem[]): string | undefined {
  const dates = items.flatMap((item) => {
    const date = validDate(item.capturedAt);
    return date ? [date] : [];
  }).sort((left, right) => left.getTime() - right.getTime());
  if (dates.length === 0) return undefined;
  if (dates.length === 1) return dates[0].toLocaleString();
  return `${dates[0].toLocaleString()} – ${
    dates[dates.length - 1].toLocaleString()
  }`;
}

function collectionItemFromAsset(asset: any): PhotoCollectionItem {
  return {
    assetId: String(asset.assetId ?? asset._id),
    fileName: String(asset.fileName ?? "Photo"),
    status: String(asset.status ?? "staged"),
    capturedAt: asset.capturedAt,
    thumbnailUrl: asset.thumbnailUrl,
    shortCaption: asset.shortCaption ?? asset.inventory?.shortCaption,
    location: asset.location ?? null,
  };
}

function uniquePhotoItems(items: PhotoCollectionItem[]): PhotoCollectionItem[] {
  return [...new Map(items.map((item) => [item.assetId, item])).values()];
}

export const PhotosTrack = memo(function PhotosTrack({
  scale,
  transform,
  width,
  height,
  focusedPhoto,
  onFocusedPhotoDismiss,
}: PhotosTrackProps) {
  const navigate = useNavigate();
  const { start, end } = useTimelineRange();
  const [data, setData] = useState<TimelinePhotoData>();
  const [trackLoading, setTrackLoading] = useState(false);
  const [trackError, setTrackError] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheet, setSheet] = useState<PhotoSheetState>();
  const timelineRequestSerial = useRef(0);
  const sheetRequestSerial = useRef(0);
  const openedFocusKey = useRef<string | undefined>(undefined);
  const returnFocusElement = useRef<SVGGElement | null>(null);
  const detailLimit = Math.max(100, Math.min(2_000, Math.floor(width / 22)));

  useEffect(() => {
    const requestSerial = ++timelineRequestSerial.current;
    const timer = globalThis.setTimeout(() => {
      setTrackLoading(true);
      setTrackError(false);
      void callResource("media-library", {
        action: "timeline",
        start: start.toISOString(),
        end: end.toISOString(),
        detailLimit,
      }).then((result) => {
        if (requestSerial !== timelineRequestSerial.current) return;
        setData(result as TimelinePhotoData);
      }).catch(() => {
        if (requestSerial === timelineRequestSerial.current) {
          setTrackError(true);
        }
      }).finally(() => {
        if (requestSerial === timelineRequestSerial.current) {
          setTrackLoading(false);
        }
      });
    }, 250);
    return () => {
      globalThis.clearTimeout(timer);
      if (requestSerial === timelineRequestSerial.current) {
        timelineRequestSerial.current += 1;
      }
    };
  }, [start.getTime(), end.getTime(), detailLimit]);

  const rescaled = useMemo(() => transform.rescaleX(scale), [scale, transform]);
  const markerGroups = useMemo(
    () =>
      data?.mode === "items"
        ? groupTimelinePhotoMarkers(
          data.items ?? [],
          (date) => rescaled(date),
          width,
        )
        : [],
    [data, rescaled, width],
  );
  const maxBucketCount = useMemo(
    () =>
      Math.max(
        ...(data?.mode === "density"
          ? (data.buckets ?? []).map((entry) => Number(entry.count))
          : []),
        1,
      ),
    [data],
  );

  useEffect(() => {
    if (!focusedPhoto) {
      openedFocusKey.current = undefined;
      return;
    }
    const key = `focus:${focusedPhoto.item.assetId}`;
    if (openedFocusKey.current === key) return;
    openedFocusKey.current = key;
    returnFocusElement.current = null;
    sheetRequestSerial.current += 1;
    setSheet({
      key,
      kind: "focus",
      title: focusedPhoto.item.fileName,
      description: focusedPhoto.capturedAt
        ? `Captured ${focusedPhoto.capturedAt.toLocaleString()}`
        : "Missing capture time. This photo is unplaced and cannot appear on the Timeline until a time is assigned in Media.",
      items: [focusedPhoto.item],
      total: 1,
      loading: false,
    });
    setSheetOpen(true);
  }, [focusedPhoto]);

  const openMarkerGroup = useCallback((
    group: PhotoMarkerGroup,
    trigger: SVGGElement,
  ) => {
    returnFocusElement.current = trigger;
    sheetRequestSerial.current += 1;
    const count = group.items.length;
    setSheet({
      key: `markers:${group.items.map((item) => item.assetId).join(",")}`,
      kind: "markers",
      title: count === 1 ? group.items[0].fileName : `${count} nearby photos`,
      description: formattedPhotoRange(group.items),
      items: group.items,
      total: count,
      loading: false,
    });
    setSheetOpen(true);
  }, []);

  const loadBucketPage = useCallback(async (
    key: string,
    bucketStart: Date,
    bucketEnd: Date,
    cursor: string | undefined,
    requestSerial: number,
  ) => {
    setSheet((current) =>
      current?.key === key
        ? { ...current, loading: true, error: undefined }
        : current
    );
    try {
      const result = await callResource("media", {
        action: "listAssets",
        kind: "image",
        inventoryFilter: "all",
        placement: "all",
        capturedFrom: bucketStart.toISOString(),
        capturedTo: new Date(bucketEnd.getTime() - 1).toISOString(),
        limit: PHOTO_SHEET_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (requestSerial !== sheetRequestSerial.current) return;
      const items = (result.assets ?? []).map(collectionItemFromAsset);
      setSheet((current) =>
        current?.key === key
          ? {
            ...current,
            items: cursor
              ? uniquePhotoItems([...current.items, ...items])
              : uniquePhotoItems(items),
            total: Number(result.total ?? items.length),
            nextCursor: result.nextCursor
              ? String(result.nextCursor)
              : undefined,
            loading: false,
            error: undefined,
          }
          : current
      );
    } catch (error) {
      if (requestSerial !== sheetRequestSerial.current) return;
      setSheet((current) =>
        current?.key === key
          ? {
            ...current,
            loading: false,
            error: error instanceof Error
              ? error.message
              : "Photo list could not be loaded.",
          }
          : current
      );
    }
  }, []);

  const openDensityBucket = useCallback((
    bucket: TimelinePhotoBucket,
    trigger: SVGGElement,
  ) => {
    returnFocusElement.current = trigger;
    const resolution = data?.resolution;
    const bucketStart = validDate(bucket.start);
    const bucketEnd = resolution
      ? photoDensityBucketEnd(bucket.start, resolution)
      : undefined;
    if (!bucketStart || !bucketEnd) return;
    const key =
      `bucket:${bucketStart.toISOString()}:${bucketEnd.toISOString()}`;
    const requestSerial = ++sheetRequestSerial.current;
    setSheet({
      key,
      kind: "bucket",
      title: `${Number(bucket.count)} photos`,
      description:
        `${bucketStart.toLocaleString()} – ${bucketEnd.toLocaleString()}`,
      items: [],
      total: Number(bucket.count),
      loading: true,
      bucketStart,
      bucketEnd,
    });
    setSheetOpen(true);
    void loadBucketPage(key, bucketStart, bucketEnd, undefined, requestSerial);
  }, [data?.resolution, loadBucketPage]);

  const loadMore = useCallback(() => {
    if (
      !sheet || sheet.kind !== "bucket" || sheet.loading ||
      (!sheet.nextCursor && !sheet.error) || !sheet.bucketStart ||
      !sheet.bucketEnd
    ) return;
    void loadBucketPage(
      sheet.key,
      sheet.bucketStart,
      sheet.bucketEnd,
      sheet.error && sheet.items.length === 0 ? undefined : sheet.nextCursor,
      sheetRequestSerial.current,
    );
  }, [loadBucketPage, sheet]);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    const dismissedFocusedPhoto = !open && sheet?.kind === "focus";
    setSheetOpen(open);
    if (!open) {
      sheetRequestSerial.current += 1;
      globalThis.setTimeout(() => returnFocusElement.current?.focus(), 0);
      if (dismissedFocusedPhoto) onFocusedPhotoDismiss?.();
    }
  }, [onFocusedPhotoDismiss, sheet?.kind]);

  return (
    <>
      <BaseTrack
        config={PHOTOS_CONFIG}
        scale={scale}
        transform={transform}
        width={width}
        height={height}
        items={[]}
      >
        {data?.mode === "density" && (data.buckets ?? []).map((bucket) => {
          const bucketStart = validDate(bucket.start);
          const bucketEnd = data.resolution
            ? photoDensityBucketEnd(bucket.start, data.resolution)
            : undefined;
          if (!bucketStart || !bucketEnd) return null;
          const rawX0 = rescaled(bucketStart);
          const rawX1 = rescaled(bucketEnd);
          if (rawX1 < 0 || rawX0 > width) return null;
          const x = Math.max(0, rawX0);
          const bucketWidth = Math.max(2, Math.min(width, rawX1) - x);
          const barHeight = Math.max(
            3,
            (Number(bucket.count) / maxBucketCount) * (height - 5),
          );
          const ready = Number(bucket.statuses?.ready ?? 0);
          const failed = Number(bucket.statuses?.failed ?? 0) +
            Number(bucket.statuses?.source_missing ?? 0);
          const fill = failed > 0
            ? "#ef4444"
            : ready === bucket.count
            ? "#22c55e"
            : "#f59e0b";
          const label =
            `Open ${bucket.count} photos from ${bucketStart.toLocaleString()}`;
          const activate = (trigger: SVGGElement) =>
            openDensityBucket(bucket, trigger);
          return (
            <g
              key={String(bucket.start)}
              role="button"
              tabIndex={0}
              aria-label={label}
              className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
              onClick={(event) => {
                event.stopPropagation();
                activate(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                activate(event.currentTarget);
              }}
            >
              <rect
                x={x}
                y={height - barHeight}
                width={bucketWidth}
                height={barHeight}
                rx={1}
                fill={fill}
                opacity={0.8}
              >
                <title>{bucket.count} photos</title>
              </rect>
            </g>
          );
        })}
        {data?.mode === "items" && markerGroups.map((group) => {
          const count = group.items.length;
          const first = group.items[0];
          const statuses = new Set(group.items.map((item) => item.status));
          const borderColor = statuses.has("failed") ||
              statuses.has("source_missing") || statuses.has("source_changed")
            ? "#ef4444"
            : statuses.size === 1
            ? STATUS_COLOR[first.status] ?? "#94a3b8"
            : "#f59e0b";
          const label = count === 1
            ? `Open photo ${first.fileName}`
            : `Open ${count} nearby photos`;
          const activate = (trigger: SVGGElement) =>
            openMarkerGroup(group, trigger);
          return (
            <g
              key={group.items.map((item) => item.assetId).join(":")}
              role="button"
              tabIndex={0}
              aria-label={label}
              className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
              onClick={(event) => {
                event.stopPropagation();
                activate(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (!isActivationKey(event)) return;
                event.preventDefault();
                event.stopPropagation();
                activate(event.currentTarget);
              }}
            >
              <foreignObject x={group.x - 15} y={2} width={30} height={32}>
                <div
                  className="relative h-7 w-7 rounded-full border-2 bg-muted"
                  style={{ borderColor }}
                >
                  <AuthenticatedMediaImage
                    path={first.thumbnailUrl}
                    alt={first.fileName}
                    className="h-full w-full rounded-full object-cover"
                  />
                  {count > 1 && (
                    <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 text-[10px] font-semibold leading-5 text-white shadow">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </div>
              </foreignObject>
              <title>
                {count > 1
                  ? `${count} nearby photos`
                  : `${first.shortCaption ?? first.fileName} · ${first.status}`}
              </title>
            </g>
          );
        })}
        {trackLoading && !data && (
          <text x={8} y={18} fontSize={10} fill="currentColor" opacity={0.6}>
            Loading photos…
          </text>
        )}
        {trackError && (
          <text x={8} y={18} fontSize={10} fill="#ef4444">
            Photos could not be refreshed
          </text>
        )}
        {Number(data?.unplacedTimeCount ?? 0) > 0 && (
          <g
            role="button"
            tabIndex={0}
            aria-label={`Open ${data?.unplacedTimeCount} photos missing capture time`}
            className="cursor-pointer"
            onClick={(event) => {
              event.stopPropagation();
              navigate("/media?placement=missing_time");
            }}
            onKeyDown={(event) => {
              if (!isActivationKey(event)) return;
              event.preventDefault();
              event.stopPropagation();
              navigate("/media?placement=missing_time");
            }}
          >
            <rect
              x={Math.max(0, width - 92)}
              y={height - 17}
              width={88}
              height={14}
              rx={7}
              fill="#64748b"
            />
            <text
              x={Math.max(4, width - 88)}
              y={height - 7}
              fontSize={9}
              fill="white"
            >
              Unplaced {data?.unplacedTimeCount}
            </text>
          </g>
        )}
      </BaseTrack>
      <PhotoCollectionSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        title={sheet?.title ?? "Photos"}
        description={sheet?.error ?? sheet?.description}
        items={sheet?.items ?? []}
        total={sheet?.total ?? 0}
        loading={sheet?.loading ?? false}
        hasMore={Boolean(
          sheet?.nextCursor || (sheet?.kind === "bucket" && sheet.error),
        )}
        onLoadMore={loadMore}
      />
    </>
  );
});
