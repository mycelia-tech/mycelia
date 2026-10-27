import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "#/env.ts";
import {
  type CredentialBinding,
  credentialFingerprint,
  readCredential,
} from "./credentials.ts";
import { signJWT, verifyApiKey } from "./tokens.ts";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESS_TTL_SECONDS = 15 * 60;
const COOKIE_NAME = "__Host-mycelia-session";
const DEV_COOKIE_NAME = "mycelia-dev-session";

export interface BrowserSession {
  _id: string;
  credential: CredentialBinding;
  createdAt: Date;
  expiresAt: Date;
}

export interface BrowserSessionStore {
  create(session: BrowserSession): Promise<void>;
  read(id: string): Promise<BrowserSession | null>;
  remove(id: string): Promise<void>;
}

const mongoStore: BrowserSessionStore = {
  async create(session) {
    const { getRootDB } = await import("../mongo/core.server.ts");
    const collection = (await getRootDB()).collection<BrowserSession>(
      "browser_sessions",
    );
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.insertOne(session);
  },
  async read(id) {
    const { getRootDB } = await import("../mongo/core.server.ts");
    return await (await getRootDB()).collection<BrowserSession>(
      "browser_sessions",
    )
      .findOne({ _id: id }, { maxTimeMS: 5_000 });
  },
  async remove(id) {
    const { getRootDB } = await import("../mongo/core.server.ts");
    await (await getRootDB()).collection<BrowserSession>("browser_sessions")
      .deleteOne({ _id: id });
  },
};

function sessionHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cookieValue(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(";").map((item: string) => item.trim())
    .find((item: string) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Custom header blocks form CSRF; Origin is validated before any cookie use. */
export function browserSessionRequestAllowed(req: Request): boolean {
  if (req.headers["x-mycelia-session"] !== "1") return false;
  const origin = req.headers.origin;
  let configured: URL;
  try {
    configured = new URL(env.MYCELIA_FRONTEND_HOST);
  } catch {
    return false;
  }
  const secure = req.secure === true;
  const authority = req.headers.host;
  const sameOrigin = authority
    ? `${secure ? "https" : "http"}://${authority}`
    : "";
  if (origin && origin !== configured.origin && origin !== sameOrigin) {
    return false;
  }
  if (!origin && req.headers["sec-fetch-site"] === "cross-site") return false;
  if (secure) return true;
  // Plain HTTP is explicitly limited to local development. Proxy trust is
  // configured by the server, never inferred from an arbitrary forwarded header.
  if (Deno.env.get("APP_MODE") !== "dev") return false;
  try {
    const hostname = new URL(origin || sameOrigin).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function setSessionCookie(
  req: Request,
  res: Response,
  value: string,
  age = SESSION_TTL_MS / 1000,
) {
  const secure = req.secure === true;
  res.setHeader(
    "Set-Cookie",
    [
      `${secure ? COOKIE_NAME : DEV_COOKIE_NAME}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${age}`,
      ...(secure ? ["Secure"] : []),
    ].join("; "),
  );
}

export function createBrowserSessionHandler(dependencies: {
  store?: BrowserSessionStore;
  verify?: typeof verifyApiKey;
  read?: typeof readCredential;
  sign?: typeof signJWT;
  now?: () => number;
} = {}) {
  const store = dependencies.store ?? mongoStore;
  const verify = dependencies.verify ?? verifyApiKey;
  const read = dependencies.read ?? readCredential;
  const sign = dependencies.sign ?? signJWT;
  const now = dependencies.now ?? Date.now;
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (!browserSessionRequestAllowed(req)) {
      res.status(403).json({ error: "session_origin_or_transport_denied" });
      return;
    }
    const raw = cookieValue(req, req.secure ? COOKIE_NAME : DEV_COOKIE_NAME);
    const existingId = raw && /^[\w-]{43}$/.test(raw)
      ? sessionHash(raw)
      : undefined;
    if (req.method === "DELETE") {
      if (existingId) await store.remove(existingId);
      setSessionCookie(req, res, "", 0);
      res.json({ signedOut: true });
      return;
    }

    let session: BrowserSession | null = null;
    if (req.method === "POST") {
      if (
        typeof req.body?.client_id !== "string" ||
        typeof req.body?.client_secret !== "string"
      ) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const credential = await verify(req.body.client_secret);
      if (!credential || credential._id?.toString() !== req.body.client_id) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      const id = randomBytes(32).toString("base64url");
      session = {
        _id: sessionHash(id),
        credential: {
          id: req.body.client_id,
          fingerprint: credentialFingerprint(credential),
        },
        createdAt: new Date(now()),
        expiresAt: new Date(now() + SESSION_TTL_MS),
      };
      await store.create(session);
      if (existingId) await store.remove(existingId);
      setSessionCookie(req, res, id);
    } else if (existingId) {
      session = await store.read(existingId);
    }
    const credential = session && session.expiresAt.getTime() > now()
      ? await read(session.credential.id)
      : null;
    if (
      !session || !credential?.isActive ||
      credentialFingerprint(credential) !== session.credential.fingerprint
    ) {
      if (existingId) await store.remove(existingId);
      setSessionCookie(req, res, "", 0);
      res.status(401).json({ error: "session_expired" });
      return;
    }
    const token = await sign(
      session.credential.id,
      credential.owner,
      credential.policies,
      `${ACCESS_TTL_SECONDS}s`,
      [session.credential],
      session._id,
    );
    res.json({
      access_token: token,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SECONDS,
      client_id: session.credential.id,
      expires_at: session.expiresAt.toISOString(),
    });
  };
}

export const browserSessionHandler = createBrowserSessionHandler();
