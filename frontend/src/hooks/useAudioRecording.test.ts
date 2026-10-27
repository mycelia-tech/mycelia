import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { connectAudioRecordingWebSocket } from "./useAudioRecording";

vi.mock(
  "@/lib/api",
  () => ({ apiClient: { baseURL: "https://mycelia.test", getJWT: vi.fn() } }),
);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.mocked(apiClient.getJWT).mockReset().mockResolvedValue("synthetic-token");
  useSettingsStore.setState({
    apiEndpoint: "https://mycelia.test",
    clientId: "client",
    sessionStatus: "authenticated",
    sessionRevision: 1,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("sends an audio JWT only through the credential subprotocol", async () => {
  vi.useFakeTimers();
  const connection = connectAudioRecordingWebSocket();
  await Promise.resolve();
  const socket = FakeWebSocket.instances[0];
  expect(socket.url).toBe("wss://mycelia.test/ws_pcm");
  expect(socket.protocols).toEqual(["mycelia", "mycelia.jwt.synthetic-token"]);
  socket.onopen?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(await connection).toBe(socket);
  socket.close();
});

it("never creates an anonymous audio socket", async () => {
  vi.mocked(apiClient.getJWT).mockResolvedValueOnce(null);
  await expect(connectAudioRecordingWebSocket()).rejects.toThrow(
    "Authentication is required",
  );
  expect(FakeWebSocket.instances).toHaveLength(0);
});

for (const change of ["endpoint", "revision"] as const) {
  it(`rejects a late audio JWT after ${change} changes`, async () => {
    let finish!: (token: string) => void;
    vi.mocked(apiClient.getJWT).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const connection = connectAudioRecordingWebSocket();
    if (change === "endpoint") {
      useSettingsStore.getState().setApiEndpoint("https://other.test");
    } else useSettingsStore.getState().setSessionStatus("anonymous");
    finish("old-token");
    await expect(connection).rejects.toThrow("session change");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
}

it("closes and rejects a pending handshake after logout", async () => {
  const connection = connectAudioRecordingWebSocket();
  await Promise.resolve();
  useSettingsStore.getState().setSessionStatus("anonymous");
  await expect(connection).rejects.toThrow("session change");
  expect(FakeWebSocket.instances[0].closed).toBe(true);
});
