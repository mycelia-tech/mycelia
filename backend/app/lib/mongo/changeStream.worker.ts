import {
  closeChangeStreamDB,
  getChangeStreamDB,
  getRootDB,
} from "./core.server.ts";
import { publishEvent } from "@/lib/events/publisher.ts";
import type { ChangeStreamDocument } from "mongodb";
import { debounce } from "@std/async/debounce";
import {
  deriveObjectListCategories,
  OBJECT_LIST_TYPE_FLAGS,
} from "@/lib/objects/list-categories.ts";
import {
  enqueueObjectDensityChange,
  recoverObjectDensityPending,
} from "@/lib/objects/timeline-density.worker.ts";
import type { ChangeStreamOptions, Db } from "mongodb";
import {
  enqueueConversationProjectionChange,
  shouldQueueConversationProjectionChange,
} from "@/lib/location/conversation-map.server.ts";

let changeStreamWorker: { stop: () => Promise<void> } | null = null;

function getDocumentId(doc: any): string {
  if (doc._id) {
    return typeof doc._id === "string" ? doc._id : doc._id.toString();
  }
  return "unknown";
}

export function createPerCollectionChangeDebouncer(
  publisher: (collectionName: string) => void | Promise<void>,
  delayMs = 1_000,
): (collectionName: string) => void {
  const publishers = new Map<string, () => void>();
  return (collectionName: string) => {
    let publish = publishers.get(collectionName);
    if (!publish) {
      publish = debounce(() => publisher(collectionName), delayMs);
      publishers.set(collectionName, publish);
    }
    publish();
  };
}

const debouncedFrequentChanges = createPerCollectionChangeDebouncer(
  async (collectionName) => {
    await publishEvent(`mongo:${collectionName}`, "mongo.change", {
      collection: collectionName,
    });
  },
);

export function getCollectionChangeStreamOptions(
  collectionName: string,
): ChangeStreamOptions {
  // Catalog backfills can update hundreds of thousands of objects. Asking the
  // server for updateLookup here would hydrate every large object before we
  // know whether this is the derived, compact catalog-only update.
  return collectionName === "objects" ? {} : { fullDocument: "updateLookup" };
}

// Keep Objects' selective hydration semantics; all other collections (including
// newly created ones) share one database cursor, not one socket per collection.
export const DATABASE_CHANGE_PIPELINE = [
  { $match: { "ns.coll": { $ne: "objects" } } },
];

const OBJECT_CATALOG_CORRECTOR_PROJECTION = {
  _listCategories: 1,
  ...Object.fromEntries(OBJECT_LIST_TYPE_FLAGS.map(([flag]) => [flag, 1])),
};

export async function loadObjectUpdateDocument(
  db: Db,
  documentKey: unknown,
): Promise<Record<string, any> | null> {
  const id = documentKey && typeof documentKey === "object"
    ? (documentKey as { _id?: unknown })._id
    : undefined;
  if (id == null) return null;
  return await db.collection<Record<string, any>>("objects").findOne(
    { _id: id } as never,
  );
}

export async function validateObjectCatalogBatch(
  db: Db,
  ids: unknown[],
): Promise<void> {
  if (ids.length === 0) return;
  const documents = await db.collection<Record<string, any>>("objects").find(
    { _id: { $in: ids } } as never,
    {
      projection: OBJECT_CATALOG_CORRECTOR_PROJECTION,
      maxTimeMS: 3_000,
    },
  ).toArray();
  for (const document of documents) {
    await correctObjectListCategories(db, "update", document, {
      updatedFields: { _listCategories: document._listCategories },
    });
  }
}

export function createObjectCatalogValidationQueue(
  db: Db,
  options: {
    batchSize?: number;
    delayMs?: number;
    retryMs?: number;
    onError?: (error: unknown) => void | Promise<void>;
  } = {},
): {
  enqueue: (documentKey: unknown) => void;
  flushNow: () => Promise<boolean>;
} {
  const batchSize = Math.max(1, options.batchSize ?? 1_000);
  const delayMs = Math.max(0, options.delayMs ?? 25);
  const retryMs = Math.max(50, options.retryMs ?? 60_000);
  const pending = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<boolean> | null = null;
  let rescheduleDelayMs = delayMs;

  const schedule = (delay: number) => {
    if (timer || active) return;
    timer = setTimeout(() => {
      timer = null;
      void startDrain();
    }, delay);
  };

  const drain = async (): Promise<boolean> => {
    while (pending.size > 0) {
      const entries = [...pending.entries()].slice(0, batchSize);
      for (const [key] of entries) pending.delete(key);
      try {
        await validateObjectCatalogBatch(
          db,
          entries.map(([, id]) => id),
        );
      } catch (error) {
        for (const [key, id] of entries) {
          if (!pending.has(key)) pending.set(key, id);
        }
        await options.onError?.(error);
        rescheduleDelayMs = retryMs;
        return false;
      }
    }
    return true;
  };

  const startDrain = (): Promise<boolean> => {
    if (active) return active;
    active = drain().finally(() => {
      active = null;
      if (pending.size > 0 && !timer) schedule(rescheduleDelayMs);
      rescheduleDelayMs = delayMs;
    });
    return active;
  };

  return {
    enqueue(documentKey) {
      const id = documentKey && typeof documentKey === "object"
        ? (documentKey as { _id?: unknown })._id
        : undefined;
      if (id == null) return;
      pending.set(`${typeof id}:${String(id)}`, id);
      schedule(delayMs);
    },
    async flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (active || pending.size > 0) {
        const succeeded = await (active ?? startDrain());
        if (!succeeded) return false;
      }
      return true;
    },
  };
}

export function normalizeChangedFields(updateDescription: unknown): string[] {
  if (!updateDescription || typeof updateDescription !== "object") return [];
  const description = updateDescription as {
    updatedFields?: Record<string, unknown>;
    removedFields?: unknown[];
    truncatedArrays?: Array<{ field?: unknown }>;
  };
  const fields = [
    ...Object.keys(description.updatedFields ?? {}),
    ...(description.removedFields ?? []).filter((field): field is string =>
      typeof field === "string"
    ),
    ...(description.truncatedArrays ?? []).map((entry) => entry?.field).filter(
      (field): field is string => typeof field === "string",
    ),
  ];
  return [...new Set(fields)];
}

const OBJECT_DENSITY_FIELDS = new Set([
  "timeRanges",
  "isPerson",
  "isEvent",
  "isPromise",
  "isRelationship",
  "isPlace",
  "isOrganization",
  "isProduct",
  "isProject",
  "isAnimal",
  "isConcept",
  "isMedia",
]);

export function isObjectCatalogOnlyChange(
  operationType: string,
  updateDescription?: unknown,
): boolean {
  if (operationType !== "update") return false;
  const changedFields = normalizeChangedFields(updateDescription);
  return changedFields.length === 1 && changedFields[0] === "_listCategories";
}

export function shouldRefreshObjectDensity(
  operationType: string,
  updateDescription?: unknown,
): boolean {
  if (["insert", "replace", "delete"].includes(operationType)) return true;
  if (operationType !== "update") return false;
  return normalizeChangedFields(updateDescription).some((field) => {
    const root = field.split(".", 1)[0];
    return OBJECT_DENSITY_FIELDS.has(root);
  });
}

export function shouldSuppressMongoChange(collectionName: string): boolean {
  return collectionName === "object_timeline_density_pending" ||
    collectionName === "location_conversation_projection_pending";
}

export async function correctObjectListCategories(
  db: Db,
  operationType: string,
  document: Record<string, any> | null | undefined,
  updateDescription?: unknown,
): Promise<boolean> {
  if (!document?._id || operationType === "delete") return false;

  let candidate = document;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expected = deriveObjectListCategories(candidate);
    const current = Array.isArray(candidate._listCategories)
      ? candidate._listCategories
      : [];
    if (
      current.length === expected.length &&
      current.every((value: unknown, index: number) =>
        value === expected[index]
      )
    ) {
      return false;
    }

    const flagSnapshot = Object.fromEntries(
      OBJECT_LIST_TYPE_FLAGS.map(([flag]) => [
        flag,
        candidate[flag] === true ? true : { $ne: true },
      ]),
    );
    const result = await db.collection("objects").updateOne(
      { _id: candidate._id, ...flagSnapshot },
      { $set: { _listCategories: expected } },
    );
    if (result.modifiedCount > 0) return true;
    const latest = await db.collection("objects").findOne(
      { _id: candidate._id },
      {
        projection: {
          _listCategories: 1,
          ...Object.fromEntries(
            OBJECT_LIST_TYPE_FLAGS.map(([flag]) => [flag, 1]),
          ),
        },
      },
    );
    if (!latest) return false;
    candidate = latest;
  }
  throw new Error("Object list categories changed during correction");
}

async function markObjectListCatalogNotReady(db: Db, error: unknown) {
  await db.collection<{ _id: string }>("object_list_state").updateOne(
    { _id: "catalog" },
    {
      $set: {
        schemaVersion: 1,
        ready: false,
        driftDetectedAt: new Date(),
        driftReason: error instanceof Error ? error.message : String(error),
      },
    },
    { upsert: true },
  );
}

async function publishMongoChange(
  collectionName: string,
  operationType: string,
  documentId: string,
  document?: any,
  updateDescription?: unknown,
): Promise<void> {
  const eventData = {
    collection: collectionName,
    operationType,
    documentId,
    document,
    updateDescription,
    changedFields: normalizeChangedFields(updateDescription),
    timestamp: new Date().toISOString(),
  };

  // This is an internal durable work queue. Its insert/delete churn has no UI
  // consumer and must not produce websocket invalidations.
  if (shouldSuppressMongoChange(collectionName)) return;

  if (
    [
      "histogram_5min",
      "histogram_1hour",
      "histogram_1day",
      "histogram_1week",
      "object_timeline_density",
      "object_timeline_density_sources",
      "object_timeline_density_state",
      "location_conversation_projection",
      "location_conversation_projection_state",
      "location_route_fragments",
      "location_route_geometry",
      "location_route_breaks",
      "location_route_projection_state",
      "access_logs",
    ].includes(collectionName)
  ) {
    debouncedFrequentChanges(collectionName);
    return;
  }

  if (
    collectionName === "job_logs" && operationType === "insert" &&
    document?.jobId
  ) {
    await publishEvent(`jobs:${document.jobId}:logs`, "job.log", {
      logId: documentId,
      jobId: document.jobId,
      stream: document.stream,
      text: document.text,
      timestamp: document.timestamp ?? new Date().toISOString(),
    });
  }

  await publishEvent(
    `mongo:${collectionName}:${documentId}`,
    "mongo.change",
    eventData,
  );
  await publishEvent(`mongo:${collectionName}`, "mongo.change", eventData);
}

export async function startChangeStreamWorker(): Promise<void> {
  if (changeStreamWorker) {
    console.log("[ChangeStream] Worker already started");
    return;
  }

  console.log("[ChangeStream] Starting MongoDB change stream worker...");

  try {
    const db = await getRootDB();
    const watchDb = await getChangeStreamDB();
    const objectCatalogValidation = createObjectCatalogValidationQueue(db, {
      onError: async (error) => {
        await markObjectListCatalogNotReady(db, error);
        console.error(
          "[ChangeStream] Failed to validate object list categories:",
          error,
        );
      },
    });

    const changeStreams: Array<{ stop: () => Promise<void> }> = [];

    for (const scope of ["objects", "database"] as const) {
      try {
        const changeStream = scope === "objects"
          ? watchDb.collection("objects").watch(
            [],
            getCollectionChangeStreamOptions("objects"),
          )
          : watchDb.watch(DATABASE_CHANGE_PIPELINE, {
            fullDocument: "updateLookup",
          });

        changeStream.on("change", async (change: ChangeStreamDocument) => {
          const collectionName = "ns" in change && "coll" in change.ns
            ? change.ns.coll
            : undefined;
          if (!collectionName || collectionName.startsWith("system.")) return;
          try {
            const operationType = change.operationType;
            let documentId: string;
            let document: any = null;
            let updateDescription: unknown;

            switch (operationType) {
              case "insert":
                documentId = getDocumentId(change.fullDocument);
                document = change.fullDocument;
                break;
              case "update":
                updateDescription = change.updateDescription;
                documentId = getDocumentId(change.documentKey);
                document = change.fullDocument;
                break;
              case "replace":
                documentId = getDocumentId(change.documentKey);
                document = change.fullDocument;
                break;
              case "delete":
                documentId = getDocumentId(change.documentKey);
                break;
              case "invalidate":
                console.warn(
                  `[ChangeStream] Invalid change stream for ${collectionName}`,
                );
                return;
              default:
                return;
            }

            const catalogOnly = collectionName === "objects" &&
              isObjectCatalogOnlyChange(operationType, updateDescription);

            if (catalogOnly) {
              objectCatalogValidation.enqueue(change.documentKey);
              return;
            }

            if (
              collectionName === "objects" && operationType === "update" &&
              !document
            ) {
              document = await loadObjectUpdateDocument(
                db,
                change.documentKey,
              );
            }

            if (
              collectionName === "objects" &&
              shouldRefreshObjectDensity(operationType, updateDescription)
            ) {
              await enqueueObjectDensityChange(
                { operationType, documentId, document },
                db,
              );
            }

            if (
              collectionName === "objects" &&
              shouldQueueConversationProjectionChange(
                operationType,
                normalizeChangedFields(updateDescription),
              )
            ) {
              await enqueueConversationProjectionChange(db, {
                kind: "object",
                documentId: change.documentKey &&
                    typeof change.documentKey === "object"
                  ? (change.documentKey as { _id?: unknown })._id
                  : document?._id,
              });
            }
            if (collectionName === "location_segments") {
              await enqueueConversationProjectionChange(db, {
                kind: "segments",
              });
            }
            if (
              collectionName === "location_tracks" ||
              collectionName === "location_track_geometry"
            ) {
              await db.collection<{
                _id: string;
                dirty?: boolean;
                status?: string;
                sourceChangedAt?: Date;
              }>("location_route_projection_state").updateOne(
                { _id: "current" },
                {
                  $set: {
                    dirty: true,
                    status: "stale",
                    sourceChangedAt: new Date(),
                  },
                },
                { upsert: true },
              );
            }

            if (collectionName === "objects" && document) {
              try {
                await correctObjectListCategories(
                  db,
                  operationType,
                  document,
                  updateDescription,
                );
              } catch (error) {
                await markObjectListCatalogNotReady(db, error);
                console.error(
                  `[ChangeStream] Failed to correct object list categories for ${documentId}:`,
                  error,
                );
              }
            }

            await publishMongoChange(
              collectionName,
              operationType,
              documentId,
              document,
              updateDescription,
            );
          } catch (error) {
            console.error(
              `[ChangeStream] Error processing change for ${collectionName}:`,
              error,
            );
          }
        });

        changeStream.on("error", (error: Error) => {
          console.error(
            `[ChangeStream] Error watching ${scope}:`,
            error,
          );
        });

        changeStreams.push({
          stop: async () => {
            await changeStream.close();
          },
        });
      } catch (error) {
        console.error(
          `[ChangeStream] Failed to watch ${scope}:`,
          error,
        );
        await Promise.all(changeStreams.map((cs) => cs.stop()));
        await closeChangeStreamDB();
        throw error;
      }
    }

    changeStreamWorker = {
      stop: async () => {
        console.log("[ChangeStream] Stopping change stream worker...");
        await Promise.all(changeStreams.map((cs) => cs.stop()));
        await objectCatalogValidation.flushNow();
        await closeChangeStreamDB();
        changeStreamWorker = null;
        console.log("[ChangeStream] Change stream worker stopped");
      },
    };

    await recoverObjectDensityPending(db);

    console.log(
      `[ChangeStream] Started ${changeStreams.length} isolated cursors (objects + database)`,
    );
  } catch (error) {
    console.error("[ChangeStream] Failed to start worker:", error);
    throw error;
  }
}

export async function stopChangeStreamWorker(): Promise<void> {
  if (changeStreamWorker) {
    await changeStreamWorker.stop();
  }
}
