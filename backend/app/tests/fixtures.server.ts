import { EJSON } from "bson";
import {
  Auth,
  defaultResourceManager,
  Policy,
  Resource,
  ResourceManager,
  signJWT,
} from "@/lib/auth/index.ts";
import { FsResource, getFsResource } from "@/lib/mongo/fs.server.ts";
import { redis } from "@/lib/redis.ts";
import { closeChangeStreamDB, closeRootDB, MongoResource } from "@/lib/mongo/core.server.ts";
import { env } from "#/env.ts";
import { MongoClient, UUID } from "mongodb";
import { TimelineResource } from "@/lib/timeline/resource.server.ts";
import { generateApiKey } from "@/lib/auth/tokens.ts";
import { accessLogger, getServerAuth } from "@/lib/auth/core.server.ts";
import { fn } from "@std/expect";
import { ObjectsResource } from "@/lib/objects/resource.server.ts";
import { MessengerResource } from "@/lib/messenger/resource.server.ts";
import { JobsResource } from "@/lib/resources/worker.ts";
import { SearchResource } from "@/lib/search/resource.server.ts";
import { DocsResource } from "@/lib/docs/resource.server.ts";
import { ConfigResource } from "@/lib/config/resource.server.ts";
import { z } from "zod";
import type { Request } from "express";
import { up } from "@/lib/mongo/migrator.ts";

import { discoverJobWorkers, jobRegistry } from "@/lib/jobs/job-registry.ts";
import { type Fixture, runFixtureLifecycle } from "./fixture-lifecycle.ts";
import { readTestSession } from "./test-session.ts";

export type { Fixture } from "./fixture-lifecycle.ts";

const testSession = await readTestSession();

const sampleAudioFile = await Deno.readFile("app/tests/sample_audio.wav");

await discoverJobWorkers();

export const testFixtures = new Map<any, Fixture>();

export function defineFixture(fixture: Fixture) {
  testFixtures.set(fixture.token, fixture);
}

function resolveFixtures(tokens: any[] | undefined): Fixture[] {
  if (!tokens) {
    return [];
  }
  return tokens.flatMap((token) => {
    const fixture = testFixtures.get(token);
    if (!fixture) {
      throw new Error(`Fixture ${token} not found`);
    }
    return [...resolveFixtures(fixture.dependencies), fixture];
  });
}

function dropDuplicates<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

redis.options.host = testSession.redisHost;
redis.options.password = undefined;
redis.options.port = testSession.redisPort;
await redis.connect();
// The owning runner enforces sequential modules. Redis pub/sub ignores DB
// indices, so parallel files must not share this pair. This endpoint comes only
// from the runner's private manifest, never from application REDIS_* settings.
await redis.flushdb();

defineFixture({
  token: ResourceManager,
  factory: () => defaultResourceManager,
});

defineFixture({
  token: "SampleAudioFile",
  factory: () =>
    new File([sampleAudioFile as any], "sample.wav", { type: "audio/wav" }),
});

defineFixture({
  token: "AuthFactory",
  factory: () => {
    return ({
      principal = "test",
      policies = [],
    }: {
      principal?: string;
      policies?: Policy[];
    }) => {
      return new Auth({
        principal,
        policies,
      });
    };
  },
});

defineFixture({
  token: "Admin",
  dependencies: ["AuthFactory"],
  factory: (authFactory) =>
    authFactory({
      principal: "admin",
      policies: [
        {
          action: "*",
          resource: "**",
          effect: "allow",
        },
      ],
    }),
});

defineFixture({
  token: "BearerFactory",
  factory: () => {
    Deno.env.set("SECRET_KEY", new UUID().toString());
    return async (auth: Auth) =>
      `Bearer ${await signJWT(
        auth.principal,
        auth.principal,
        auth.policies,
        "1 hour",
      )}`;
  },
});

defineFixture({
  token: "Mongo",
  factory: async () => {
    const mongoUri = testSession.mongoUri;
    const databaseName = new UUID().toString();
    const previous = {
      mongoUrl: env.MONGO_URL,
      databaseName: env.DATABASE_NAME,
      processMongoUrl: Deno.env.get("MONGO_URL"),
      processDatabaseName: Deno.env.get("DATABASE_NAME"),
    };
    const restoreConfig = () => {
      env.MONGO_URL = previous.mongoUrl;
      env.DATABASE_NAME = previous.databaseName;
      for (const [name, value] of [
        ["MONGO_URL", previous.processMongoUrl],
        ["DATABASE_NAME", previous.processDatabaseName],
      ] as const) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    };
    // env.ts captures configuration when imported. Updating only Deno.env leaves
    // direct application lookups (credential revocation, browser sessions) on the
    // sentinel endpoint, while resource calls see this fixture's private DB.
    // This wiring is confined to tests: production has no DB override mechanism.
    await closeRootDB();
    await closeChangeStreamDB();
    Deno.env.set("MONGO_URL", mongoUri);
    Deno.env.set("DATABASE_NAME", databaseName);
    env.MONGO_URL = mongoUri;
    env.DATABASE_NAME = databaseName;
    const resource = new MongoResource();
    const client = new MongoClient(
      mongoUri,
      {
        timeoutMS: 10_000,
        directConnection: true,
      },
    );
    try {
      await client.connect();
    } catch (error) {
      try { await client.close(); } finally { restoreConfig(); }
      throw error;
    }
    const isolatedDB = client.db(databaseName);
    const fs = new FsResource();
    const timeline = new TimelineResource();
    const objects = new ObjectsResource();
    const messenger = new MessengerResource();
    const jobs = new JobsResource();
    const search = new SearchResource();
    const docs = new DocsResource();
    const config = new ConfigResource();
    resource.getRootDB = async () => isolatedDB;
    fs.getRootDB = async () => isolatedDB;
    defaultResourceManager.registerResource(resource);
    defaultResourceManager.registerResource(fs);
    defaultResourceManager.registerResource(timeline);
    defaultResourceManager.registerResource(objects);
    defaultResourceManager.registerResource(messenger);
    defaultResourceManager.registerResource(jobs);
    defaultResourceManager.registerResource(search);
    defaultResourceManager.registerResource(docs);
    defaultResourceManager.registerResource(config);

    return {
      db: isolatedDB,
      client,
      restoreConfig,
    };
  },
  teardown: async ({ client, db, restoreConfig }) => {
    const errors: unknown[] = [];
    try {
      await db.dropDatabase();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        const results = await Promise.allSettled([
          closeRootDB(), closeChangeStreamDB(), client.close(),
        ]);
        errors.push(...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
      } finally { restoreConfig(); }
    }
    if (errors.length) throw new AggregateError(errors, "Mongo fixture cleanup failed");
  },
});

defineFixture({
  token: "uploadedFile",
  dependencies: ["Admin", "Mongo"],
  factory: async (auth: Auth) => {
    const fs = await getFsResource(auth);
    return fs({
      action: "upload",
      bucket: "test",
      filename: "file.bin",
      data: new Uint8Array([1, 2, 3]),
      metadata: { foo: "bar" },
    });
  },
});

defineFixture({
  token: "ServerAuth",
  dependencies: ["Admin", "BearerFactory"],
  factory: async (
    auth: Auth,
    bearerFactory: (auth: Auth) => Promise<string>,
  ) => {
    const bearerToken = await bearerFactory(auth);
    const token = bearerToken.replace("Bearer ", "");
    Deno.env.set("MYCELIA_TOKEN", token);
    return auth;
  },
  teardown: () => {
    Deno.env.delete("MYCELIA_TOKEN");
  },
});

defineFixture({
  token: "TestApiKey",
  dependencies: ["Mongo", "ServerAuth"],
  factory: async (auth: Auth) => {
    const policies = [{
      resource: "**",
      action: "*",
      effect: "allow" as const,
    }];
    return await generateApiKey("test-owner", "test-key", policies);
  },
});

defineFixture({
  token: "AdminAuthHeaders",
  dependencies: ["Admin", "BearerFactory"],
  factory: async (
    auth: Auth,
    bearerFactory: (auth: Auth) => Promise<string>,
  ) => {
    return {
      "Authorization": await bearerFactory(auth),
    };
  },
});

defineFixture({
  token: "accessLogger",
  factory: () => {
    const stub = fn(() => { }) as any;
    accessLogger.log = (auth, resource, actions) =>
      stub(auth.principal, resource.code, actions);
    return stub;
  },
});

defineFixture({
  token: "MockRedisXadd",
  factory: () => {
    const originalXadd = redis.xadd;
    const calls: Array<{ args: any[] }> = [];
    const mockXadd = fn(async (...args: any[]) => {
      calls.push({ args });
      return "1234567890-0";
    });
    redis.xadd = mockXadd as any;
    return {
      mock: Object.assign(mockXadd, {
        calls,
      }),
      original: originalXadd,
      restore: () => {
        redis.xadd = originalXadd;
      },
    };
  },
  teardown: ({ restore }) => {
    restore();
  },
});

defineFixture({
  token: "MockRedisXaddError",
  factory: () => {
    const originalXadd = redis.xadd;
    const mockXadd = fn(async () => {
      throw new Error("Redis connection failed");
    });
    redis.xadd = mockXadd as any;
    return {
      mock: mockXadd,
      original: originalXadd,
      restore: () => {
        redis.xadd = originalXadd;
      },
    };
  },
  teardown: ({ restore }) => {
    restore();
  },
});

defineFixture({
  token: "TestAuth",
  dependencies: ["AuthFactory"],
  factory: (authFactory) => authFactory({ principal: "test-user" }),
});

defineFixture({
  token: "MockFetch",
  factory: async () => {
    const mocks: { rule: RegExp, handler: any }[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      for (const mock of mocks) {
        if (mock.rule.test(url)) {
          return mock.handler(input, init);
        }
      }
      return originalFetch(input, init);
    };
    return {
      mocks,
      addMock: (rule: RegExp, handler: any) => {
        mocks.push({ rule, handler });
      },
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  },
  teardown: ({ restore }) => {
    restore();
  },
});

defineFixture({
  token: "MockCallResourceSDK",
  dependencies: ["MockFetch", "Admin", "BearerFactory"],
  factory: async ({ addMock }, auth: Auth, bearerFactory: (auth: Auth) => Promise<string>) => {
    const previous = {
      MYCELIA_JWT: Deno.env.get("MYCELIA_JWT"),
      MYCELIA_URL: Deno.env.get("MYCELIA_URL"),
    };
    const bearer = await bearerFactory(auth);
    Deno.env.set("MYCELIA_JWT", bearer.replace("Bearer ", ""));
    Deno.env.set("MYCELIA_URL", "http://not-used");
    addMock(/.*\/api\/resource\/(.*)/, async (input: any, data: any) => {
      const auth = await getServerAuth();
      const code = input.toString().split("/").pop()!;
      const resource = defaultResourceManager.getResource(code, auth);
      const result = await resource(EJSON.deserialize(JSON.parse(data.body)));
      return new Response(EJSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return previous;
  },
  teardown: (previous: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  },
});

defineFixture({
  token: "Migrations",
  dependencies: ["Mongo"],
  factory: async ({ db, client }) => {
    await up(db, client);
  },
});

defineFixture({
  token: "TestResource",
  factory: () => {
    return {
      mongo: {
        code: "mongo",
        schemas: {
          request: z.any(),
          response: z.any(),
        },
        use: async () => ({}),
        extractActions: () => [{ path: ["db", "objects"], actions: ["read"] }],
      } as Resource<any, any>,
      redis: {
        code: "redis",
        schemas: {
          request: z.any(),
          response: z.any(),
        },
        use: async () => ({}),
        extractActions: () => [{ path: ["key"], actions: ["get"] }],
      } as Resource<any, any>,
      mongoMultiple: {
        code: "mongo",
        schemas: {
          request: z.any(),
          response: z.any(),
        },
        use: async () => ({}),
        extractActions: () => [
          { path: ["db", "users"], actions: ["read"] },
          { path: ["db", "posts"], actions: ["write"] },
        ],
      } as Resource<any, any>,
    };
  },
});

defineFixture({
  token: "ExpressRequestFactory",
  factory: () => {
    return (options: {
      method?: string;
      headers?: Record<string, string>;
      body?: any;
      query?: Record<string, string>;
    }) => {
      const contentType = options.headers?.["content-type"] || "";
      let body = options.body;

      if (typeof body === "string") {
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(body);
          body = Object.fromEntries(params.entries());
        } else if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(body);
          } catch {
            // Ignore parse errors
          }
        }
      }

      return {
        method: options.method || "GET",
        headers: options.headers || {},
        body: body,
        query: options.query || {},
        get: (name: string) => options.headers?.[name.toLowerCase()] || undefined,
      } as unknown as Request;
    };
  },
});

console.log("All fixtures defined");

export function withFixtures(
  dependencies: any[],
  testFn: (...args: any[]) => Promise<void> | void,
) {
  return async () => {
    const fixtures = dropDuplicates(resolveFixtures(dependencies));
    await runFixtureLifecycle(fixtures, dependencies, testFn, () => {
      defaultResourceManager.clearResources();
    });
  };
}
