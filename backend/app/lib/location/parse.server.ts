import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

export type TrackFormat = "gpx" | "kml" | "kmz";

export interface ParsedPoint {
  ts: Date;
  lat: number;
  lng: number;
  ele?: number;
  trackIndex?: number;
  sourceFragmentIndex?: number;
  sourcePointIndex?: number;
  pointIndex?: number;
}

export interface ParsedCoordinate {
  lat: number;
  lng: number;
  ele?: number;
  /** Explicit GPX trkseg / KML track boundary retained for route projection. */
  sourceFragmentIndex?: number;
  /** Position inside the explicit source fragment. */
  sourcePointIndex?: number;
}

export interface ParsedStyle {
  color?: string;
  width?: number;
  icon?: string;
  styleUrl?: string;
  raw?: Record<string, unknown>;
}

export interface ParsedMetadata {
  name?: string;
  customNames?: Record<string, string>;
  localizedNames?: Record<string, string>;
  localizedDescriptions?: Record<string, string>;
  description?: string;
  featureTypes?: string[];
  icon?: string;
  scale?: number;
  visibility?: boolean;
  sourceTimestamp?: Date;
  localId?: string;
  additionalStyle?: string;
  accessRules?: string;
  annotation?: string;
  folderPath?: string[];
  /** Complete non-geometry metadata as parsed from the source feature. */
  rawMetadata?: Record<string, unknown>;
  style?: ParsedStyle;
  styleDefinitions?: Record<string, ParsedStyle>;
}

export interface ParsedTrack extends ParsedMetadata {
  kind: "timed-track" | "untimed-path" | "mixed-track";
  sourceIndex: number;
  coordinates: Array<ParsedCoordinate & { ts?: Date }>;
}

export interface ParsedBookmark extends ParsedMetadata, ParsedCoordinate {
  sourceIndex: number;
}

export interface ParseResult {
  /** Application declared in the source format, when provided. */
  exporter?: string;
  /** Canonical timestamped observations only. Bookmarks never appear here. */
  points: ParsedPoint[];
  tracks: ParsedTrack[];
  bookmarks: ParsedBookmark[];
  datasetMetadata: ParsedMetadata;
  /** Invalid or structurally unmatched records that could not be retained. */
  skipped: number;
  /** Retained map geometry that has no timeline timestamp. */
  untimedCoordinates: number;
  invalidCoordinates: number;
  invalidTimestamps: number;
  unpairedCoordinates: number;
  unpairedTimestamps: number;
  unsupportedGeometries: number;
  /** Original KML member selected from a KMZ archive. */
  sourceEntryName?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isValidCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseVisibility(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseLocalized(node: any): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const item of asArray(node?.["mwm:lang"] ?? node?.lang)) {
    const code = nonEmptyString(item?.["@_code"]) ?? "default";
    const text = nonEmptyString(
      typeof item === "string" ? item : item?.["#text"],
    );
    if (text) values[code] = text;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

const GEOMETRY_PAYLOAD_KEYS = new Set([
  "coordinates",
  "gx:coord",
  "coord",
  "trkpt",
  "rtept",
  "wpt",
]);
const TIMED_GEOMETRY_KEYS = new Set([
  "gx:Track",
  "Track",
  "gx:MultiTrack",
  "MultiTrack",
]);

function nonGeometryMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    const values = value.map(nonGeometryMetadata).filter((child) =>
      child !== undefined
    );
    return values.length > 0 ? values : undefined;
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (GEOMETRY_PAYLOAD_KEYS.has(key) || TIMED_GEOMETRY_KEYS.has(key)) {
      continue;
    }
    const parsed = nonGeometryMetadata(child);
    if (parsed === undefined) continue;
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length === 0
    ) continue;
    result[key] = parsed;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function rawMetadata(node: unknown): Record<string, unknown> | undefined {
  const value = nonGeometryMetadata(node);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.keys(value).length > 0
    ? value as Record<string, unknown>
    : undefined;
}

function parseExtendedData(node: any): ParsedMetadata {
  if (!node || typeof node !== "object") return {};
  const localizedNames = parseLocalized(node["mwm:name"] ?? node.name);
  const customNames = parseLocalized(node["mwm:customName"] ?? node.customName);
  const localizedDescriptions = parseLocalized(
    node["mwm:description"] ?? node.description,
  );
  const featureTypes = asArray(
    node["mwm:featureTypes"]?.["mwm:value"] ??
      node.featureTypes?.value,
  ).map(nonEmptyString).filter((value): value is string => !!value);
  const sourceTimestamp = parseTimestamp(
    node["mwm:lastModified"] ?? node.lastModified,
  ) ?? undefined;
  const scale = finiteNumber(node["mwm:scale"] ?? node.scale);
  const icon = nonEmptyString(node["mwm:icon"] ?? node.icon);
  const visibility = parseVisibility(
    node["mwm:visibility"] ?? node.visibility,
  );
  const localId = nonEmptyString(node["mwm:localId"] ?? node.localId);
  const additionalStyle = nonEmptyString(
    node["mwm:additionalStyle"] ?? node.additionalStyle,
  );
  const accessRules = nonEmptyString(
    node["mwm:accessRules"] ?? node.accessRules,
  );
  const annotation = nonEmptyString(
    node["mwm:annotation"] ?? node.annotation,
  );
  return {
    ...(localizedNames ? { localizedNames } : {}),
    ...(customNames ? { customNames } : {}),
    ...(localizedDescriptions ? { localizedDescriptions } : {}),
    ...(featureTypes.length > 0 ? { featureTypes } : {}),
    ...(icon ? { icon } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
    ...(localId ? { localId } : {}),
    ...(additionalStyle ? { additionalStyle } : {}),
    ...(accessRules ? { accessRules } : {}),
    ...(annotation ? { annotation } : {}),
  };
}

function parseKmlStyle(pm: any): ParsedStyle | undefined {
  const line = pm?.Style?.LineStyle;
  const styleUrl = nonEmptyString(pm?.styleUrl);
  const color = nonEmptyString(line?.color);
  const width = finiteNumber(line?.width);
  const icon = styleUrl?.replace(/^#placemark-/, "");
  if (!styleUrl && !color && width === undefined && !icon) return undefined;
  return {
    ...(color ? { color } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(icon ? { icon } : {}),
    ...(styleUrl ? { styleUrl } : {}),
    raw: {
      ...(line ? { lineStyle: line } : {}),
      ...(styleUrl ? { styleUrl } : {}),
    },
  };
}

function parseKmlStyleDefinitions(document: any) {
  const definitions: Record<string, ParsedStyle> = {};
  for (const node of asArray(document?.Style)) {
    const id = nonEmptyString(node?.["@_id"]);
    if (!id) continue;
    const href = nonEmptyString(node?.IconStyle?.Icon?.href);
    const line = node?.LineStyle;
    const color = nonEmptyString(line?.color);
    const width = finiteNumber(line?.width);
    const icon = href?.split("/").pop()?.replace(/\.png$/i, "");
    definitions[id] = {
      ...(color ? { color } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(icon ? { icon } : {}),
      ...(href ? { styleUrl: href } : {}),
      raw: node,
    };
  }
  return Object.keys(definitions).length > 0 ? definitions : undefined;
}

function metadataFromKml(node: any, folderPath?: string[]): ParsedMetadata {
  const extended = parseExtendedData(node?.ExtendedData);
  const name = nonEmptyString(node?.name);
  const description = nonEmptyString(node?.description) ??
    extended.localizedDescriptions?.default;
  const sourceTimestamp = parseTimestamp(node?.TimeStamp?.when) ??
    extended.sourceTimestamp;
  const visibility = parseVisibility(node?.visibility) ?? extended.visibility;
  const style = parseKmlStyle(node);
  return {
    ...extended,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(style ? { style } : {}),
    ...(folderPath && folderPath.length > 0 ? { folderPath } : {}),
    ...(rawMetadata(node) ? { rawMetadata: rawMetadata(node) } : {}),
  };
}

function finalize(result: ParseResult): ParseResult {
  result.points.sort((a, b) =>
    a.ts.getTime() - b.ts.getTime() ||
    (a.trackIndex ?? 0) - (b.trackIndex ?? 0) ||
    (a.pointIndex ?? 0) - (b.pointIndex ?? 0)
  );
  return result;
}

function gpxColor(node: any): string | undefined {
  const extensions = node?.extensions;
  return nonEmptyString(
    extensions?.["xsi:gpx"]?.color ??
      extensions?.gpx?.color ??
      extensions?.color,
  );
}

function metadataFromGpx(node: any): ParsedMetadata {
  const name = nonEmptyString(node?.name);
  const description = nonEmptyString(node?.desc);
  const color = gpxColor(node);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(color ? { style: { color, raw: { color } } } : {}),
    ...(rawMetadata(node) ? { rawMetadata: rawMetadata(node) } : {}),
  };
}

function coordinateFromGpx(node: any): ParsedCoordinate | null {
  const lat = Number(node?.["@_lat"]);
  const lng = Number(node?.["@_lon"]);
  if (!isValidCoordinate(lat, lng)) return null;
  const ele = finiteNumber(node?.ele);
  return { lat, lng, ...(ele !== undefined ? { ele } : {}) };
}

export function parseGpx(text: string): ParseResult {
  const doc = parser.parse(text);
  const gpx = doc?.gpx;
  if (!gpx) throw new Error("Not a GPX document: missing <gpx> root");

  const result: ParseResult = {
    points: [],
    tracks: [],
    bookmarks: [],
    exporter: nonEmptyString(gpx["@_creator"]),
    datasetMetadata: metadataFromGpx(gpx.metadata ?? gpx),
    skipped: 0,
    untimedCoordinates: 0,
    invalidCoordinates: 0,
    invalidTimestamps: 0,
    unpairedCoordinates: 0,
    unpairedTimestamps: 0,
    unsupportedGeometries: 0,
  };

  const addTrack = (node: any, rawFragments: any[][]) => {
    const trackIndex = result.tracks.length;
    const coordinates: Array<ParsedCoordinate & { ts?: Date }> = [];
    let timed = 0;
    for (
      let fragmentIndex = 0;
      fragmentIndex < rawFragments.length;
      fragmentIndex++
    ) {
      const rawPoints = rawFragments[fragmentIndex];
      for (
        let sourcePointIndex = 0;
        sourcePointIndex < rawPoints.length;
        sourcePointIndex++
      ) {
        const raw = rawPoints[sourcePointIndex];
        const coordinate = coordinateFromGpx(raw);
        if (!coordinate) {
          result.skipped++;
          result.invalidCoordinates++;
          continue;
        }
        const ts = parseTimestamp(raw?.time) ?? undefined;
        if (raw?.time && !ts) result.invalidTimestamps++;
        const pointIndex = coordinates.length;
        const source = { sourceFragmentIndex: fragmentIndex, sourcePointIndex };
        coordinates.push({ ...coordinate, ...source, ...(ts ? { ts } : {}) });
        if (ts) {
          timed++;
          result.points.push({
            ...coordinate,
            ...source,
            ts,
            trackIndex,
            pointIndex,
          });
        } else {
          result.untimedCoordinates++;
        }
      }
    }
    if (coordinates.length > 0) {
      result.tracks.push({
        ...metadataFromGpx(node),
        kind: timed === coordinates.length
          ? "timed-track"
          : timed === 0
          ? "untimed-path"
          : "mixed-track",
        sourceIndex: trackIndex,
        coordinates,
      });
    }
  };

  for (const trk of asArray(gpx.trk)) {
    const rawFragments = asArray(trk?.trkseg).map((seg: any) =>
      asArray(seg?.trkpt)
    );
    addTrack(trk, rawFragments);
  }
  for (const route of asArray(gpx.rte)) {
    addTrack(route, [asArray(route?.rtept)]);
  }
  for (const waypoint of asArray(gpx.wpt)) {
    const coordinate = coordinateFromGpx(waypoint);
    if (!coordinate) {
      result.skipped++;
      result.invalidCoordinates++;
      continue;
    }
    result.bookmarks.push({
      ...coordinate,
      ...metadataFromGpx(waypoint),
      sourceIndex: result.bookmarks.length,
    });
    // Waypoints are saved places, not observations; lack of a timestamp does
    // not mean the bookmark was skipped.
  }

  return finalize(result);
}

interface PlacemarkSource {
  node: any;
  folderPath: string[];
}

/** Recursively collect every Placemark and its source folder hierarchy. */
function collectPlacemarks(
  node: any,
  out: PlacemarkSource[],
  folderPath: string[] = [],
): void {
  if (!node || typeof node !== "object") return;
  for (const pm of asArray(node.Placemark)) out.push({ node: pm, folderPath });
  for (const child of asArray(node.Document)) {
    collectPlacemarks(child, out, folderPath);
  }
  for (const child of asArray(node.Folder)) {
    const name = nonEmptyString(child?.name);
    collectPlacemarks(child, out, name ? [...folderPath, name] : folderPath);
  }
}

function parseCoordinateTuple(value: unknown, commaSeparated = false) {
  const parts = String(value ?? "").trim().split(
    commaSeparated ? /[,\s]+/ : /\s+/,
  ).map(Number);
  const [lng, lat, ele] = parts;
  if (!isValidCoordinate(lat, lng)) return null;
  return {
    lat,
    lng,
    ...(Number.isFinite(ele) ? { ele } : {}),
  } satisfies ParsedCoordinate;
}

function lineStringCoordinates(
  geometry: any,
): { coordinates: ParsedCoordinate[]; invalid: number } {
  const raw = geometry?.coordinates;
  if (typeof raw !== "string") return { coordinates: [], invalid: 1 };
  const values = raw.split(/\s+/).filter(Boolean).map((chunk: string) =>
    parseCoordinateTuple(chunk, true)
  );
  return {
    coordinates: values.filter((value): value is ParsedCoordinate =>
      value !== null
    ),
    invalid: values.filter((value) => value === null).length,
  };
}

export function parseKml(text: string): ParseResult {
  const doc = parser.parse(text);
  const kml = doc?.kml;
  if (!kml) throw new Error("Not a KML document: missing <kml> root");

  const document = kml.Document ?? kml;
  const styleDefinitions = parseKmlStyleDefinitions(document);
  const result: ParseResult = {
    points: [],
    tracks: [],
    bookmarks: [],
    datasetMetadata: {
      ...metadataFromKml(document),
      ...(styleDefinitions ? { styleDefinitions } : {}),
    },
    skipped: 0,
    untimedCoordinates: 0,
    invalidCoordinates: 0,
    invalidTimestamps: 0,
    unpairedCoordinates: 0,
    unpairedTimestamps: 0,
    unsupportedGeometries: 0,
  };
  const placemarks: PlacemarkSource[] = [];
  collectPlacemarks(kml, placemarks);

  for (const source of placemarks) {
    const pm = source.node;
    const metadata = metadataFromKml(pm, source.folderPath);
    const addKmlTrack = (trackFragments: any[]) => {
      const trackIndex = result.tracks.length;
      const coordinates: Array<ParsedCoordinate & { ts?: Date }> = [];
      let timed = 0;
      for (
        let fragmentIndex = 0;
        fragmentIndex < trackFragments.length;
        fragmentIndex++
      ) {
        const track = trackFragments[fragmentIndex];
        const whens = asArray(track?.when);
        const coords = [
          ...asArray(track?.["gx:coord"]),
          ...asArray(track?.coord),
        ];
        for (let i = 0; i < Math.max(whens.length, coords.length); i++) {
          if (i >= coords.length) {
            result.unpairedTimestamps++;
            result.skipped++;
            continue;
          }
          const coordinate = parseCoordinateTuple(coords[i]);
          if (!coordinate) {
            result.invalidCoordinates++;
            result.skipped++;
            continue;
          }
          const ts = parseTimestamp(whens[i]) ?? undefined;
          if (i >= whens.length) result.unpairedCoordinates++;
          else if (!ts) result.invalidTimestamps++;
          const pointIndex = coordinates.length;
          const sourcePosition = {
            sourceFragmentIndex: fragmentIndex,
            sourcePointIndex: i,
          };
          coordinates.push({
            ...coordinate,
            ...sourcePosition,
            ...(ts ? { ts } : {}),
          });
          if (ts) {
            timed++;
            result.points.push({
              ...coordinate,
              ...sourcePosition,
              ts,
              trackIndex,
              pointIndex,
            });
          } else {
            result.untimedCoordinates++;
          }
        }
      }
      if (coordinates.length > 0) {
        result.tracks.push({
          ...metadata,
          kind: timed === coordinates.length
            ? "timed-track"
            : timed === 0
            ? "untimed-path"
            : "mixed-track",
          sourceIndex: trackIndex,
          coordinates,
        });
      }
    };

    const tracks = [...asArray(pm?.["gx:Track"]), ...asArray(pm?.Track)];
    for (const track of tracks) addKmlTrack([track]);
    for (
      const multiTrack of [
        ...asArray(pm?.["gx:MultiTrack"]),
        ...asArray(pm?.MultiTrack),
      ]
    ) {
      const children = [
        ...asArray(multiTrack?.["gx:Track"]),
        ...asArray(multiTrack?.Track),
      ];
      if (children.length > 0) addKmlTrack(children);
      else result.unsupportedGeometries++;
    }

    const lineStrings = [
      ...asArray(pm?.LineString),
      ...asArray(pm?.MultiGeometry).flatMap((mg: any) =>
        asArray(mg?.LineString)
      ),
    ];
    for (const line of lineStrings) {
      const parsed = lineStringCoordinates(line);
      const coordinates = parsed.coordinates;
      result.invalidCoordinates += parsed.invalid;
      result.skipped += parsed.invalid;
      result.untimedCoordinates += coordinates.length;
      if (coordinates.length > 0) {
        result.tracks.push({
          ...metadata,
          kind: "untimed-path",
          sourceIndex: result.tracks.length,
          coordinates,
        });
      }
    }

    for (const point of asArray(pm?.Point)) {
      const coordinate = parseCoordinateTuple(point?.coordinates, true);
      if (!coordinate) {
        result.skipped++;
        result.invalidCoordinates++;
        continue;
      }
      result.bookmarks.push({
        ...coordinate,
        ...metadata,
        sourceIndex: result.bookmarks.length,
      });
      // A KML bookmark TimeStamp records when it was saved. It is retained as
      // metadata and never becomes a whereabouts point.
    }
    const multiGeometries = asArray(pm?.MultiGeometry);
    result.unsupportedGeometries += asArray(pm?.Polygon).length +
      asArray(pm?.Model).length +
      multiGeometries.reduce(
        (count, geometry: any) =>
          count + asArray(geometry?.Polygon).length +
          asArray(geometry?.Model).length,
        0,
      );
  }

  return finalize(result);
}

export function parseKmz(bytes: Uint8Array): ParseResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Error(
      `Not a KMZ archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const names = Object.keys(entries);
  const kmlName = names.find((name) => name.toLowerCase() === "doc.kml") ??
    names.find((name) => name.toLowerCase().endsWith(".kml"));
  if (!kmlName) throw new Error("KMZ archive contains no .kml document");
  const result = parseKml(new TextDecoder().decode(entries[kmlName]));
  result.sourceEntryName = kmlName;
  return result;
}

export function detectFormat(filename: string): TrackFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gpx")) return "gpx";
  if (lower.endsWith(".kml")) return "kml";
  if (lower.endsWith(".kmz")) return "kmz";
  return null;
}

export function parseTrackFile(
  format: TrackFormat,
  bytes: Uint8Array,
): ParseResult {
  switch (format) {
    case "gpx":
      return parseGpx(new TextDecoder().decode(bytes));
    case "kml":
      return parseKml(new TextDecoder().decode(bytes));
    case "kmz":
      return parseKmz(bytes);
  }
}
