import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Marker, useMap, useMapEvents } from "react-leaflet";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import {
  type PhotoCollectionItem,
  PhotoCollectionSheet,
} from "@/components/media/PhotoCollectionSheet";

const CLUSTER_RADIUS_PX = 52;
export const PHOTO_CLUSTER_DETAILS_ZOOM = 16;
const PHOTO_MAP_LOAD_ERROR_TOAST = "photo-map-load-error";

interface PhotoMapPoint extends PhotoCollectionItem {
  latitude: number;
  longitude: number;
}

interface PhotoCluster {
  lat: number;
  lng: number;
  x: number;
  y: number;
  points: PhotoMapPoint[];
}

export function shouldOpenPhotoCluster(
  pointCount: number,
  zoom: number,
  maxZoom: number,
): boolean {
  if (pointCount <= 1) return true;
  return zoom >= PHOTO_CLUSTER_DETAILS_ZOOM ||
    (Number.isFinite(maxZoom) && zoom >= maxZoom);
}

function icon(count: number, status?: string) {
  const color = count > 1
    ? "#f97316"
    : status === "ready"
    ? "#22c55e"
    : status === "failed" || status === "source_missing"
    ? "#ef4444"
    : "#64748b";
  const size = count > 99 ? 44 : count > 9 ? 38 : 32;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html:
      `<div aria-hidden="true" style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:white;font-weight:600;font-size:12px;font-family:inherit;">📷${
        count > 1 ? ` ${count}` : ""
      }</div>`,
  });
}

function AccessiblePhotoMarker({
  position,
  markerIcon,
  label,
  eventHandlers,
}: {
  position: [number, number];
  markerIcon: L.DivIcon;
  label: string;
  eventHandlers: L.LeafletEventHandlerFnMap;
}) {
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const applyAccessibleName = () => {
      const element = marker.getElement();
      if (!element) return;
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", label);
    };
    applyAccessibleName();
    marker.on("add", applyAccessibleName);
    return () => {
      marker.off("add", applyAccessibleName);
    };
  }, [label]);

  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={markerIcon}
      title={label}
      alt={label}
      keyboard
      riseOnHover
      eventHandlers={eventHandlers}
    />
  );
}

export function PhotoClustersLayer({
  onStats,
  focusedAssetId,
  onFocusedAssetClose,
}: {
  onStats?: (stats: {
    totalPlaced: number;
    visibleCount: number;
    unplacedLocationCount: number;
    truncated: boolean;
  }) => void;
  focusedAssetId?: string;
  onFocusedAssetClose?: () => void;
}) {
  const map = useMap();
  const fittedOnce = useRef(false);
  const fittingUntil = useRef(0);
  const loadSerial = useRef(0);
  const focusSerial = useRef(0);
  const returnFocusElement = useRef<HTMLElement | null>(null);
  const moveTimer = useRef<
    ReturnType<typeof globalThis.setTimeout> | undefined
  >(
    undefined,
  );
  const [points, setPoints] = useState<PhotoMapPoint[]>([]);
  const [viewTick, setViewTick] = useState(0);
  const [selectedCluster, setSelectedCluster] = useState<
    PhotoCluster | undefined
  >();
  const [focusedItem, setFocusedItem] = useState<
    PhotoCollectionItem | undefined
  >();
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    const serial = ++loadSerial.current;
    try {
      const bounds = map.getBounds();
      const initialLoad = !fittedOnce.current;
      const result = await callResource("media-library", {
        action: "map",
        ...(initialLoad ? {} : {
          bounds: {
            west: Math.max(-180, Math.min(180, bounds.getWest())),
            south: Math.max(-90, Math.min(90, bounds.getSouth())),
            east: Math.max(-180, Math.min(180, bounds.getEast())),
            north: Math.max(-90, Math.min(90, bounds.getNorth())),
          },
        }),
        limit: 2_000,
      });
      if (serial !== loadSerial.current) return;
      const loadedPoints = (result.points ?? []) as PhotoMapPoint[];
      setPoints(loadedPoints);
      setTruncated(Boolean(result.truncated));
      toast.dismiss(PHOTO_MAP_LOAD_ERROR_TOAST);
      if (initialLoad) fittedOnce.current = true;
      if (initialLoad && loadedPoints.length > 0 && !focusedAssetId) {
        // Leaflet can emit a late moveend after the fit animation and after the
        // initial request has resolved. Keep the authoritative bootstrap points
        // while that programmatic movement settles; subsequent user movement
        // still switches to bounded viewport queries.
        fittingUntil.current = Date.now() + 5_000;
        map.fitBounds(
          loadedPoints.map((point) => [point.latitude, point.longitude]),
          { padding: [24, 24], maxZoom: 14 },
        );
      }
      onStats?.({
        totalPlaced: Number(result.totalPlaced ?? 0),
        visibleCount: loadedPoints.length,
        unplacedLocationCount: Number(result.unplacedLocationCount ?? 0),
        truncated: Boolean(result.truncated),
      });
    } catch (error) {
      if (serial !== loadSerial.current) return;
      toast.error("Could not load photos on the map", {
        id: PHOTO_MAP_LOAD_ERROR_TOAST,
        description: error instanceof Error
          ? error.message
          : "The photo viewport request failed.",
        action: {
          label: "Retry",
          onClick: () => void load(),
        },
      });
    }
  }, [focusedAssetId, map, onStats]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const serial = ++focusSerial.current;
    if (!focusedAssetId) {
      setFocusedItem(undefined);
      return;
    }

    setFocusedItem(undefined);
    let active = true;
    void callResource("media", {
      action: "getAsset",
      assetId: focusedAssetId,
    }).then((result) => {
      if (!active || serial !== focusSerial.current) return;
      const asset = result.asset;
      if (!asset || asset.kind !== "image") {
        throw new Error("Only photo assets can be opened on the map");
      }
      const latitude = Number(asset.location?.latitude);
      const longitude = Number(asset.location?.longitude);
      const hasLocation = Number.isFinite(latitude) &&
        Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 &&
        longitude >= -180 && longitude <= 180;
      const visual = result.visual?.visualUnderstanding;
      const shortCaption = typeof visual?.shortCaption === "string" &&
          visual.shortCaption.trim()
        ? visual.shortCaption
        : typeof visual?.description === "string" && visual.description.trim()
        ? visual.description
        : undefined;
      setFocusedItem({
        assetId: String(asset._id),
        fileName: String(asset.fileName ?? "Photo"),
        status: String(asset.status ?? "staged"),
        capturedAt: asset.capturedAt,
        thumbnailUrl: asset.thumbnailUrl ?? asset.previewUrl,
        shortCaption,
        location: hasLocation ? { latitude, longitude } : null,
      });
      if (hasLocation) {
        const maxZoom = map.getMaxZoom();
        const targetZoom = Math.min(
          PHOTO_CLUSTER_DETAILS_ZOOM,
          Number.isFinite(maxZoom) ? maxZoom : PHOTO_CLUSTER_DETAILS_ZOOM,
        );
        fittingUntil.current = Date.now() + 5_000;
        map.flyTo([latitude, longitude], targetZoom, { animate: true });
      }
    }).catch((error) => {
      if (!active || serial !== focusSerial.current) return;
      setFocusedItem(undefined);
      toast.error("Could not open this photo on the map", {
        id: `photo-map-focus-${focusedAssetId}`,
        description: error instanceof Error
          ? error.message
          : "The photo details request failed.",
      });
    });
    return () => {
      active = false;
    };
  }, [focusedAssetId, map]);
  const scheduleViewportLoad = useCallback(() => {
    if (Date.now() < fittingUntil.current) {
      // Re-project clusters after the bootstrap fit without replacing the
      // authoritative unbounded bootstrap result with a transient viewport.
      setViewTick((value) => value + 1);
      return;
    }
    if (moveTimer.current !== undefined) {
      globalThis.clearTimeout(moveTimer.current);
    }
    moveTimer.current = globalThis.setTimeout(() => {
      setViewTick((value) => value + 1);
      void load();
    }, 120);
  }, [load]);
  useEffect(() => () => {
    if (moveTimer.current !== undefined) {
      globalThis.clearTimeout(moveTimer.current);
    }
  }, []);
  useMapEvents({
    moveend: scheduleViewportLoad,
    zoomend: scheduleViewportLoad,
  });

  const clusters = useMemo(() => {
    void viewTick;
    const result: PhotoCluster[] = [];
    for (const point of points) {
      const projected = map.latLngToContainerPoint([
        point.latitude,
        point.longitude,
      ]);
      const found = result.find((entry) =>
        Math.hypot(entry.x - projected.x, entry.y - projected.y) <
          CLUSTER_RADIUS_PX
      );
      if (found) found.points.push(point);
      else {
        result.push({
          lat: point.latitude,
          lng: point.longitude,
          x: projected.x,
          y: projected.y,
          points: [point],
        });
      }
    }
    return result;
  }, [map, points, viewTick]);

  const openCluster = useCallback((
    cluster: PhotoCluster,
    marker?: L.Marker,
  ) => {
    returnFocusElement.current = marker?.getElement() ?? null;
    setFocusedItem(undefined);
    setSelectedCluster(cluster);
  }, []);

  const zoomToCluster = useCallback((cluster: PhotoCluster) => {
    const maxZoom = map.getMaxZoom();
    const targetZoom = Math.min(
      PHOTO_CLUSTER_DETAILS_ZOOM,
      Number.isFinite(maxZoom) ? maxZoom : PHOTO_CLUSTER_DETAILS_ZOOM,
    );
    const bounds = L.latLngBounds(
      cluster.points.map((point) => [point.latitude, point.longitude]),
    );
    map.fitBounds(bounds, {
      animate: true,
      padding: [48, 48],
      maxZoom: targetZoom,
    });
  }, [map]);

  const selectedItems = useMemo<PhotoCollectionItem[]>(
    () =>
      focusedItem
        ? [focusedItem]
        : (selectedCluster?.points ?? []).map((point) => ({
          assetId: String(point.assetId),
          fileName: point.fileName,
          status: point.status,
          capturedAt: point.capturedAt,
          thumbnailUrl: point.thumbnailUrl,
          shortCaption: point.shortCaption,
          location: {
            latitude: point.latitude,
            longitude: point.longitude,
          },
        })),
    [focusedItem, selectedCluster],
  );

  const selectedCenter = selectedCluster
    ? {
      latitude: selectedCluster.points.reduce(
        (sum, point) => sum + point.latitude,
        0,
      ) / selectedCluster.points.length,
      longitude: selectedCluster.points.reduce(
        (sum, point) => sum + point.longitude,
        0,
      ) / selectedCluster.points.length,
    }
    : undefined;

  return (
    <>
      {clusters.map((cluster, index) => {
        const point = cluster.points[0];
        const zoom = map.getZoom();
        const maxZoom = map.getMaxZoom();
        const opensDetails = shouldOpenPhotoCluster(
          cluster.points.length,
          zoom,
          maxZoom,
        );
        const markerLabel = cluster.points.length === 1
          ? `Photo: ${
            point.shortCaption?.trim() || point.fileName
          }. Open photo list.`
          : `${cluster.points.length} photos near this location. ${
            opensDetails ? "Open photo list." : "Zoom in to separate photos."
          }`;
        const activate = (event: L.LeafletEvent) => {
          if (
            shouldOpenPhotoCluster(
              cluster.points.length,
              map.getZoom(),
              map.getMaxZoom(),
            )
          ) {
            openCluster(cluster, event.target as L.Marker);
          } else {
            zoomToCluster(cluster);
          }
        };
        return (
          <AccessiblePhotoMarker
            key={`${cluster.lat}:${cluster.lng}:${index}`}
            position={[cluster.lat, cluster.lng]}
            markerIcon={icon(cluster.points.length, point.status)}
            label={markerLabel}
            eventHandlers={{
              click: activate,
              keydown: (event) => {
                const keyboardEvent = event.originalEvent;
                if (
                  keyboardEvent.key === "Enter" || keyboardEvent.key === " " ||
                  keyboardEvent.key === "Spacebar"
                ) {
                  keyboardEvent.preventDefault();
                  activate(event);
                }
              },
            }}
          />
        );
      })}
      <PhotoCollectionSheet
        open={Boolean(focusedItem || selectedCluster)}
        onOpenChange={(open) => {
          if (open) return;
          const closingFocusedItem = Boolean(focusedItem);
          setFocusedItem(undefined);
          setSelectedCluster(undefined);
          if (closingFocusedItem) {
            onFocusedAssetClose?.();
          } else {
            globalThis.setTimeout(
              () => returnFocusElement.current?.focus(),
              0,
            );
          }
        }}
        title={focusedItem
          ? focusedItem.location
            ? "Photo on the map"
            : "Photo is not placed on the map"
          : truncated
          ? "Photos at this location"
          : selectedItems.length === 1
          ? "Photo at this location"
          : `${selectedItems.length} photos at this location`}
        description={focusedItem
          ? focusedItem.location
            ? `${focusedItem.location.latitude.toFixed(5)}, ${
              focusedItem.location.longitude.toFixed(5)
            }`
            : "No GPS or manual coordinates are stored for this photo, so the map was not moved."
          : selectedCenter
          ? truncated
            ? `Showing the latest loaded photos near ${
              selectedCenter.latitude.toFixed(5)
            }, ${
              selectedCenter.longitude.toFixed(5)
            }. The current viewport is capped; zoom in to narrow the results.`
            : `${selectedCenter.latitude.toFixed(5)}, ${
              selectedCenter.longitude.toFixed(5)
            }`
          : undefined}
        items={selectedItems}
        total={selectedItems.length}
        hasMore={!focusedItem && truncated}
      />
    </>
  );
}
