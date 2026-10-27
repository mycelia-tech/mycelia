import type { IncomingMessage } from "node:http";

export const WEBSOCKET_PROTOCOL = "mycelia";
const CREDENTIAL_PROTOCOL_PREFIX = "mycelia.jwt.";
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const URL_CREDENTIAL_NAMES = new Set([
  "token",
  "jwt",
  "accesstoken",
  "authorization",
  "apikey",
  "clientsecret",
  "password",
]);

/** Only the public protocol may be echoed in the handshake response. */
export function selectWebSocketProtocol(
  protocols: Set<string>,
): string | false {
  return protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false;
}

/**
 * Normalize the browser protocol credential or device Bearer header into the
 * ordinary authenticator. Reject ambiguity; never retain URL query values or
 * the credential-bearing protocol header in the normalized request.
 */
export function createWebSocketAuthRequest(
  upgrade: IncomingMessage,
): Request | null {
  try {
    const url = new URL(upgrade.url || "/", "http://websocket.local");
    if (
      url.origin !== "http://websocket.local" || url.username || url.password
    ) return null;
    for (const name of url.searchParams.keys()) {
      if (URL_CREDENTIAL_NAMES.has(name.toLowerCase().replace(/[-_]/g, ""))) {
        return null;
      }
    }
    url.search = "";
    url.hash = "";

    for (const name of ["authorization", "sec-websocket-protocol"]) {
      const count = (upgrade.rawHeaders ?? []).filter((value, index) =>
        index % 2 === 0 && value.toLowerCase() === name
      ).length;
      if (count > 1 || Array.isArray(upgrade.headers[name])) {
        return null;
      }
    }
    const authorization = upgrade.headers.authorization;
    const protocolHeader = upgrade.headers["sec-websocket-protocol"];
    const protocols = protocolHeader === undefined
      ? []
      : protocolHeader.split(",").map((value) => value.trim());
    if (
      new Set(protocols).size !== protocols.length ||
      protocols.some((value) => !value)
    ) return null;
    const credentials = protocols.filter((value) =>
      value.startsWith(CREDENTIAL_PROTOCOL_PREFIX)
    );
    if (
      protocols.some((value) =>
        value !== WEBSOCKET_PROTOCOL &&
        !value.startsWith(CREDENTIAL_PROTOCOL_PREFIX)
      )
    ) return null;
    if (
      credentials.length > 1 ||
      credentials.length &&
        (!protocols.includes(WEBSOCKET_PROTOCOL) || authorization !== undefined)
    ) return null;

    const token = credentials.length === 1
      ? credentials[0].slice(CREDENTIAL_PROTOCOL_PREFIX.length)
      : typeof authorization === "string"
      ? /^Bearer ([^\s,]+)$/i.exec(authorization)?.[1]
      : undefined;
    if (!token || token.length > 8192 || !JWT_PATTERN.test(token)) return null;
    return new Request(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // Invalid URLs/headers must fail closed without logging credential values.
    return null;
  }
}
