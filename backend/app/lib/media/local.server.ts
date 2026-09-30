import { walk } from "@std/fs/walk";
import {
  basename,
  dirname,
  extname,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { env } from "#/env.ts";

export type LocalMediaInspection = {
  realPath: string;
  relativePath: string;
  fileName: string;
  kind: "image" | "pdf";
  mimeType: string;
  byteLength: number;
  sha256: string;
  pageCount: number;
  width?: number;
  height?: number;
  capturedAt?: Date;
  capturedAtTimeZone?: string;
  capturedAtTimeZoneSource?: "embedded" | "exif_offset" | "unknown";
  location?: MediaLocation;
  metadata: Record<string, unknown>;
};

export type MediaLocation = {
  latitude: number;
  longitude: number;
  altitudeMeters?: number;
};

export type CapturedAtInspection = {
  capturedAt?: Date;
  capturedAtTimeZone?: string;
  capturedAtTimeZoneSource?: "embedded" | "exif_offset" | "unknown";
};

export type UploadedMediaPreparation = {
  inspection: Omit<LocalMediaInspection, "realPath" | "relativePath">;
  thumbnail?: { data: Uint8Array; width: number; height: number };
  preview?: { data: Uint8Array; width: number; height: number };
};

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
]);

export function mediaSourceConfigured(): boolean {
  return Boolean(env.MEDIA_SOURCE_ROOT);
}

export type MediaSourceFolderListing = {
  currentPath: string;
  parentPath?: string;
  scanUnavailableReason?: string;
  folders: Array<{
    name: string;
    relativePath: string;
    unavailableReason?: string;
  }>;
};

export function assertSafeMediaRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("A relative media path is required");
  }
  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    relativePath.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(
      'Use "." or a path relative to the configured media source; absolute paths and ".." are not allowed',
    );
  }
}

function mediaSourceAliases(): Record<string, string> {
  const aliases = JSON.parse(env.MEDIA_SOURCE_ALIASES);
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("MEDIA_SOURCE_ALIASES must be a JSON object");
  }
  for (const [name, target] of Object.entries(aliases)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || typeof target !== "string"
    ) {
      throw new Error(
        "Media source aliases require a simple name and relative path",
      );
    }
    assertSafeMediaRelativePath(target);
  }
  return aliases;
}

function separateSourceNames(): string[] {
  return [...Object.keys(mediaSourceAliases()), env.MEDIA_SOURCE_DISKS_DIR]
    .filter(Boolean);
}

function childMediaPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

export function assertMediaScanSelection(relativePath: string): void {
  assertSafeMediaRelativePath(relativePath);
  const normalized = relativePath.split(/[\\/]+/).filter((p) => p && p !== ".")
    .join("/");
  if (env.MEDIA_SOURCE_DISKS_DIR && normalized === env.MEDIA_SOURCE_DISKS_DIR) {
    throw new Error("Choose a disk or a folder before scanning");
  }
}

export async function resolveMediaSourcePath(
  relativePath: string,
  sourceRoot = env.MEDIA_SOURCE_ROOT,
): Promise<{
  root: string;
  realPath: string;
  relativePath: string;
}> {
  if (!sourceRoot) {
    throw new Error("MEDIA_SOURCE_ROOT is not configured");
  }
  assertSafeMediaRelativePath(relativePath);
  const logicalPath = relativePath.split(/[\\/]+/).filter((p) => p && p !== ".")
    .join("/") || ".";
  const [first, ...rest] = logicalPath.split("/");
  const aliases = mediaSourceAliases();
  const aliasTarget = Object.hasOwn(aliases, first)
    ? aliases[first]
    : undefined;
  const root = await Deno.realPath(sourceRoot);
  const candidate = resolve(root, aliasTarget ?? first, ...rest);
  // Reject links even when their destination happens to remain inside the root.
  let componentPath = root;
  for (const component of relative(root, candidate).split(SEPARATOR)) {
    if (!component || component === ".") continue;
    componentPath = resolve(componentPath, component);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(componentPath);
    } catch {
      throw mediaSourceUnavailable(relativePath);
    }
    if (info.isSymlink) {
      throw new Error("Media source symlinks are not allowed");
    }
  }
  const realPath = await Deno.realPath(candidate);
  if (realPath !== root && !realPath.startsWith(`${root}${SEPARATOR}`)) {
    throw new Error("Media path escapes the configured source root");
  }
  return { root, realPath, relativePath: logicalPath };
}

function mediaSourceUnavailable(relativePath: string): Error {
  return new Error(
    `Media folder "${relativePath}" is unavailable. Connect the external disk and refresh folders; if it remains unavailable, recreate the backend with the same media mounts.`,
  );
}

export async function listMediaSourceFolders(
  relativePath: string,
  sourceRoot = env.MEDIA_SOURCE_ROOT,
): Promise<MediaSourceFolderListing> {
  if (!sourceRoot) throw new Error("MEDIA_SOURCE_ROOT is not configured");
  assertSafeMediaRelativePath(relativePath);
  const { root, realPath, relativePath: currentPath } =
    await resolveMediaSourcePath(
      relativePath,
      sourceRoot,
    );
  const stat = await Deno.stat(realPath);
  if (!stat.isDirectory) throw new Error("Selected media path is not a folder");

  const folders: MediaSourceFolderListing["folders"] = [];
  const aliases = mediaSourceAliases();
  for await (const entry of Deno.readDir(realPath)) {
    // Deno reports symlinks separately, so isDirectory excludes them. Resolve
    // again as a defense in depth check before exposing a selectable path.
    if (!entry.isDirectory || entry.isSymlink) continue;
    if (currentPath === "." && Object.hasOwn(aliases, entry.name)) continue;
    let childRealPath: string;
    try {
      childRealPath = await Deno.realPath(resolve(realPath, entry.name));
      await Deno.stat(childRealPath);
    } catch {
      folders.push({
        name: entry.name,
        relativePath: childMediaPath(currentPath, entry.name),
        unavailableReason: "Disk unavailable — reconnect and refresh",
      });
      continue;
    }
    if (
      childRealPath !== root &&
      !childRealPath.startsWith(`${root}${SEPARATOR}`)
    ) continue;
    folders.push({
      name: currentPath === "." && entry.name === env.MEDIA_SOURCE_DISKS_DIR
        ? "Connected disks"
        : entry.name,
      relativePath: childMediaPath(currentPath, entry.name),
    });
  }
  if (currentPath === ".") {
    for (const name of Object.keys(aliases)) {
      let unavailableReason: string | undefined;
      try {
        const target = await resolveMediaSourcePath(name, sourceRoot);
        if (!(await Deno.stat(target.realPath)).isDirectory) throw new Error();
      } catch {
        unavailableReason = "Disk unavailable — reconnect and refresh";
      }
      folders.push({
        name,
        relativePath: name,
        ...(unavailableReason ? { unavailableReason } : {}),
      });
    }
  }
  folders.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  return {
    currentPath,
    ...(currentPath === env.MEDIA_SOURCE_DISKS_DIR
      ? { scanUnavailableReason: "Choose a disk or a folder before scanning" }
      : {}),
    ...(currentPath === "." ? {} : { parentPath: dirname(currentPath) }),
    folders,
  };
}

export type MediaDirectoryEntry = {
  name: string;
  relativePath: string;
  kind: "directory" | "image" | "unsupported";
};

/** A stable name cursor bounds each inventory commit, including very wide folders. */
export async function readMediaSourceDirectoryPage(
  relativePath: string,
  afterName = "",
  limit = 1_000,
  sourceRoot = env.MEDIA_SOURCE_ROOT,
): Promise<{ entries: MediaDirectoryEntry[]; nextAfterName?: string }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Directory page size must be between 1 and 1000");
  }
  assertMediaScanSelection(relativePath);
  const { realPath, relativePath: currentPath } = await resolveMediaSourcePath(
    relativePath,
    sourceRoot,
  );
  // Keep only the next page, not an array of the entire library or directory.
  const excludedSources = currentPath === "." ? separateSourceNames() : [];
  let entries: MediaDirectoryEntry[] = [];
  const trim = () => {
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    entries = entries.slice(0, limit + 1);
  };
  try {
    for await (const entry of Deno.readDir(realPath)) {
      if (entry.isSymlink || (!entry.isFile && !entry.isDirectory)) continue;
      if (excludedSources.includes(entry.name)) continue;
      if (entry.name <= afterName) continue;
      entries.push({
        name: entry.name,
        relativePath: childMediaPath(currentPath, entry.name),
        kind: entry.isDirectory
          ? "directory"
          : [".jpg", ".jpeg", ".png", ".webp"].includes(
              extname(entry.name).toLowerCase(),
            )
          ? "image"
          : "unsupported",
      });
      if (entries.length >= (limit + 1) * 2) trim();
    }
  } catch {
    throw mediaSourceUnavailable(relativePath);
  }
  trim();
  return {
    entries: entries.slice(0, limit),
    ...(entries.length > limit
      ? { nextAfterName: entries[limit - 1].name }
      : {}),
  };
}

export async function scanMediaSource(
  relativePath: string,
  limit: number,
): Promise<string[]> {
  return (await scanMediaSourceInventory(relativePath, limit)).paths;
}

export async function scanMediaSourceInventory(
  relativePath: string,
  limit: number,
  options: { includeUnsupported?: boolean } = {},
): Promise<{
  paths: string[];
  unsupportedPaths: string[];
  truncated: boolean;
}> {
  assertMediaScanSelection(relativePath);
  const resolved = await resolveMediaSourcePath(relativePath);
  const stat = await Deno.stat(resolved.realPath);
  if (stat.isFile) {
    const supported = SUPPORTED_EXTENSIONS.has(
      extname(resolved.realPath).toLowerCase(),
    );
    return {
      paths: supported ? [resolved.relativePath] : [],
      unsupportedPaths: !supported && options.includeUnsupported
        ? [resolved.relativePath]
        : [],
      truncated: false,
    };
  }
  if (!stat.isDirectory) {
    throw new Error("Media source is not a file or folder");
  }

  const files: string[] = [];
  const unsupportedPaths: string[] = [];
  let truncated = false;
  for await (
    const entry of walk(resolved.realPath, {
      includeDirs: false,
      followSymlinks: false,
      maxDepth: 20,
      skip: resolved.relativePath === "."
        ? separateSourceNames().map((name) =>
          new RegExp(
            `^${
              resolve(resolved.root, name).replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              )
            }(?:[/\\\\]|$)`,
          )
        )
        : [],
    })
  ) {
    if (!entry.isFile) continue;
    const supported = SUPPORTED_EXTENSIONS.has(
      extname(entry.name).toLowerCase(),
    );
    if (!supported && !options.includeUnsupported) continue;
    const real = await Deno.realPath(entry.path);
    if (
      real !== resolved.root && !real.startsWith(`${resolved.root}${SEPARATOR}`)
    ) {
      continue;
    }
    const logicalPath = childMediaPath(
      resolved.relativePath,
      relative(resolved.realPath, real),
    );
    if (supported) files.push(logicalPath);
    else unsupportedPaths.push(logicalPath);
    if (files.length + unsupportedPaths.length > limit) {
      truncated = true;
      if (supported) files.pop();
      else unsupportedPaths.pop();
      break;
    }
  }
  return {
    paths: files.sort(),
    unsupportedPaths: unsupportedPaths.sort(),
    truncated,
  };
}

export function detectMediaMime(
  bytes: Uint8Array,
): { kind: "image" | "pdf"; mimeType: string } {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  ) return { kind: "image", mimeType: "image/webp" };
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  throw new Error("Unsupported or invalid media file");
}

async function inspectMediaFile(
  path: string,
  fileName: string,
  limits: { maxImageBytes: number; maxPdfBytes: number; maxPdfPages: number },
): Promise<Omit<LocalMediaInspection, "realPath" | "relativePath">> {
  const stat = await Deno.stat(path);
  if (!stat.isFile) throw new Error("Media item is not a file");
  const file = await Deno.open(path, { read: true });
  const header = new Uint8Array(16);
  try {
    const bytesRead = await file.read(header);
    if (!bytesRead) throw new Error("Unsupported or invalid media file");
  } finally {
    file.close();
  }
  const detected = detectMediaMime(header);
  const maximum = detected.kind === "pdf"
    ? limits.maxPdfBytes
    : limits.maxImageBytes;
  if (stat.size > maximum) {
    throw new Error(`File exceeds the configured ${maximum} byte limit`);
  }
  const data = await Deno.readFile(path);

  let pageCount = 1;
  let width: number | undefined;
  let height: number | undefined;
  let metadata: Record<string, unknown> = {};
  if (detected.kind === "pdf") {
    const pdf = await PDFDocument.load(data, { ignoreEncryption: false });
    pageCount = pdf.getPageCount();
    if (pageCount > limits.maxPdfPages) {
      throw new Error(
        `PDF has ${pageCount} pages; maximum is ${limits.maxPdfPages}`,
      );
    }
    metadata = {
      pageCount,
      title: pdf.getTitle(),
      author: pdf.getAuthor(),
      subject: pdf.getSubject(),
      creator: pdf.getCreator(),
      producer: pdf.getProducer(),
      creationDate: pdf.getCreationDate()?.toISOString(),
      modificationDate: pdf.getModificationDate()?.toISOString(),
    };
  } else {
    const [technical, exif] = await Promise.all([
      ffprobe(path),
      readExifMetadata(path),
    ]);
    const location = normalizeMediaLocation({
      latitude: exif.GPSLatitude,
      longitude: exif.GPSLongitude,
      altitudeMeters: exif.GPSAltitude,
    });
    metadata = {
      ...technical,
      ...(Object.keys(exif).length > 0 ? { exif } : {}),
      ...(location ? { location } : {}),
    };
    const stream = Array.isArray(technical.streams)
      ? technical.streams[0]
      : null;
    width = Number(stream?.width) || undefined;
    height = Number(stream?.height) || undefined;
    if (!width || !height) {
      throw new Error("Image dimensions could not be read");
    }
    if (width * height > 75_000_000) {
      throw new Error("Image exceeds the 75 megapixel safety limit");
    }
  }

  const capturedAt = inspectCapturedAt(metadata);
  return {
    fileName,
    kind: detected.kind,
    mimeType: detected.mimeType,
    byteLength: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    pageCount,
    width,
    height,
    ...capturedAt,
    location: mediaLocationFromMetadata(metadata),
    metadata,
  };
}

async function ffprobe(path: string): Promise<Record<string, unknown>> {
  const command = new Deno.Command("ffprobe", {
    args: [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,size:format_tags:stream=width,height,pix_fmt,color_space,color_transfer,color_primaries:stream_tags",
      "-of",
      "json",
      path,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `Image metadata extraction failed: ${
        new TextDecoder().decode(output.stderr).slice(0, 300)
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

export async function readExifMetadata(
  path: string,
): Promise<Record<string, unknown>> {
  try {
    const output = await new Deno.Command("exiftool", {
      args: ["-json", "-n", "-a", "-s", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) return {};
    const parsed = JSON.parse(new TextDecoder().decode(output.stdout));
    const first = Array.isArray(parsed) ? parsed[0] : null;
    if (!first || typeof first !== "object") return {};
    const { SourceFile: _sourceFile, ...metadata } = first;
    return metadata;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "EXIF_METADATA_TOOL_UNAVAILABLE: rebuild the backend image with exiftool before importing photos; capture time and GPS cannot be inspected safely",
      );
    }
    throw error;
  }
}

type ParsedTimeZoneOffset = {
  normalized: string;
  minutes: number;
};

function parseTimeZoneOffset(raw: unknown): ParsedTimeZoneOffset | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (/^[zZ]$/.test(value)) return { normalized: "Z", minutes: 0 };
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return undefined;
  const direction = match[1] === "+" ? 1 : -1;
  return {
    normalized: `${match[1]}${match[2]}:${match[3]}`,
    minutes: direction * (hours * 60 + minutes),
  };
}

function parseCaptureTimestamp(
  raw: string,
  exifOffset?: unknown,
): CapturedAtInspection | undefined {
  const match =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*([zZ]|[+-]\d{2}:?\d{2})?$/
      .exec(
        raw.trim(),
      );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  if (
    month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 ||
    minute > 59 || second > 59
  ) return undefined;

  // Date.UTC is used deliberately even when EXIF has no offset. Parsing a
  // naive timestamp through `new Date(string)` would make imports depend on
  // the backend process timezone. The `unknown` marker below preserves the
  // fact that this is a wall-clock value, not a proven UTC instant.
  const wallClockUtcMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const wallClock = new Date(wallClockUtcMs);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) return undefined;

  const embeddedOffset = parseTimeZoneOffset(match[8]);
  const attachedOffset = embeddedOffset ?? parseTimeZoneOffset(exifOffset);
  return {
    capturedAt: new Date(
      wallClockUtcMs - (attachedOffset?.minutes ?? 0) * 60_000,
    ),
    ...(attachedOffset
      ? { capturedAtTimeZone: attachedOffset.normalized }
      : {}),
    capturedAtTimeZoneSource: embeddedOffset
      ? "embedded"
      : attachedOffset
      ? "exif_offset"
      : "unknown",
  };
}

export function inspectCapturedAt(
  metadata: Record<string, unknown>,
): CapturedAtInspection {
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const format = metadata.format && typeof metadata.format === "object"
    ? metadata.format as Record<string, unknown>
    : {};
  const exif = metadata.exif && typeof metadata.exif === "object"
    ? metadata.exif as Record<string, unknown>
    : undefined;
  const tagObjects = [exif, format.tags, ...streams.map((s: any) => s?.tags)]
    .filter((value): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object")
    );
  const candidates = [
    {
      dateKeys: ["DateTimeOriginal", "date_time_original"],
      offsetKeys: [
        "OffsetTimeOriginal",
        "offset_time_original",
        "OffsetTimeDigitized",
        "offset_time_digitized",
      ],
    },
    {
      dateKeys: ["CreateDate", "create_date"],
      offsetKeys: [
        "OffsetTimeDigitized",
        "offset_time_digitized",
        "OffsetTimeOriginal",
        "offset_time_original",
      ],
    },
    { dateKeys: ["creation_time", "date"], offsetKeys: [] },
  ];
  for (const tags of tagObjects) {
    for (const candidate of candidates) {
      const offset = candidate.offsetKeys.map((key) => tags[key]).find((raw) =>
        parseTimeZoneOffset(raw)
      );
      for (const key of candidate.dateKeys) {
        const raw = tags[key];
        if (typeof raw !== "string") continue;
        const parsed = parseCaptureTimestamp(raw, offset);
        if (parsed) return parsed;
      }
    }
  }
  return {};
}

function finiteNumber(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && value.trim())
  ) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeMediaLocation(
  value: unknown,
): MediaLocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const latitude = finiteNumber(candidate.latitude);
  const longitude = finiteNumber(candidate.longitude);
  const altitudeMeters = finiteNumber(candidate.altitudeMeters);
  if (
    latitude === undefined || latitude < -90 || latitude > 90 ||
    longitude === undefined || longitude < -180 || longitude > 180
  ) return undefined;
  return {
    latitude,
    longitude,
    ...(altitudeMeters !== undefined ? { altitudeMeters } : {}),
  };
}

export function mediaLocationFromMetadata(
  metadata: unknown,
): MediaLocation | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  return normalizeMediaLocation(
    (metadata as Record<string, unknown>).location,
  );
}

export async function inspectLocalMedia(
  relativePath: string,
  limits: { maxImageBytes: number; maxPdfBytes: number; maxPdfPages: number },
): Promise<LocalMediaInspection> {
  const resolved = await resolveMediaSourcePath(relativePath);
  const inspected = await inspectMediaFile(
    resolved.realPath,
    basename(resolved.realPath),
    limits,
  );

  return {
    realPath: resolved.realPath,
    relativePath: resolved.relativePath,
    ...inspected,
  };
}

export async function prepareUploadedMedia(
  bytes: Uint8Array,
  fileName: string,
  limits: { maxImageBytes: number; maxPdfBytes: number; maxPdfPages: number },
  options: { createPreviews?: boolean } = {},
): Promise<UploadedMediaPreparation> {
  const detected = detectMediaMime(bytes.slice(0, 16));
  const suffix = detected.kind === "pdf"
    ? ".pdf"
    : detected.mimeType === "image/jpeg"
    ? ".jpg"
    : detected.mimeType === "image/png"
    ? ".png"
    : ".webp";
  const sourcePath = await Deno.makeTempFile({ suffix });
  try {
    await Deno.writeFile(sourcePath, bytes);
    const inspection = await inspectMediaFile(
      sourcePath,
      basename(fileName.replaceAll("\\", "/")) || `upload${suffix}`,
      limits,
    );
    if (inspection.kind === "pdf" || options.createPreviews === false) {
      return { inspection };
    }
    const [thumbnail, preview] = await Promise.all([
      createWebpPreview(sourcePath, 256, 70),
      createWebpPreview(sourcePath, 1280, 80),
    ]);
    return { inspection, thumbnail, preview };
  } finally {
    await Deno.remove(sourcePath).catch(() => undefined);
  }
}

export async function createWebpPreview(
  sourcePath: string,
  maxDimension: number,
  quality: number,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const outputPath = await Deno.makeTempFile({ suffix: ".webp" });
  try {
    const result = await new Deno.Command("ffmpeg", {
      args: [
        "-v",
        "error",
        "-i",
        sourcePath,
        "-vf",
        `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        "-c:v",
        "libwebp",
        "-q:v",
        String(quality),
        "-y",
        outputPath,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `Preview generation failed: ${
          new TextDecoder().decode(result.stderr).slice(0, 300)
        }`,
      );
    }
    const metadata = await ffprobe(outputPath);
    const stream = Array.isArray(metadata.streams) ? metadata.streams[0] : null;
    return {
      data: await Deno.readFile(outputPath),
      width: Number(stream?.width),
      height: Number(stream?.height),
    };
  } finally {
    await Deno.remove(outputPath).catch(() => undefined);
  }
}

export async function readLocalMedia(
  relativePath: string,
): Promise<Uint8Array> {
  const resolved = await resolveMediaSourcePath(relativePath);
  return await Deno.readFile(resolved.realPath);
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
