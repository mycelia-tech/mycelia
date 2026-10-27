import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  assertLoopbackBindings,
  loopbackPortBindings,
  type OwnedTestContainer,
  parseTestArguments,
  readTestSession,
  validateTestSession,
  withOwnedTestContainers,
} from "./test-session.ts";
import { runFixtureLifecycle } from "./fixture-lifecycle.ts";

Deno.test("test port requests use dynamic loopback bindings and reject public inspect results", () => {
  for (const port of [6379, 27017]) {
    deepStrictEqual(loopbackPortBindings(port), {
      [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "0" }],
    });
    assertLoopbackBindings({
      [`${port}/tcp`]: [{ hostIp: "127.0.0.1", hostPort: 49152 }],
    }, port);
    for (const hostIp of ["0.0.0.0", "::", "", "192.0.2.1"]) {
      throws(() =>
        assertLoopbackBindings({
          [`${port}/tcp`]: [{ hostIp, hostPort: 49152 }],
        }, port)
      );
    }
    throws(() => assertLoopbackBindings({}, port));
  }
});

function owned(
  name: string,
  events: string[],
  stop?: () => Promise<void>,
): OwnedTestContainer {
  events.push(`start ${name}`);
  return {
    host: "localhost",
    port: name === "redis" ? 16379 : 27018,
    stop: async () => {
      events.push(`stop ${name}`);
      await stop?.();
    },
  };
}

Deno.test("one pair survives multiple modules and is stopped after failed child status", async () => {
  const events: string[] = [];
  const status = await withOwnedTestContainers(
    async () => owned("redis", events),
    async () => owned("mongo", events),
    async (session) => {
      equal(session.redisHost, "127.0.0.1");
      events.push("module one", "module two");
      return 1;
    },
  );
  equal(status, 1);
  deepStrictEqual(events, [
    "start redis",
    "start mongo",
    "module one",
    "module two",
    "stop mongo",
    "stop redis",
  ]);
});

Deno.test("partial startup cleans already created containers and preserves failure", async () => {
  const events: string[] = [];
  const failure = new Error("mongo startup failed");
  await rejects(
    withOwnedTestContainers(
      async () => owned("redis", events),
      () => Promise.reject(failure),
      async () => {
        throw new Error("must not run");
      },
    ),
    (error) => error === failure,
  );
  deepStrictEqual(events, ["start redis", "stop redis"]);
});

Deno.test("interruption after startup awaits cleanup without running tests", async () => {
  const events: string[] = [];
  const abort = new AbortController();
  await rejects(
    withOwnedTestContainers(
      async () => owned("redis", events),
      async () => {
        abort.abort();
        return owned("mongo", events);
      },
      async () => {
        throw new Error("must not run");
      },
      { signal: abort.signal },
    ),
    /abort/i,
  );
  deepStrictEqual(events, [
    "start redis",
    "start mongo",
    "stop mongo",
    "stop redis",
  ]);
});

Deno.test("hung cleanup is bounded and still attempts the other container", async () => {
  const events: string[] = [];
  await rejects(
    withOwnedTestContainers(
      async () => owned("redis", events),
      async () => owned("mongo", events, () => new Promise(() => {})),
      async () => 0,
      { cleanupTimeoutMs: 5 },
    ),
    /cleanup timed out/,
  );
  deepStrictEqual(events.slice(-2), ["stop mongo", "stop redis"]);
});

Deno.test("test and teardown failures are both retained", async () => {
  const events: string[] = [];
  await rejects(
    withOwnedTestContainers(
      async () => owned("redis", events),
      async () =>
        owned("mongo", events, () => Promise.reject(new Error("stop failed"))),
      () => Promise.reject(new Error("test failed")),
    ),
    (error) => {
      equal(error instanceof AggregateError, true);
      deepStrictEqual(
        (error as AggregateError).errors.map((item) => item.message),
        ["test failed", "stop failed"],
      );
      return true;
    },
  );
  equal(events.at(-1), "stop redis");
});

Deno.test("private session validation rejects production endpoints and wrong session", () => {
  const valid = {
    version: 1,
    session: "synthetic-session",
    mongoUri: "mongodb://127.0.0.1:27018/?directConnection=true",
    redisHost: "127.0.0.1",
    redisPort: 16379,
  };
  equal(validateTestSession(valid, valid.session).mongoUri, valid.mongoUri);
  for (
    const change of [
      { mongoUri: "mongodb://mongo:27017/production" },
      {
        mongoUri:
          "mongodb://user:secret@127.0.0.1:27018/?directConnection=true",
      },
      { redisHost: "production.example" },
      { redisPort: 637 },
      { session: "wrong" },
    ]
  ) {
    throws(() => validateTestSession({ ...valid, ...change }, valid.session));
  }
});

Deno.test("fixtures reject missing, public, or symlinked handoff files", async () => {
  const previousPath = Deno.env.get("MYCELIA_TEST_SESSION_FILE");
  const previousId = Deno.env.get("MYCELIA_TEST_SESSION_ID");
  const directory = await Deno.makeTempDir();
  try {
    Deno.env.delete("MYCELIA_TEST_SESSION_FILE");
    Deno.env.delete("MYCELIA_TEST_SESSION_ID");
    await rejects(readTestSession(), /require app\/tests\/run-backend-tests/);
    const path = `${directory}/session.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        session: "synthetic-session",
        mongoUri: "mongodb://127.0.0.1:27018/?directConnection=true",
        redisHost: "127.0.0.1",
        redisPort: 16379,
      }),
      { mode: 0o600 },
    );
    Deno.env.set("MYCELIA_TEST_SESSION_FILE", path);
    Deno.env.set("MYCELIA_TEST_SESSION_ID", "synthetic-session");
    equal((await readTestSession()).redisPort, 16379);
    await Deno.chmod(path, 0o644);
    await rejects(readTestSession(), /private regular file/);
    await Deno.chmod(path, 0o600);
    await Deno.symlink(path, `${directory}/linked.json`);
    Deno.env.set("MYCELIA_TEST_SESSION_FILE", `${directory}/linked.json`);
    await rejects(readTestSession(), /private regular file/);
  } finally {
    if (previousPath === undefined) {
      Deno.env.delete("MYCELIA_TEST_SESSION_FILE");
    } else Deno.env.set("MYCELIA_TEST_SESSION_FILE", previousPath);
    if (previousId === undefined) Deno.env.delete("MYCELIA_TEST_SESSION_ID");
    else Deno.env.set("MYCELIA_TEST_SESSION_ID", previousId);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runner rejects parallelism, checking overrides, foreign paths and arbitrary options", () => {
  deepStrictEqual(
    parseTestArguments([
      "app/tests/a.test.ts",
      "--filter",
      "example",
      "--trace-leaks",
    ]),
    ["app/tests/a.test.ts", "--filter", "example", "--trace-leaks"],
  );
  for (
    const arg of [
      "--parallel",
      "-j",
      "--no-check",
      "--config",
      "--allow-all",
      "https://example.test/a.ts",
    ]
  ) {
    throws(() => parseTestArguments([arg]));
  }
  throws(() => parseTestArguments(["--filter"]));
});

Deno.test("fixture setup failure unwinds earlier resources and always clears registry", async () => {
  const events: string[] = [];
  await rejects(
    runFixtureLifecycle(
      [
        {
          token: "database",
          factory: () => "db",
          teardown: () => {
            events.push("close database");
          },
        },
        {
          token: "broken",
          factory: () => {
            throw new Error("setup failed");
          },
          teardown: () => {
            events.push("invalid teardown");
          },
        },
      ],
      [],
      () => {
        events.push("invalid test");
      },
      () => {
        events.push("clear");
      },
    ),
    /setup failed/,
  );
  deepStrictEqual(events, ["close database", "clear"]);
});

Deno.test("fixtures unwind dependents first and report every cleanup failure", async () => {
  const events: string[] = [];
  await rejects(
    runFixtureLifecycle(
      [
        {
          token: "database",
          factory: () => "db",
          teardown: () => {
            events.push("database");
          },
        },
        {
          token: "client",
          dependencies: ["database"],
          factory: (db) => db,
          teardown: () => {
            events.push("client");
            throw new Error("client cleanup failed");
          },
        },
      ],
      ["client"],
      (client) => {
        equal(client, "db");
        throw new Error("assertion failed");
      },
      () => {
        events.push("clear");
      },
    ),
    (error) => {
      deepStrictEqual(
        (error as AggregateError).errors.map((item) => item.message),
        ["assertion failed", "client cleanup failed"],
      );
      return true;
    },
  );
  deepStrictEqual(events, ["client", "database", "clear"]);
});
