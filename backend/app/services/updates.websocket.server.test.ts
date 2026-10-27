import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.14";
import { expect } from "@std/expect";
import type { WebSocket } from "npm:ws@^8.18.0";
import { Auth } from "@/lib/auth/core.server.ts";
import { createWebSocketAuthRequest } from "@/lib/auth/websocket.ts";
import {
  authorizeUpdatesChannel,
  publicUpdatesData,
  UpdatesWebSocketSession,
} from "./updates.websocket.server.ts";
import {
  UpdatesPubSubHub,
  type UpdatesRedisSubscriber,
} from "./updates-pubsub.server.ts";

const admin = new Auth({
  principal: "test",
  policies: [{ resource: "**", action: "*", effect: "allow" }],
});

class DeferredRedisSubscriber extends EventEmitter
  implements UpdatesRedisSubscriber {
  status = "wait";
  subscribeCalls: string[][] = [];
  unsubscribeCalls: string[][] = [];
  private resolveConnection: (() => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveConnection = resolve;
    });
  }

  becomeReady(): void {
    this.status = "ready";
    this.emit("ready");
    this.resolveConnection?.();
  }

  subscribe(...channels: string[]): Promise<number> {
    this.subscribeCalls.push(channels);
    return Promise.resolve(this.subscribeCalls.length);
  }

  unsubscribe(...channels: string[]): Promise<number> {
    this.unsubscribeCalls.push(channels);
    return Promise.resolve(this.unsubscribeCalls.length);
  }

  disconnect(): void {
    this.status = "end";
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  terminateCalls = 0;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    callback?.();
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.terminateCalls++;
    this.readyState = 3;
  }
}

const quietLogger = {
  log: (..._args: unknown[]) => undefined,
  warn: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
};

function upgradeRequest(
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    url,
    headers: { host: "localhost:5173", ...headers },
  } as IncomingMessage;
}

Deno.test("updates websocket rejects JWT in the query even with a header", () => {
  const request = createWebSocketAuthRequest(
    upgradeRequest("/ws?token=signed-jwt"),
  );

  expect(request).toBeNull();
});

Deno.test("updates websocket preserves a device Authorization header", () => {
  const request = createWebSocketAuthRequest(
    upgradeRequest("/ws", {
      authorization: "Bearer header.jwt.signature",
    }),
  );

  expect(request?.headers.get("Authorization")).toBe(
    "Bearer header.jwt.signature",
  );
});

Deno.test("updates session queues subscribe until Redis application readiness", async () => {
  const redis = new DeferredRedisSubscriber();
  const hub = new UpdatesPubSubHub(redis, quietLogger);
  const socket = new FakeWebSocket();
  const session = new UpdatesWebSocketSession(
    socket as unknown as WebSocket,
    hub,
    admin,
  );

  const initialization = session.initialize();
  const subscription = session.enqueueMessage(JSON.stringify({
    type: "subscribe",
    channel: "mongo:objects",
  }));
  await Promise.resolve();

  assertEquals(redis.subscribeCalls, []);
  assertEquals(socket.sent, []);

  redis.becomeReady();
  await initialization;
  await subscription;

  assertEquals(redis.subscribeCalls, [["mycelia:mongo:objects"]]);
  assertEquals(socket.sent.map((message) => message.type), [
    "ready",
    "subscribed",
  ]);

  await session.cleanup();
  hub.stop();
});

Deno.test("updates session cleanup is idempotent under concurrent close paths", async () => {
  const redis = new DeferredRedisSubscriber();
  const hub = new UpdatesPubSubHub(redis, quietLogger);
  const socket = new FakeWebSocket();
  const session = new UpdatesWebSocketSession(
    socket as unknown as WebSocket,
    hub,
    admin,
  );

  const initialization = session.initialize();
  redis.becomeReady();
  await initialization;
  await session.enqueueMessage(JSON.stringify({
    type: "subscribe",
    channel: "jobs:*",
  }));

  const firstCleanup = session.cleanup();
  const secondCleanup = session.cleanup();
  assertStrictEquals(firstCleanup, secondCleanup);
  await Promise.all([firstCleanup, secondCleanup]);

  assertEquals(redis.unsubscribeCalls, [["mycelia:jobs:*"]]);
  assertEquals(hub.listenerCount("jobs:*"), 0);
  hub.stop();
});

Deno.test("chat:self maps to a user-scoped Redis channel", async () => {
  const redis = new DeferredRedisSubscriber();
  const hub = new UpdatesPubSubHub(redis, quietLogger);
  const socket = new FakeWebSocket();
  const session = new UpdatesWebSocketSession(
    socket as unknown as WebSocket,
    hub,
    admin,
    "chat:user:abc123",
  );

  const initialization = session.initialize();
  redis.becomeReady();
  await initialization;
  await session.enqueueMessage(JSON.stringify({
    type: "subscribe",
    channel: "chat:self",
  }));

  assertEquals(redis.subscribeCalls, [["mycelia:chat:user:abc123"]]);
  redis.emit(
    "message",
    "mycelia:chat:user:abc123",
    JSON.stringify({ event: "chat.updated", data: { chatId: "one" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const delivered = socket.sent.find((message) => message.type === "event");
  assertEquals(delivered?.channel, "chat:self");

  await session.enqueueMessage(JSON.stringify({
    type: "subscribe",
    channel: "chat:user:someone-else",
  }));
  expect(socket.sent.at(-1)).toMatchObject({
    type: "error",
    message: "Chat channel is scoped",
  });

  await session.cleanup();
  hub.stop();
});

Deno.test("updates channel policies reject private, unknown and filtered streams", async () => {
  const reader = new Auth({
    principal: "reader",
    policies: [{ resource: "db/objects", action: "read", effect: "allow" }],
  });
  expect(await authorizeUpdatesChannel(reader, "mongo:objects")).toBe(true);
  expect(await authorizeUpdatesChannel(reader, "mongo:configs")).toBe(false);
  expect(await authorizeUpdatesChannel(reader, "jobs:*")).toBe(false);
  expect(await authorizeUpdatesChannel(admin, "arbitrary:channel")).toBe(false);
  expect(await authorizeUpdatesChannel(admin, "chat:user:another")).toBe(false);
  const filtered = new Auth({
    principal: "reader",
    policies: [{
      resource: "db/objects",
      action: "read",
      effect: "modify",
      middleware: { code: "filter", arg: { filter: { owner: "reader" } } },
    }],
  });
  expect(await authorizeUpdatesChannel(filtered, "mongo:objects")).toBe(false);
});

Deno.test("Mongo invalidations contain no documents or update values", () => {
  expect(publicUpdatesData("mongo:configs", {
    collection: "configs",
    operationType: "update",
    documentId: "one",
    timestamp: "now",
    changedFields: ["apiKey"],
    document: { apiKey: "fake-secret" },
    updateDescription: { updatedFields: { apiKey: "fake-secret" } },
  })).toEqual({
    collection: "configs",
    operationType: "update",
    documentId: "one",
    timestamp: "now",
    changedFields: ["apiKey"],
  });
  expect(
    publicUpdatesData("objects:*", {
      objectId: "one",
      object: { private: "value" },
    }),
  ).toEqual({ objectId: "one" });
});

Deno.test("unauthorized subscriptions never reach Redis", async () => {
  const redis = new DeferredRedisSubscriber();
  const hub = new UpdatesPubSubHub(redis, quietLogger);
  const socket = new FakeWebSocket();
  const session = new UpdatesWebSocketSession(
    socket as unknown as WebSocket,
    hub,
    new Auth({ principal: "restricted", policies: [] }),
  );
  const initialization = session.initialize();
  redis.becomeReady();
  await initialization;
  await session.enqueueMessage(
    JSON.stringify({ type: "subscribe", channel: "mongo:configs" }),
  );
  expect(redis.subscribeCalls).toEqual([]);
  expect(socket.sent.at(-1)).toMatchObject({
    type: "error",
    message: "Channel access denied",
  });
  await session.cleanup();
  hub.stop();
});

Deno.test("events revalidate the token and never deliver after revocation", async () => {
  const redis = new DeferredRedisSubscriber();
  const hub = new UpdatesPubSubHub(redis, quietLogger);
  const socket = new FakeWebSocket();
  let valid = true;
  const session = new UpdatesWebSocketSession(
    socket as unknown as WebSocket,
    hub,
    admin,
    undefined,
    async () => valid ? admin : null,
  );
  const initialization = session.initialize();
  redis.becomeReady();
  await initialization;
  await session.enqueueMessage(
    JSON.stringify({ type: "subscribe", channel: "mongo:objects" }),
  );
  redis.emit(
    "message",
    "mycelia:mongo:objects",
    JSON.stringify({
      event: "mongo.change",
      data: {
        collection: "objects",
        documentId: "one",
        document: { secret: "fake" },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(socket.sent.at(-1)).toMatchObject({
    type: "event",
    data: { collection: "objects", documentId: "one" },
  });
  expect((socket.sent.at(-1)?.data as any).document).toBeUndefined();
  valid = false;
  const count = socket.sent.length;
  redis.emit(
    "message",
    "mycelia:mongo:objects",
    JSON.stringify({
      event: "mongo.change",
      data: { collection: "objects", documentId: "two" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(socket.sent.length).toBe(count);
  expect(socket.readyState).toBe(3);
  await session.cleanup();
  hub.stop();
});
