import type { IncomingMessage } from "node:http";
import type { WebSocket } from "npm:ws@^8.18.0";
import { type Auth, authenticate } from "@/lib/auth/core.server.ts";
import {
  defaultResourceManager,
  type ResourceAction,
  type ResourceManager,
} from "@/lib/auth/resources.ts";
import { getQueue } from "@/lib/jobs/queue.ts";
import { jobRegistry } from "@/lib/jobs/job-registry.ts";
import {
  closeWebSocket,
  isExpectedWebSocketDisconnect,
  sendWebSocket,
  terminateWebSocket,
} from "@/lib/websocket-transport.ts";
import {
  type UpdatesPubSubEvent,
  UpdatesPubSubHub,
  updatesPubSubHub,
} from "@/services/updates-pubsub.server.ts";
import { chatUserChannel } from "@/lib/chat/events.server.ts";
import { createWebSocketAuthRequest } from "@/lib/auth/websocket.ts";

interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "ping";
  channel?: string;
}

interface ServerMessage {
  type:
    | "ready"
    | "subscribed"
    | "unsubscribed"
    | "event"
    | "resync_required"
    | "pong"
    | "error";
  channel?: string;
  event?: string;
  data?: unknown;
  message?: string;
  reason?: string;
}

type SessionState = "new" | "open" | "closing" | "closed";

export async function authorizeUpdatesChannel(
  auth: Auth,
  channel: string,
  manager: ResourceManager = defaultResourceManager,
): Promise<boolean> {
  let actions: ResourceAction[];
  const mongo = /^mongo:([a-zA-Z0-9_.-]+)(?::[a-zA-Z0-9_.-]+)?$/.exec(channel);
  if (mongo) actions = [{ path: ["db", mongo[1]], actions: ["read"] }];
  else if (/^jobs:(\*|[a-zA-Z0-9_.-]+)(:logs)?$/.test(channel)) {
    actions = [{ path: ["jobs"], actions: ["read"] }];
    if (channel.endsWith(":logs")) {
      actions.push({ path: ["db", "job_logs"], actions: ["read"] });
    }
  } else if (channel === "objects:*") {
    actions = [{ path: ["objects"], actions: ["read"] }];
  } else if (channel === "timeline:*") {
    actions = [{ path: ["timeline"], actions: ["read"] }];
  } else if (channel === "chat:self") {
    actions = [{ path: ["chat", "read"], actions: ["read"] }];
  } else return false;
  try {
    // A row-filter modifier cannot safely authorize an unfiltered event stream.
    await manager.ensureAllowed(auth, ...actions);
    return true;
  } catch (error) {
    if (error instanceof Response && error.status === 403) return false;
    throw error;
  }
}

export function publicUpdatesData(channel: string, data: unknown): unknown {
  if (!channel.startsWith("mongo:") && channel !== "objects:*") return data;
  if (!data || typeof data !== "object") return {};
  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys = channel.startsWith("mongo:")
    ? ["collection", "operationType", "documentId", "timestamp"]
    : ["objectId", "timestamp"];
  for (const key of keys) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  if (Array.isArray(source.changedFields)) {
    result.changedFields = source.changedFields.filter((field) =>
      typeof field === "string"
    );
  }
  return result;
}

export class UpdatesWebSocketSession {
  private readonly subscriptions = new Set<string>();
  private readonly subscriptionAliases = new Map<string, string>();
  private state: SessionState = "new";
  private initialization: Promise<void> | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private cleanupPromise: Promise<void> | null = null;
  private removeResyncListener: (() => void) | null = null;
  private resolveClosed: () => void = () => undefined;
  readonly closed: Promise<void>;

  private readonly handlePubSubEvent = async (event: UpdatesPubSubEvent) => {
    if (this.state !== "open") return;

    try {
      const payload = JSON.parse(event.message);
      const clientChannel = [...this.subscriptionAliases.entries()].find(
        ([, serverChannel]) => serverChannel === event.channel,
      )?.[0] ?? event.channel;
      if (
        !await this.refreshAuthorization() || this.state !== "open" ||
        !this.subscriptions.has(clientChannel) ||
        !await authorizeUpdatesChannel(this.auth, clientChannel)
      ) return;
      this.sendMessage({
        type: "event",
        channel: clientChannel,
        event: payload.event,
        data: publicUpdatesData(clientChannel, payload.data),
      });
    } catch (error) {
      console.error(
        `[WS] Invalid Redis payload for ${event.channel}:`,
        error,
      );
    }
  };

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: UpdatesPubSubHub,
    private auth: Auth,
    private readonly scopedChatChannel?: string,
    private readonly refreshAuth?: () => Promise<Auth | null>,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  private async refreshAuthorization(): Promise<boolean> {
    if (!this.refreshAuth) return true;
    const auth = await this.refreshAuth();
    if (auth && auth.principal === this.auth.principal) {
      this.auth = auth;
      return true;
    }
    closeWebSocket(this.ws, 1008, "Unauthorized", "/ws");
    void this.cleanup();
    return false;
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeInternal();
    return this.initialization;
  }

  private async initializeInternal(): Promise<void> {
    await this.hub.start();
    if (this.state !== "new") return;

    this.removeResyncListener = this.hub.onResync(({ reason }) => {
      if (this.state !== "open") return;
      this.sendMessage({ type: "resync_required", reason });
    });
    this.state = "open";
    this.sendMessage({ type: "ready" });
  }

  /** Serializes all protocol commands from this browser session. */
  enqueueMessage(rawMessage: string): Promise<void> {
    const operation = this.commandTail.then(async () => {
      await this.initialize();
      if (this.state !== "open") return;
      if (!await this.refreshAuthorization()) return;
      await this.handleMessage(rawMessage);
    });

    this.commandTail = operation.catch((error) => {
      void this.fail(error);
    });
    return this.commandTail;
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      this.sendMessage({ type: "error", message: "Invalid message format" });
      return;
    }

    switch (message.type) {
      case "subscribe":
        if (!message.channel) {
          this.sendMessage({ type: "error", message: "Channel is required" });
          return;
        }
        if (!isValidChannel(message.channel)) {
          this.sendMessage({ type: "error", message: "Invalid channel name" });
          return;
        }
        if (
          message.channel.startsWith("chat:") &&
          message.channel !== "chat:self"
        ) {
          this.sendMessage({
            type: "error",
            message: "Chat channel is scoped",
          });
          return;
        }
        if (message.channel === "chat:self" && !this.scopedChatChannel) {
          this.sendMessage({
            type: "error",
            message: "Chat channel is unavailable",
          });
          return;
        }
        if (!await authorizeUpdatesChannel(this.auth, message.channel)) {
          this.sendMessage({ type: "error", message: "Channel access denied" });
          return;
        }
        await this.subscribe(message.channel);
        return;

      case "unsubscribe":
        if (!message.channel) return;
        if (!isValidChannel(message.channel)) {
          this.sendMessage({ type: "error", message: "Invalid channel name" });
          return;
        }
        await this.unsubscribe(message.channel);
        return;

      case "ping":
        this.sendMessage({ type: "pong" });
        return;

      default:
        this.sendMessage({
          type: "error",
          message: `Unknown message type: ${
            (message as { type?: unknown }).type
          }`,
        });
    }
  }

  private async subscribe(channel: string): Promise<void> {
    if (this.subscriptions.has(channel)) {
      this.sendMessage({ type: "subscribed", channel });
      return;
    }

    const serverChannel = channel === "chat:self"
      ? this.scopedChatChannel!
      : channel;
    await this.hub.subscribe(serverChannel, this.handlePubSubEvent);
    this.subscriptions.add(channel);
    this.subscriptionAliases.set(channel, serverChannel);
    this.sendMessage({ type: "subscribed", channel });
    console.log(`[WS] Subscribed to channel: ${channel}`);

    if (channel.startsWith("jobs:") && channel !== "jobs:*") {
      await this.sendCurrentJobState(channel.slice("jobs:".length));
    }
  }

  private async unsubscribe(channel: string): Promise<void> {
    if (!this.subscriptions.has(channel)) return;

    const serverChannel = this.subscriptionAliases.get(channel) ?? channel;
    await this.hub.unsubscribe(serverChannel, this.handlePubSubEvent);
    this.subscriptions.delete(channel);
    this.subscriptionAliases.delete(channel);
    this.sendMessage({ type: "unsubscribed", channel });
    console.log(`[WS] Unsubscribed from channel: ${channel}`);
  }

  private async sendCurrentJobState(jobId: string): Promise<void> {
    try {
      for (const jobType of jobRegistry.getJobTypes()) {
        const queue = getQueue(jobType);
        const job = await queue.getJob(jobId);
        if (!job) continue;

        const state = await job.getState();
        this.sendMessage({
          type: "event",
          channel: `jobs:${jobId}`,
          event: `job.${state}`,
          data: {
            jobId: job.id,
            jobType,
            state,
            progress: job.progress,
            result: job.returnvalue,
            failedReason: job.failedReason,
          },
        });
        return;
      }
    } catch (error) {
      console.error(
        `[WS] Failed to fetch current state for job ${jobId}:`,
        error,
      );
    }
  }

  private sendMessage(message: ServerMessage): boolean {
    return sendWebSocket(this.ws, JSON.stringify(message), "/ws");
  }

  private async fail(error: unknown): Promise<void> {
    if (this.state === "closing" || this.state === "closed") return;
    if (!isExpectedWebSocketDisconnect(error)) {
      console.error("[WS] Updates session command failed:", error);
    }
    terminateWebSocket(this.ws, "/ws");
    await this.cleanup();
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupInternal();
    return this.cleanupPromise;
  }

  private async cleanupInternal(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";

    try {
      // Let an already-running subscribe/unsubscribe settle before taking the
      // final subscription snapshot. Failures are handled by enqueueMessage().
      await this.commandTail;

      this.removeResyncListener?.();
      this.removeResyncListener = null;

      const subscriptions = [...this.subscriptions];
      this.subscriptions.clear();
      const results = await Promise.allSettled(
        subscriptions.map((channel) =>
          this.hub.unsubscribe(
            this.subscriptionAliases.get(channel) ?? channel,
            this.handlePubSubEvent,
          )
        ),
      );
      this.subscriptionAliases.clear();
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "[WS] Failed to release updates subscription:",
            result.reason,
          );
        }
      }
    } finally {
      this.state = "closed";
      this.resolveClosed();
    }
  }
}

function isValidChannel(channel: string): boolean {
  return /^[a-zA-Z0-9._:*-]+$/.test(channel);
}

export async function handleUpdatesWebSocket(
  ws: WebSocket,
  request: IncomingMessage,
): Promise<void> {
  console.log("[WS] /ws connection attempt");

  const req = createWebSocketAuthRequest(request);
  const auth = req ? await authenticate(req) : null;
  if (!auth) {
    console.log("[WS] /ws authentication failed");
    closeWebSocket(ws, 1008, "Unauthorized", "/ws");
    return;
  }
  if (ws.readyState !== 1) return;

  const session = new UpdatesWebSocketSession(
    ws,
    updatesPubSubHub,
    auth,
    await chatUserChannel(auth.principal),
    () => req ? authenticate(req) : Promise.resolve(null),
  );

  const removeListeners = () => {
    ws.off("message", onMessage);
    ws.off("close", onClose);
    ws.off("error", onError);
  };
  const onMessage = (data: unknown) => {
    const rawMessage = data instanceof Uint8Array
      ? new TextDecoder().decode(data)
      : String(data);
    void session.enqueueMessage(rawMessage);
  };
  const onClose = () => {
    void session.cleanup();
  };
  const onError = (error: Error) => {
    if (!isExpectedWebSocketDisconnect(error)) {
      console.error("[WS] /ws socket error:", error);
    }
    void session.cleanup();
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);
  ws.on("error", onError);

  try {
    await session.initialize();
    if (!session.isOpen) {
      await session.cleanup();
      return;
    }
    console.log("[WS] /ws application session ready");
    await session.closed;
  } catch (error) {
    console.error("[WS] /ws failed to initialize:", error);
    terminateWebSocket(ws, "/ws");
    await session.cleanup();
  } finally {
    removeListeners();
  }
}
