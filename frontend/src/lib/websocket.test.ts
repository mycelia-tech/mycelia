// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  apiClient: {
    baseURL: "http://localhost:5173",
    getJWT: vi.fn().mockResolvedValue("test-token"),
  },
}));

import { WebSocketClient } from "./websocket";
import { apiClient } from "./api";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string[]) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("WebSocket application readiness", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.mocked(apiClient.getJWT).mockReset().mockResolvedValue("test-token");
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never opens an anonymous socket and allows retry after sign-in", async () => {
    const client = new WebSocketClient();
    vi.mocked(apiClient.getJWT).mockResolvedValueOnce(null);
    await expect(client.connect()).rejects.toThrow(
      "Authentication is required",
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
    const connection = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(new URL(socket.url).search).toBe("");
    expect(socket.url).not.toContain("test-token");
    expect(socket.protocols).toEqual(["mycelia", "mycelia.jwt.test-token"]);
    socket.open();
    socket.receive({ type: "ready" });
    await connection;
    client.disconnect();
  });

  it("ignores a token arriving after logout without blocking a new session", async () => {
    const client = new WebSocketClient();
    let finish!: (token: string | null) => void;
    vi.mocked(apiClient.getJWT).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const previous = client.connect().catch((error) => error);
    client.disconnect();
    const next = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    finish("stale-token");
    expect(await previous).toBeInstanceOf(Error);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready" });
    await next;
    client.disconnect();
  });

  it("cancels a pending handshake and restores preserved subscriptions after reauth", async () => {
    const client = new WebSocketClient();
    client.subscribe("jobs:*", vi.fn());
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const pending = client.connect().catch((error) => error);
    client.disconnect({ preserveSubscriptions: true });
    expect(await pending).toBeInstanceOf(Error);
    const next = client.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const socket = FakeWebSocket.instances[1];
    socket.open();
    socket.receive({ type: "ready" });
    await next;
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "subscribe",
      channel: "jobs:*",
    });
    client.disconnect();
  });

  it("sends subscriptions only after the server ready message", async () => {
    const client = new WebSocketClient();
    const callback = vi.fn();
    client.subscribe("jobs:*", callback);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(client.isConnected).toBe(false);
    expect(socket.sent).toEqual([]);

    socket.receive({ type: "ready" });

    expect(client.isConnected).toBe(true);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "subscribe", channel: "jobs:*" },
    ]);
    client.disconnect();
  });

  it("notifies global and channel listeners after a delivery gap", async () => {
    const client = new WebSocketClient();
    const eventListener = vi.fn();
    const resyncListener = vi.fn();
    client.onResync(resyncListener);
    client.subscribe("mongo:objects", eventListener);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready" });
    socket.receive({
      type: "resync_required",
      reason: "redis_reconnected",
    });

    expect(resyncListener).toHaveBeenCalledWith("redis_reconnected");
    expect(eventListener).toHaveBeenCalledWith({
      channel: "mongo:objects",
      event: "resync_required",
      data: { reason: "redis_reconnected" },
    });
    client.disconnect();
  });

  it("resyncs canonical state only after a connection epoch is subscribed", async () => {
    const client = new WebSocketClient();
    const resyncListener = vi.fn();
    client.onResync(resyncListener);
    client.subscribe("jobs:*", vi.fn());

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready" });
    expect(resyncListener).not.toHaveBeenCalled();

    socket.receive({ type: "subscribed", channel: "jobs:*" });
    expect(resyncListener).toHaveBeenCalledWith("subscriptions_ready");
    client.disconnect();
  });

  it("resyncs after a channel is added to an already ready connection", async () => {
    const client = new WebSocketClient();
    const resyncListener = vi.fn();
    client.onResync(resyncListener);
    client.subscribe("jobs:*", vi.fn());

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "ready" });
    socket.receive({ type: "subscribed", channel: "jobs:*" });
    resyncListener.mockClear();

    client.subscribe("mongo:objects", vi.fn());
    expect(resyncListener).not.toHaveBeenCalled();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "subscribe",
      channel: "mongo:objects",
    });

    socket.receive({ type: "subscribed", channel: "mongo:objects" });
    expect(resyncListener).toHaveBeenCalledWith("subscriptions_ready");
    client.disconnect();
  });
});
