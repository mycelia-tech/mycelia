/** Private handoff from the owning test runner; never use application endpoints. */
export interface TestSession {
  version: 1;
  session: string;
  mongoUri: string;
  redisHost: string;
  redisPort: number;
}

export function loopbackPortBindings(port: number) {
  return { [`${port}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "0" }] };
}

export function assertLoopbackBindings(
  ports: Record<string, { hostIp: string; hostPort: number }[]>,
  expectedPort: number,
): void {
  const bindings = ports[`${expectedPort}/tcp`];
  if (
    !bindings?.length ||
    Object.values(ports).some((entries) =>
      entries.some(({ hostIp, hostPort }) =>
        hostIp !== "127.0.0.1" || !Number.isInteger(hostPort) ||
        hostPort < 1024 || hostPort > 65535
      )
    )
  ) {
    throw new Error("Test container ports must be published only on 127.0.0.1");
  }
}

export function validateTestSession(
  value: unknown,
  session: string,
): TestSession {
  const input = value as Partial<TestSession> | null;
  if (!input || input.version !== 1 || !session || input.session !== session) {
    throw new Error(
      "Invalid backend test session; use app/tests/run-backend-tests.ts",
    );
  }
  let mongo: URL;
  try {
    mongo = new URL(input.mongoUri ?? "");
  } catch {
    throw new Error("Invalid test Mongo endpoint");
  }
  if (
    mongo.protocol !== "mongodb:" || mongo.hostname !== "127.0.0.1" ||
    !mongo.port || mongo.username || mongo.password || mongo.pathname !== "/" ||
    mongo.search !== "?directConnection=true" || mongo.hash ||
    input.redisHost !== "127.0.0.1" ||
    !Number.isInteger(input.redisPort) || input.redisPort! < 1024 ||
    input.redisPort! > 65535 || Number(mongo.port) < 1024 ||
    Number(mongo.port) > 65535
  ) {
    throw new Error(
      "Test endpoints must be isolated loopback ports without credentials",
    );
  }
  return input as TestSession;
}

export async function readTestSession(): Promise<TestSession> {
  const path = Deno.env.get("MYCELIA_TEST_SESSION_FILE");
  const session = Deno.env.get("MYCELIA_TEST_SESSION_ID");
  if (!path || !session) {
    throw new Error(
      "Backend integration tests require app/tests/run-backend-tests.ts",
    );
  }
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    throw new Error("Backend test session file must be a private regular file");
  }
  return validateTestSession(
    JSON.parse(await Deno.readTextFile(path)),
    session,
  );
}

export interface OwnedTestContainer {
  host: string;
  port: number;
  stop(): Promise<void>;
}

export async function within<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stops every successfully created resource, including partial startup/failing tests. */
export async function withOwnedTestContainers<T>(
  startRedis: () => Promise<OwnedTestContainer>,
  startMongo: () => Promise<OwnedTestContainer>,
  run: (session: TestSession) => Promise<T>,
  options: { signal?: AbortSignal; cleanupTimeoutMs?: number } = {},
): Promise<T> {
  const owned: OwnedTestContainer[] = [];
  const errors: unknown[] = [];
  let result: T | undefined;
  try {
    options.signal?.throwIfAborted();
    const redis = await startRedis();
    owned.push(redis);
    options.signal?.throwIfAborted();
    const mongo = await startMongo();
    owned.push(mongo);
    options.signal?.throwIfAborted();
    if (
      ![redis.host, mongo.host].every((host) =>
        ["127.0.0.1", "localhost"].includes(host)
      )
    ) {
      throw new Error("The backend test runner requires a local Docker engine");
    }
    const session = crypto.randomUUID();
    result = await run(validateTestSession({
      version: 1,
      session,
      mongoUri: `mongodb://127.0.0.1:${mongo.port}/?directConnection=true`,
      redisHost: "127.0.0.1",
      redisPort: redis.port,
    }, session));
  } catch (error) {
    errors.push(error);
  } finally {
    // Independent cleanup attempts: failure stopping Mongo must not leave Redis running.
    for (const container of owned.reverse()) {
      try {
        await within(
          container.stop(),
          options.cleanupTimeoutMs ?? 15_000,
          "Test container cleanup",
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    throw new AggregateError(errors, "Backend test run or cleanup failed");
  }
  return result as T;
}

export function parseTestArguments(args: string[]): string[] {
  const accepted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--filter") {
      const filter = args[++i];
      if (!filter) throw new Error("--filter requires a test name or pattern");
      accepted.push(arg, filter);
    } else if (arg.startsWith("--filter=") && arg.length > 9) {
      accepted.push(arg);
    } else if (arg === "--trace-leaks") {
      accepted.push(arg);
    } else if (!arg.startsWith("-") && arg.length && !arg.includes("://")) {
      accepted.push(arg);
    } else {
      throw new Error(
        `Unsupported test option: ${arg}. Modules must run sequentially with sanitizers enabled.`,
      );
    }
  }
  return accepted;
}
