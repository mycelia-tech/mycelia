import L from "leaflet";
import { CircleMarker, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
import type {
  ConversationMapCluster,
  MapRouteDetailResponse,
  PresenceMapCluster,
  RecordedLocationTrack,
} from "@/types/location";
import { sourceColor } from "./LocationSourceLayers.tsx";
import { formatDurationShort } from "./LocationMap.tsx";

function conversationIcon(count: number, stale: boolean): L.DivIcon {
  const size = Math.min(54, 30 + Math.log2(Math.max(1, count)) * 4);
  const opacity = stale
    ? 0.48
    : Math.min(1, 0.66 + Math.log10(count + 1) * 0.16);
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html:
      `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:rgba(124,58,237,${opacity});border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:12px;font-family:inherit;">💬 ${count}</div>`,
  });
}

export function PresenceDensityLayer({
  clusters,
  stale = false,
}: {
  clusters: PresenceMapCluster[];
  stale?: boolean;
}) {
  const maxDwell = Math.max(1, ...clusters.map((cluster) => cluster.dwellMs));
  const maxVisits = Math.max(
    1,
    ...clusters.map((cluster) => cluster.visitCount),
  );
  return (
    <>
      {clusters.map((cluster) => {
        const [lng, lat] = cluster.center;
        const dwellWeight = Math.sqrt(cluster.dwellMs / maxDwell);
        const visitWeight = Math.log1p(cluster.visitCount) /
          Math.log1p(maxVisits);
        return (
          <CircleMarker
            key={cluster.id}
            center={[lat, lng]}
            radius={Math.max(5, 5 + dwellWeight * 22)}
            pathOptions={{
              color: "#0f766e",
              weight: 1.5,
              fillColor: "#14b8a6",
              fillOpacity: (stale ? 0.22 : 0.36) + visitWeight * 0.42,
            }}
          >
            <Tooltip>
              {formatDurationShort(cluster.dwellMs)} present ·{" "}
              {cluster.visitCount} visit{cluster.visitCount === 1 ? "" : "s"}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

export function ConversationDensityLayer({
  clusters,
  stale = false,
  onOpenCluster,
}: {
  clusters: ConversationMapCluster[];
  stale?: boolean;
  onOpenCluster: (cluster: ConversationMapCluster) => void;
}) {
  const map = useMap();
  return (
    <>
      {clusters.map((cluster) => {
        const [lng, lat] = cluster.center;
        const coincident =
          Math.abs(cluster.bounds.east - cluster.bounds.west) < 1e-7 &&
          Math.abs(cluster.bounds.north - cluster.bounds.south) < 1e-7;
        return (
          <Marker
            key={cluster.id}
            position={[lat, lng]}
            icon={conversationIcon(cluster.conversationCount, stale)}
            eventHandlers={{
              click: () => {
                if (coincident || map.getZoom() >= 18) {
                  onOpenCluster(cluster);
                  return;
                }
                map.fitBounds([
                  [cluster.bounds.south, cluster.bounds.west],
                  [cluster.bounds.north, cluster.bounds.east],
                ], { maxZoom: 18, padding: [30, 30] });
              },
            }}
          >
            <Tooltip>{cluster.conversationCount} conversations</Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

export function RouteProjectionLayer({
  data,
  showConnectors,
  sourceTracks,
  onSelectTrack,
  stale = false,
}: {
  data: MapRouteDetailResponse | undefined;
  showConnectors: boolean;
  sourceTracks?: RecordedLocationTrack[];
  onSelectTrack?: (track: RecordedLocationTrack) => void;
  stale?: boolean;
}) {
  const sourceById = new Map(
    sourceTracks?.map((track) => [String(track._id), track]),
  );
  const conflictedTracks = new Set(
    (data?.conflicts ?? []).flatMap((conflict) =>
      conflict.trackIds.map(String)
    ),
  );
  return (
    <>
      {(data?.fragments ?? []).map((fragment) => {
        const conflicted = conflictedTracks.has(String(fragment.trackId));
        const source = sourceById.get(String(fragment.trackId));
        const sourceHue = [...String(fragment.trackId)].reduce((hash, char) =>
          (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 360;
        const color = sourceTracks
          ? sourceColor(source?.style?.color, `hsl(${sourceHue} 65% 45%)`)
          : "#2563eb";
        return (
          <Polyline
            key={fragment.id}
            eventHandlers={source && onSelectTrack
              ? {
                click: () =>
                  onSelectTrack(source),
              }
              : undefined}
            positions={fragment.path.map(([lng, lat]) => [lat, lng])}
            pathOptions={{
              color: conflicted ? "#f59e0b" : color,
              weight: conflicted ? 4 : 3,
              opacity: stale ? 0.38 : 0.82,
            }}
          >
            <Tooltip sticky>
              {fragment.displayName || "Recorded route"} · {fragment.pointCount}
              {" "}
              points{conflicted ? " · overlapping source review" : ""}
            </Tooltip>
          </Polyline>
        );
      })}
      {showConnectors && (data?.connectors ?? []).map((connector) => (
        <Polyline
          key={String(connector._id)}
          positions={[
            [connector.from.coordinates[1], connector.from.coordinates[0]],
            [connector.to.coordinates[1], connector.to.coordinates[0]],
          ]}
          pathOptions={{
            color: "#9ca3af",
            weight: 1.25,
            dashArray: "4 8",
            opacity: stale ? 0.15 : 0.3,
          }}
        >
          <Tooltip sticky>
            Recording gap — route unknown ·{" "}
            {connector.reason === "distance_threshold"
              ? "GPS fixes too far apart"
              : connector.reason === "time_threshold"
              ? "GPS fixes too far apart in time"
              : connector.reason.replaceAll("_", " ")}
            {" · "}
            {connector.distanceM < 1000
              ? `${connector.distanceM} m`
              : `${(connector.distanceM / 1000).toFixed(1)} km`}
            {connector.durationMs !== undefined &&
              connector.durationMs > 0 &&
              ` · ${formatDurationShort(connector.durationMs)}`}
          </Tooltip>
        </Polyline>
      ))}
    </>
  );
}
