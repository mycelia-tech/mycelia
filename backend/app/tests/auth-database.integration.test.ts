import { expect } from "@std/expect";
import type { Db } from "mongodb";
import { withFixtures } from "./fixtures.server.ts";
import {
  callExpressHandler,
  createMockExpressRequest,
  createMockExpressResponse,
} from "./express-helpers.ts";
import { generateApiKeyWithId, revokeApiKey } from "@/lib/auth/tokens.ts";
import { browserSessionHandler } from "@/lib/auth/browser-session.ts";
import { oauthTokenHandler } from "@/routes/oauth.token.ts";
import { apiResourceHandler } from "@/routes/api.resource.$name.ts";
import { getRootDB } from "@/lib/mongo/core.server.ts";
import { env } from "#/env.ts";

const owner = "synthetic-external-client";
const policies = [{
  resource: "db/auth_fixture",
  action: "read",
  effect: "allow" as const,
}];

function requestWith(token: string) {
  return callExpressHandler(
    apiResourceHandler,
    "https://fixture.test/api/resource/mongo",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      params: { name: "mongo" },
      body: { action: "count", collection: "auth_fixture", query: {} },
    },
  );
}

Deno.test(
  "external API key token authorizes a resource and stops working immediately after DB revocation",
  withFixtures(
    ["Mongo"],
    async ({ db }: { db: Db }) => {
      await db.collection("auth_fixture").insertOne({ synthetic: true });
      const key = await generateApiKeyWithId(owner, "integration", policies);
      const exchange = await callExpressHandler(
        oauthTokenHandler,
        "https://fixture.test/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: {
            grant_type: "client_credentials",
            client_id: key.clientId,
            client_secret: key.apiKey,
          },
        },
      );
      expect(exchange.status).toBe(200);
      const { access_token: token } = await exchange.json();
      const allowed = await requestWith(token);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toBe(1);
      expect(await revokeApiKey(owner, key.clientId)).toBe(true);
      expect((await requestWith(token)).status).toBe(401);
    },
  ),
);

Deno.test(
  "browser session store and logout invalidate real bound JWTs in the fixture DB",
  withFixtures(
    ["Mongo"],
    async ({ db }: { db: Db }) => {
      const key = await generateApiKeyWithId(
        owner,
        "browser-integration",
        policies,
      );
      const sessionRequest = (method: string, cookie?: string) => {
        const request = createMockExpressRequest(
          "https://fixture.test/auth/session",
          {
            method,
            headers: {
              origin: "https://fixture.test",
              "x-mycelia-session": "1",
              ...(cookie && { cookie }),
            },
            body: { client_id: key.clientId, client_secret: key.apiKey },
          },
        );
        Object.defineProperty(request, "secure", { value: true });
        return request;
      };
      const login = createMockExpressResponse();
      await browserSessionHandler(sessionRequest("POST"), login.res);
      expect(login.getStatus()).toBe(200);
      const token = login.getBody().access_token;
      expect(await db.collection("browser_sessions").countDocuments({})).toBe(
        1,
      );
      expect((await requestWith(token)).status).toBe(200);
      const logout = createMockExpressResponse();
      await browserSessionHandler(
        sessionRequest(
          "DELETE",
          login.getHeaders()["set-cookie"].split(";")[0],
        ),
        logout.res,
      );
      expect(logout.getStatus()).toBe(200);
      expect(await db.collection("browser_sessions").countDocuments({})).toBe(
        0,
      );
      expect((await requestWith(token)).status).toBe(401);
    },
  ),
);

Deno.test("direct application Mongo pools follow fixture isolation and restore captured configuration", async () => {
  const before = { mongoUrl: env.MONGO_URL, databaseName: env.DATABASE_NAME };
  const names: string[] = [];
  for (let index = 0; index < 2; index++) {
    await withFixtures(["Mongo"], async ({ db }: { db: Db }) => {
      const application = await getRootDB();
      expect(application.databaseName).toBe(db.databaseName);
      expect(await application.collection("auth_fixture").countDocuments({}))
        .toBe(0);
      await application.collection("auth_fixture").insertOne({
        synthetic: true,
      });
      expect(await db.collection("auth_fixture").countDocuments({})).toBe(1);
      names.push(application.databaseName);
    })();
    expect({ mongoUrl: env.MONGO_URL, databaseName: env.DATABASE_NAME })
      .toEqual(before);
  }
  expect(names[0]).not.toBe(names[1]);
});
