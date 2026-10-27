import { expect } from "@std/expect";
import type { IncomingMessage } from "node:http";
import {
  createWebSocketAuthRequest,
  selectWebSocketProtocol,
} from "../websocket.ts";

const jwt = "synthetic.payload.signature";
const protocol = `mycelia, mycelia.jwt.${jwt}`;
function upgrade(
  url = "/ws",
  headers: Record<string, string | string[] | undefined> = {},
  rawHeaders?: string[],
): IncomingMessage {
  return { url, headers, rawHeaders } as IncomingMessage;
}

Deno.test("WebSocket browser credential is normalized without a URL or protocol secret", () => {
  const request = createWebSocketAuthRequest(
    upgrade("/ws?debug=private", { "sec-websocket-protocol": protocol }),
  );
  expect(request?.headers.get("authorization")).toBe(`Bearer ${jwt}`);
  expect(request?.url).toBe("http://websocket.local/ws");
  expect(request?.headers.has("sec-websocket-protocol")).toBe(false);
});

Deno.test("device Bearer headers remain supported with no browser protocol", () => {
  const request = createWebSocketAuthRequest(
    upgrade("/ws_pcm", { authorization: `Bearer ${jwt}` }),
  );
  expect(request?.headers.get("authorization")).toBe(`Bearer ${jwt}`);
});

Deno.test("WebSocket credentials are rejected when missing, malformed, or ambiguous", () => {
  const headers: Record<string, string | string[]>[] = [
    {},
    { authorization: "Basic secret" },
    { authorization: "Bearer malformed" },
    { "sec-websocket-protocol": "mycelia" },
    { "sec-websocket-protocol": `mycelia.jwt.${jwt}` },
    { "sec-websocket-protocol": "mycelia, mycelia.jwt." },
    {
      "sec-websocket-protocol":
        `${protocol}, mycelia.jwt.other.payload.signature`,
    },
    { "sec-websocket-protocol": `${protocol}, mycelia` },
    { "sec-websocket-protocol": protocol, authorization: `Bearer ${jwt}` },
    { "sec-websocket-protocol": [protocol] },
    { authorization: [`Bearer ${jwt}`] },
    { "sec-websocket-protocol": "unknown", authorization: `Bearer ${jwt}` },
  ];
  for (const value of headers) {
    expect(createWebSocketAuthRequest(upgrade("/ws", value))).toBeNull();
  }
  expect(
    createWebSocketAuthRequest(
      upgrade("/ws", { authorization: `Bearer ${jwt}` }, [
        "Authorization",
        `Bearer ${jwt}`,
        "Authorization",
        `Bearer ${jwt}`,
      ]),
    ),
  ).toBeNull();
});

Deno.test("URL credentials always fail closed even alongside valid header or protocol", () => {
  for (
    const query of [
      "token",
      "access_token",
      "Authorization",
      "api-key",
      "client_secret",
      "password",
    ]
  ) {
    for (
      const headers of [{ authorization: `Bearer ${jwt}` }, {
        "sec-websocket-protocol": protocol,
      }]
    ) {
      expect(
        createWebSocketAuthRequest(upgrade(`/ws?${query}=secret`, headers)),
      ).toBeNull();
    }
  }
  expect(
    createWebSocketAuthRequest(
      upgrade("http://user:password@host/ws", {
        authorization: `Bearer ${jwt}`,
      }),
    ),
  ).toBeNull();
});

Deno.test("handshake protocol selection never echoes the credential even when offered first", () => {
  expect(selectWebSocketProtocol(new Set([`mycelia.jwt.${jwt}`, "mycelia"])))
    .toBe("mycelia");
  expect(selectWebSocketProtocol(new Set([`mycelia.jwt.${jwt}`]))).toBe(false);
});
