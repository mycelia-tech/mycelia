import type { LocationOrigin } from "@myceliasdk/location-sources.ts";
import { originFromExporter } from "./sources.server.ts";
import { createHash } from "node:crypto";
import { ObjectId } from "bson";
import type { Auth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { getFsResource, uploadToGridFS } from "@/lib/mongo/fs.server.ts";
import {
  detectFormat,
  type ParsedBookmark,
  type ParsedMetadata,
  type ParsedPoint,
  type ParsedTrack,
  type ParseResult,
  parseTrackFile,
  type TrackFormat,
} from "@/lib/location/parse.server.ts";

const PREVIEWS = "location_import_previews";
const IMPORTS = "location_imports";
const POINTS = "location_points";
const TRACKS = "location_tracks";
const TRACK_GEOMETRY = "location_track_geometry";
const BOOKMARKS = "location_bookmarks";
const CONFLICTS = "location_point_conflicts";
const METADATA_CONFLICTS = "location_metadata_conflicts";
const META = "location_meta";
const FILE_BUCKET = "location_files";
const LOOKUP_BATCH = 4000;
const WRITE_BATCH = 1000;
const GEOMETRY_CHUNK_SIZE = 2000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCATION_PARSER_VERSION = 3;
export const LOCATION_POINT_HASH_VERSION = 1;
export const LOCATION_CONTENT_PROFILE_VERSION = 3;

type MongoCall = (input: any) => Promise<any>;

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
  format: TrackFormat;
  contentHash: string;
  fileSize: number;
  parserVersion: number;
  contentProfileVersion: number;
  sourceEntryName?: string;
  exactFileMatch?: {
    importId: string;
    filename: string;
    createdAt?: Date;
  };
  timeRange?: { start: Date; end: Date };
  counts: LocationImportCounts;
  duplicateSources: Array<{
    importId: string;
    filename: string;
    matchedPoints: number;
  }>;
  conflicts: Array<{
    ts: Date;
    incoming: Array<{ hash: string; lat: number; lng: number; ele?: number }>;
    existing: Array<{
      hash: string;
      lat: number;
      lng: number;
      ele?: number;
    }>;
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
  datasetMetadata: ParsedMetadata;
  expiresAt: Date;
  canConfirm: boolean;
}

interface AnalysisInternal {
  public: Omit<LocationImportPreview, "previewId" | "expiresAt">;
  uniquePoints: Map<string, ParsedPoint>;
  existingByHash: Map<string, any>;
  newHashes: Set<string>;
  conflictHashes: Set<string>;
  existingAtConflict: Map<number, any[]>;
  trackFingerprints: string[];
  bookmarkCoordinateHashes: string[];
  revision: number;
  fingerprint: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pointHash(point: ParsedPoint): string {
  return `${point.ts.getTime()}:${point.lat.toFixed(5)}:${
    point.lng.toFixed(5)
  }`;
}

export function coordinateHash(point: { lat: number; lng: number }): string {
  return `${point.lat.toFixed(6)}:${point.lng.toFixed(6)}`;
}

export function trackFingerprint(track: ParsedTrack): string {
  const coordinates = track.coordinates.map((point) =>
    point.ts
      ? `${point.ts.getTime()}:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`
      : `${point.lat.toFixed(6)}:${point.lng.toFixed(6)}`
  );
  return sha256(`${track.kind}\n${coordinates.join("\n")}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function metadataForStorage(metadata: ParsedMetadata) {
  return {
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.customNames ? { customNames: metadata.customNames } : {}),
    ...(metadata.localizedNames
      ? { localizedNames: metadata.localizedNames }
      : {}),
    ...(metadata.localizedDescriptions
      ? { localizedDescriptions: metadata.localizedDescriptions }
      : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.featureTypes ? { featureTypes: metadata.featureTypes } : {}),
    ...(metadata.icon ? { icon: metadata.icon } : {}),
    ...(metadata.scale !== undefined ? { scale: metadata.scale } : {}),
    ...(metadata.visibility !== undefined
      ? { visibility: metadata.visibility }
      : {}),
    ...(metadata.sourceTimestamp
      ? { sourceTimestamp: metadata.sourceTimestamp }
      : {}),
    ...(metadata.localId ? { localId: metadata.localId } : {}),
    ...(metadata.additionalStyle
      ? { additionalStyle: metadata.additionalStyle }
      : {}),
    ...(metadata.accessRules ? { accessRules: metadata.accessRules } : {}),
    ...(metadata.annotation ? { annotation: metadata.annotation } : {}),
    ...(metadata.folderPath ? { folderPath: metadata.folderPath } : {}),
    ...(metadata.rawMetadata ? { rawMetadata: metadata.rawMetadata } : {}),
    ...(metadata.style ? { style: metadata.style } : {}),
    ...(metadata.styleDefinitions
      ? { styleDefinitions: metadata.styleDefinitions }
      : {}),
  };
}

function displayName(metadata: ParsedMetadata): string | undefined {
  return metadata.customNames?.default ?? metadata.localizedNames?.default ??
    metadata.name;
}

function metadataPriority(format: TrackFormat): number {
  return format === "kmz" || format === "kml" ? 20 : 10;
}

function bookmarkIdentity(bookmark: ParsedBookmark): string {
  if (bookmark.localId) {
    return `local:${bookmark.localId}:coord:${coordinateHash(bookmark)}`;
  }
  const name = displayName(bookmark)?.trim().toLocaleLowerCase();
  return name
    ? `coord:${coordinateHash(bookmark)}:name:${name}`
    : `coord:${coordinateHash(bookmark)}`;
}

function existingBookmarkIdentity(bookmark: any): string | undefined {
  if (bookmark.identityKey) return String(bookmark.identityKey);
  const localId = bookmark.metadata?.localId;
  if (localId) return `local:${localId}:coord:${bookmark.coordinateHash}`;
  const name = String(bookmark.displayName ?? "").trim().toLocaleLowerCase();
  return name ? `coord:${bookmark.coordinateHash}:name:${name}` : undefined;
}

function chooseBookmarkCandidate(
  bookmark: ParsedBookmark,
  candidates: any[],
): any | undefined {
  const identity = bookmarkIdentity(bookmark);
  const exact = candidates.filter((candidate) =>
    existingBookmarkIdentity(candidate) === identity
  );
  if (exact.length === 1) return exact[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

const REVIEWABLE_METADATA_FIELDS = [
  "name",
  "customNames",
  "localizedNames",
  "localizedDescriptions",
  "description",
  "featureTypes",
  "icon",
  "scale",
  "visibility",
  "sourceTimestamp",
  "localId",
  "additionalStyle",
  "accessRules",
  "annotation",
  "style",
] as const;

function comparableMetadata(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object") {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(),
      ),
    );
  }
  return JSON.stringify(value);
}

function comparableColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hasHash = value.startsWith("#");
  const hex = value.replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return hex;
  if (!/^[0-9a-f]{8}$/.test(hex)) return value.toLowerCase();
  if (hasHash) return hex.slice(2);
  return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`;
}

function stylesConflict(existing: unknown, incoming: unknown): boolean {
  if (!existing || typeof existing !== "object") return false;
  if (!incoming || typeof incoming !== "object") return false;
  const left = existing as Record<string, unknown>;
  const right = incoming as Record<string, unknown>;
  for (const field of ["color", "width", "icon", "styleUrl"]) {
    if (left[field] === undefined || right[field] === undefined) continue;
    const leftValue = field === "color"
      ? comparableColor(left[field])
      : comparableMetadata(left[field]);
    const rightValue = field === "color"
      ? comparableColor(right[field])
      : comparableMetadata(right[field]);
    if (leftValue !== rightValue) return true;
  }
  return false;
}

function metadataFieldDifferences(
  existing: Record<string, any> | undefined,
  incoming: Record<string, any>,
): Array<{ field: string; existingValue: unknown; incomingValue: unknown }> {
  if (!existing) return [];
  return REVIEWABLE_METADATA_FIELDS.flatMap((field) => {
    const existingValue = existing[field];
    const incomingValue = incoming[field];
    if (
      existingValue === undefined || existingValue === null ||
      incomingValue === undefined || incomingValue === null ||
      (field === "style" && !stylesConflict(existingValue, incomingValue)) ||
      comparableMetadata(existingValue) === comparableMetadata(incomingValue)
    ) return [];
    return [{ field, existingValue, incomingValue }];
  });
}

function decimateCoordinates(
  coordinates: Array<{ lat: number; lng: number }>,
  budget = 2000,
): [number, number][] {
  if (coordinates.length <= budget) {
    return coordinates.map((point) => [point.lng, point.lat]);
  }
  const result: [number, number][] = [];
  const stride = (coordinates.length - 1) / (budget - 1);
  for (let index = 0; index < budget; index++) {
    const point = coordinates[Math.round(index * stride)];
    result.push([point.lng, point.lat]);
  }
  return result;
}

function contentProfile(
  dataset: ParseResult,
  file: {
    sizeBytes: number;
    contentHash: string;
    format: TrackFormat;
    sourceEntryName?: string;
  },
) {
  return {
    version: LOCATION_CONTENT_PROFILE_VERSION,
    file: {
      ...file,
      parserVersion: LOCATION_PARSER_VERSION,
    },
    datasetMetadata: metadataForStorage(dataset.datasetMetadata),
    counts: {
      timedCoordinates: dataset.points.length,
      untimedCoordinates: dataset.untimedCoordinates,
      trackCoordinates: dataset.tracks.reduce(
        (total, track) => total + track.coordinates.length,
        0,
      ),
      timedTracks:
        dataset.tracks.filter((track) => track.kind === "timed-track").length,
      untimedTracks:
        dataset.tracks.filter((track) => track.kind === "untimed-path").length,
      mixedTracks:
        dataset.tracks.filter((track) => track.kind === "mixed-track").length,
      tracks: dataset.tracks.length,
      withinFileTrackDuplicates: dataset.tracks.length -
        new Set(dataset.tracks.map(trackFingerprint)).size,
      bookmarks: dataset.bookmarks.length,
      withinFileBookmarkDuplicates: dataset.bookmarks.length -
        new Set(dataset.bookmarks.map(bookmarkIdentity)).size,
      invalidCoordinates: dataset.invalidCoordinates,
      invalidTimestamps: dataset.invalidTimestamps,
      unpairedCoordinates: dataset.unpairedCoordinates,
      unpairedTimestamps: dataset.unpairedTimestamps,
      unsupportedGeometries: dataset.unsupportedGeometries,
      styleDefinitions: Object.keys(
        dataset.datasetMetadata.styleDefinitions ?? {},
      ).length,
    },
  };
}

async function getRevision(mongo: MongoCall): Promise<number> {
  const doc = await mongo({
    action: "findOne",
    collection: META,
    query: { key: "import-revision" },
  });
  return Number(doc?.value ?? 0);
}

async function cleanupExpiredPreviews(
  auth: Auth,
  mongo: MongoCall,
): Promise<void> {
  const expired = await mongo({
    action: "find",
    collection: PREVIEWS,
    query: { expiresAt: { $lte: new Date() } },
    options: { limit: 100, projection: { stagedFileId: 1, status: 1 } },
  });
  if (expired.length === 0) return;
  const fs = await getFsResource(auth);
  for (const preview of expired) {
    if (preview.status !== "confirmed" && preview.stagedFileId) {
      try {
        await fs({
          action: "delete",
          bucket: FILE_BUCKET,
          id: String(preview.stagedFileId),
        });
      } catch (error) {
        console.warn(
          "[location-import] Expired staged file cleanup failed:",
          error instanceof Error ? error.message : error,
        );
        continue;
      }
    }
    await mongo({
      action: "deleteOne",
      collection: PREVIEWS,
      query: { _id: preview._id },
    });
  }
}

export async function bumpLocationImportRevision(
  mongo: MongoCall,
): Promise<void> {
  await mongo({
    action: "updateOne",
    collection: META,
    query: { key: "import-revision" },
    update: { $inc: { value: 1 }, $set: { changedAt: new Date() } },
    options: { upsert: true },
  });
}

async function findByValues(
  mongo: MongoCall,
  collection: string,
  field: string,
  values: unknown[],
  projection?: Record<string, number>,
): Promise<any[]> {
  const found: any[] = [];
  for (const valuesChunk of chunk(values, LOOKUP_BATCH)) {
    if (valuesChunk.length === 0) continue;
    found.push(
      ...await mongo({
        action: "find",
        collection,
        query: { [field]: { $in: valuesChunk } },
        options: {
          ...(projection ? { projection } : {}),
          limit: Math.max(valuesChunk.length * 4, LOOKUP_BATCH),
        },
      }),
    );
  }
  return found;
}

function sourceImportIds(point: any): string[] {
  const ids = Array.isArray(point.importIds) && point.importIds.length > 0
    ? point.importIds
    : point.importId != null
    ? [point.importId]
    : [];
  return Array.from(
    new Set<string>(ids.map((id: unknown) => String(id))),
  );
}

function pointGroups(
  points: Iterable<ParsedPoint>,
): Map<number, ParsedPoint[]> {
  const groups = new Map<number, ParsedPoint[]>();
  for (const point of points) {
    const timestamp = point.ts.getTime();
    const group = groups.get(timestamp) ?? [];
    group.push(point);
    groups.set(timestamp, group);
  }
  return groups;
}

export async function analyzeLocationDataset(
  mongo: MongoCall,
  filename: string,
  format: TrackFormat,
  contentHash: string,
  dataset: ParseResult,
  fileFacts: { sizeBytes?: number; sourceEntryName?: string } = {},
): Promise<AnalysisInternal> {
  const exact = await mongo({
    action: "findOne",
    collection: IMPORTS,
    query: { contentHash, committedAt: { $exists: true } },
    options: { projection: { filename: 1, createdAt: 1 } },
  });

  const uniquePoints = new Map<string, ParsedPoint>();
  let withinFileDuplicates = 0;
  for (const point of dataset.points) {
    const hash = pointHash(point);
    if (uniquePoints.has(hash)) withinFileDuplicates++;
    else uniquePoints.set(hash, point);
  }

  const hashes = [...uniquePoints.keys()];
  const existingDocs = await findByValues(
    mongo,
    POINTS,
    "hash",
    hashes,
    { hash: 1, ts: 1, loc: 1, ele: 1, importId: 1, importIds: 1, visible: 1 },
  );
  const existingByHash = new Map(
    existingDocs.filter((doc) => doc.visible !== false).map((doc) => [
      doc.hash,
      doc,
    ]),
  );

  const incomingByTs = pointGroups(uniquePoints.values());
  const unmatchedByTs = new Map<number, ParsedPoint[]>();
  for (const [timestamp, points] of incomingByTs) {
    const unmatched = points.filter((point) =>
      !existingByHash.has(pointHash(point))
    );
    if (unmatched.length > 0) unmatchedByTs.set(timestamp, unmatched);
  }

  const existingAtTimes = await findByValues(
    mongo,
    POINTS,
    "ts",
    [...unmatchedByTs.keys()].map((timestamp) => new Date(timestamp)),
    { hash: 1, ts: 1, loc: 1, ele: 1, visible: 1, selection: 1 },
  );
  const existingByTs = new Map<number, any[]>();
  for (const point of existingAtTimes) {
    if (point.visible === false || point.selection === "rejected") continue;
    const timestamp = new Date(point.ts).getTime();
    const group = existingByTs.get(timestamp) ?? [];
    group.push(point);
    existingByTs.set(timestamp, group);
  }

  const conflictHashes = new Set<string>();
  const conflicts: LocationImportPreview["conflicts"] = [];
  for (const [timestamp, incoming] of unmatchedByTs) {
    const existing = existingByTs.get(timestamp) ?? [];
    if (existing.length === 0) continue;
    for (const point of incoming) conflictHashes.add(pointHash(point));
    if (conflicts.length < 50) {
      conflicts.push({
        ts: new Date(timestamp),
        incoming: incoming.map((point) => ({
          hash: pointHash(point),
          lat: point.lat,
          lng: point.lng,
          ...(point.ele !== undefined ? { ele: point.ele } : {}),
        })),
        existing: existing.map((point) => ({
          hash: point.hash,
          lat: point.loc.coordinates[1],
          lng: point.loc.coordinates[0],
          ...(point.ele !== undefined ? { ele: point.ele } : {}),
        })),
      });
    }
  }
  const newHashes = new Set(
    hashes.filter((hash) =>
      !existingByHash.has(hash) && !conflictHashes.has(hash)
    ),
  );

  const sourceCounts = new Map<string, number>();
  for (const point of existingByHash.values()) {
    for (const importId of sourceImportIds(point)) {
      sourceCounts.set(importId, (sourceCounts.get(importId) ?? 0) + 1);
    }
  }
  const sourceObjectIds = [...sourceCounts.keys()].filter(ObjectId.isValid).map(
    (id) => new ObjectId(id),
  );
  const sourceImports = await findByValues(
    mongo,
    IMPORTS,
    "_id",
    sourceObjectIds,
    { filename: 1, committedAt: 1 },
  );
  const duplicateSources = sourceImports.filter((source) => source.committedAt)
    .map((source) => ({
      importId: String(source._id),
      filename: source.filename,
      matchedPoints: sourceCounts.get(String(source._id)) ?? 0,
    })).sort((a, b) => b.matchedPoints - a.matchedPoints);

  const trackFingerprints = dataset.tracks.map(trackFingerprint);
  const uniqueTrackFingerprints = [...new Set(trackFingerprints)];
  const existingTracks = await findByValues(
    mongo,
    TRACKS,
    "fingerprint",
    uniqueTrackFingerprints,
    { fingerprint: 1, metadata: 1, _id: 1 },
  );
  const matchedTrackFingerprints = new Set(
    existingTracks.map((track) => track.fingerprint),
  );

  const bookmarkCoordinateHashes = dataset.bookmarks.map(coordinateHash);
  const existingBookmarks = await findByValues(
    mongo,
    BOOKMARKS,
    "coordinateHash",
    bookmarkCoordinateHashes,
    {
      coordinateHash: 1,
      identityKey: 1,
      metadata: 1,
      displayName: 1,
      _id: 1,
    },
  );
  const bookmarksByCoordinate = new Map<string, any[]>();
  for (const bookmark of existingBookmarks) {
    const candidates = bookmarksByCoordinate.get(bookmark.coordinateHash) ?? [];
    candidates.push(bookmark);
    bookmarksByCoordinate.set(bookmark.coordinateHash, candidates);
  }
  const uniqueBookmarks = [...new Map(dataset.bookmarks.map((bookmark) => [
    bookmarkIdentity(bookmark),
    bookmark,
  ])).values()];
  const bookmarkMatches = uniqueBookmarks.map((bookmark) => ({
    bookmark,
    candidates: bookmarksByCoordinate.get(coordinateHash(bookmark)) ?? [],
  })).map((entry) => ({
    ...entry,
    match: chooseBookmarkCandidate(entry.bookmark, entry.candidates),
  }));
  const bookmarksMatched = bookmarkMatches.filter((entry) => entry.match)
    .length;
  const ambiguousBookmarks = bookmarkMatches.filter((entry) =>
    !entry.match && entry.candidates.length > 0
  );
  const metadataDifferences: LocationImportPreview["metadataDifferences"] = [];
  for (const [hash, existingPoint] of existingByHash) {
    const incomingElevation = uniquePoints.get(hash)?.ele;
    if (
      existingPoint.ele !== undefined && incomingElevation !== undefined &&
      Number(existingPoint.ele) !== incomingElevation
    ) {
      metadataDifferences.push({
        kind: "elevation",
        hash,
        existing: Number(existingPoint.ele),
        incoming: incomingElevation,
      });
    }
  }
  for (const entry of ambiguousBookmarks) {
    const hash = coordinateHash(entry.bookmark);
    metadataDifferences.push({
      kind: "ambiguous_bookmark",
      coordinateHash: hash,
    });
  }
  for (const track of dataset.tracks) {
    const fingerprint = trackFingerprint(track);
    const existing = existingTracks.find((item) =>
      item.fingerprint === fingerprint
    );
    if (!existing) continue;
    const incoming = metadataForStorage(track);
    for (
      const difference of metadataFieldDifferences(existing.metadata, incoming)
    ) {
      metadataDifferences.push({
        kind: "entity_metadata",
        entityType: "track",
        entityId: String(existing._id),
        ...difference,
      });
    }
  }
  for (const entry of bookmarkMatches) {
    if (!entry.match) continue;
    const incoming = metadataForStorage(entry.bookmark);
    for (
      const difference of metadataFieldDifferences(
        entry.match.metadata,
        incoming,
      )
    ) {
      metadataDifferences.push({
        kind: "entity_metadata",
        entityType: "bookmark",
        entityId: String(entry.match._id),
        ...difference,
      });
    }
  }

  const groupedConflictTimestamps = new Set(
    [...conflictHashes].map((hash) => Number(hash.split(":", 1)[0])),
  );
  const counts: LocationImportCounts = {
    sourcePoints: dataset.points.length,
    uniquePoints: uniquePoints.size,
    newPoints: newHashes.size,
    matchedPoints: existingByHash.size,
    withinFileDuplicates,
    withinFileTrackDuplicates: dataset.tracks.length -
      uniqueTrackFingerprints.length,
    withinFileBookmarkDuplicates: dataset.bookmarks.length -
      uniqueBookmarks.length,
    conflictPoints: conflictHashes.size,
    conflictGroups: groupedConflictTimestamps.size,
    skipped: dataset.skipped,
    timedCoordinates: dataset.points.length,
    untimedCoordinates: dataset.untimedCoordinates,
    trackCoordinates: dataset.tracks.reduce(
      (total, track) => total + track.coordinates.length,
      0,
    ),
    timedTracks:
      dataset.tracks.filter((track) => track.kind === "timed-track").length,
    untimedTracks:
      dataset.tracks.filter((track) => track.kind === "untimed-path").length,
    mixedTracks:
      dataset.tracks.filter((track) => track.kind === "mixed-track").length,
    invalidCoordinates: dataset.invalidCoordinates,
    invalidTimestamps: dataset.invalidTimestamps,
    unpairedCoordinates: dataset.unpairedCoordinates,
    unpairedTimestamps: dataset.unpairedTimestamps,
    unsupportedGeometries: dataset.unsupportedGeometries,
    styleDefinitions: Object.keys(
      dataset.datasetMetadata.styleDefinitions ?? {},
    ).length,
    tracks: dataset.tracks.length,
    tracksNew:
      uniqueTrackFingerprints.filter((fingerprint) =>
        !matchedTrackFingerprints.has(fingerprint)
      ).length,
    tracksMatched:
      uniqueTrackFingerprints.filter((fingerprint) =>
        matchedTrackFingerprints.has(fingerprint)
      ).length,
    bookmarks: dataset.bookmarks.length,
    bookmarksNew: uniqueBookmarks.length - bookmarksMatched -
      ambiguousBookmarks.length,
    bookmarksMatched,
    metadataReview: metadataDifferences.length,
  };
  const revision = await getRevision(mongo);
  const fingerprint = sha256(JSON.stringify({ contentHash, revision, counts }));
  const pointValues = [...uniquePoints.values()];

  return {
    public: {
      filename,
      format,
      contentHash,
      fileSize: fileFacts.sizeBytes ?? 0,
      parserVersion: LOCATION_PARSER_VERSION,
      contentProfileVersion: LOCATION_CONTENT_PROFILE_VERSION,
      ...(fileFacts.sourceEntryName
        ? { sourceEntryName: fileFacts.sourceEntryName }
        : {}),
      ...(exact
        ? {
          exactFileMatch: {
            importId: String(exact._id),
            filename: exact.filename,
            createdAt: exact.createdAt,
          },
        }
        : {}),
      ...(pointValues.length > 0
        ? {
          timeRange: {
            start: pointValues[0].ts,
            end: pointValues[pointValues.length - 1].ts,
          },
        }
        : {}),
      counts,
      duplicateSources,
      conflicts,
      metadataDifferences: metadataDifferences.slice(0, 100),
      datasetMetadata: metadataForStorage(dataset.datasetMetadata),
      canConfirm: !exact &&
        (counts.newPoints > 0 || counts.matchedPoints > 0 ||
          counts.conflictPoints > 0 || counts.tracks > 0 ||
          counts.bookmarks > 0),
    },
    uniquePoints,
    existingByHash,
    newHashes,
    conflictHashes,
    existingAtConflict: existingByTs,
    trackFingerprints,
    bookmarkCoordinateHashes,
    revision,
    fingerprint,
  };
}

export async function analyzeLocationFile(
  auth: Auth,
  file: { originalname: string; mimetype: string; buffer: Uint8Array },
  originOverride?: LocationOrigin,
): Promise<LocationImportPreview> {
  const format = detectFormat(file.originalname);
  if (!format) throw new Error("UNSUPPORTED_FORMAT");
  const bytes = new Uint8Array(file.buffer);
  const contentHash = sha256(bytes);
  const dataset = parseTrackFile(format, bytes);
  const origin = originOverride ?? originFromExporter(dataset.exporter);
  if (
    dataset.points.length === 0 && dataset.tracks.length === 0 &&
    dataset.bookmarks.length === 0
  ) {
    throw new Error("NO_LOCATION_DATA");
  }

  const mongo = await getMongoResource(auth);
  await cleanupExpiredPreviews(auth, mongo);
  const analysis = await analyzeLocationDataset(
    mongo,
    file.originalname,
    format,
    contentHash,
    dataset,
    { sizeBytes: bytes.byteLength, sourceEntryName: dataset.sourceEntryName },
  );
  const previewId = new ObjectId();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  let stagedFileId: ObjectId | undefined;
  if (!analysis.public.exactFileMatch) {
    stagedFileId = await uploadToGridFS(
      auth,
      new File([bytes], file.originalname, { type: file.mimetype }),
      FILE_BUCKET,
      { source: "location-import-preview", previewId: String(previewId) },
    );
  }
  await mongo({
    action: "insertOne",
    collection: PREVIEWS,
    doc: {
      _id: previewId,
      filename: file.originalname,
      format,
      contentHash,
      ...(stagedFileId ? { stagedFileId } : {}),
      ...(origin ? { origin } : {}),
      status: "ready",
      parserVersion: LOCATION_PARSER_VERSION,
      pointHashVersion: LOCATION_POINT_HASH_VERSION,
      revision: analysis.revision,
      analysisFingerprint: analysis.fingerprint,
      analysis: analysis.public,
      expiresAt,
      createdAt: new Date(),
      createdBy: auth.principal || "web",
    },
  });
  return { previewId: String(previewId), expiresAt, ...analysis.public, origin };
}

async function recordEntityMetadataConflicts(
  mongo: MongoCall,
  importId: ObjectId,
  format: TrackFormat,
  entityType: "track" | "bookmark",
  entityId: ObjectId,
  existing: Record<string, any> | undefined,
  incoming: Record<string, any>,
  existingPriority: number,
): Promise<void> {
  await mongo({
    action: "deleteMany",
    collection: METADATA_CONFLICTS,
    query: {
      incomingImportId: importId,
      entityType,
      entityId,
      status: "pending",
      resolution: { $exists: false },
    },
  });
  const differences = metadataFieldDifferences(existing, incoming);
  if (differences.length === 0) return;
  await mongo({
    action: "bulkWrite",
    collection: METADATA_CONFLICTS,
    operations: differences.map((difference) => {
      const conflictKey =
        `${entityType}:${entityId}:${difference.field}:${importId}`;
      const incomingPriority = metadataPriority(format);
      return {
        updateOne: {
          filter: { conflictKey },
          update: {
            $setOnInsert: {
              _id: new ObjectId(),
              conflictKey,
              entityType,
              entityId,
              field: difference.field,
              existingValue: difference.existingValue,
              incomingValue: difference.incomingValue,
              incomingImportId: importId,
              incomingFormat: format,
              defaultSelection: incomingPriority >= existingPriority
                ? "incoming"
                : "existing",
              status: "pending",
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      };
    }),
    options: { ordered: false },
  });
}

async function recordPointMetadataConflicts(
  mongo: MongoCall,
  importId: ObjectId,
  format: TrackFormat,
  analysis: AnalysisInternal,
): Promise<void> {
  const operations = [...analysis.existingByHash.entries()].flatMap(
    ([hash, existing]) => {
      const incoming = analysis.uniquePoints.get(hash);
      if (
        existing.ele === undefined || incoming?.ele === undefined ||
        Number(existing.ele) === incoming.ele
      ) return [];
      const conflictKey = `point:${existing._id}:ele:${importId}`;
      return [{
        updateOne: {
          filter: { conflictKey },
          update: {
            $setOnInsert: {
              _id: new ObjectId(),
              conflictKey,
              entityType: "point",
              entityId: existing._id,
              field: "ele",
              existingValue: Number(existing.ele),
              incomingValue: incoming.ele,
              incomingImportId: importId,
              incomingFormat: format,
              defaultSelection: "existing",
              status: "pending",
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      }];
    },
  );
  for (const batch of chunk(operations, WRITE_BATCH)) {
    await mongo({
      action: "bulkWrite",
      collection: METADATA_CONFLICTS,
      operations: batch,
      options: { ordered: false },
    });
  }
}

async function replaceTrackGeometry(
  mongo: MongoCall,
  trackId: ObjectId,
  coordinates: ParsedTrack["coordinates"],
): Promise<number> {
  const chunks = chunk(coordinates, GEOMETRY_CHUNK_SIZE);
  for (
    const batch of chunk(
      chunks.map((points, chunkIndex) => ({
        chunkIndex,
        points,
      })),
      100,
    )
  ) {
    await mongo({
      action: "bulkWrite",
      collection: TRACK_GEOMETRY,
      operations: batch.map(({ chunkIndex, points }) => ({
        updateOne: {
          filter: { trackId, chunkIndex },
          update: {
            $set: {
              startIndex: chunkIndex * GEOMETRY_CHUNK_SIZE,
              points: points.map((point, offset) => ({
                index: chunkIndex * GEOMETRY_CHUNK_SIZE + offset,
                coordinates: [point.lng, point.lat],
                ...(point.ele !== undefined ? { ele: point.ele } : {}),
                ...(point.ts ? { ts: point.ts } : {}),
                ...(point.sourceFragmentIndex !== undefined
                  ? { sourceFragmentIndex: point.sourceFragmentIndex }
                  : {}),
                ...(point.sourcePointIndex !== undefined
                  ? { sourcePointIndex: point.sourcePointIndex }
                  : {}),
                quality: point.ts ? "timed" : "untimed",
              })),
              updatedAt: new Date(),
            },
            $setOnInsert: { _id: new ObjectId(), trackId, chunkIndex },
          },
          upsert: true,
        },
      })),
      options: { ordered: false },
    });
  }
  await mongo({
    action: "deleteMany",
    collection: TRACK_GEOMETRY,
    query: { trackId, chunkIndex: { $gte: chunks.length } },
  });
  return chunks.length;
}

async function upsertTracks(
  mongo: MongoCall,
  importId: ObjectId,
  format: TrackFormat,
  tracks: ParsedTrack[],
): Promise<void> {
  const groupedTracks = new Map<string, ParsedTrack[]>();
  for (const track of tracks) {
    const fingerprint = trackFingerprint(track);
    groupedTracks.set(fingerprint, [
      ...(groupedTracks.get(fingerprint) ?? []),
      track,
    ]);
  }
  const fingerprints = [...groupedTracks.keys()];
  const existingTracks = await findByValues(
    mongo,
    TRACKS,
    "fingerprint",
    fingerprints,
  );
  const existingByFingerprint = new Map(
    existingTracks.map((track) => [track.fingerprint, track]),
  );
  const descriptors = [...groupedTracks.entries()].map(
    ([fingerprint, sourceTracks]) => {
      const track = sourceTracks[0];
      const existing = existingByFingerprint.get(fingerprint);
      return {
        track,
        sourceTracks,
        fingerprint,
        existing,
        trackId: existing?._id ?? new ObjectId(),
        applyGeometry: !existing || existing.geometryCompleteness !== "full" ||
          Number(existing.geometryPriority ?? 0) <= metadataPriority(format),
      };
    },
  );
  for (const batch of chunk(descriptors, WRITE_BATCH)) {
    const operations = batch.map(
      ({
        track,
        sourceTracks,
        fingerprint,
        existing,
        trackId,
      }) => {
        const metadata = metadataForStorage(track);
        const applyCanonical = !existing?.manualOverrides &&
          Number(existing?.metadataPriority ?? 0) <= metadataPriority(format);
        return {
          updateOne: {
            filter: { fingerprint },
            update: {
              $setOnInsert: {
                _id: trackId,
                fingerprint,
                visible: false,
                visibilityOwner: importId,
                createdAt: new Date(),
              },
              ...(applyCanonical
                ? {
                  $set: {
                    metadata,
                    displayName: displayName(track) ?? null,
                    style: track.style ?? null,
                    visibility: track.visibility ?? true,
                    metadataPriority: metadataPriority(format),
                  },
                }
                : {}),
              $addToSet: {
                sourceRefs: {
                  $each: sourceTracks.map((sourceTrack) => ({
                    importId,
                    format,
                    sourceIndex: sourceTrack.sourceIndex,
                    metadata: metadataForStorage(sourceTrack),
                  })),
                },
              },
            },
            upsert: true,
          },
        };
      },
    );
    if (operations.length > 0) {
      await mongo({
        action: "bulkWrite",
        collection: TRACKS,
        operations,
        options: { ordered: false },
      });
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.applyGeometry) {
      const geometryChunkCount = await replaceTrackGeometry(
        mongo,
        descriptor.trackId,
        descriptor.track.coordinates,
      );
      const renderPath = decimateCoordinates(descriptor.track.coordinates);
      await mongo({
        action: "updateOne",
        collection: TRACKS,
        query: { _id: descriptor.trackId },
        update: {
          $set: {
            kind: descriptor.track.kind,
            path: renderPath,
            renderPath,
            pointCount: descriptor.track.coordinates.length,
            geometryPointCount: descriptor.track.coordinates.length,
            geometryChunkCount,
            geometryCompleteness: "full",
            geometryPriority: metadataPriority(format),
            contentProfileVersion: LOCATION_CONTENT_PROFILE_VERSION,
            routeBoundaryCompleteness: "full",
            timedPointCount: descriptor.track.coordinates.filter((point) =>
              point.ts
            ).length,
            untimedPointCount: descriptor.track.coordinates.filter((point) =>
              !point.ts
            ).length,
          },
        },
      });
    }
    if (descriptor.existing) {
      await recordEntityMetadataConflicts(
        mongo,
        importId,
        format,
        "track",
        descriptor.trackId,
        descriptor.existing.metadata,
        metadataForStorage(descriptor.track),
        Number(descriptor.existing.metadataPriority ?? 0),
      );
    }
  }
}

async function upsertBookmarks(
  mongo: MongoCall,
  importId: ObjectId,
  format: TrackFormat,
  bookmarks: ParsedBookmark[],
): Promise<void> {
  const groupedBookmarks = new Map<string, ParsedBookmark[]>();
  for (const bookmark of bookmarks) {
    const identity = bookmarkIdentity(bookmark);
    groupedBookmarks.set(identity, [
      ...(groupedBookmarks.get(identity) ?? []),
      bookmark,
    ]);
  }
  const bookmarkGroups = [...groupedBookmarks.values()];
  const coordinateHashes = bookmarkGroups.map((group) =>
    coordinateHash(group[0])
  );
  const existing = await findByValues(
    mongo,
    BOOKMARKS,
    "coordinateHash",
    coordinateHashes,
  );
  const byCoordinate = new Map<string, any[]>();
  for (const bookmark of existing) {
    const values = byCoordinate.get(bookmark.coordinateHash) ?? [];
    values.push(bookmark);
    byCoordinate.set(bookmark.coordinateHash, values);
  }
  const operations: any[] = [];
  for (const sourceBookmarks of bookmarkGroups) {
    const bookmark = sourceBookmarks[0];
    const coordHash = coordinateHash(bookmark);
    const candidates = byCoordinate.get(coordHash) ?? [];
    const candidate = chooseBookmarkCandidate(bookmark, candidates);
    const metadata = metadataForStorage(bookmark);
    const canonical = {
      identityKey: bookmarkIdentity(bookmark),
      metadata,
      displayName: displayName(bookmark) ?? null,
      description: bookmark.description ?? null,
      featureTypes: bookmark.featureTypes ?? [],
      icon: bookmark.icon ?? bookmark.style?.icon ?? null,
      style: bookmark.style ?? null,
      scale: bookmark.scale ?? null,
      visibility: bookmark.visibility ?? true,
      sourceTimestamp: bookmark.sourceTimestamp ?? null,
      metadataPriority: metadataPriority(format),
    };
    const sourceRefs = sourceBookmarks.map((sourceBookmark) => ({
      importId,
      format,
      sourceIndex: sourceBookmark.sourceIndex,
      metadata: metadataForStorage(sourceBookmark),
    }));
    if (candidate) {
      const applyCanonical = !candidate.manualOverrides &&
        Number(candidate.metadataPriority ?? 0) <= metadataPriority(format);
      operations.push({
        updateOne: {
          filter: { _id: candidate._id },
          update: {
            ...(applyCanonical ? { $set: canonical } : {}),
            $addToSet: { sourceRefs: { $each: sourceRefs } },
          },
        },
      });
      await recordEntityMetadataConflicts(
        mongo,
        importId,
        format,
        "bookmark",
        candidate._id,
        candidate.metadata,
        metadata,
        Number(candidate.metadataPriority ?? 0),
      );
    } else {
      operations.push({
        insertOne: {
          document: {
            _id: new ObjectId(),
            coordinateHash: coordHash,
            loc: {
              type: "Point",
              coordinates: [bookmark.lng, bookmark.lat],
            },
            ...(bookmark.ele !== undefined ? { ele: bookmark.ele } : {}),
            ...canonical,
            sourceRefs,
            visible: false,
            visibilityOwner: importId,
            ...(candidates.length > 0 ? { reviewStatus: "pending" } : {}),
            createdAt: new Date(),
          },
        },
      });
    }
  }
  for (const batch of chunk(operations, WRITE_BATCH)) {
    await mongo({
      action: "bulkWrite",
      collection: BOOKMARKS,
      operations: batch,
      options: { ordered: false },
    });
  }
}

async function recordConflicts(
  mongo: MongoCall,
  importId: ObjectId,
  format: TrackFormat,
  analysis: AnalysisInternal,
): Promise<void> {
  const grouped = pointGroups(
    [...analysis.uniquePoints.entries()].filter(([hash]) =>
      analysis.conflictHashes.has(hash)
    ).map(([, point]) => point),
  );
  const operations = [...grouped.entries()].map(([timestamp, incoming]) => ({
    updateOne: {
      filter: { conflictKey: `ts:${timestamp}` },
      update: {
        $setOnInsert: {
          _id: new ObjectId(),
          conflictKey: `ts:${timestamp}`,
          ts: new Date(timestamp),
          status: "pending",
          createdAt: new Date(),
        },
        $addToSet: {
          candidates: {
            importId,
            format,
            points: incoming.map((point) => ({
              hash: pointHash(point),
              loc: {
                type: "Point",
                coordinates: [point.lng, point.lat],
              },
              ...(point.ele !== undefined ? { ele: point.ele } : {}),
            })),
          },
          sourceImportIds: importId,
        },
        $set: {
          existingPoints: (analysis.existingAtConflict.get(timestamp) ?? [])
            .map((point) => ({
              hash: point.hash,
              loc: point.loc,
              ...(point.ele !== undefined ? { ele: point.ele } : {}),
            })),
        },
      },
      upsert: true,
    },
  }));
  for (const batch of chunk(operations, WRITE_BATCH)) {
    await mongo({
      action: "bulkWrite",
      collection: CONFLICTS,
      operations: batch,
      options: { ordered: false },
    });
  }
}

function canonicalEntityFields(
  entityType: "track" | "bookmark",
  entity: Record<string, any>,
  metadata: Record<string, any>,
  priority: number,
): Record<string, unknown> {
  const common = {
    metadata,
    displayName: displayName(metadata) ?? null,
    style: metadata.style ?? null,
    visibility: metadata.visibility ?? true,
    metadataPriority: priority,
  };
  if (entityType === "track") {
    return { ...common, geometryPriority: priority };
  }
  const name = displayName(metadata)?.trim().toLocaleLowerCase();
  const identityKey = metadata.localId
    ? `local:${metadata.localId}:coord:${entity.coordinateHash}`
    : name
    ? `coord:${entity.coordinateHash}:name:${name}`
    : `coord:${entity.coordinateHash}`;
  return {
    ...common,
    identityKey,
    description: metadata.description ?? null,
    featureTypes: metadata.featureTypes ?? [],
    icon: metadata.icon ?? metadata.style?.icon ?? null,
    scale: metadata.scale ?? null,
    sourceTimestamp: metadata.sourceTimestamp ?? null,
  };
}

/** Remove one import's typed provenance without leaving occurrence duplicates. */
export async function removeLocationEntitySourceRefs(
  mongo: MongoCall,
  importId: ObjectId,
): Promise<void> {
  for (
    const [collection, entityType] of [
      [TRACKS, "track"],
      [BOOKMARKS, "bookmark"],
    ] as const
  ) {
    const entities = await mongo({
      action: "find",
      collection,
      query: { "sourceRefs.importId": importId },
      options: { limit: 100000 },
    });
    for (const entity of entities) {
      const remaining = (entity.sourceRefs ?? []).filter((source: any) =>
        String(source.importId) !== String(importId)
      );
      if (remaining.length === 0) {
        if (entityType === "track") {
          await mongo({
            action: "deleteMany",
            collection: TRACK_GEOMETRY,
            query: { trackId: entity._id },
          });
        }
        await mongo({
          action: "deleteOne",
          collection,
          query: { _id: entity._id },
        });
        continue;
      }
      const selected = remaining.reduce((best: any, source: any) =>
        metadataPriority(source.format) >= metadataPriority(best.format)
          ? source
          : best
      );
      const canonical = entity.manualOverrides ? {} : canonicalEntityFields(
        entityType,
        entity,
        selected.metadata ?? {},
        metadataPriority(selected.format),
      );
      await mongo({
        action: "updateOne",
        collection,
        query: { _id: entity._id },
        update: { $set: { sourceRefs: remaining, ...canonical } },
      });
    }
  }
}

async function publishImportedEntities(
  mongo: MongoCall,
  importId: ObjectId,
): Promise<void> {
  for (const collection of [TRACKS, BOOKMARKS]) {
    await mongo({
      action: "updateMany",
      collection,
      query: { visibilityOwner: importId },
      update: {
        $set: { visible: true },
        $unset: { visibilityOwner: "" },
      },
    });
  }
}

async function compensateFailedCommit(
  mongo: MongoCall,
  importId: ObjectId,
): Promise<void> {
  await mongo({
    action: "deleteMany",
    collection: POINTS,
    query: { createdByImportId: importId, visible: false },
  });
  await mongo({
    action: "updateMany",
    collection: POINTS,
    query: { importIds: importId },
    update: {
      $pull: {
        importIds: importId,
        sourceRefs: { importId },
      },
    },
  });
  await removeLocationEntitySourceRefs(mongo, importId);
  await mongo({
    action: "deleteMany",
    collection: METADATA_CONFLICTS,
    query: { incomingImportId: importId },
  });
}

export class StaleLocationPreviewError extends Error {
  constructor(public refreshed: LocationImportPreview) {
    super("LOCATION_PREVIEW_STALE");
  }
}

export async function confirmLocationPreview(
  auth: Auth,
  previewIdString: string,
  originOverride?: LocationOrigin,
): Promise<any> {
  if (!ObjectId.isValid(previewIdString)) throw new Error("PREVIEW_NOT_FOUND");
  const previewId = new ObjectId(previewIdString);
  const mongo = await getMongoResource(auth);
  const preview = await mongo({
    action: "findOne",
    collection: PREVIEWS,
    query: { _id: previewId },
  });
  if (!preview || preview.expiresAt < new Date()) {
    throw new Error("PREVIEW_NOT_FOUND");
  }
  if (preview.status === "confirmed" && preview.receipt) return preview.receipt;
  if (preview.analysis?.exactFileMatch) {
    const receipt = {
      duplicate: true,
      importId: preview.analysis.exactFileMatch.importId,
      filename: preview.filename,
      counts: preview.analysis.counts,
    };
    await mongo({
      action: "updateOne",
      collection: PREVIEWS,
      query: { _id: previewId },
      update: {
        $set: { status: "confirmed", receipt, confirmedAt: new Date() },
      },
    });
    return receipt;
  }
  if (!preview.stagedFileId) throw new Error("PREVIEW_FILE_MISSING");

  const fs = await getFsResource(auth);
  const bytes: Uint8Array = await fs({
    action: "download",
    bucket: FILE_BUCKET,
    id: String(preview.stagedFileId),
  });
  if (sha256(bytes) !== preview.contentHash) {
    throw new Error("PREVIEW_FILE_CHANGED");
  }
  const dataset = parseTrackFile(preview.format, bytes);
  const origin: LocationOrigin | undefined = originOverride ?? preview.origin ??
    originFromExporter(dataset.exporter);
  const analysis = await analyzeLocationDataset(
    mongo,
    preview.filename,
    preview.format,
    preview.contentHash,
    dataset,
    {
      sizeBytes: bytes.byteLength,
      sourceEntryName: dataset.sourceEntryName,
    },
  );
  if (
    analysis.revision !== preview.revision ||
    analysis.fingerprint !== preview.analysisFingerprint
  ) {
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    const refreshed = {
      previewId: String(previewId),
      expiresAt,
      ...analysis.public,
      origin,
    };
    await mongo({
      action: "updateOne",
      collection: PREVIEWS,
      query: { _id: previewId },
      update: {
        $set: {
          revision: analysis.revision,
          analysisFingerprint: analysis.fingerprint,
          analysis: analysis.public,
          ...(origin ? { origin } : {}),
          expiresAt,
        },
      },
    });
    throw new StaleLocationPreviewError(refreshed);
  }

  const claimed = await mongo({
    action: "findOneAndUpdate",
    collection: PREVIEWS,
    query: { _id: previewId, status: "ready" },
    update: {
      $set: {
        status: "committing",
        commitStartedAt: new Date(),
        ...(origin ? { origin } : {}),
      },
    },
    options: { returnDocument: "after" },
  });
  if (!claimed) {
    const latest = await mongo({
      action: "findOne",
      collection: PREVIEWS,
      query: { _id: previewId },
    });
    if (latest?.status === "confirmed" && latest.receipt) return latest.receipt;
    throw new Error("PREVIEW_COMMITTING");
  }

  let importId = new ObjectId();
  try {
    const importDoc = await mongo({
      action: "findOne",
      collection: IMPORTS,
      query: { contentHash: preview.contentHash },
    });
    if (importDoc?.committedAt) {
      const receipt = {
        duplicate: true,
        importId: String(importDoc._id),
        filename: preview.filename,
        counts: importDoc.receipt ?? analysis.public.counts,
      };
      await mongo({
        action: "updateOne",
        collection: PREVIEWS,
        query: { _id: previewId },
        update: {
          $set: { status: "confirmed", receipt, confirmedAt: new Date() },
        },
      });
      return receipt;
    }
    importId = importDoc?._id ?? importId;
    if (!importDoc) {
      await mongo({
        action: "insertOne",
        collection: IMPORTS,
        doc: {
          _id: importId,
          filename: preview.filename,
          ...(origin ? { origin } : {}),
          format: preview.format,
          contentHash: preview.contentHash,
          fileId: preview.stagedFileId,
          previewId,
          parserVersion: LOCATION_PARSER_VERSION,
          contentProfileVersion: LOCATION_CONTENT_PROFILE_VERSION,
          pointHashVersion: LOCATION_POINT_HASH_VERSION,
          fileSize: bytes.byteLength,
          ...(dataset.sourceEntryName
            ? { sourceEntryName: dataset.sourceEntryName }
            : {}),
          datasetMetadata: metadataForStorage(dataset.datasetMetadata),
          status: "committing",
          createdAt: new Date(),
          createdBy: auth.principal || "web",
        },
      });
    } else {
      await mongo({
        action: "updateOne",
        collection: IMPORTS,
        query: { _id: importId },
        update: {
          $set: {
            status: "committing",
            lastError: null,
            ...(origin ? { origin } : {}),
          },
        },
      });
    }

    await upsertTracks(mongo, importId, preview.format, dataset.tracks);
    await upsertBookmarks(mongo, importId, preview.format, dataset.bookmarks);

    const matchedHashes = [...analysis.existingByHash.keys()];
    for (const hashes of chunk(matchedHashes, WRITE_BATCH)) {
      await mongo({
        action: "updateMany",
        collection: POINTS,
        query: { hash: { $in: hashes }, visible: { $ne: false } },
        update: {
          $addToSet: {
            importIds: importId,
            sourceRefs: { importId, format: preview.format },
          },
        },
      });
    }
    const elevationEnrichment = [...analysis.existingByHash.entries()].filter(
      ([hash, existing]) =>
        existing.ele === undefined &&
        analysis.uniquePoints.get(hash)?.ele !== undefined,
    );
    for (const batch of chunk(elevationEnrichment, WRITE_BATCH)) {
      await mongo({
        action: "bulkWrite",
        collection: POINTS,
        operations: batch.map(([hash]) => ({
          updateOne: {
            filter: { hash, ele: { $exists: false } },
            update: {
              $set: { ele: analysis.uniquePoints.get(hash)!.ele },
            },
          },
        })),
        options: { ordered: false },
      });
    }

    const newPoints = [...analysis.newHashes].map((hash) => ({
      hash,
      point: analysis.uniquePoints.get(hash)!,
    }));
    for (const batch of chunk(newPoints, WRITE_BATCH)) {
      await mongo({
        action: "bulkWrite",
        collection: POINTS,
        operations: batch.map(({ hash, point }) => ({
          updateOne: {
            filter: { hash },
            update: {
              $set: {
                ts: point.ts,
                loc: {
                  type: "Point",
                  coordinates: [point.lng, point.lat],
                },
                ...(point.ele !== undefined ? { ele: point.ele } : {}),
                importId,
                visibilityOwner: importId,
                visible: false,
                selection: "accepted",
                recoveryState: null,
              },
              $setOnInsert: {
                _id: new ObjectId(),
                hash,
                createdAt: new Date(),
                createdByImportId: importId,
              },
              $addToSet: {
                importIds: importId,
                sourceRefs: { importId, format: preview.format },
              },
            },
            upsert: true,
          },
        })),
        options: { ordered: false },
      });
    }
    await recordConflicts(mongo, importId, preview.format, analysis);
    await recordPointMetadataConflicts(
      mongo,
      importId,
      preview.format,
      analysis,
    );
    await publishImportedEntities(mongo, importId);

    // One multi-document update publishes every newly-owned point before the
    // import becomes eligible for processing. No worker is triggered earlier.
    await mongo({
      action: "updateMany",
      collection: POINTS,
      query: { visibilityOwner: importId },
      update: {
        $set: { visible: true },
        $unset: { recoveryState: "" },
      },
    });

    const counts = analysis.public.counts;
    const profile = contentProfile(dataset, {
      sizeBytes: bytes.byteLength,
      contentHash: preview.contentHash,
      format: preview.format,
      sourceEntryName: dataset.sourceEntryName,
    });
    const receipt = {
      ...counts,
      schemaVersion: LOCATION_CONTENT_PROFILE_VERSION,
      file: profile.file,
      contentProfile: profile,
      pointsImported: counts.newPoints,
      pointsDeduplicated: counts.matchedPoints + counts.withinFileDuplicates,
      pointsSkipped: counts.skipped,
    };
    await mongo({
      action: "updateOne",
      collection: IMPORTS,
      query: { _id: importId },
      update: {
        $set: {
          status: "parsed",
          committedAt: new Date(),
          receipt,
          contentProfileVersion: LOCATION_CONTENT_PROFILE_VERSION,
          contentProfile: profile,
          geometryCompleteness: "full",
          fileSize: bytes.byteLength,
          ...(dataset.sourceEntryName
            ? { sourceEntryName: dataset.sourceEntryName }
            : {}),
          metadataDifferences: analysis.public.metadataDifferences,
          pointCount: counts.newPoints,
          dedupedCount: counts.matchedPoints + counts.withinFileDuplicates,
          skippedCount: counts.skipped,
          ...(analysis.public.timeRange
            ? { timeRange: analysis.public.timeRange }
            : {}),
        },
      },
    });
    await bumpLocationImportRevision(mongo);
    const response = {
      importId: String(importId),
      filename: preview.filename,
      status: "parsed",
      counts,
      ...receipt,
    };
    await mongo({
      action: "updateOne",
      collection: PREVIEWS,
      query: { _id: previewId },
      update: {
        $set: {
          status: "confirmed",
          receipt: response,
          confirmedAt: new Date(),
        },
      },
    });
    return response;
  } catch (error) {
    if (importId) {
      await compensateFailedCommit(mongo, importId);
      await mongo({
        action: "updateOne",
        collection: IMPORTS,
        query: { _id: importId },
        update: {
          $set: {
            status: "failed",
            lastError: error instanceof Error ? error.message : String(error),
            failedAt: new Date(),
          },
        },
      });
    }
    await mongo({
      action: "updateOne",
      collection: PREVIEWS,
      query: { _id: previewId },
      update: {
        $set: {
          status: "ready",
          lastError: error instanceof Error ? error.message : String(error),
        },
      },
    });
    throw error;
  }
}

export async function backfillLocationImport(
  auth: Auth,
  importIdString: string,
): Promise<any> {
  if (!ObjectId.isValid(importIdString)) throw new Error("IMPORT_NOT_FOUND");
  const importId = new ObjectId(importIdString);
  const mongo = await getMongoResource(auth);
  const importDoc = await mongo({
    action: "findOne",
    collection: IMPORTS,
    query: { _id: importId, committedAt: { $exists: true } },
  });
  if (!importDoc) throw new Error("IMPORT_NOT_FOUND");
  if (!importDoc.fileId) throw new Error("IMPORT_SOURCE_MISSING");

  const fs = await getFsResource(auth);
  const bytes: Uint8Array = await fs({
    action: "download",
    bucket: FILE_BUCKET,
    id: String(importDoc.fileId),
  });
  if (importDoc.contentHash && sha256(bytes) !== importDoc.contentHash) {
    throw new Error("IMPORT_SOURCE_HASH_MISMATCH");
  }
  const dataset = parseTrackFile(importDoc.format, bytes);
  await upsertTracks(mongo, importId, importDoc.format, dataset.tracks);
  await upsertBookmarks(mongo, importId, importDoc.format, dataset.bookmarks);
  await publishImportedEntities(mongo, importId);
  const profile = contentProfile(dataset, {
    sizeBytes: bytes.byteLength,
    contentHash: importDoc.contentHash ?? sha256(bytes),
    format: importDoc.format,
    sourceEntryName: dataset.sourceEntryName,
  });
  const receipt = {
    ...(importDoc.receipt ?? {}),
    ...profile.counts,
    schemaVersion: LOCATION_CONTENT_PROFILE_VERSION,
    file: profile.file,
    contentProfile: profile,
    pointsImported: importDoc.receipt?.pointsImported ??
      importDoc.pointCount ?? 0,
    pointsDeduplicated: importDoc.receipt?.pointsDeduplicated ??
      importDoc.dedupedCount ?? 0,
    pointsSkipped: importDoc.receipt?.pointsSkipped ??
      importDoc.skippedCount ?? 0,
  };
  await mongo({
    action: "updateOne",
    collection: IMPORTS,
    query: { _id: importId },
    update: {
      $set: {
        parserVersion: LOCATION_PARSER_VERSION,
        contentProfileVersion: LOCATION_CONTENT_PROFILE_VERSION,
        contentProfile: profile,
        receipt,
        datasetMetadata: metadataForStorage(dataset.datasetMetadata),
        fileSize: bytes.byteLength,
        ...(dataset.sourceEntryName
          ? { sourceEntryName: dataset.sourceEntryName }
          : {}),
        geometryBackfilledAt: new Date(),
        geometryCompleteness: "full",
        lastBackfillError: null,
      },
    },
  });
  return {
    importId: String(importId),
    filename: importDoc.filename,
    contentProfile: profile,
  };
}

export async function backfillLocationImports(
  auth: Auth,
  limit = 100,
): Promise<
  { completed: any[]; failed: Array<{ importId: string; error: string }> }
> {
  const mongo = await getMongoResource(auth);
  const imports = await mongo({
    action: "find",
    collection: IMPORTS,
    query: {
      committedAt: { $exists: true },
      contentProfileVersion: { $lt: LOCATION_CONTENT_PROFILE_VERSION },
    },
    options: { sort: { createdAt: 1 }, limit: Math.min(500, limit) },
  });
  const completed: any[] = [];
  const failed: Array<{ importId: string; error: string }> = [];
  for (const importDoc of imports) {
    try {
      completed.push(await backfillLocationImport(auth, String(importDoc._id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ importId: String(importDoc._id), error: message });
      await mongo({
        action: "updateOne",
        collection: IMPORTS,
        query: { _id: importDoc._id },
        update: {
          $set: { lastBackfillError: message, backfillFailedAt: new Date() },
        },
      });
    }
  }
  return { completed, failed };
}
