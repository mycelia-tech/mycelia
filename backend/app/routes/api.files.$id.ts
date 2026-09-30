import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { type Readable } from "node:stream";
import { type Db, type GridFSFile, ObjectId } from "mongodb";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import { getFsResource } from "@/lib/mongo/fs.server.ts";

const DEFAULT_BUCKET = "uploads";
const ALLOWED_BUCKETS = [
  "uploads",
  "voice_samples",
  "location_files",
  "media_previews",
  "media_originals",
];

type MediaBucket = "media_previews" | "media_originals";

function mediaReferenceFilters(bucket: MediaBucket, id: ObjectId) {
  if (bucket === "media_originals") {
    return {
      asset: { "managedOriginal.fileId": id },
      stagedImport: { "items.managedOriginal.fileId": id },
    };
  }

  return {
    asset: {
      $or: [
        { "thumbnail.fileId": id },
        { "preview.fileId": id },
      ],
    },
    stagedImport: {
      $or: [
        { "items.thumbnail.fileId": id },
        { "items.preview.fileId": id },
      ],
    },
  };
}

export async function mediaFileBelongsToPrincipal(
  db: Db,
  bucket: MediaBucket,
  id: ObjectId,
  principal: string,
  now = new Date(),
): Promise<boolean> {
  const filters = mediaReferenceFilters(bucket, id);
  const asset = await db.collection("media_assets").findOne({
    owner: principal,
    ...filters.asset,
  }, { projection: { _id: 1 } });
  if (asset) return true;

  const stagedImport = await db.collection("media_imports").findOne({
    owner: principal,
    status: "preview",
    expiresAt: { $gt: now },
    ...filters.stagedImport,
  }, { projection: { _id: 1 } });
  return Boolean(stagedImport);
}

function contentTypeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case "gpx":
      return "application/gpx+xml; charset=utf-8";
    case "geojson":
      return "application/geo+json; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "webm":
      return "audio/webm";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

type FsCaller = (input: Record<string, unknown>) => Promise<unknown>;

type PreparedGridFsDownload =
  & {
    file: GridFSFile;
    contentType: string;
    etag: string;
  }
  & (
    | { status: "not-modified" }
    | { status: "ok"; stream: Readable }
  );

export function gridFsFileEtag(
  file: Pick<GridFSFile, "_id" | "length" | "uploadDate">,
): string {
  return `W/"${String(file._id)}-${file.length}-${file.uploadDate.getTime()}"`;
}

export function ifNoneMatchMatches(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;

  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const expected = normalize(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = normalize(candidate);
    return normalized === "*" || normalized === expected;
  });
}

/**
 * Resolves metadata before opening the GridFS chunks stream. A fresh client
 * cache validator therefore avoids both the second GridFS lookup and all chunk
 * reads, while a normal response stays streaming and bounded in memory.
 */
export async function prepareGridFsDownload(
  fs: FsCaller,
  bucket: string,
  id: ObjectId,
  ifNoneMatch?: string,
): Promise<PreparedGridFsDownload | null> {
  const files = await fs({
    action: "find",
    bucket,
    query: { _id: id },
  }) as GridFSFile[];

  if (!files || files.length === 0) return null;

  const file = files[0];
  const ext: string = file?.metadata?.extension ||
    (file?.filename?.split(".").pop() ?? "");
  const contentType = contentTypeForExtension(ext || "");
  const etag = gridFsFileEtag(file);

  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    return { status: "not-modified", file, contentType, etag };
  }

  const stream = await fs({
    action: "download",
    bucket,
    id: String(id),
    stream: true,
  }) as Readable;

  return { status: "ok", file, contentType, etag, stream };
}

function setFileResponseHeaders(
  res: Response,
  prepared: PreparedGridFsDownload,
) {
  res.setHeader("Content-Type", prepared.contentType);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("ETag", prepared.etag);
  res.setHeader("Last-Modified", prepared.file.uploadDate.toUTCString());
  res.setHeader("Content-Length", String(prepared.file.length));
}

export function isExpectedFileStreamAbort(
  error: unknown,
  requestAborted: boolean,
): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
  return requestAborted || code === "ERR_STREAM_PREMATURE_CLOSE";
}

export async function apiFilesIdHandler(req: Request, res: Response) {
  try {
    const auth = await authenticateOr401(req, res);
    const id = req.params.id;
    const bucket = (req.query.bucket as string) || DEFAULT_BUCKET;

    if (!id || !ObjectId.isValid(id)) {
      res.status(400).send("Invalid id");
      return;
    }

    if (!ALLOWED_BUCKETS.includes(bucket)) {
      res.status(400).send("Invalid bucket");
      return;
    }

    if (
      (bucket === "media_previews" || bucket === "media_originals") &&
      !await mediaFileBelongsToPrincipal(
        await getRootDB(),
        bucket,
        new ObjectId(id),
        auth.principal,
      )
    ) {
      res.status(404).send("Not found");
      return;
    }

    const fs = await getFsResource(auth);
    const prepared = await prepareGridFsDownload(
      fs as FsCaller,
      bucket,
      new ObjectId(id),
      req.get("If-None-Match"),
    );

    if (!prepared) {
      res.status(404).send("Not found");
      return;
    }

    setFileResponseHeaders(res, prepared);
    if (prepared.status === "not-modified") {
      res.status(304).end();
      return;
    }

    await pipeline(prepared.stream, res);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return; // Already sent 401 response
    }
    // Browsers routinely cancel thumbnail requests while virtualized media
    // grids scroll. A closed response is not a server failure and must not
    // produce a misleading 500/log storm.
    if (isExpectedFileStreamAbort(error, req.aborted)) return;
    console.error("Error in /api/files/:id:", error);
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
      }
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
}
