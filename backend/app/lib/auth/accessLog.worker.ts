import { getRootDB } from "@/lib/mongo/core.server.ts";
import { redis } from "@/lib/redis.ts";
import {
  ACCESS_LOG_GROUP,
  ACCESS_LOG_STREAM,
  accessLogRetentionId,
  ACKNOWLEDGE_PERSISTED_ACCESS_LOGS,
  persistAccessLogBatch,
  readAccessLogBatch,
  type StoredAccessLog,
} from "./accessLog.persistence.ts";

const DEBUG = Deno.env.get("DEBUG_ACCESS_LOG") === "true";
const log = (message: string) => DEBUG && console.log(message);

let accessLogWorker: { stop: () => Promise<void> } | null = null;

export async function startAccessLogWorker(): Promise<void> {
  if (accessLogWorker) return;
  const retainThroughId = accessLogRetentionId(
    Deno.env.get("ACCESS_LOG_RETAIN_THROUGH_ID"),
  );

  // Blocking reads must not stall the shared connection used by HTTP requests
  // and job scheduling. A finite retry count lets the loop back off on failure.
  const connection = redis.duplicate({
    maxRetriesPerRequest: 1,
    commandTimeout: 10_000,
    lazyConnect: true,
  });
  // Failed commands are reported below without exposing connection details.
  connection.on("error", () => {});
  let running = true;
  let loop: Promise<void> | undefined;
  let wakeBackoff: (() => void) | undefined;
  const worker = {
    stop: async () => {
      running = false;
      wakeBackoff?.();
      connection.disconnect();
      // Redis blocking reads/backoff stop promptly. An in-flight shared Mongo
      // connection lookup must finish its existing application retry policy;
      // do not abandon it and start concurrent database retries.
      await loop;
      if (accessLogWorker === worker) accessLogWorker = null;
    },
  };
  accessLogWorker = worker;

  const ensureGroup = async () => {
    try {
      await connection.call(
        "XGROUP",
        "CREATE",
        ACCESS_LOG_STREAM,
        ACCESS_LOG_GROUP,
        "0",
        "MKSTREAM",
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
        throw error;
      }
    }
  };

  const backoff = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeBackoff = undefined;
        resolve();
      }, 1000);
      wakeBackoff = () => {
        clearTimeout(timer);
        wakeBackoff = undefined;
        resolve();
      };
    });

  try {
    await ensureGroup();
    if (!running) return;
    loop = (async () => {
      while (running) {
        try {
          const messages = await readAccessLogBatch((...args) =>
            connection.call(args[0] as string, ...args.slice(1))
          );
          if (!running) break;
          if (!messages.length) continue;
          const db = await getRootDB();
          if (!running) break;
          await persistAccessLogBatch(messages, {
            persist: async (name, documents) => {
              await db.collection<StoredAccessLog>(name).bulkWrite(
                documents.map((document) => ({
                  updateOne: {
                    filter: { _id: document._id },
                    update: { $setOnInsert: document },
                    upsert: true,
                  },
                })),
                {
                  ordered: false,
                  timeoutMS: 15_000,
                  writeConcern: { w: "majority", j: true, wtimeoutMS: 10_000 },
                },
              );
            },
            acknowledge: async (ids) => {
              await connection.eval(
                ACKNOWLEDGE_PERSISTED_ACCESS_LOGS,
                1,
                ACCESS_LOG_STREAM,
                ACCESS_LOG_GROUP,
                retainThroughId,
                ...ids,
              );
            },
          });
          log(`[AccessLog] Persisted ${messages.length} entries`);
        } catch (error) {
          if (!running) break;
          // Exception messages can contain audit payloads or connection secrets.
          console.error(
            "[AccessLog] Batch failed; pending entries retained for retry",
          );
          await backoff();
          if (!running) break;
          if (error instanceof Error && error.message.includes("NOGROUP")) {
            try {
              await ensureGroup();
            } catch {
              console.error("[AccessLog] Consumer group unavailable; retrying");
            }
          }
        }
      }
    })().finally(() => {
      connection.disconnect();
      if (accessLogWorker === worker) accessLogWorker = null;
    });
    log("[AccessLog] Worker started");
  } catch (error) {
    await worker.stop();
    throw error;
  }
}

export async function stopAccessLogWorker(): Promise<void> {
  await accessLogWorker?.stop();
}
