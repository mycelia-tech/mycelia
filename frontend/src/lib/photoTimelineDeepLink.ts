import type { PhotoCollectionItem } from "@/components/media/PhotoCollectionSheet";

export const PHOTO_TIMELINE_FOCUS_WINDOW_MS = 10 * 60 * 1000;

export interface PhotoTimelineFocus {
  item: PhotoCollectionItem;
  capturedAt?: Date;
}

function validDate(value: unknown): Date | undefined {
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function photoTimelineFocusFromAssetDetail(
  detail: any,
  requestedAssetId: string,
): PhotoTimelineFocus {
  const asset = detail?.asset;
  const assetId = String(asset?._id ?? asset?.assetId ?? "");
  if (
    !assetId ||
    assetId.toLowerCase() !== requestedAssetId.trim().toLowerCase()
  ) {
    throw new Error("The requested photo was not returned");
  }
  if (asset.kind !== "image") {
    throw new Error("Only photo assets can be opened on the Timeline");
  }

  const capturedAt = validDate(asset.capturedAt);
  const shortCaption = detail?.visual?.visualUnderstanding?.shortCaption ??
    asset.inventory?.shortCaption;

  return {
    item: {
      assetId,
      fileName: String(asset.fileName ?? "Photo"),
      status: String(asset.status ?? "staged"),
      capturedAt: capturedAt ?? null,
      thumbnailUrl: asset.thumbnailUrl,
      shortCaption: typeof shortCaption === "string" ? shortCaption : undefined,
      location: asset.location ?? null,
    },
    capturedAt,
  };
}

export function getPhotoTimelineFocusRange(capturedAt: Date): {
  start: Date;
  end: Date;
} {
  const halfWindowMs = PHOTO_TIMELINE_FOCUS_WINDOW_MS / 2;
  return {
    start: new Date(capturedAt.getTime() - halfWindowMs),
    end: new Date(capturedAt.getTime() + halfWindowMs),
  };
}
