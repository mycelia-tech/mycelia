import { z } from "zod";
import { Resource } from "@/lib/auth/resources.ts";
import { Auth } from "../auth/index.ts";
import { Db, GridFSBucket, ObjectId } from "mongodb";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import { getRootDB as getSharedRootDB } from "./core.server.ts";

// Keep this export for callers that imported it from this module, but delegate
// to the application's shared MongoClient instead of creating an unclosed
// client for every GridFS operation.
export const getRootDB = getSharedRootDB;

const zObjectId = () =>
  z.string().refine((val) => ObjectId.isValid(val), {
    message: "Invalid ObjectId string",
  });

const uploadSchema = z.object({
  action: z.literal("upload"),
  bucket: z.string(),
  filename: z.string(),
  data: z.instanceof(Uint8Array),
  metadata: z.record(z.string(), z.any()).optional(),
});

const downloadSchema = z.object({
  action: z.literal("download"),
  bucket: z.string(),
  id: zObjectId(),
  stream: z.boolean().optional(),
});

const findSchema = z.object({
  action: z.literal("find"),
  bucket: z.string(),
  query: z.record(z.string(), z.any()).optional(),
});

const deleteSchema = z.object({
  action: z.literal("delete"),
  bucket: z.string(),
  id: zObjectId(),
});

const fsRequestSchema = z.discriminatedUnion("action", [
  uploadSchema,
  downloadSchema,
  findSchema,
  deleteSchema,
]);

type FsRequest = z.infer<typeof fsRequestSchema>;
type FsResponse = any;

export class FsResource implements Resource<FsRequest, FsResponse> {
  code = "fs";
  description = "GridFS file storage";
  schemas = {
    request: fsRequestSchema,
    response: z.any(),
  };
  getRootDB: () => Promise<Db> = getRootDB;

  async getBucket(bucket: string): Promise<GridFSBucket> {
    const db = await this.getRootDB();
    return new GridFSBucket(db, { bucketName: bucket });
  }
  async use(input: FsRequest): Promise<FsResponse> {
    const bucket = await this.getBucket(input.bucket);
    switch (input.action) {
      case "upload": {
        const id = new ObjectId();
        const { filename, data, metadata } = input;
        const uploadStream = bucket.openUploadStream(`${id}/${filename}`, {
          metadata,
          id,
        });
        uploadStream.end(data);
        return new Promise<ObjectId>((resolve, reject) => {
          uploadStream.on("finish", () => resolve(id));
          uploadStream.on("error", reject);
        });
      }
      case "download": {
        const id = typeof input.id === "string"
          ? new ObjectId(input.id)
          : input.id;
        const downloadStream = bucket.openDownloadStream(id);
        if (input.stream) return downloadStream;

        return new Promise<Uint8Array>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          downloadStream.on("data", (chunk) => chunks.push(chunk));
          downloadStream.on(
            "end",
            () => resolve(new Uint8Array(Buffer.concat(chunks))),
          );
          downloadStream.on("error", reject);
        });
      }
      case "find": {
        const query = input.query || {};
        return bucket.find(query).toArray();
      }
      case "delete": {
        const id = typeof input.id === "string"
          ? new ObjectId(input.id)
          : input.id;
        await bucket.delete(id);
        return { success: true };
      }
      default:
        throw new Error("Unknown action");
    }
  }

  extractActions(input: FsRequest) {
    return [
      {
        path: ["fs", input.bucket],
        actions: [input.action],
      },
    ];
  }
}

export async function getFsResource(
  auth: Auth,
): Promise<(input: FsRequest) => Promise<FsResponse>> {
  return auth.getResource("fs");
}

export function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop();
  return (ext && /^[a-zA-Z0-9]+$/.test(ext)) ? ext : "";
}

export async function uploadToGridFS(
  auth: Auth,
  file: File,
  bucket: string,
  metadata: Record<string, any>,
): Promise<ObjectId> {
  const fsResource = await getFsResource(auth);
  return await fsResource({
    action: "upload",
    bucket,
    filename: `${crypto.randomUUID()}/${file.name}`,
    data: new Uint8Array(await file.arrayBuffer()),
    metadata: {
      ...metadata,
      extension: getFileExtension(file.name),
      uploaded_by: auth.principal,
      uploaded_at: new Date(),
    },
  });
}
