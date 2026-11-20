import {
  type LocationOrigin,
  locationProviderLabel,
} from "@myceliasdk/location-sources.ts";
import type { ObjectId } from "bson";

export interface LocationPlace {
  name: string;
  city?: string;
  country?: string;
  countryCode?: string;
  geonameId?: number;
  admin1?: string;
}

export type LocationSegmentType = "stay" | "move" | "gap" | "manual";

export interface SegmentSource {
  manual?: boolean;
  createdBy?: string;
  importId?: string;
  filename?: string | null;
  origin?: LocationOrigin;
}

export interface LocationSegment {
  _id: ObjectId | string;
  type: LocationSegmentType;
  start: Date | string;
  end: Date | string;
  loc?: { type: "Point"; coordinates: [number, number] };
  radiusM?: number;
  place?: LocationPlace | null;
  timeZone?: string;
  path?: [number, number][];
  distanceM?: number;
  assumed?: boolean;
  source: "derived" | "manual";
  importIds?: unknown[];
  sources?: SegmentSource[];
  overlapIds?: string[];
}

export function formatSources(sources?: SegmentSource[]): string[] {
  if (!sources || sources.length === 0) return [];
  return sources.map((s) =>
    s.manual
      ? `✍️ manual${s.createdBy ? ` (${s.createdBy})` : ""}`
      : `📄 ${s.filename ?? "deleted import"}${s.origin ? ` · ${locationProviderLabel(s.origin.provider)}` : ""}`
  );
}

export interface LocationStatus {
  hasData: boolean;
  pointCount: number;
  segmentCount: number;
  bookmarkCount?: number;
  recordedTrackCount?: number;
  geonamesReady: boolean;
  geonamesCount: number;
  geonamesRefreshedAt: Date | string | null;
  geonamesSourceUrl: string | null;
  lastImportAt: Date | string | null;
}

export interface GeonamesCity {
  geonameId: number;
  name: string;
  asciiName: string;
  country: string;
  countryCode: string;
  admin1?: string;
  population: number;
  loc: { type: "Point"; coordinates: [number, number] };
  tz?: string;
}

export interface LocationImportSource {
  _id: ObjectId | string;
  filename: string;
  format: "gpx" | "kml" | "kmz";
  origin?: LocationOrigin;
}

export interface LocationImport extends LocationImportSource {
  pointCount: number;
  dedupedCount?: number;
  skippedCount: number;
  timeRange?: { start: Date | string; end: Date | string };
  status:
    | "staging"
    | "ready"
    | "committing"
    | "parsed"
    | "processed"
    | "failed"
    | "error";
  createdAt: Date | string;
  committedAt?: Date | string;
  receipt?: LocationImportCounts & {
    schemaVersion?: number;
    file?: LocationImportFileFacts;
    contentProfile?: LocationContentProfile;
    pointsImported?: number;
    pointsDeduplicated?: number;
    pointsSkipped?: number;
  };
  datasetMetadata?: LocationMetadata;
  contentProfileVersion?: number;
  contentProfile?: LocationContentProfile;
  fileSize?: number;
  sourceEntryName?: string;
  geometryCompleteness?: "full" | "render-only";
  routeBoundaryCompleteness?: "full" | "unknown" | "incomplete";
}

export interface LocationImportFileFacts {
  sizeBytes: number;
  contentHash: string;
  format: "gpx" | "kml" | "kmz";
  parserVersion: number;
  sourceEntryName?: string;
}

export interface LocationContentProfile {
  version: number;
  file: LocationImportFileFacts;
  datasetMetadata?: LocationMetadata;
  counts: Pick<
    LocationImportCounts,
    | "timedCoordinates"
    | "untimedCoordinates"
    | "trackCoordinates"
    | "timedTracks"
    | "untimedTracks"
    | "mixedTracks"
    | "tracks"
    | "bookmarks"
    | "invalidCoordinates"
    | "invalidTimestamps"
    | "unpairedCoordinates"
    | "unpairedTimestamps"
    | "unsupportedGeometries"
    | "styleDefinitions"
  >;
}

export interface LocationMetadata {
  name?: string;
  customNames?: Record<string, string>;
  localizedNames?: Record<string, string>;
  localizedDescriptions?: Record<string, string>;
  description?: string;
  featureTypes?: string[];
  icon?: string;
  scale?: number;
  visibility?: boolean;
  sourceTimestamp?: Date | string;
  localId?: string;
  additionalStyle?: string;
  accessRules?: string;
  annotation?: string;
  folderPath?: string[];
  rawMetadata?: Record<string, unknown>;
  style?: {
    color?: string;
    width?: number;
    icon?: string;
    styleUrl?: string;
  };
  styleDefinitions?: Record<string, {
    color?: string;
    width?: number;
    icon?: string;
    styleUrl?: string;
  }>;
}

export interface LocationImportCounts {
  sourcePoints: number;
  uniquePoints: number;
  newPoints: number;
  matchedPoints: number;
  withinFileDuplicates: number;
  withinFileTrackDuplicates: number;
  withinFileBookmarkDuplicates: number;
  conflictPoints: number;
  conflictGroups: number;
  skipped: number;
  timedCoordinates: number;
  untimedCoordinates: number;
  trackCoordinates: number;
  timedTracks: number;
  untimedTracks: number;
  mixedTracks: number;
  invalidCoordinates: number;
  invalidTimestamps: number;
  unpairedCoordinates: number;
  unpairedTimestamps: number;
  unsupportedGeometries: number;
  styleDefinitions: number;
  tracks: number;
  tracksNew: number;
  tracksMatched: number;
  bookmarks: number;
  bookmarksNew: number;
  bookmarksMatched: number;
  metadataReview: number;
}

export interface LocationImportPreview {
  origin?: LocationOrigin;
  previewId: string;
  filename: string;
  format: "gpx" | "kml" | "kmz";
  contentHash: string;
  fileSize: number;
  parserVersion: number;
  contentProfileVersion: number;
  sourceEntryName?: string;
  exactFileMatch?: {
    importId: string;
    filename: string;
    createdAt?: Date | string;
  };
  timeRange?: { start: Date | string; end: Date | string };
  counts: LocationImportCounts;
  duplicateSources: Array<{
    importId: string;
    filename: string;
    matchedPoints: number;
  }>;
  conflicts: Array<{
    ts: Date | string;
    incoming: LocationConflictPoint[];
    existing: LocationConflictPoint[];
  }>;
  metadataDifferences: Array<{
    kind: "elevation" | "ambiguous_bookmark" | "entity_metadata";
    hash?: string;
    coordinateHash?: string;
    entityType?: "track" | "bookmark";
    entityId?: string;
    field?: string;
    existing?: number;
    incoming?: number;
    existingValue?: unknown;
    incomingValue?: unknown;
  }>;
  datasetMetadata: LocationMetadata;
  expiresAt: Date | string;
  canConfirm: boolean;
}

export interface LocationConflictPoint {
  hash: string;
  lat: number;
  lng: number;
  ele?: number;
}

export interface SavedPlace {
  _id: ObjectId | string;
  coordinateHash: string;
  loc: { type: "Point"; coordinates: [number, number] };
  ele?: number;
  displayName?: string | null;
  description?: string | null;
  featureTypes?: string[];
  icon?: string | null;
  style?: LocationMetadata["style"] | null;
  scale?: number | null;
  visibility?: boolean;
  sourceTimestamp?: Date | string | null;
  metadata?: LocationMetadata;
  sourceRefs?: Array<{
    importId: ObjectId | string;
    format: "gpx" | "kml" | "kmz";
    sourceIndex: number;
    metadata?: LocationMetadata;
  }>;
  reviewStatus?: "pending" | "accepted" | "rejected";
}

export interface RecordedLocationTrack {
  _id: ObjectId | string;
  fingerprint: string;
  kind: "timed-track" | "untimed-path" | "mixed-track";
  displayName?: string | null;
  pointCount: number;
  path: [number, number][];
  renderPath?: [number, number][];
  geometryCompleteness?: "full" | "render-only";
  routeBoundaryCompleteness?: "full" | "unknown" | "incomplete";
  geometryPointCount?: number;
  geometryChunkCount?: number;
  timedPointCount?: number;
  untimedPointCount?: number;
  style?: LocationMetadata["style"] | null;
  visibility?: boolean;
  metadata?: LocationMetadata;
  sourceRefs?: Array<{
    importId: ObjectId | string;
    format: "gpx" | "kml" | "kmz";
    sourceIndex: number;
    metadata?: LocationMetadata;
  }>;
}

export interface LocationTrackGeometryPoint {
  index: number;
  coordinates: [number, number];
  ele?: number;
  ts?: Date | string;
  quality: "timed" | "untimed";
}

export interface LocationTrackGeometryChunk {
  _id: ObjectId | string;
  trackId: ObjectId | string;
  chunkIndex: number;
  startIndex: number;
  points: LocationTrackGeometryPoint[];
}

export interface LocationMetadataConflict {
  _id: ObjectId | string;
  entityType: "track" | "bookmark" | "point";
  entityId: ObjectId | string;
  field: string;
  existingValue: unknown;
  incomingValue: unknown;
  incomingImportId: ObjectId | string;
  incomingFormat: "gpx" | "kml" | "kmz";
  defaultSelection: "existing" | "incoming";
  status: "pending" | "resolved";
  resolution?: "keep_existing" | "use_incoming" | "defer";
  createdAt: Date | string;
  decidedAt?: Date | string;
}

export interface LocationPointConflict {
  _id: ObjectId | string;
  ts: Date | string;
  status: "pending" | "resolved";
  resolution?: "keep_existing" | "use_incoming" | "defer";
  decidedAt?: Date | string;
  selectedImportId?: ObjectId | string;
  existingPoints?: Array<{
    hash: string;
    loc: { type: "Point"; coordinates: [number, number] };
    ele?: number;
  }>;
  candidates?: Array<{
    importId: ObjectId | string;
    format: "gpx" | "kml" | "kmz";
    points: Array<{
      hash: string;
      loc: { type: "Point"; coordinates: [number, number] };
      ele?: number;
    }>;
  }>;
}

export interface ConversationMapGroup {
  key: string;
  loc: { type: "Point"; coordinates: [number, number] };
  place: LocationPlace | null;
  stayCount: number;
  conversationCount: number;
  conversations: Array<{
    _id: ObjectId | string;
    name?: string;
    icon?: string;
    start: Date | string;
    end: Date | string | null;
    stayId: ObjectId | string;
    stayLoc: { type: "Point"; coordinates: [number, number] };
  }>;
}

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapCell {
  z: 4 | 7 | 10 | 13 | 16 | 19;
  x: number;
  y: number;
}

export interface LocationMapProjectionState {
  status: "building" | "ready" | "stale" | "failed" | "not-built";
  revision: number;
  stale: boolean;
  progress?: { processed: number; total?: number };
  error?: string;
}

export interface PresenceMapCluster {
  id: string;
  cell: MapCell;
  center: [number, number];
  dwellMs: number;
  visitCount: number;
}

export interface ConversationMapCluster {
  id: string;
  cell: MapCell;
  center: [number, number];
  bounds: MapBounds;
  conversationCount: number;
  singleGroupKey?: string;
}

export interface MapDensityResponse {
  projection: LocationMapProjectionState;
  effectiveCellZoom: MapCell["z"];
  coarsened: boolean;
  presenceClusters: PresenceMapCluster[];
  conversationClusters: ConversationMapCluster[];
  totals: {
    matchedConversations: number;
    unmatchedConversations: number;
    stays: number;
  };
}

export interface MapRouteFragment {
  id: string;
  trackId: ObjectId | string;
  fragmentIndex: number;
  path: [number, number][];
  pointCount: number;
  displayName?: string;
  sourceRefs?: RecordedLocationTrack["sourceRefs"];
  timeStart?: Date | string;
  timeEnd?: Date | string;
}

export interface MapRouteConnector {
  _id: ObjectId | string;
  reason:
    | "source_boundary"
    | "non_increasing_time"
    | "silence"
    | "teleport"
    | "sparse_jump"
    | "distance_threshold"
    | "time_threshold";
  distanceM: number;
  durationMs?: number;
  from: { coordinates: [number, number]; ts?: Date | string };
  to: { coordinates: [number, number]; ts?: Date | string };
}

export interface LocationRouteConflict {
  _id: ObjectId | string;
  pairKey: string;
  trackIds: Array<ObjectId | string>;
  trackNames: Array<string | null>;
  sources?: Array<{
    name?: string | null;
    filename?: string;
    format?: string;
    importedAt?: Date | string;
  }>;
  overlapStart: Date | string;
  overlapEnd: Date | string;
  medianSeparationM: number;
  status: "pending" | "resolved" | "superseded";
  resolution?: "use_first" | "use_second" | "keep_both" | "defer";
  resolvedAt?: Date | string;
}

export type MapRouteSourceTrack = Pick<
  RecordedLocationTrack,
  "_id" | "displayName" | "pointCount" | "geometryPointCount" |
    "routeBoundaryCompleteness" | "style"
>;

export interface MapRouteDetailResponse {
  projection: {
    status: string;
    revision: number;
    projectionVersion?: number;
    ready: boolean;
  };
  fragments: MapRouteFragment[];
  connectors: MapRouteConnector[];
  conflicts: LocationRouteConflict[];
  sourceTracks?: MapRouteSourceTrack[];
  lod: "overview" | "detail";
  detailLimited: boolean;
}

export interface MapTimelineSummary {
  dataRange: { start: Date | string; end: Date | string };
  range: { start: Date | string; end: Date | string };
  bucketMs: number;
  buckets: Array<{
    start: Date | string;
    end: Date | string;
    dwellMs: number;
    stayCount: number;
    conversationCount: number;
  }>;
  projection: LocationMapProjectionState;
}

export interface ConversationMapGroupSummary {
  groupKey: string;
  conversationCount: number;
  loc: { type: "Point"; coordinates: [number, number] };
  place: LocationPlace | null;
}

export interface ConversationMapItem {
  conversationId: ObjectId | string;
  name?: string;
  icon?: string | { text?: string; base64?: string };
  start: Date | string;
  end: Date | string;
  loc: { type: "Point"; coordinates: [number, number] };
  matchKind: "manual" | "stay" | "move";
}

/** Deterministic color per place so the same city always matches. */
export function placeColor(
  place: LocationPlace | null | undefined,
  manual = false,
): string {
  if (manual) return "#8b5cf6";
  const key = place?.geonameId?.toString() ?? place?.name ?? "unknown";
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

export function formatPlace(place: LocationPlace | null | undefined): string {
  if (!place) return "Unknown location";
  const parts = [place.city ?? place.name, place.country].filter(Boolean);
  return parts.join(", ") || "Unknown location";
}

export function segmentDurationMs(segment: LocationSegment): number {
  return new Date(segment.end).getTime() - new Date(segment.start).getTime();
}
