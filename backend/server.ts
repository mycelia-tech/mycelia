import { load as loadEnv } from "@std/dotenv";
import { existsSync } from "@std/fs/exists";

if (existsSync(".env")) {
  await loadEnv({ envPath: ".env", export: true });
}

if (existsSync("../.env")) {
  await loadEnv({ envPath: "../.env", export: true });
}

import "@/lib/telemetry.ts";
import yargs, { type ArgumentsCamelCase, type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { generateApiKeyWithId, verifyApiKey } from "@/lib/auth/tokens.ts";
import process, { exit } from "node:process";
import { authenticate, verifyToken } from "@/lib/auth/core.server.ts";
import {
  createWebSocketAuthRequest,
  selectWebSocketProtocol,
} from "@/lib/auth/websocket.ts";
import { env } from "#/env.ts";
import { type Policy } from "@/lib/auth/resources.ts";
import express from "express";
import morgan from "morgan";
import type { Request, Response } from "express";
import { createInterface } from "node:readline/promises";
import cors from "npm:cors@2.8.5";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "npm:ws@^8.18.0";
import { MongoClient } from "mongodb";

import { requestCounter } from "@/lib/telemetry.ts";
import { handlePcmWebSocket } from "@/services/audio.websocket.server.ts";
import { handleOpusWebSocket } from "@/services/audio.websocket.opus.server.ts";
import { handleUpdatesWebSocket } from "@/services/updates.websocket.server.ts";
import { updatesPubSubHub } from "@/services/updates-pubsub.server.ts";
import { setupResources } from "@/lib/resources/registry.ts";
import { shutdownTelemetry } from "@/lib/telemetry.ts";
import { ensureAllCollectionsExist } from "@/lib/mongo/collections.ts";
import { registerRoutes } from "./routes.ts";
import { errorHandler } from "@/middleware/errorHandler.ts";
import { createBodyParsers } from "@/middleware/body-parsers.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import { redis } from "@/lib/redis.ts";
import { startWorkers, stopWorkers } from "@/lib/jobs/workers.ts";
import { maintenanceManager } from "@/lib/jobs/maintenance-manager.ts";
import {
  startChangeStreamWorker,
  stopChangeStreamWorker,
} from "@/lib/mongo/changeStream.worker.ts";
import {
  startAccessLogWorker,
  stopAccessLogWorker,
} from "@/lib/auth/accessLog.worker.ts";
import { triggerManager } from "@/lib/jobs/trigger-manager.ts";
import { down, status, to, up } from "@/lib/mongo/migrator.ts";
import { setServiceReady } from "@/routes/health.ts";
import {
  isExpectedWebSocketDisconnect,
  WebSocketSupervisor,
} from "@/lib/websocket-transport.ts";

let logFile: Deno.FsFile | null = null;
let dependencyWatchdogInterval: ReturnType<typeof setInterval> | null = null;
const dependencyRedis = redis.duplicate();
// Keep liveness probes out of the application pool. Large, legitimate writes
// (for example a location import) can occupy that pool long enough for a
// checkout timeout to look like a database outage and trigger a needless
// self-heal restart.
const dependencyMongo = new MongoClient(env.MONGO_URL, {
  maxPoolSize: 1,
  maxConnecting: 1,
  serverSelectionTimeoutMS: 5_000,
  waitQueueTimeoutMS: 5_000,
});
let dependencyWatchdogRunning = false;
let dependencyFailures = 0;

const DEPENDENCY_WATCHDOG_INTERVAL_MS = 30_000;
const DEPENDENCY_WATCHDOG_TIMEOUT_MS = 8_000;
const DEPENDENCY_FAILURE_LIMIT = 3;

async function checkCriticalDependencies(): Promise<void> {
  if (dependencyWatchdogRunning) return;
  dependencyWatchdogRunning = true;
  try {
    const check = Promise.all([
      dependencyRedis.ping(),
      dependencyMongo.db(env.DATABASE_NAME).command(
        { ping: 1 },
        { timeoutMS: 5_000 },
      ),
      Promise.resolve().then(() => {
        if (!updatesPubSubHub.isReady) {
          throw new Error("updates Redis Pub/Sub is not reconciled");
        }
      }),
    ]);
    await Promise.race([
      check,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("critical dependency check timed out")),
          DEPENDENCY_WATCHDOG_TIMEOUT_MS,
        )
      ),
    ]);
    if (dependencyFailures > 0) {
      console.log(
        `[SELF-HEAL] Critical dependencies recovered after ${dependencyFailures} failed check(s).`,
      );
    }
    dependencyFailures = 0;
  } catch (error) {
    dependencyFailures++;
    console.error(
      `[WATCHDOG] Critical dependency check ${dependencyFailures}/${DEPENDENCY_FAILURE_LIMIT} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (dependencyFailures >= DEPENDENCY_FAILURE_LIMIT) {
      setServiceReady(false);
      console.error(
        "[SELF-HEAL] MongoDB or Redis remained unavailable; exiting so Docker restart policy can recover the backend.",
      );
      exit(1);
    }
  } finally {
    dependencyWatchdogRunning = false;
  }
}

function startDependencyWatchdog(): void {
  if (dependencyWatchdogInterval !== null) return;
  dependencyWatchdogInterval = setInterval(
    checkCriticalDependencies,
    DEPENDENCY_WATCHDOG_INTERVAL_MS,
  );
  console.log(
    `[WATCHDOG] Critical dependency monitor started interval=${DEPENDENCY_WATCHDOG_INTERVAL_MS}ms failureLimit=${DEPENDENCY_FAILURE_LIMIT}.`,
  );
}

function stopDependencyWatchdog(): void {
  if (dependencyWatchdogInterval === null) return;
  clearInterval(dependencyWatchdogInterval);
  dependencyWatchdogInterval = null;
  dependencyRedis.disconnect();
  void dependencyMongo.close().catch(() => {});
}

function setupLogging() {
  const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
  const LOG_FILE_PATH = "server.log";

  try {
    logFile = Deno.openSync(LOG_FILE_PATH, {
      create: true,
      write: true,
      append: true,
    });
    const originalLog = console.log;
    const originalError = console.error;

    const writeToLog = (args: any[], isError = false) => {
      const timestamp = new Date().toISOString();
      const message = args.map((arg) => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(" ");

      const logLine = `[${timestamp}] ${
        isError ? "ERROR" : "INFO"
      }: ${message}\n`;

      try {
        originalLog(...args);
        if (logFile) {
          try {
            const stats = Deno.statSync(LOG_FILE_PATH);
            if (stats.size > MAX_LOG_SIZE) {
              logFile.close();
              if (existsSync(LOG_FILE_PATH + ".old")) {
                Deno.removeSync(LOG_FILE_PATH + ".old");
              }
              Deno.renameSync(LOG_FILE_PATH, LOG_FILE_PATH + ".old");
              logFile = Deno.openSync(LOG_FILE_PATH, {
                create: true,
                write: true,
                append: true,
              });
            }
          } catch (rotateError) {
            // If rotation fails, we'll just try to continue writing to the current file
            // Re-open if it was closed but rename failed
            if (!logFile) {
              logFile = Deno.openSync(LOG_FILE_PATH, {
                create: true,
                write: true,
                append: true,
              });
            }
          }

          logFile.writeSync(new TextEncoder().encode(logLine));
          logFile.syncDataSync();
        }
      } catch (e) {
        originalError("Failed to write to log file:", e);
      }
    };

    console.log = (...args: any[]) => writeToLog(args, false);
    console.error = (...args: any[]) => writeToLog(args, true);

    console.log(
      `Logging initialized - logs will be written to ${LOG_FILE_PATH}`,
    );
  } catch (error) {
    console.error("Failed to setup logging:", error);
  }
}

function cleanupLogging() {
  if (logFile) {
    logFile.close();
    logFile = null;
  }
}

async function startServer(
  host: string,
  port: number,
  skipChecks = false,
  noWorkers = false,
) {
  const backendMode = Deno.env.get("APP_MODE") ?? "prod";
  const processStartedAt = new Date();
  let applicationStartupComplete = false;
  setServiceReady(false);
  console.log(
    `[SERVICE] backend starting mode=${backendMode} pid=${Deno.pid} ` +
      `startedAt=${processStartedAt.toISOString()}`,
  );
  await setupResources();
  if (!skipChecks) {
    const db = await getRootDB();
    await ensureAllCollectionsExist(db);
  }
  // The shared UI Pub/Sub transport is part of application readiness. Browser
  // sessions are accepted only after its Redis ready check has completed.
  updatesPubSubHub.onReadinessChange((ready) => {
    if (!ready) setServiceReady(false);
    else if (applicationStartupComplete) setServiceReady(true);
  });
  await updatesPubSubHub.start();

  const app = express();
  const httpServer = createHttpServer(app);

  app.disable("x-powered-by");
  // Only trust forwarding headers from an explicitly configured reverse proxy.
  if (Deno.env.get("MYCELIA_TRUST_PROXY")) {
    app.set("trust proxy", Deno.env.get("MYCELIA_TRUST_PROXY"));
  }
  const corsOrigins = [
    env.MYCELIA_FRONTEND_HOST,
    "https://localhost:4433",
    "http://localhost:5173",
    "http://localhost:5180",
  ].filter(Boolean) as string[];
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    exposedHeaders: [
      "X-Mycelia-Chat-Id",
      "X-Mycelia-Model",
      "X-Mycelia-Request-Id",
    ],
  }));
  // HTTP request logging - disable with LOG_HTTP=false
  if (Deno.env.get("LOG_HTTP") !== "false") {
    morgan.token("url-path", (req: Request) => (req.url || "/").split("?")[0]);
    app.use(
      morgan(
        ":method :url-path :status :res[content-length] - :response-time ms",
        {
          skip: (req: Request) =>
            req.url === "/health" ||
            req.url === "/readiness" ||
            req.url?.startsWith("/api/audio/pipeline") ||
            req.url?.startsWith("/api/resource/"),
        },
      ),
    );
  }
  app.use(createBodyParsers());

  app.use((req: Request, _res: Response, next: () => void) => {
    if (req.url !== "/health" && req.url !== "/readiness") {
      requestCounter.add(1, {
        method: req.method,
        route: new URL(req.url || "/", "http://localhost").pathname,
      });
    }
    next();
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectWebSocketProtocol,
  });
  const webSocketSupervisor = new WebSocketSupervisor();
  const activeWebSocketHandlers = new Set<Promise<void>>();
  webSocketSupervisor.start();

  async function isUpgradeAuthenticated(request: any): Promise<boolean> {
    const normalized = createWebSocketAuthRequest(request);
    return normalized !== null && await authenticate(normalized) !== null;
  }

  const runWebSocketHandler = (
    label: string,
    ws: any,
    handler: () => Promise<void>,
  ) => {
    webSocketSupervisor.track(ws, label);
    const activeHandler = handler()
      .catch((error) => {
        console.error(`[WS] ${label} handler failed:`, error);
        webSocketSupervisor.fail(ws, label, error);
      })
      .finally(() => activeWebSocketHandlers.delete(activeHandler));
    activeWebSocketHandlers.add(activeHandler);
  };

  const handleUpgrade = async (request: any, socket: any, head: any) => {
    if (!await isUpgradeAuthenticated(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    // Unified auto-detecting audio endpoint (recommended)
    if (url.pathname === "/ws/audio") {
      wss.handleUpgrade(request, socket, head, (ws: any) => {
        runWebSocketHandler(
          "/ws/audio",
          ws,
          () => handlePcmWebSocket(ws, request),
        );
      });
      // Legacy endpoints (backward compatibility)
    } else if (url.pathname === "/ws_pcm") {
      wss.handleUpgrade(request, socket, head, (ws: any) => {
        runWebSocketHandler(
          "/ws_pcm",
          ws,
          () => handlePcmWebSocket(ws, request),
        );
      });
    } else if (url.pathname === "/ws_omi") {
      wss.handleUpgrade(request, socket, head, (ws: any) => {
        runWebSocketHandler(
          "/ws_omi",
          ws,
          () => handleOpusWebSocket(ws, request),
        );
      });
    } else if (url.pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws: any) => {
        runWebSocketHandler(
          "/ws",
          ws,
          () => handleUpdatesWebSocket(ws, request),
        );
      });
    } else {
      socket.destroy();
    }
  };

  httpServer.on("upgrade", (request, socket, head) => {
    // Guard the raw TCP socket synchronously. Authentication is asynchronous,
    // and a peer may disappear before it has been upgraded to a ws instance.
    socket.on("error", (error) => {
      if (!isExpectedWebSocketDisconnect(error)) {
        console.error("[WS] Raw upgrade socket failed:", error);
      }
    });
    handleUpgrade(request, socket, head).catch((error) => {
      console.error("[WS] Upgrade failed:", error);
      socket.destroy();
    });
  });

  // Request logging - enable with DEBUG_REQUESTS=true
  if (Deno.env.get("DEBUG_REQUESTS") === "true") {
    app.use((req: Request, _res: Response, next: () => void) => {
      if (req.url !== "/health" && req.url !== "/readiness") {
        console.log(
          `Incoming request: ${req.method} ${
            new URL(req.url || "/", "http://localhost").pathname
          }`,
        );
      }
      next();
    });
  }

  // Register all routes
  registerRoutes(app);

  // Error handling middleware (must be last)
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.log(`Server is running on ${host}:${port}`);
      console.log(`Open http://${host}:${port}`);
      resolve();
    });
  });

  // Start workers AFTER the HTTP server is listening (workers depend on HTTP API)
  if (!noWorkers) {
    await startWorkers();
    await startChangeStreamWorker();
    await startAccessLogWorker();
    await triggerManager.start();
    await maintenanceManager.start();
  }

  applicationStartupComplete = true;
  setServiceReady(updatesPubSubHub.isReady);
  startDependencyWatchdog();
  console.log(
    `[READY] backend ready mode=${backendMode} workers=${!noWorkers} ` +
      `reload=${backendMode === "dev" ? "watch" : "manual"} ` +
      `url=http://${host}:${port} readiness=/readiness ` +
      `startedAt=${processStartedAt.toISOString()} ` +
      `readyAt=${new Date().toISOString()}`,
  );

  ["SIGTERM", "SIGINT"].forEach((signal) => {
    process.once(signal, async () => {
      setServiceReady(false);
      stopDependencyWatchdog();
      console.log(`Received shutdown signal: ${signal}`);
      httpServer?.close(console.error);
      await webSocketSupervisor.shutdown();
      wss.close();
      await Promise.race([
        Promise.allSettled([...activeWebSocketHandlers]),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      updatesPubSubHub.stop();
      await stopWorkers();
      await stopAccessLogWorker();
      await stopChangeStreamWorker();
      await triggerManager.stop();
      await maintenanceManager.stop();
      await shutdownTelemetry();
      cleanupLogging();
    });
  });
}

async function configureCli() {
  await yargs(hideBin(process.argv))
    .scriptName("deno run -A server.ts")
    .usage("$0 <command> [options]")
    .command(
      "serve",
      "Start web server.",
      (y: Argv) =>
        y
          .option("port", {
            alias: "p",
            type: "number",
            describe: "Port to serve on.",
            default: 5173,
          })
          .option("host", {
            alias: "h",
            type: "string",
            describe: "Host to serve on.",
            default: "0.0.0.0",
          })
          .option("skip-checks", {
            type: "boolean",
            describe: "Skip MongoDB collection and index checks.",
            default: false,
          })
          .option("workers", {
            type: "boolean",
            describe: "Start background workers.",
            default: true,
          }),
      async (
        args: ArgumentsCamelCase<{
          host: string;
          port: number;
          skipChecks?: boolean;
          workers?: boolean;
        }>,
      ) => {
        try {
          const host = String(args.host);
          const port = Number(args.port);
          const skipChecks = Boolean(args.skipChecks);
          const noWorkers = !args.workers;
          await startServer(host, port, skipChecks, noWorkers);
          await new Promise((resolve) => {
            process.on("SIGINT", resolve);
            process.on("SIGTERM", resolve);
          });
        } catch (err) {
          console.error("Failed to start server:", err);
          exit(1);
        }
      },
    )
    .command(
      "token-create",
      "Create a new token.",
      (y: Argv) =>
        y
          .option("owner", {
            alias: "o",
            type: "string",
            describe: "The owner of the token.",
            default: "admin",
          })
          .option("name", {
            alias: "n",
            type: "string",
            describe: "The name of the token (e.g. browser-ui, cli, mobile).",
            default: "default",
          }),
      async (args: ArgumentsCamelCase<{ owner: string; name: string }>) => {
        const owner = String(args.owner);
        const name = String(args.name);
        console.log("Generating API key...");
        await setupResources();
        const { apiKey, clientId } = await generateApiKeyWithId(owner, name, [
          { resource: "**", action: "**", effect: "allow" } as Policy,
        ]);
        console.log("");
        console.log(`Created API key "${name}" (owner: ${owner})`);
        console.log("");
        console.log(`MYCELIA_CLIENT_ID=${clientId}`);
        console.log(`MYCELIA_TOKEN=${apiKey}`);
        console.log("");
        console.log(
          "Copy these values to your .env file or enter them in the setup page.",
        );
      },
    )
    .command(
      "token-validate",
      "Validate a token.",
      (y: Argv) =>
        y.option("token", {
          type: "string",
          describe: "Token to validate",
        }),
      async (args: ArgumentsCamelCase<{ token?: string }>) => {
        let token = args.token as string | undefined;
        if (!token) {
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          token = await rl.question("Enter the token: ");
          await rl.close();
        }
        if (!token) {
          console.log("Invalid token");
          exit(1);
        }
        if (token.startsWith("mycelia_")) {
          const doc = await verifyApiKey(token);
          if (!doc) {
            console.log("Invalid token");
            exit(1);
          }
          console.log("Token is valid");
          console.log(`Owner: ${doc.owner}`);
          console.log(`Name: ${doc.name}`);
          console.log(`Policies: ${JSON.stringify(doc.policies)}`);
          console.log(`Created at: ${doc.createdAt}`);
        } else {
          const doc = await verifyToken(token);
          if (!doc) {
            console.log("Invalid token");
            exit(1);
          }
          console.log("Token is valid");
          console.log(JSON.stringify(doc, null, 2));
        }
      },
    )
    .command(
      "migrate-up",
      "Apply all pending migrations",
      () => {},
      async () => {
        try {
          const db = await getRootDB();
          const client = db.client as any;
          const migrated = await up(db, client);
          if (migrated.length === 0) {
            console.log("No pending migrations");
          } else {
            console.log(`Applied ${migrated.length} migration(s)`);
          }
        } catch (err) {
          console.error("Migration failed:", err);
          exit(1);
        }
      },
    )
    .command(
      "migrate-down",
      "Rollback the last migration(s)",
      (y: Argv) =>
        y.option("count", {
          alias: "n",
          type: "number",
          describe: "Number of migrations to rollback",
          default: 1,
        }),
      async (args: ArgumentsCamelCase<{ count?: number }>) => {
        try {
          const db = await getRootDB();
          const client = db.client as any;
          const count = Number(args.count) || 1;
          const rolledBack = await down(db, client, count);
          if (rolledBack.length === 0) {
            console.log("No migrations to rollback");
          } else {
            console.log(`Rolled back ${rolledBack.length} migration(s)`);
          }
        } catch (err) {
          console.error("Rollback failed:", err);
          exit(1);
        }
      },
    )
    .command(
      "migrate-to",
      "Migrate to a specific migration",
      (y: Argv) =>
        y.option("migration", {
          alias: "m",
          type: "string",
          describe: "Migration file name (e.g., 0002_messengers_setup.ts)",
          demandOption: true,
        }),
      async (args: ArgumentsCamelCase<{ migration: string }>) => {
        try {
          const db = await getRootDB();
          const client = db.client as any;
          const migrationFile = String(args.migration);
          const migrated = await to(db, client, migrationFile);
          if (migrated.length === 0) {
            console.log(`Already at migration ${migrationFile}`);
          } else {
            console.log(
              `Migrated ${migrated.length} migration(s) to ${migrationFile}`,
            );
          }
        } catch (err) {
          console.error("Migration failed:", err);
          exit(1);
        }
      },
    )
    .command(
      "migrate-status",
      "Show migration status",
      () => {},
      async () => {
        try {
          const db = await getRootDB();
          const migrationStatus = await status(db);
          console.log("\nMigration Status:");
          console.log(`Total migrations: ${migrationStatus.all.length}`);
          console.log(`Applied: ${migrationStatus.applied.length}`);
          console.log(`Pending: ${migrationStatus.pending.length}`);

          if (migrationStatus.applied.length > 0) {
            console.log("\nApplied migrations:");
            migrationStatus.applied.forEach((file) => {
              console.log(`  ✓ ${file}`);
            });
          }

          if (migrationStatus.pending.length > 0) {
            console.log("\nPending migrations:");
            migrationStatus.pending.forEach((file) => {
              console.log(`  ○ ${file}`);
            });
          }
        } catch (err) {
          console.error("Failed to get migration status:", err);
          exit(1);
        }
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}

async function main() {
  setupLogging();
  await configureCli();
  cleanupLogging();
  exit(0);
}

main();
