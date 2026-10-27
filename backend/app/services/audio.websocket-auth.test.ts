import { expect } from "@std/expect";
import type { IncomingMessage } from "node:http";
import { handlePcmWebSocket } from "./audio.websocket.server.ts";
import { handleOpusWebSocket } from "./audio.websocket.opus.server.ts";

for (
  const [name, handler] of [["PCM", handlePcmWebSocket], [
    "Opus",
    handleOpusWebSocket,
  ]] as const
) {
  Deno.test(`${name} rejects URL credentials without logging them`, async () => {
    const lines: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      lines.push(values);
    };
    const closes: unknown[][] = [];
    const socket = {
      readyState: 1,
      close: (...args: unknown[]) => {
        closes.push(args);
      },
    };
    try {
      await expect(handler(socket, {
        url: "/ws_pcm?token=synthetic-private-secret",
        headers: { authorization: "Bearer synthetic.payload.signature" },
      } as IncomingMessage)).rejects.toThrow("Unauthorized");
      expect(closes[0]?.[0]).toBe(1008);
      expect(JSON.stringify(lines)).not.toContain("synthetic-private-secret");
      expect(JSON.stringify(lines)).not.toContain(
        "synthetic.payload.signature",
      );
      expect(JSON.stringify(lines)).not.toContain("?token");
    } finally {
      console.log = originalLog;
    }
  });
}
