import { expect } from "@std/expect";
import { ObjectId } from "bson";
import { createSecretKey } from "node:crypto";
import { SignJWT } from "jose";
import {
  Auth,
  getServerAuth,
  getSystemAuth,
  verifyToken,
} from "../core.server.ts";
import {
  credentialFingerprint,
  validateCredentialBindings,
} from "../credentials.ts";
import { signJWT } from "../tokens.ts";
import { extractClientCredentials } from "../oauth.ts";
import {
  type BrowserSession,
  browserSessionRequestAllowed,
  createBrowserSessionHandler,
} from "../browser-session.ts";
import { createSetupHandler } from "@/routes/setup.ts";
import {
  createMockExpressRequest,
  createMockExpressResponse,
} from "@/tests/express-helpers.ts";

const credentialId = "123456789012345678901234";
const secret = "test-auth-lifecycle-secret-01234567890123456789";
const policies = [{
  resource: "objects",
  action: "read",
  effect: "allow",
}] as const;
const credential = () => ({
  _id: new ObjectId(credentialId),
  owner: "owner",
  policies: [...policies],
  isActive: true,
  hashedKey: "unused",
  salt: "unused",
  name: "Browser",
  openPrefix: "unused",
  createdAt: new Date(),
});

async function withSecret(fn: () => Promise<void>) {
  const previous = Deno.env.get("SECRET_KEY");
  Deno.env.set("SECRET_KEY", secret);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("SECRET_KEY");
    else Deno.env.set("SECRET_KEY", previous);
  }
}

Deno.test("credential tokens preserve key identity and reject revoked/downgraded keys", () =>
  withSecret(async () => {
    let current = credential();
    const binding = {
      id: credentialId,
      fingerprint: credentialFingerprint(current),
    };
    const token = await signJWT(
      credentialId,
      current.owner,
      current.policies,
      "15m",
      [binding],
    );
    const readCredential = async () => current;
    const auth = await verifyToken(token, { readCredential });
    expect(auth?.principal).toBe("owner");
    expect(auth?.credentialBindings).toEqual([binding]);
    current = { ...current, policies: [] };
    expect(await verifyToken(token, { readCredential })).toBeNull();
    current = { ...credential(), isActive: false };
    expect(await verifyToken(token, { readCredential })).toBeNull();
    expect(
      await verifyToken(token, {
        readCredential: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  }));

Deno.test("legacy unbound JWTs require a fresh credential exchange", () =>
  withSecret(async () => {
    const token = await new SignJWT({
      owner: "owner",
      principal: "owner",
      policies,
    })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h")
      .sign(createSecretKey(new TextEncoder().encode(secret)));
    expect(await verifyToken(token)).toBeNull();
  }));

Deno.test("invalid worker JWT fails closed, explicit server auth remains available", () =>
  withSecret(async () => {
    const previous = Deno.env.get("MYCELIA_JWT");
    try {
      Deno.env.set("MYCELIA_JWT", "invalid");
      await expect(getServerAuth()).rejects.toBeInstanceOf(Response);
      expect(getSystemAuth().principal).toBe("server");
      Deno.env.set(
        "MYCELIA_JWT",
        await signJWT("worker", "job:1", [...policies], "15m"),
      );
      expect((await getServerAuth()).principal).toBe("job:1");
    } finally {
      if (previous === undefined) Deno.env.delete("MYCELIA_JWT");
      else Deno.env.set("MYCELIA_JWT", previous);
    }
  }));

Deno.test("delegation requires every credential binding to remain valid", async () => {
  const value = credential();
  const binding = {
    id: credentialId,
    fingerprint: credentialFingerprint(value),
  };
  expect(await validateCredentialBindings([binding], async () => value)).toBe(
    true,
  );
  expect(await validateCredentialBindings([], async () => value)).toBe(false);
  expect(
    await validateCredentialBindings([binding, {
      ...binding,
      id: "223456789012345678901234",
    }], async (id) => id === credentialId ? value : null),
  ).toBe(false);
});

Deno.test("credentials in URL are rejected even when a valid Basic header is present", async () => {
  const request = createMockExpressRequest(
    "https://mycelia.test/oauth/token?client_secret=url-secret",
    {
      method: "POST",
      headers: { authorization: `Basic ${btoa("client:header-secret")}` },
    },
  );
  expect((await extractClientCredentials(request)).clientSecret).toBe("");
  const bodyRequest = createMockExpressRequest(
    "https://mycelia.test/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { client_id: "client", client_secret: "body-secret" },
    },
  );
  expect((await extractClientCredentials(bodyRequest)).clientSecret).toBe(
    "body-secret",
  );
});

function sessionRequest(
  method: string,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
) {
  const req = createMockExpressRequest("https://mycelia.test/auth/session", {
    method,
    headers: {
      origin: "https://mycelia.test",
      "x-mycelia-session": "1",
      ...(cookie && { cookie }),
      ...extraHeaders,
    },
    body: { client_id: credentialId, client_secret: "fake-secret" },
  });
  Object.defineProperty(req, "secure", { value: true });
  return req;
}

function sessionFixture() {
  const sessions = new Map<string, BrowserSession>();
  let current = credential();
  let now = Date.now();
  const handler = createBrowserSessionHandler({
    verify: async () => current,
    read: async () => current,
    store: {
      create: async (session) => {
        sessions.set(session._id, session);
      },
      read: async (id) => sessions.get(id) ?? null,
      remove: async (id) => {
        sessions.delete(id);
      },
    },
    now: () => now,
  });
  return {
    handler,
    sessions,
    read: async () => current,
    revoke: () => {
      current = { ...current, isActive: false };
    },
    advance: () => {
      now += 25 * 60 * 60 * 1000;
    },
  };
}

Deno.test("browser sessions require verified TLS outside explicit loopback development", () => {
  const previous = Deno.env.get("APP_MODE");
  try {
    const request = createMockExpressRequest(
      "http://localhost:5173/auth/session",
      {
        headers: {
          origin: "http://localhost:5173",
          "x-mycelia-session": "1",
          "x-forwarded-proto": "https",
        },
      },
    );
    Object.defineProperty(request, "secure", { value: false });
    Deno.env.set("APP_MODE", "prod");
    expect(browserSessionRequestAllowed(request)).toBe(false);
    Deno.env.set("APP_MODE", "dev");
    expect(browserSessionRequestAllowed(request)).toBe(true);
    request.headers.host = "mycelia.test";
    request.headers.origin = "http://mycelia.test";
    expect(browserSessionRequestAllowed(request)).toBe(false);
  } finally {
    if (previous === undefined) Deno.env.delete("APP_MODE");
    else Deno.env.set("APP_MODE", previous);
  }
});

Deno.test("browser sessions use protected opaque cookies and logout revokes access tokens", () =>
  withSecret(async () => {
    const fixture = sessionFixture();
    const response = createMockExpressResponse();
    await fixture.handler(sessionRequest("POST"), response.res);
    const cookie = response.getHeaders()["set-cookie"];
    expect(cookie).toContain("__Host-mycelia-session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(response.getHeaders()["cache-control"]).toBe("no-store");
    expect(response.getBody().expires_in).toBe(900);
    expect([...fixture.sessions.keys()][0]).not.toBe(
      cookie.split(";")[0].split("=")[1],
    );
    const token = response.getBody().access_token;
    const deps = {
      readCredential: fixture.read,
      activeSession: async (id: string) => fixture.sessions.has(id),
    };
    expect(await verifyToken(token, deps)).toBeInstanceOf(Auth);
    await fixture.handler(
      sessionRequest("DELETE", cookie),
      createMockExpressResponse().res,
    );
    expect(fixture.sessions.size).toBe(0);
    expect(await verifyToken(token, deps)).toBeNull();
  }));

Deno.test("sessions reject cross-origin/missing-CSRF requests before reading or issuing cookies", () =>
  withSecret(async () => {
    const fixture = sessionFixture();
    for (
      const headers of [{ origin: "https://untrusted.test" }, {
        "x-mycelia-session": "",
      }] as Record<string, string>[]
    ) {
      const response = createMockExpressResponse();
      await fixture.handler(
        sessionRequest("POST", undefined, headers),
        response.res,
      );
      expect(response.getStatus()).toBe(403);
      expect(fixture.sessions.size).toBe(0);
    }
  }));

Deno.test("session refresh fails after expiry or key revocation", () =>
  withSecret(async () => {
    for (const expire of [false, true]) {
      const fixture = sessionFixture();
      const login = createMockExpressResponse();
      await fixture.handler(sessionRequest("POST"), login.res);
      if (expire) fixture.advance();
      else fixture.revoke();
      const response = createMockExpressResponse();
      await fixture.handler(
        sessionRequest("GET", login.getHeaders()["set-cookie"]),
        response.res,
      );
      expect(response.getStatus()).toBe(401);
      expect(fixture.sessions.size).toBe(0);
    }
  }));

function bootstrapFixture(failCreate = false) {
  let claimed = false;
  let created = 0;
  const handler = createSetupHandler({
    bootstrapToken: () => secret,
    mongo: async () => async (input: any) => {
      if (input.action === "find") return [];
      if (claimed) {
        throw new Error("Database operation failed", {
          cause: Object.assign(new Error("duplicate"), { code: 11000 }),
        });
      }
      claimed = true;
      return { insertedId: "initial-admin" };
    },
    createKey: async () => {
      if (failCreate) throw new Error("injected write failure");
      created++;
      return { apiKey: "fake-bootstrap-key", clientId: credentialId };
    },
    createObjects: async () => {},
  });
  return { handler, created: () => created, claimed: () => claimed };
}

function bootstrapRequest(token = secret) {
  return createMockExpressRequest("https://mycelia.test/api/setup", {
    method: "POST",
    headers: { "x-mycelia-bootstrap": token },
    body: { create: true },
  });
}

Deno.test("bootstrap rejects missing proof and atomically creates one administrator", async () => {
  const fixture = bootstrapFixture();
  const denied = createMockExpressResponse();
  await fixture.handler(bootstrapRequest(""), denied.res);
  expect(denied.getStatus()).toBe(403);
  expect(fixture.claimed()).toBe(false);
  const first = createMockExpressResponse();
  const second = createMockExpressResponse();
  await Promise.all([
    fixture.handler(bootstrapRequest(), first.res),
    fixture.handler(bootstrapRequest(), second.res),
  ]);
  expect([first.getStatus(), second.getStatus()].sort()).toEqual([200, 409]);
  expect(fixture.created()).toBe(1);
});

Deno.test("ambiguous bootstrap failure preserves the claim instead of creating another root key", async () => {
  const fixture = bootstrapFixture(true);
  const first = createMockExpressResponse();
  await fixture.handler(bootstrapRequest(), first.res);
  expect(first.getStatus()).toBe(500);
  const second = createMockExpressResponse();
  await fixture.handler(bootstrapRequest(), second.res);
  expect(second.getStatus()).toBe(409);
  expect(fixture.claimed()).toBe(true);
});
