import { apiClient } from "@/lib/api";

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
  data?: any;
  message?: string;
  reason?: string;
}

type EventCallback = (event: any) => void;
type ResyncCallback = (reason?: string) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, Set<EventCallback>> = new Map();
  private resyncCallbacks = new Set<ResyncCallback>();
  private pendingEpochSubscriptions = new Set<string>();
  private awaitingEpochResync = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isConnecting = false;
  private isIntentionalClose = false;
  private isApplicationReady = false;
  private connectionPromise: Promise<void> | null = null;
  private connectionEpoch = 0;
  private cancelConnection: (() => void) | null = null;

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.isApplicationReady) {
      return;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.isIntentionalClose = false;
    const epoch = ++this.connectionEpoch;
    const connection = this._connect(epoch);
    this.connectionPromise = connection;

    try {
      await connection;
    } catch (error) {
      if (
        epoch === this.connectionEpoch && !this.isIntentionalClose &&
        this.subscriptions.size > 0
      ) {
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      if (this.connectionPromise === connection) {
        this.isConnecting = false;
        this.connectionPromise = null;
      }
    }
  }

  private async _connect(epoch: number): Promise<void> {
    const endpoint = apiClient.baseURL;
    const jwt = await apiClient.getJWT();
    if (
      epoch !== this.connectionEpoch || this.isIntentionalClose ||
      endpoint !== apiClient.baseURL
    ) {
      throw new Error("WebSocket connection was cancelled");
    }
    if (!jwt) {
      throw new Error("Authentication is required for WebSocket updates");
    }
    const wsUrl = new URL(endpoint + "/ws");
    wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settleReady = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        this.cancelConnection = null;
        resolve();
      };
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        this.cancelConnection = null;
        reject(error);
      };
      this.cancelConnection = () =>
        settleError(new Error("WebSocket connection was cancelled"));

      try {
        const socket = new WebSocket(wsUrl.toString(), [
          "mycelia",
          `mycelia.jwt.${jwt}`,
        ]);
        this.ws = socket;
        this.isApplicationReady = false;

        socket.onopen = () => {
          if (this.ws !== socket) return;
          console.log(
            "WebSocket transport connected; awaiting server readiness",
          );
        };

        socket.onmessage = (event) => {
          if (this.ws !== socket) return;
          try {
            const message: ServerMessage = JSON.parse(event.data);
            if (message.type === "ready") {
              this.handleReady();
              settleReady();
              return;
            }
            this.handleMessage(message);
          } catch (error) {
            console.error("Failed to parse WebSocket message:", error);
          }
        };

        socket.onerror = (error) => {
          if (this.ws !== socket) return;
          console.error("WebSocket error:", error);
        };

        socket.onclose = () => {
          if (this.ws !== socket) return;
          console.log("WebSocket closed");
          this.ws = null;
          this.isApplicationReady = false;
          this.pendingEpochSubscriptions.clear();
          this.awaitingEpochResync = false;
          settleError(
            new Error("WebSocket closed before application readiness"),
          );

          if (!this.isIntentionalClose) {
            this.scheduleReconnect();
          }
        };

        timeout = setTimeout(() => {
          if (this.ws === socket && !this.isApplicationReady) {
            settleError(new Error("WebSocket application readiness timeout"));
            socket.close();
          }
        }, 10000);
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleReady(): void {
    if (this.isApplicationReady) return;
    this.isApplicationReady = true;
    this.reconnectAttempts = 0;
    console.log("WebSocket application session ready");

    this.pendingEpochSubscriptions.clear();
    this.awaitingEpochResync = this.subscriptions.size > 0;
    for (const channel of this.subscriptions.keys()) {
      this.pendingEpochSubscriptions.add(channel);
      this.sendMessage({ type: "subscribe", channel });
    }
  }

  disconnect(options: { preserveSubscriptions?: boolean } = {}): void {
    this.connectionEpoch++;
    this.isIntentionalClose = true;
    this.cancelConnection?.();
    this.cancelConnection = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.isApplicationReady = false;
    this.pendingEpochSubscriptions.clear();
    this.awaitingEpochResync = false;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (!options.preserveSubscriptions) this.subscriptions.clear();
  }

  subscribe(channel: string, callback: EventCallback): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());

      if (this.isApplicationReady) {
        this.awaitingEpochResync = true;
        this.pendingEpochSubscriptions.add(channel);
        this.sendMessage({ type: "subscribe", channel });
      }
    }

    this.subscriptions.get(channel)!.add(callback);

    if (
      this.ws?.readyState !== WebSocket.OPEN &&
      !this.isIntentionalClose &&
      !this.isConnecting
    ) {
      this.connect().catch((error) => {
        console.error("Failed to connect WebSocket:", error);
      });
    }

    return () => {
      this.unsubscribe(channel, callback);
    };
  }

  unsubscribe(channel: string, callback: EventCallback): void {
    const callbacks = this.subscriptions.get(channel);
    if (!callbacks) return;

    callbacks.delete(callback);

    if (callbacks.size === 0) {
      this.subscriptions.delete(channel);

      if (this.isApplicationReady) {
        this.pendingEpochSubscriptions.delete(channel);
        this.sendMessage({ type: "unsubscribe", channel });
        this.completeSubscriptionEpochIfReady();
      }
    }
  }

  onResync(callback: ResyncCallback): () => void {
    this.resyncCallbacks.add(callback);
    return () => this.resyncCallbacks.delete(callback);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "event":
        if (message.channel) {
          const callbacks = this.subscriptions.get(message.channel);
          if (callbacks) {
            for (const callback of callbacks) {
              try {
                callback({
                  channel: message.channel,
                  event: message.event,
                  data: message.data,
                });
              } catch (error) {
                console.error("Error in WebSocket event callback:", error);
              }
            }
          }
        }
        break;

      case "subscribed":
        console.log(`Subscribed to channel: ${message.channel}`);
        if (message.channel) {
          this.pendingEpochSubscriptions.delete(message.channel);
          this.completeSubscriptionEpochIfReady();
        }
        break;

      case "unsubscribed":
        console.log(`Unsubscribed from channel: ${message.channel}`);
        break;

      case "resync_required":
        this.notifyResync(message.reason ?? "unknown");
        break;

      case "error":
        console.error(`WebSocket error: ${message.message}`);
        break;

      case "pong":
        break;
    }
  }

  private completeSubscriptionEpochIfReady(): void {
    if (!this.awaitingEpochResync || this.pendingEpochSubscriptions.size > 0) {
      return;
    }
    this.awaitingEpochResync = false;
    this.notifyResync("subscriptions_ready");
  }

  private notifyResync(reason: string): void {
    console.warn(
      `WebSocket delivery gap boundary reached (${reason}); ` +
        "subscribers must refresh canonical state",
    );
    for (const callback of this.resyncCallbacks) {
      try {
        callback(reason);
      } catch (error) {
        console.error("Error in WebSocket global resync callback:", error);
      }
    }
    for (const [channel, callbacks] of this.subscriptions) {
      for (const callback of callbacks) {
        try {
          callback({
            channel,
            event: "resync_required",
            data: { reason },
          });
        } catch (error) {
          console.error("Error in WebSocket resync callback:", error);
        }
      }
    }
  }

  private sendMessage(message: any): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.isApplicationReady) {
      const messageStr = JSON.stringify(message);
      console.log(`WebSocket sending: ${messageStr}`);
      this.ws.send(messageStr);
    } else {
      console.warn(
        `WebSocket not open, cannot send:`,
        message,
        `readyState: ${this.ws?.readyState}`,
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached");
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        console.error("Reconnect failed:", error);
      });
    }, delay) as unknown as number;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.isApplicationReady;
  }
}

export const wsClient = new WebSocketClient();
