import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  acquireTestRunLease,
  assertTestContainerLimits,
  boundedMongoCommand,
  MINIMUM_TEST_FREE_BYTES,
  REDIS_TEST_COMMAND,
  requireNoRunningTestDatabases,
  requireTestDiskCapacity,
  requireTestRunnerVersion,
  runningTestDatabases,
  testContainerLimits,
} from "./test-runner-guard.ts";
import { within } from "./test-session.ts";

Deno.test("admission detects current and legacy test database containers without matching production", () => {
  const inventory = [
    {
      Id: "a".repeat(64),
      Names: ["/owned-mongo"],
      Image: "mongo:8.0",
      State: "running",
      Labels: { "mycelia.test-run": "owned" },
    },
    {
      Id: "b".repeat(64),
      Names: ["/legacy-redis"],
      Image: "docker.io/library/redis@sha256:1234",
      State: "paused",
      Labels: { "org.testcontainers": "true" },
    },
    {
      Id: "c".repeat(64),
      Names: ["/legacy-mongo"],
      Image: "registry.example:5000/bitnami/mongodb:8",
      State: "restarting",
      Labels: { "org.testcontainers.session-id": "old-session" },
    },
    {
      Id: "d".repeat(64),
      Names: ["/production-mongo"],
      Image: "mongo:8.2",
      State: "running",
      Labels: { "com.docker.compose.service": "mongo" },
    },
    {
      Id: "e".repeat(64),
      Names: ["/production-redis"],
      Image: "redis:7",
      State: "running",
      Labels: {},
    },
  ];
  deepStrictEqual(runningTestDatabases(inventory).map((item) => item.name), [
    "/owned-mongo",
    "/legacy-redis",
    "/legacy-mongo",
  ]);
  throws(
    () => requireNoRunningTestDatabases(inventory),
    /3 active test Mongo\/Redis/,
  );
  requireNoRunningTestDatabases(inventory.slice(3));
  throws(
    () =>
      requireNoRunningTestDatabases([{
        ...inventory[0],
        Image: `sha256:${"f".repeat(64)}`,
      }]),
    /1 active test Mongo\/Redis/,
  );
});

Deno.test("admission ignores stopped test databases and unrelated Testcontainers HTTP images", () => {
  const inventory = [
    { Image: "mongo:8.0", State: "exited" },
    { Image: "redis:7", State: "created" },
    { Image: "nginx:alpine", State: "running" },
    { Image: "node:22", State: "running" },
    { Image: "wiremock/wiremock:3", State: "running" },
    { Image: "testcontainers/ryuk:0.14.0", State: "running" },
    { Image: "mongo-express:latest", State: "running" },
  ].map((container) => ({
    ...container,
    Labels: { "org.testcontainers": "true" },
  }));
  deepStrictEqual(runningTestDatabases(inventory), []);
  requireNoRunningTestDatabases(inventory);
});

Deno.test("existing-container diagnostics expose only bounded names and ids", () => {
  const inventory = Array.from({ length: 8 }, (_, index) => ({
    Id: "a".repeat(64),
    Names: [`/test-${index}-${"x".repeat(400)}\u001b`],
    Image: "redis:7",
    State: "running",
    Labels: { "mycelia.test-run": "DO_NOT_PRINT_SECRET" },
  }));
  throws(() => requireNoRunningTestDatabases(inventory), (error) => {
    const message = (error as Error).message;
    equal(message.includes("DO_NOT_PRINT_SECRET"), false);
    equal(message.includes("\u001b"), false);
    equal(message.includes("(+3 more)"), true);
    equal(message.includes("/test-5"), false);
    equal(message.length < 1200, true);
    return true;
  });
});

Deno.test("runner rejects a shadowed or unpinned Deno before resource admission", () => {
  requireTestRunnerVersion("2.9.5");
  for (const version of ["2.6.8", "2.9.4", "2.10.0"]) {
    throws(
      () => requireTestRunnerVersion(version),
      /Use the Deno 2.9.5 executable/,
    );
  }
});

Deno.test("resource admission requires applied CPU/RAM/swap and application cache limits", () => {
  deepStrictEqual(testContainerLimits("mongo"), {
    Memory: 1024 ** 3,
    MemorySwap: 1024 ** 3,
    NanoCpus: 1_000_000_000,
  });
  deepStrictEqual(testContainerLimits("redis"), {
    Memory: 256 * 1024 ** 2,
    MemorySwap: 256 * 1024 ** 2,
    NanoCpus: 500_000_000,
  });
  for (const role of ["mongo", "redis"] as const) {
    const command = role === "mongo"
      ? boundedMongoCommand(["--replSet", "rs0"])
      : [...REDIS_TEST_COMMAND];
    const valid = {
      HostConfig: testContainerLimits(role),
      Config: { Cmd: command },
    };
    assertTestContainerLimits(role, valid);
    for (const name of ["Memory", "MemorySwap", "NanoCpus"]) {
      throws(() =>
        assertTestContainerLimits(role, {
          ...valid,
          HostConfig: { ...valid.HostConfig, [name]: 0 },
        }), /required .* limit/);
    }
    throws(
      () => assertTestContainerLimits(role, { ...valid, Config: { Cmd: [] } }),
      /application memory limit/,
    );
  }
  throws(() =>
    assertTestContainerLimits("redis", {
      HostConfig: testContainerLimits("redis"),
      Config: {
        Cmd: [
          "redis-server",
          "--maxmemory",
          "128mb",
          "--maxmemory-policy",
          "allkeys-lru",
        ],
      },
    }), /instead of evicting/);
});

Deno.test("Mongo cache bound preserves replica-set startup and rejects ambiguous overrides", () => {
  const original = ["--replSet", "rs0", "--keyFile", "/synthetic/key"];
  deepStrictEqual(boundedMongoCommand(original), [
    ...original,
    "--wiredTigerCacheSizeGB",
    "0.25",
  ]);
  equal(original.length, 4);
  throws(() => boundedMongoCommand(undefined), /Unexpected Mongo/);
  throws(
    () =>
      boundedMongoCommand(["--replSet", "rs0", "--wiredTigerCacheSizeGB", "4"]),
    /Unexpected Mongo/,
  );
});

Deno.test("disk admission checks checkout and temp before allowing a run", async () => {
  const seen: string[] = [];
  await requireTestDiskCapacity(["/checkout", "/tmp", "/tmp"], async (path) => {
    seen.push(path);
    return { bavail: MINIMUM_TEST_FREE_BYTES / 4096, bsize: 4096 };
  });
  deepStrictEqual(seen, ["/checkout", "/tmp"]);
  for (const lowDiskPath of ["/checkout", "/tmp"]) {
    await rejects(
      requireTestDiskCapacity(["/checkout", "/tmp"], async (path) => ({
        bavail: (path === lowDiskPath ? 3.6 * 1024 ** 3 : 6 * 1024 ** 3) / 4096,
        bsize: 4096,
      })),
      (error) => {
        equal((error as Error).message.includes(lowDiskPath), true);
        equal(
          (error as Error).message.includes("No test containers were started"),
          true,
        );
        return true;
      },
    );
  }
  await rejects(
    requireTestDiskCapacity(
      ["/tmp"],
      async () => ({ bavail: NaN, bsize: 4096 }),
    ),
    /available: unknown/,
  );
});

Deno.test("different worktrees contend on one lease and release keeps the same inode", async () => {
  const directory = await Deno.makeTempDir();
  let first: Awaited<ReturnType<typeof acquireTestRunLease>> | undefined;
  let second: Awaited<ReturnType<typeof acquireTestRunLease>> | undefined;
  try {
    first = await acquireTestRunLease({
      owner: "first",
      checkout: "/checkout/one",
    }, directory);
    const initial = await Deno.stat(first.path);
    await rejects(
      acquireTestRunLease(
        { owner: "second", checkout: "/checkout/two" },
        directory,
      ),
      /Another backend test suite is active/,
    );
    equal((await Deno.stat(first.path)).ino, initial.ino);
    first.release();
    first.release();
    second = await acquireTestRunLease({
      owner: "second",
      checkout: "/checkout/two",
    }, directory);
    equal((await Deno.stat(second.path)).ino, initial.ino);
    equal(
      JSON.parse(await Deno.readTextFile(second.path)).checkout,
      "/checkout/two",
    );
  } finally {
    first?.release();
    second?.release();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("lease rejects unsafe directory permissions, symlinks and hardlinks without modifying targets", async () => {
  const parent = await Deno.makeTempDir();
  const owner = { owner: "test", checkout: "/synthetic" };
  try {
    const unsafe = `${parent}/unsafe`;
    await Deno.mkdir(unsafe, { mode: 0o755 });
    await rejects(
      acquireTestRunLease(owner, unsafe),
      /directory must be private/,
    );
    const privateDirectory = `${parent}/private`;
    await Deno.mkdir(privateDirectory, { mode: 0o700 });
    await Deno.symlink(privateDirectory, `${parent}/linked-directory`);
    await rejects(
      acquireTestRunLease(owner, `${parent}/linked-directory`),
      /directory must be private/,
    );
    const target = `${parent}/unchanged.txt`;
    await Deno.writeTextFile(target, "synthetic payload", { mode: 0o600 });
    const lock = `${privateDirectory}/runner.lock`;
    await Deno.symlink(target, lock);
    await rejects(
      acquireTestRunLease(owner, privateDirectory),
      /regular file without links/,
    );
    equal(await Deno.readTextFile(target), "synthetic payload");
    await Deno.remove(lock);
    await Deno.link(target, lock);
    await rejects(
      acquireTestRunLease(owner, privateDirectory),
      /regular file without links/,
    );
    equal(await Deno.readTextFile(target), "synthetic payload");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("kernel releases a crashed process lease without removing or stealing its file", async () => {
  const directory = await Deno.makeTempDir();
  const moduleUrl = new URL("./test-runner-guard.ts", import.meta.url).href;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const { acquireTestRunLease } = await import(${
        JSON.stringify(moduleUrl)
      });
      await acquireTestRunLease({ owner: "synthetic-child", checkout: "/synthetic/child" }, Deno.args[0]);
      console.log("locked"); setInterval(() => {}, 1000);`,
      directory,
    ],
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.getReader();
  let childExited = false;
  let replacement: Awaited<ReturnType<typeof acquireTestRunLease>> | undefined;
  try {
    const message = await within(
      reader.read(),
      10_000,
      "Synthetic lock process",
    );
    equal(new TextDecoder().decode(message.value).trim(), "locked");
    const inode = (await Deno.stat(`${directory}/runner.lock`)).ino;
    await rejects(
      acquireTestRunLease(
        { owner: "contender", checkout: "/synthetic/other" },
        directory,
      ),
      /Another backend test suite/,
    );
    child.kill("SIGKILL");
    await within(child.status, 5_000, "Synthetic child exit");
    childExited = true;
    replacement = await acquireTestRunLease({
      owner: "replacement",
      checkout: "/synthetic/other",
    }, directory);
    equal((await Deno.stat(replacement.path)).ino, inode);
  } finally {
    replacement?.release();
    if (!childExited) {
      try {
        child.kill("SIGKILL");
      } catch { /* Already exited. */ }
      await child.status;
    }
    await reader.cancel();
    reader.releaseLock();
    await Deno.remove(directory, { recursive: true });
  }
});
