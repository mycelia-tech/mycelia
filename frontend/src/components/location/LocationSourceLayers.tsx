import { CircleMarker, Polyline, Tooltip } from "react-leaflet";
import type { RecordedLocationTrack, SavedPlace } from "@/types/location";

export function sourceColor(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const value = raw.replace(/^#/, "");
  if (/^[0-9a-f]{8}$/i.test(value)) {
    if (raw.startsWith("#")) return `#${value.slice(2)}`; // GPX AARRGGBB
    const blue = value.slice(2, 4);
    const green = value.slice(4, 6);
    const red = value.slice(6, 8);
    return `#${red}${green}${blue}`; // KML AABBGGRR
  }
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
  return fallback;
}

export function SavedPlacesLayer({
  places,
  onSelect,
}: {
  places: SavedPlace[];
  onSelect?: (place: SavedPlace) => void;
}) {
  return (
    <>
      {places.filter((place) => place.visibility !== false).map((place) => {
        const [lng, lat] = place.loc.coordinates;
        const color = sourceColor(place.style?.color, "#f59e0b");
        return (
          <CircleMarker
            key={String(place._id)}
            center={[lat, lng]}
            radius={6}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.85,
              weight: place.reviewStatus === "pending" ? 3 : 1.5,
              dashArray: place.reviewStatus === "pending" ? "3 2" : undefined,
            }}
            eventHandlers={onSelect
              ? { click: () => onSelect(place) }
              : undefined}
          >
            <Tooltip>
              {place.displayName || "Saved place"}
              {place.featureTypes?.[0] ? ` · ${place.featureTypes[0]}` : ""}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

export function RecordedTracksLayer({
  tracks,
  onSelect,
}: {
  tracks: RecordedLocationTrack[];
  onSelect?: (track: RecordedLocationTrack) => void;
}) {
  return (
    <>
      {tracks.filter((track) => {
        const path = track.renderPath ?? track.path;
        return track.visibility !== false && path?.length > 1;
      }).map((track) => {
        const path = track.renderPath ?? track.path;
        return (
          <Polyline
            key={String(track._id)}
            positions={path.map(([lng, lat]) => [lat, lng])}
            pathOptions={{
              color: sourceColor(track.style?.color, "#7c3aed"),
              weight: Math.min(8, Math.max(2, track.style?.width ?? 3)),
              opacity: 0.75,
              dashArray: track.kind === "untimed-path"
                ? "6 5"
                : track.kind === "mixed-track"
                ? "10 4 2 4"
                : undefined,
            }}
            eventHandlers={onSelect
              ? { click: () => onSelect(track) }
              : undefined}
          >
            <Tooltip sticky>
              {track.displayName || "Recorded track"} · {track.pointCount}{" "}
              points
              {track.kind === "untimed-path" ? " · no timeline timestamps" : ""}
              {track.kind === "mixed-track" ? " · includes untimed points" : ""}
              {track.geometryCompleteness === "render-only"
                ? " · source geometry needs backfill"
                : ""}
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}
