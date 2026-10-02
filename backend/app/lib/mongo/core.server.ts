import { Db, MongoClient } from "mongodb";

import { z } from "zod";
import { Resource } from "@/lib/auth/resources.ts";
import { permissionDenied } from "../auth/utils.ts";

import createDefaultQueryTester from "sift";

import { Filter } from "mongodb";
import { Auth } from "../auth/index.ts";
import { env } from "#/env.ts";
import { withObjectListCategories } from "@/lib/objects/list-categories.ts";
import {
  TIMELINE_DENSITY_SOURCE_WRITE_TIMEOUT_MS,
  withTimelineDensityWrite,
} from "@/lib/timeline/density-write.ts";

let client: MongoClient | null = null;
let changeStreamClient: MongoClient | null = null;

// Long-polling cursors must never borrow the HTTP/GridFS pool.
export const CHANGE_STREAM_POOL_SIZE = 4;
export async function getChangeStreamDB(): Promise<Db> {
  changeStreamClient ??= new MongoClient(env.MONGO_URL, {
    maxPoolSize: CHANGE_STREAM_POOL_SIZE,
    appName: "mycelia-change-streams",
  });
  await changeStreamClient.connect();
  return changeStreamClient.db(env.DATABASE_NAME);
}

export async function closeChangeStreamDB(): Promise<void> {
  const previous = changeStreamClient;
  changeStreamClient = null;
  await previous?.close();
}

// One shared, explicitly bounded application pool. GridFS and regular Mongo
// resources use this client; the cap prevents a request burst from creating
// unbounded sockets. Change streams have their own isolated pool above.
const MAX_MONGO_POOL_SIZE = 100;

function createMongoClient(): MongoClient {
  return new MongoClient(env.MONGO_URL, {
    maxPoolSize: MAX_MONGO_POOL_SIZE,
  });
}

interface CursorEntry {
  cursor: any;
  expiresAt: number;
  principal: string;
}

const cursorMap = new Map<string, CursorEntry>();

const CURSOR_TTL_MS = 30 * 60 * 1000;

let cursorIdCounter = 0;

function generateCursorId(principal: string): string {
  return `${principal}:${Date.now()}:${++cursorIdCounter}`;
}

function cleanupExpiredCursors(): void {
  const now = Date.now();
  for (const [key, entry] of cursorMap.entries()) {
    if (entry.expiresAt < now) {
      cursorMap.delete(key);
      entry.cursor.close().catch(() => {});
    }
  }
}

const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

// Serializes concurrent connection attempts so only one retry loop runs at a time
let connectingPromise: Promise<void> | null = null;

async function connectWithRetry(): Promise<void> {
  // If a connection attempt is already in progress, wait on it
  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    if (!client) {
      client = createMongoClient();
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.connect();
        return;
      } catch (err) {
        lastError = err as Error;
        const delay = Math.min(
          INITIAL_DELAY_MS * Math.pow(2, attempt - 1),
          MAX_DELAY_MS,
        );
        console.log(
          `[MongoDB] Connection attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          // Reset client for fresh connection attempt
          try {
            await client.close();
          } catch { /* ignore */ }
          client = createMongoClient();
        }
      }
    }
    throw lastError;
  })();

  try {
    await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

export const getRootDB = async (): Promise<Db> => {
  await connectWithRetry();
  return client!.db(env.DATABASE_NAME);
};

export function sift(query: Filter<unknown>): (item: unknown) => boolean {
  const tester = (createDefaultQueryTester as any)(query);
  return (item: unknown) => tester(item);
}

const findBaseOptions = z.object({
  projection: z.record(z.string(), z.any()).optional(),
  sort: z.record(z.string(), z.any()).optional(),
  limit: z.number().optional(),
  skip: z.number().optional(),
  hint: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  maxTimeMS: z.number().int().positive().optional(),
}).optional();

const findSchema = z.object({
  action: z.literal("find"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  options: findBaseOptions,
});

const findOneSchema = z.object({
  action: z.literal("findOne"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  options: findBaseOptions,
});

const getFirstBatchSchema = z.object({
  action: z.literal("getFirstBatch"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  options: z.object({
    projection: z.record(z.string(), z.any()).optional(),
    sort: z.record(z.string(), z.any()).optional(),
    limit: z.number().optional(),
    skip: z.number().optional(),
    hint: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    maxTimeMS: z.number().int().positive().optional(),
  }).optional(),
  batchSize: z.number(),
});

const getMoreSchema = z.object({
  action: z.literal("getMore"),
  collection: z.string(),
  cursorId: z.string(),
  batchSize: z.number(),
});

const closeCursorSchema = z.object({
  action: z.literal("closeCursor"),
  collection: z.string(),
  cursorId: z.string(),
});

const countSchema = z.object({
  action: z.literal("count"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  options: z.object({
    maxTimeMS: z.number().int().positive().optional(),
    hint: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  }).optional(),
});

const insertOneSchema = z.object({
  action: z.literal("insertOne"),
  collection: z.string(),
  doc: z.record(z.string(), z.any()),
});

const insertManySchema = z.object({
  action: z.literal("insertMany"),
  collection: z.string(),
  docs: z.array(z.record(z.string(), z.any())),
});

const updateBaseOptions = z.object({
  upsert: z.boolean().optional(),
  touchUpdatedAt: z.boolean().optional(),
}).optional();

const updateOneSchema = z.object({
  action: z.literal("updateOne"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  update: z.record(z.string(), z.any()),
  options: updateBaseOptions,
});

const updateManySchema = z.object({
  action: z.literal("updateMany"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  update: z.record(z.string(), z.any()),
  options: updateBaseOptions,
});

const deleteOneSchema = z.object({
  action: z.literal("deleteOne"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
});

const deleteManySchema = z.object({
  action: z.literal("deleteMany"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
});

const aggregateSchema = z.object({
  action: z.literal("aggregate"),
  collection: z.string(),
  pipeline: z.array(z.record(z.string(), z.any())),
  options: z.record(z.string(), z.any()).optional(),
});

const bulkWriteSchema = z.object({
  action: z.literal("bulkWrite"),
  collection: z.string(),
  operations: z.array(z.record(z.string(), z.any())),
  options: z.object({
    ordered: z.boolean().optional(),
    touchUpdatedAt: z.boolean().optional(),
  }).optional(),
});

const createIndexSchema = z.object({
  action: z.literal("createIndex"),
  collection: z.string(),
  index: z.record(z.string(), z.any()),
  options: z.record(z.string(), z.any()).optional(),
});

const listIndexesSchema = z.object({
  action: z.literal("listIndexes"),
  collection: z.string(),
});

const findOneAndUpdateSchema = z.object({
  action: z.literal("findOneAndUpdate"),
  collection: z.string(),
  query: z.record(z.string(), z.any()),
  update: z.record(z.string(), z.any()),
  options: z.object({
    sort: z.record(z.string(), z.any()).optional(),
    returnDocument: z.enum(["before", "after"]).optional(),
    upsert: z.boolean().optional(),
    touchUpdatedAt: z.boolean().optional(),
  }).optional(),
});

const mongoRequestSchema = z.discriminatedUnion("action", [
  findSchema,
  findOneSchema,
  insertOneSchema,
  insertManySchema,
  updateOneSchema,
  updateManySchema,
  deleteOneSchema,
  deleteManySchema,
  countSchema,
  aggregateSchema,
  bulkWriteSchema,
  createIndexSchema,
  listIndexesSchema,
  getFirstBatchSchema,
  getMoreSchema,
  closeCursorSchema,
  findOneAndUpdateSchema,
]);

export type MongoRequest = z.infer<typeof mongoRequestSchema>;
export type MongoResponse = any;

export const DIARIZATION_RECORDING_LEASE_BUSY_CODE =
  "diarization_recording_lease_busy";

export function isDiarizationRecordingLeaseCollision(
  input: MongoRequest,
  error: unknown,
): boolean {
  if (
    input.action !== "findOneAndUpdate" ||
    input.collection !== "diarization_recording_leases" ||
    input.options?.upsert !== true ||
    !Object.prototype.hasOwnProperty.call(input.query, "_id") ||
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== 11000
  ) {
    return false;
  }

  const keyPattern = (error as { keyPattern?: Record<string, unknown> })
    .keyPattern;
  const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
  return keyPattern?._id === 1 ||
    (keyValue !== undefined &&
      Object.prototype.hasOwnProperty.call(keyValue, "_id"));
}

export function normalizeInsertedDocument(
  collection: string,
  doc: Record<string, any>,
): Record<string, any> {
  return collection === "objects" ? withObjectListCategories(doc) : doc;
}

const actionMap = {
  count: ["read"],
  find: ["read"],
  findOne: ["read"],
  insertOne: ["write"],
  insertMany: ["write"],
  updateOne: ["update"],
  updateMany: ["update"],
  deleteOne: ["delete"],
  deleteMany: ["delete"],
  aggregate: ["read", "write", "update", "delete"],
  bulkWrite: ["write", "update", "delete"],
  createIndex: ["write"],
  listIndexes: ["read"],
  getFirstBatch: ["read"],
  getMore: ["read"],
  closeCursor: ["read"],
  findOneAndUpdate: ["read", "update"],
} satisfies { [K in MongoRequest["action"]]: string[] };

export class MongoResource implements Resource<MongoRequest, MongoResponse> {
  code = "mongo";
  description = "MongoDB operations";
  schemas = {
    request: mongoRequestSchema,
    response: z.any(),
  };

  private collectionExistsCache = new Set<string>();

  clearCollectionCache(): void {
    this.collectionExistsCache.clear();
  }

  private async executeFindWithCursor(
    collection: any,
    query: Record<string, any>,
    options: any,
    batchSize: number,
    principal: string,
  ): Promise<{ cursorId: string; data: any[]; hasMore: boolean }> {
    cleanupExpiredCursors();

    const cursorOptions: any = {
      ...options,
      batchSize,
    };

    const cursor = collection.find(query, cursorOptions);

    const results: any[] = [];
    let count = 0;
    while (count < batchSize && await cursor.hasNext()) {
      const doc = await cursor.next();
      if (doc) {
        results.push(doc);
        count++;
      }
    }

    const hasMore = await cursor.hasNext();

    if (!hasMore) {
      await cursor.close();
      return {
        cursorId: "",
        data: results,
        hasMore: false,
      };
    }

    const cursorId = generateCursorId(principal);
    cursorMap.set(cursorId, {
      cursor,
      expiresAt: Date.now() + CURSOR_TTL_MS,
      principal,
    });

    return { cursorId, data: results, hasMore };
  }

  private async continueCursor(
    collection: string,
    cursorId: string,
    batchSize: number,
    principal: string,
  ): Promise<{ data: any[]; hasMore: boolean }> {
    cleanupExpiredCursors();

    const cursorEntry = cursorMap.get(cursorId);

    if (!cursorEntry) {
      return { data: [], hasMore: false };
    }

    if (cursorEntry.principal !== principal) {
      return { data: [], hasMore: false };
    }

    if (cursorEntry.expiresAt < Date.now()) {
      cursorMap.delete(cursorId);
      await cursorEntry.cursor.close();
      return { data: [], hasMore: false };
    }

    const cursor = cursorEntry.cursor;

    try {
      const results: any[] = [];
      let count = 0;
      while (count < batchSize && await cursor.hasNext()) {
        const doc = await cursor.next();
        if (doc) {
          results.push(doc);
          count++;
        }
      }

      const hasMore = await cursor.hasNext();

      if (!hasMore) {
        cursorMap.delete(cursorId);
        await cursor.close();
      } else {
        cursorEntry.expiresAt = Date.now() + CURSOR_TTL_MS;
      }

      return { data: results, hasMore };
    } catch (error) {
      cursorMap.delete(cursorId);
      try {
        await cursor.close();
      } catch {
        // ignore
      }
      throw error;
    }
  }

  private async closeCursor(
    cursorId: string,
    principal: string,
  ): Promise<{ closed: boolean }> {
    cleanupExpiredCursors();

    const cursorEntry = cursorMap.get(cursorId);
    if (!cursorEntry || cursorEntry.principal !== principal) {
      return { closed: false };
    }

    cursorMap.delete(cursorId);
    await cursorEntry.cursor.close();
    return { closed: true };
  }
  async getRootDB(): Promise<Db> {
    return getRootDB();
  }

  async ensureCollectionExists(db: Db, collectionName: string): Promise<void> {
    // Check cache first - if we've already verified this collection exists, skip the check
    if (this.collectionExistsCache.has(collectionName)) {
      return;
    }

    try {
      const collections = await db.listCollections({ name: collectionName })
        .toArray();

      if (collections.length === 0) {
        await db.createCollection(collectionName);
        console.log(`Auto-created collection: ${collectionName}`);
      }

      // Add to cache after successful verification/creation
      this.collectionExistsCache.add(collectionName);
    } catch (error) {
      console.error(
        `Failed to ensure collection ${collectionName} exists:`,
        error,
      );
      // Don't add to cache on error - we'll try again next time
      // Don't throw the error - let the operation continue
      // The operation will fail gracefully if the collection truly doesn't exist
    }
  }
  async use(input: MongoRequest, auth: Auth): Promise<MongoResponse> {
    const db = await this.getRootDB();

    await this.ensureCollectionExists(db, input.collection);

    try {
      return await withTimelineDensityWrite(
        db,
        input,
        () => this.execute(db, input, auth),
      );
    } catch (error) {
      if (isDiarizationRecordingLeaseCollision(input, error)) {
        return Response.json({
          success: false,
          code: DIARIZATION_RECORDING_LEASE_BUSY_CODE,
          error: "Recording lease is already held",
        }, { status: 409 });
      }
      console.error(
        `MongoDB operation failed on collection ${input.collection}:`,
        error,
      );
      throw new Error(
        `Database operation failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  private async execute(
    db: Db,
    input: MongoRequest,
    auth: Auth,
  ): Promise<MongoResponse> {
    const collection = db.collection(input.collection);
    // Bound both the whole driver operation (including multi-command bulks)
    // and each server command before the durable density intent expires.
    const sourceWriteOptions = input.collection === "audio_chunks" ||
        input.collection === "transcriptions"
      ? {
        maxTimeMS: TIMELINE_DENSITY_SOURCE_WRITE_TIMEOUT_MS,
        timeoutMS: TIMELINE_DENSITY_SOURCE_WRITE_TIMEOUT_MS,
      }
      : {};
    switch (input.action) {
      case "find": {
        const limit = input.options?.limit ?? 1000;
        return collection.find(input.query, input.options).batchSize(limit)
          .limit(limit).toArray();
      }
      case "findOne":
        return collection.findOne(input.query, input.options);
      case "getFirstBatch": {
        return this.executeFindWithCursor(
          collection,
          input.query,
          input.options,
          input.batchSize,
          auth.principal,
        );
      }
      case "getMore": {
        return this.continueCursor(
          input.collection,
          input.cursorId,
          input.batchSize,
          auth.principal,
        );
      }
      case "closeCursor":
        return this.closeCursor(input.cursorId, auth.principal);
      case "insertOne": {
        const doc = {
          ...normalizeInsertedDocument(input.collection, input.doc),
          updatedAt: new Date(),
        };
        return collection.insertOne(doc, sourceWriteOptions);
      }
      case "insertMany": {
        const docs = input.docs.map((doc) => ({
          ...normalizeInsertedDocument(input.collection, doc),
          updatedAt: new Date(),
        }));
        return collection.insertMany(docs, sourceWriteOptions);
      }
      case "updateOne": {
        const update = { ...input.update };
        if (input.options?.touchUpdatedAt !== false) {
          if (update.$set) {
            update.$set = { ...update.$set, updatedAt: new Date() };
          } else {
            update.$set = { updatedAt: new Date() };
          }
        }
        const { touchUpdatedAt: _touchUpdatedAt, ...options } = input.options ??
          {};
        return collection.updateOne(input.query, update, {
          ...options,
          ...sourceWriteOptions,
        });
      }
      case "updateMany": {
        const update = { ...input.update };
        if (input.options?.touchUpdatedAt !== false) {
          if (update.$set) {
            update.$set = { ...update.$set, updatedAt: new Date() };
          } else {
            update.$set = { updatedAt: new Date() };
          }
        }
        const { touchUpdatedAt: _touchUpdatedAt, ...options } = input.options ??
          {};
        return collection.updateMany(
          input.query,
          update,
          { ...options, ...sourceWriteOptions },
        );
      }
      case "deleteOne":
        return collection.deleteOne(input.query, sourceWriteOptions);
      case "deleteMany":
        return collection.deleteMany(input.query, sourceWriteOptions);
      case "count":
        return collection.countDocuments(input.query, input.options);
      case "aggregate":
        return collection.aggregate(input.pipeline, input.options).toArray();
      case "bulkWrite": {
        const touchUpdatedAt = input.options?.touchUpdatedAt !== false;
        const operations = input.operations.map((op: any) => {
          if (op.insertOne) {
            return {
              ...op,
              insertOne: {
                ...op.insertOne,
                document: {
                  ...normalizeInsertedDocument(
                    input.collection,
                    op.insertOne.document,
                  ),
                  updatedAt: new Date(),
                },
              },
            };
          }
          if (op.insertMany) {
            return {
              ...op,
              insertMany: {
                ...op.insertMany,
                documents: op.insertMany.documents.map((doc: any) => ({
                  ...normalizeInsertedDocument(input.collection, doc),
                  updatedAt: new Date(),
                })),
              },
            };
          }
          if (op.updateOne) {
            const updateOp = op.updateOne;
            const update = { ...updateOp.update };
            if (touchUpdatedAt) {
              if (update.$set) {
                update.$set = { ...update.$set, updatedAt: new Date() };
              } else {
                update.$set = { updatedAt: new Date() };
              }
            }
            return { ...op, updateOne: { ...updateOp, update } };
          }
          if (op.updateMany) {
            const updateOp = op.updateMany;
            const update = { ...updateOp.update };
            if (touchUpdatedAt) {
              if (update.$set) {
                update.$set = { ...update.$set, updatedAt: new Date() };
              } else {
                update.$set = { updatedAt: new Date() };
              }
            }
            return { ...op, updateMany: { ...updateOp, update } };
          }
          if (op.replaceOne) {
            const replaceOp = op.replaceOne;
            return {
              ...op,
              replaceOne: {
                ...replaceOp,
                replacement: {
                  ...normalizeInsertedDocument(
                    input.collection,
                    replaceOp.replacement,
                  ),
                  ...(touchUpdatedAt ? { updatedAt: new Date() } : {}),
                },
              },
            };
          }
          return op;
        });
        const { touchUpdatedAt: _touchUpdatedAt, ...options } = input.options ??
          {};
        return collection.bulkWrite(operations as any, {
          ...options,
          ...sourceWriteOptions,
        });
      }
      case "createIndex":
        return collection.createIndex(input.index, input.options);
      case "listIndexes":
        if (
          !(await db.listCollections({ name: input.collection }).hasNext())
        ) {
          return [];
        }
        return collection.indexes();
      case "findOneAndUpdate": {
        const update = { ...input.update };
        if (input.options?.touchUpdatedAt !== false) {
          if (update.$set) {
            update.$set = { ...update.$set, updatedAt: new Date() };
          } else {
            update.$set = { updatedAt: new Date() };
          }
        }
        const { touchUpdatedAt: _touchUpdatedAt, ...options } = input.options ??
          {};
        if (options.returnDocument === "before") {
          options.returnDocument = "before";
        } else if (options.returnDocument === "after") {
          options.returnDocument = "after";
        }
        const result = await collection.findOneAndUpdate(
          input.query,
          update,
          { ...options, ...sourceWriteOptions },
        );
        // MongoDB driver returns the document directly (or null if not found)
        return result;
      }
      default:
        throw new Error("Unknown action");
    }
  }

  extractActions(input: MongoRequest) {
    let actions: string[];

    if (input.action === "bulkWrite") {
      const actionSet = new Set<string>();
      for (const op of input.operations) {
        if (op.insertOne || op.insertMany) actionSet.add("write");
        if (op.updateOne || op.updateMany || op.replaceOne) {
          actionSet.add("update");
          const updateOp = op.updateOne || op.updateMany || op.replaceOne;
          if (updateOp.options?.upsert) {
            actionSet.add("write");
          }
        }
        if (op.deleteOne || op.deleteMany) actionSet.add("delete");
      }
      actions = Array.from(actionSet);
      // If no operations, default to read just to have something,
      // though bulkWrite with no ops is technically a no-op.
      if (actions.length === 0) actions.push("read");
    } else if (input.action === "aggregate") {
      const isWrite = input.pipeline.some(
        (stage) => "$out" in stage || "$merge" in stage,
      );
      actions = isWrite ? ["read", "write", "update", "delete"] : ["read"];
    } else {
      actions = [...actionMap[input.action]];
      if (
        (input.action === "updateOne" || input.action === "updateMany" ||
          input.action === "findOneAndUpdate") &&
        (input as any).options?.upsert
      ) {
        actions.push("write");
      }
    }

    return [
      {
        path: ["db", input.collection],
        actions,
      },
    ];
  }

  modifiers = {
    filter: {
      schema: z.object({
        filter: z.record(z.string(), z.any()),
      }),
      use: async (
        { arg, auth, input }: {
          arg: { filter: Filter<unknown> };
          auth: Auth;
          input: MongoRequest;
        },
        next: (input: MongoRequest, auth: Auth) => Promise<MongoResponse>,
      ) => {
        if (input.action === "insertOne") {
          const matcher = sift(arg.filter);
          if (!matcher(input.doc)) {
            permissionDenied();
          }
          return next(input, auth);
        }
        if (input.action === "insertMany") {
          const matcher = sift(arg.filter);
          if (input.docs.some((doc) => !matcher(doc))) {
            permissionDenied();
          }
          return next(input, auth);
        }

        if ("query" in input) {
          const query = {
            $and: [
              input.query,
              arg.filter,
            ],
          };

          const result = await next({
            ...input,
            query,
          }, auth);
          return result;
        } else {
          // For actions without query (like aggregate), just pass through
          const result = await next(input, auth);
          return result;
        }
      },
    },
  };
}

export function getMongoResource(
  auth: Auth,
) {
  return auth.getResource<MongoRequest, MongoResponse>("mongo");
}
