import { CircleMarker, Tooltip, useMap } from "react-leaflet";
import type { MapSourcePointCluster } from "@/types/location";

export function MapSourcePointsLayer({ clusters }: { clusters: MapSourcePointCluster[] }) {
  const map = useMap();
  return (
    <>
      {clusters.map(({ lat, lng, count, firstAt, lastAt }) => (
        <CircleMarker
          key={`${lat}/${lng}`}
          center={[lat, lng]}
          radius={count === 1 ? 4 : Math.min(16, 6 + Math.log2(count))}
          pathOptions={{ color: "#075985", fillColor: "#38bdf8", fillOpacity: 0.8, weight: 1.5 }}
          eventHandlers={count > 1 ? {
            click: () => map.setView([lat, lng], Math.min(map.getMaxZoom(), map.getZoom() + 2)),
          } : undefined}
        >
          <Tooltip>
            <strong>{count.toLocaleString()} GPS {count === 1 ? "point" : "points"}</strong>
            <br />{new Date(firstAt).toLocaleString()}
            {+new Date(firstAt) !== +new Date(lastAt) && <> – {new Date(lastAt).toLocaleString()}</>}
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}
