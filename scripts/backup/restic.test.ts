import {
  attestRecovery,
  type BootstrapDependencies,
  buildResticEnvironment,
  checkBootstrap,
  executeWithRunner,
  type ExternalCommandRequest,
  initializeKeychain,
  initializeRepository,
  loadPasswordContext,
  loadVerifiedResticContext,
  type PasswordCommandDependencies,
  passwordCommandMain,
} from "./restic.ts";
import {
  type BootstrapRecord,
  bootstrapStatePaths,
  ensureBootstrapDirectories,
  readBootstrapState,
  writeBootstrapStateAtomic,
} from "./bootstrap-state.ts";
import { withLock } from "./state.ts";
import type { CommandResult, Runner, RunningCommand } from "./types.ts";
import {
  commandTerminationError,
  DenoRunner,
  type RunnerChildProcess,
} from "./runner.ts";
import {
  activateRepositoryQuarantine,
  allowLeaseReleaseAfterRepositoryQuarantine,
  assertRepositoryWritable,
  readRepositoryQuarantine,
  type RepositoryTrigger,
  retainLeaseForRepositoryRecovery,
} from "./repository-safety.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectFailure(
  operation: Promise<unknown>,
): Promise<Error & Record<string, unknown>> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, "expected operation to fail");
  return caught as Error & Record<string, unknown>;
}

async function settlesWithin<T>(
  operation: Promise<T>,
  maxMs: number,
): Promise<T> {
  const expired = Symbol("test deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: T | typeof expired;
  try {
    result = await Promise.race([
      operation,
      new Promise<typeof expired>((resolve) => {
        timer = setTimeout(() => resolve(expired), maxMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (result === expired) {
    await operation.catch(() => undefined);
    throw new Error("operation did not settle within the test deadline");
  }
  return result;
}

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function assertClosedChildEnvironment(
  request: ExternalCommandRequest,
  home: string,
  extraKeys: readonly string[] = [],
): void {
  assert(request.clearEnv === true, "subprocess inherited parent environment");
  assert(request.env?.HOME === home, "validated home was not pinned");
  assert(
    request.env?.PATH ===
      `${home}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    "fixed safe path was not pinned",
  );
  assert(
    Object.keys(request.env ?? {}).sort().join(",") ===
      ["HOME", "PATH", ...extraKeys].sort().join(","),
    "child environment shape changed",
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(bytes);
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", copied.buffer)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function preparedRecoveryRoot(): Promise<{
  root: string;
  sourcePath: string;
  helperPath: string;
  record: Extract<BootstrapRecord, { phase: "recovery_attested" }>;
}> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeTextFile(`${root}/.env`, "DATABASE_NAME=mycelia\n", {
    mode: 0o600,
  });
  await Deno.chmod(`${root}/.env`, 0o600);
  await Deno.writeTextFile(`${root}/.env.backup`, "", { mode: 0o600 });
  await Deno.chmod(`${root}/.env.backup`, 0o600);
  await Deno.writeTextFile(`${root}/rclone.conf`, "reviewed rclone config\n", {
    mode: 0o600,
  });
  await Deno.chmod(`${root}/rclone.conf`, 0o600);
  await Deno.mkdir(`${root}/scripts/backup`, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${root}/scripts/restic-password-command`,
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  await Deno.chmod(`${root}/scripts/restic-password-command`, 0o755);
  const sourcePath = `${root}/scripts/backup/keychain-helper.swift`;
  const sourceBytes = new TextEncoder().encode("reviewed swift source\n");
  await Deno.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const paths = await ensureBootstrapDirectories(root);
  const helperBytes = new TextEncoder().encode("compiled helper\n");
  await Deno.writeFile(paths.helperPath, helperBytes, { mode: 0o700 });
  await Deno.chmod(paths.helperPath, 0o700);
  const common = {
    schema: 1 as const,
    installationId: "11111111-1111-4111-8111-111111111111",
    credentialGenerationId: "22222222-2222-4222-8222-222222222222",
    account: "mycelia",
    service: "tech.mycelia.backup.restic",
    label: "tech.mycelia.backup.restic",
    keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
    helperSourceSha256: await sha256(sourceBytes),
    helperExecutableSha256: await sha256(helperBytes),
    bootstrapStartedAtUtc: "2026-09-30T12:00:00.000Z",
  };
  await writeBootstrapStateAtomic(root, {
    ...common,
    phaseUpdatedAtUtc: "2026-09-30T12:00:00.000Z",
    phase: "creation_pending",
  });
  await writeBootstrapStateAtomic(root, {
    ...common,
    phaseUpdatedAtUtc: "2026-09-30T12:00:01.000Z",
    phase: "created_unconfirmed",
    credentialCreatedAtUtc: "2026-09-30T12:00:01.000Z",
    itemPersistentRefSha256: "3".repeat(64),
  });
  const record = {
    ...common,
    phaseUpdatedAtUtc: "2026-09-30T12:00:02.000Z",
    phase: "recovery_attested" as const,
    credentialCreatedAtUtc: "2026-09-30T12:00:01.000Z",
    itemPersistentRefSha256: "3".repeat(64),
    recoveryReceiptId: "receipt-1234",
    recoveryAttestedAtUtc: "2026-09-30T12:00:02.000Z",
  };
  await writeBootstrapStateAtomic(root, record);
  return { root, sourcePath, helperPath: paths.helperPath, record };
}

function commandResult(
  code: number,
  value: unknown,
  timedOut = false,
): CommandResult {
  return {
    code,
    timedOut,
    terminationConfirmed: true,
    forcedKill: false,
    stdout: new TextEncoder().encode(JSON.stringify(value)),
    stderr: new Uint8Array(),
  };
}

function textResult(code: number, value: string): CommandResult {
  return {
    code,
    timedOut: false,
    terminationConfirmed: true,
    forcedKill: false,
    stdout: new TextEncoder().encode(value),
    stderr: new Uint8Array(),
  };
}

function failingInputRunner(
  failure: "writer" | "consumer",
  observed: { killed: boolean; statusSettled: boolean },
): Runner {
  return {
    run: () => Promise.reject(new Error("buffered run is not expected")),
    spawn: (): RunningCommand => {
      let resolveStatus!: (value: {
        code: number;
        timedOut: boolean;
        terminationConfirmed: true;
        forcedKill: false;
      }) => void;
      const status = new Promise<{
        code: number;
        timedOut: boolean;
        terminationConfirmed: true;
        forcedKill: false;
      }>(
        (resolve) => {
          resolveStatus = resolve;
        },
      );
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      return {
        stdin: new WritableStream<Uint8Array>({
          write() {
            if (failure === "writer") throw new Error("closed input");
          },
        }),
        stdout: failure === "consumer"
          ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("broken output"));
            },
          })
          : empty(),
        stderr: empty(),
        status,
        kill: () => {
          observed.killed = true;
          setTimeout(() => {
            observed.statusSettled = true;
            resolveStatus({
              code: -1,
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
            });
          }, 20);
        },
      };
    },
  };
}

Deno.test("stdin command adapter kills drains and awaits status after writer or consumer failure", async () => {
  for (const failure of ["writer", "consumer"] as const) {
    const observed = { killed: false, statusSettled: false };
    let rejected = false;
    try {
      await executeWithRunner(failingInputRunner(failure, observed), {
        argv: ["/not-executed"],
        input: new Uint8Array([1]),
        timeoutMs: 1_000,
        maxOutputBytes: 10,
      });
    } catch {
      rejected = true;
    }
    assert(rejected, `${failure} failure was accepted`);
    assert(observed.killed, `${failure} failure did not terminate the child`);
    assert(
      observed.statusSettled,
      `${failure} failure returned before child status and drains settled`,
    );
  }
});

Deno.test("DenoRunner aborts a blocked stdin writer after output consumption fails", async () => {
  let resolveWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  let resolveStatus!: (value: { code: number }) => void;
  const rawStatus = new Promise<{ code: number }>((resolve) => {
    resolveStatus = resolve;
  });
  const rawChild: RunnerChildProcess = {
    stdin: new WritableStream<Uint8Array>({
      write() {
        return blockedWrite;
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic stdout failure"));
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    status: rawStatus,
    kill() {
      resolveStatus({ code: 143 });
    },
  };
  const operation = executeWithRunner(new DenoRunner(() => rawChild), {
    argv: ["/not-executed"],
    input: new Uint8Array([1]),
    timeoutMs: 5_000,
    terminationGraceMs: 50,
    terminationConfirmMs: 100,
    maxOutputBytes: 1,
  });
  const fallback = setTimeout(resolveWrite, 500);
  const error = await expectFailure(settlesWithin(operation, 100));
  resolveWrite();
  clearTimeout(fallback);
  assert(
    error.message !== "operation did not settle within the test deadline",
    "blocked stdin write outlived the bounded termination path",
  );
  assert(error.code === "COMMAND_FAILED", "output failure was misclassified");
});

Deno.test("stdin adapter gives rejected typed termination priority after writer or consumer fails first", async () => {
  for (const failure of ["writer", "consumer"] as const) {
    for (
      const terminal of [
        commandTerminationError(true, false, true),
        commandTerminationError(false, true, true),
      ] as const
    ) {
      let resolveKill!: () => void;
      const killed = new Promise<void>((resolve) => {
        resolveKill = resolve;
      });
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      const fake = {
        run: () => Promise.reject(new Error("unexpected buffered path")),
        spawn: () => ({
          stdin: new WritableStream<Uint8Array>({
            write() {
              if (failure === "writer") throw new Error("writer failed first");
            },
          }),
          stdout: failure === "consumer"
            ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("consumer failed first"));
              },
            })
            : empty(),
          stderr: empty(),
          status: killed.then(() => Promise.reject(terminal)),
          kill: resolveKill,
        }),
      } as unknown as Runner;

      const error = await expectFailure(
        executeWithRunner(fake, {
          argv: ["/not-executed"],
          input: new Uint8Array([1]),
        }),
      );
      assert(
        Object.is(error, terminal),
        `${failure} masked the typed terminal error`,
      );
    }
  }
});

Deno.test("generic runner aborts pending stdin before awaiting typed status", async () => {
  let resolveWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  let rejectStatus!: (reason: unknown) => void;
  const status = new Promise<never>((_resolve, reject) => {
    rejectStatus = reject;
  });
  const terminal = commandTerminationError(true, false, true);
  let killed = false;
  const fake: Runner = {
    run: () => Promise.reject(new Error("unexpected buffered path")),
    spawn: () => ({
      stdin: new WritableStream<Uint8Array>({
        write() {
          return pendingWrite;
        },
      }),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("synthetic output failure"));
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      status,
      kill() {
        killed = true;
        rejectStatus(terminal);
      },
    }),
  };
  const fallback = setTimeout(resolveWrite, 500);
  const error = await expectFailure(
    settlesWithin(
      executeWithRunner(fake, {
        argv: ["/not-executed"],
        input: new Uint8Array([1]),
        maxOutputBytes: 1,
      }),
      100,
    ),
  );
  resolveWrite();
  clearTimeout(fallback);
  assert(killed, "output failure did not terminate the child");
  assert(Object.is(error, terminal), "typed status lost to pending stdin");
});

Deno.test("stdin adapter preserves typed termination when a required output stream is missing", async () => {
  for (const missing of ["stdout", "stderr"] as const) {
    for (
      const scenario of [
        {
          status: Promise.reject(commandTerminationError(true, false, true)),
          expected: { timedOut: true, terminationConfirmed: false },
        },
        {
          status: Promise.resolve({
            code: 137,
            timedOut: false,
            terminationConfirmed: true,
            forcedKill: true,
          }),
          expected: { timedOut: false, terminationConfirmed: true },
        },
        {
          status: Promise.resolve({
            code: null,
            timedOut: true,
            terminationConfirmed: false,
            forcedKill: true,
          }),
          expected: { timedOut: true, terminationConfirmed: false },
        },
      ] as const
    ) {
      const fake = {
        run: () => Promise.reject(new Error("unexpected buffered path")),
        spawn: () => ({
          stdin: new WritableStream<Uint8Array>(),
          stdout: missing === "stdout"
            ? null
            : new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
          stderr: missing === "stderr"
            ? null
            : new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
          status: scenario.status,
          kill: () => {},
        }),
      } as unknown as Runner;
      const error = await expectFailure(
        executeWithRunner(fake, {
          argv: ["/not-executed"],
          input: new Uint8Array([1]),
        }),
      );
      assert(
        error.code === "COMMAND_TERMINATION_UNCONFIRMED" &&
          error.timedOut === scenario.expected.timedOut &&
          error.terminationConfirmed ===
            scenario.expected.terminationConfirmed &&
          error.forcedKill === true,
        `${missing} masked typed termination`,
      );
    }
  }
});

Deno.test("stdin adapter still prioritizes typed missing-stream status when kill throws", async () => {
  const terminal = commandTerminationError(true, false, false);
  let statusAwaited = false;
  const fake = {
    run: () => Promise.reject(new Error("unexpected buffered path")),
    spawn: () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: null,
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      status: Promise.resolve().then(() => {
        statusAwaited = true;
        throw terminal;
      }),
      kill: () => {
        throw new Error("kill raced with exit");
      },
    }),
  } as unknown as Runner;
  const error = await expectFailure(
    executeWithRunner(fake, {
      argv: ["/not-executed"],
      input: new Uint8Array([1]),
    }),
  );
  assert(statusAwaited, "typed missing-stream status was not awaited");
  assert(Object.is(error, terminal), "throwing kill masked typed status");
});

Deno.test("stdin adapter keeps missing output as command failure after natural termination", async () => {
  const fake = {
    run: () => Promise.reject(new Error("unexpected buffered path")),
    spawn: () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: null,
      stderr: null,
      status: Promise.resolve({
        code: 0,
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
      }),
      kill: () => {},
    }),
  } as unknown as Runner;
  const error = await expectFailure(
    executeWithRunner(fake, {
      argv: ["/not-executed"],
      input: new Uint8Array([1]),
    }),
  );
  assert(error.code === "COMMAND_FAILED", "missing output was misclassified");
});

Deno.test("stdin adapter rejects returned unconfirmed or forced status with closed metadata", async () => {
  for (
    const status of [
      {
        code: null,
        timedOut: true,
        terminationConfirmed: false,
        forcedKill: true,
      },
      {
        code: 137,
        timedOut: true,
        terminationConfirmed: true,
        forcedKill: true,
      },
    ] as const
  ) {
    const empty = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    const fake = {
      run: () => Promise.reject(new Error("unexpected buffered path")),
      spawn: () => ({
        stdin: new WritableStream<Uint8Array>(),
        stdout: empty(),
        stderr: empty(),
        status: Promise.resolve(status),
        kill: () => {},
      }),
    } as unknown as Runner;
    const error = await expectFailure(
      executeWithRunner(fake, {
        argv: ["/not-executed"],
        input: new Uint8Array([1]),
      }),
    );
    assert(error.code === "COMMAND_TERMINATION_UNCONFIRMED", "wrong code");
    assert(error.timedOut === true, "timeout metadata lost");
    assert(
      error.terminationConfirmed === status.terminationConfirmed &&
        error.forcedKill === true,
      "termination metadata changed",
    );
    assert(
      JSON.stringify(Object.keys(error).sort()) ===
        JSON.stringify([
          "code",
          "forcedKill",
          "terminationConfirmed",
          "timedOut",
        ]),
      "termination error exposed unexpected fields",
    );
  }
});

Deno.test("security lookup delegates termination to the shared runner and preserves typed failure", async () => {
  const module = await import("./restic.ts") as unknown as Record<
    string,
    unknown
  >;
  const lookup = module.runSecurityLookupForTest as
    | ((
      argv: readonly string[],
      environment: Readonly<{ HOME: string; PATH: string }>,
      runner: Runner,
    ) => Promise<CommandResult>)
    | undefined;
  assert(typeof lookup === "function", "security lookup test seam is missing");
  const terminal = commandTerminationError(true, false, true);
  let observed:
    | Readonly<{ argv: readonly string[]; options: Record<string, unknown> }>
    | undefined;
  const runner: Runner = {
    run: (argv, options) => {
      observed = { argv, options };
      return Promise.reject(terminal);
    },
    spawn: () => {
      throw new Error("security lookup must use the buffered shared runner");
    },
  };
  const error = await expectFailure(
    lookup(
      ["/usr/bin/security", "find-generic-password"],
      { HOME: "/tmp/home", PATH: "/usr/bin:/bin" },
      runner,
    ),
  );
  assert(
    Object.is(error, terminal),
    "security lookup masked termination facts",
  );
  assert(
    JSON.stringify(observed?.argv) ===
      '["/usr/bin/security","find-generic-password"]',
    "security argv changed",
  );
  assert(
    observed?.options.clearEnv === true &&
      observed.options.terminationGraceMs === 250 &&
      observed.options.terminationConfirmMs === 1_000 &&
      observed.options.timeoutMs === 30_000,
    "security lookup did not use bounded shared termination",
  );
});

async function freshBootstrapRoot(): Promise<string> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeTextFile(`${root}/.env`, "DATABASE_NAME=mycelia\n", {
    mode: 0o600,
  });
  await Deno.chmod(`${root}/.env`, 0o600);
  await Deno.writeTextFile(`${root}/.env.backup`, "", { mode: 0o600 });
  await Deno.chmod(`${root}/.env.backup`, 0o600);
  await Deno.mkdir(`${root}/scripts/backup`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/scripts/backup/keychain-helper.swift`,
    "reviewed helper source\n",
    { mode: 0o600 },
  );
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/scripts/restic-password-command`,
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  await Deno.chmod(`${root}/scripts/restic-password-command`, 0o755);
  await Deno.writeTextFile(`${root}/rclone.conf`, "reviewed rclone config\n", {
    mode: 0o600,
  });
  await Deno.chmod(`${root}/rclone.conf`, 0o600);
  await ensureBootstrapDirectories(root);
  return root;
}

async function preparedCreatedRoot(): Promise<{
  root: string;
  record: Extract<BootstrapRecord, { phase: "created_unconfirmed" }>;
}> {
  const root = await freshBootstrapRoot();
  const paths = bootstrapStatePaths(root);
  const sourceBytes = await Deno.readFile(
    `${root}/scripts/backup/keychain-helper.swift`,
  );
  const helperBytes = new TextEncoder().encode("compiled helper\n");
  await Deno.writeFile(paths.helperPath, helperBytes, { mode: 0o700 });
  await Deno.chmod(paths.helperPath, 0o700);
  const common = {
    schema: 1 as const,
    installationId: "11111111-1111-4111-8111-111111111111",
    credentialGenerationId: "22222222-2222-4222-8222-222222222222",
    account: "mycelia",
    service: "tech.mycelia.backup.restic",
    label: "tech.mycelia.backup.restic",
    keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
    helperSourceSha256: await sha256(sourceBytes),
    helperExecutableSha256: await sha256(helperBytes),
    bootstrapStartedAtUtc: "2026-09-30T12:00:00.000Z",
  };
  await writeBootstrapStateAtomic(root, {
    ...common,
    phaseUpdatedAtUtc: "2026-09-30T12:00:00.000Z",
    phase: "creation_pending",
  });
  const record = {
    ...common,
    phaseUpdatedAtUtc: "2026-09-30T12:00:01.000Z",
    phase: "created_unconfirmed" as const,
    credentialCreatedAtUtc: "2026-09-30T12:00:01.000Z",
    itemPersistentRefSha256: "3".repeat(64),
  };
  await writeBootstrapStateAtomic(root, record);
  return { root, record };
}

Deno.test("restic environment quotes the wrapper as one shell word and rejects inherited overrides", () => {
  const wrapper = "/tmp/mycelia quote' $() `tick`;wrapper";
  const env = buildResticEnvironment({
    composeRoot: "/tmp/mycelia root",
    repository: "rclone:pk-backup:mycelia/restic-v1",
    passwordCommandPath: wrapper,
    rcloneConfigPath: "/tmp/rclone config",
    homeDir: "/tmp/home",
    inheritedEnvironment: { PATH: "/usr/bin:/bin" },
  });
  assert(
    env.RESTIC_PASSWORD_COMMAND ===
      "exec '/tmp/mycelia quote'\\'' $() `tick`;wrapper'",
    "wrapper path was not deterministically single-quoted",
  );
  assert(
    env.RESTIC_REPOSITORY === "rclone:pk-backup:mycelia/restic-v1",
    "repository changed",
  );
  assert(
    env.MYCELIA_BACKUP_COMPOSE_ROOT === "/tmp/mycelia root",
    "compose root changed",
  );
  assert(env.RCLONE_CONFIG === "/tmp/rclone config", "rclone config changed");
  assert(env.HOME === "/tmp/home", "home changed");
  assert(Object.isFrozen(env), "restic environment is mutable");
  assert(
    Object.getPrototypeOf(env) === Object.prototype,
    "restic environment has a surprising prototype",
  );
  assert(
    JSON.stringify(Object.keys(env).sort()) === JSON.stringify([
      "HOME",
      "MYCELIA_BACKUP_COMPOSE_ROOT",
      "PATH",
      "RCLONE_CONFIG",
      "RESTIC_PASSWORD_COMMAND",
      "RESTIC_REPOSITORY",
    ]),
    "restic environment does not contain exactly six keys",
  );
  assert(
    env.PATH ===
      "/tmp/home/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    "safe path changed",
  );
  for (
    const name of [
      "RESTIC_PASSWORD",
      "RESTIC_PASSWORD_FILE",
      "RESTIC_REPOSITORY_FILE",
      "RESTIC_PROGRESS_FPS",
      "RCLONE_CONFIG",
      "RCLONE_FUTURE_OPTION",
    ]
  ) {
    let rejected = false;
    try {
      buildResticEnvironment({
        composeRoot: "/tmp/mycelia",
        repository: "rclone:pk-backup:mycelia/restic-v1",
        passwordCommandPath: "/tmp/wrapper",
        rcloneConfigPath: "/tmp/rclone.conf",
        homeDir: "/tmp/home",
        inheritedEnvironment: { [name]: "secret" },
      });
    } catch {
      rejected = true;
    }
    assert(rejected, `inherited override ${name} was accepted`);
  }
  let unsafeHomeAccepted = false;
  try {
    buildResticEnvironment({
      composeRoot: "/tmp/mycelia",
      repository: "rclone:pk-backup:mycelia/restic-v1",
      passwordCommandPath: "/tmp/wrapper",
      rcloneConfigPath: "/tmp/rclone.conf",
      homeDir: "/tmp/home:unsafe",
      inheritedEnvironment: {},
    });
    unsafeHomeAccepted = true;
  } catch { /* Expected. */ }
  assert(!unsafeHomeAccepted, "colon-bearing HOME was accepted into PATH");
});

Deno.test("closed restic environment reaches absolute and PATH-resolved children exactly", async () => {
  const createdHome = await Deno.makeTempDir();
  const home = await Deno.realPath(createdHome);
  const bin = `${home}/bin`;
  const probe = `${bin}/path-env-probe`;
  const sentinels = [
    "MYCELIA_PARENT_ONLY",
    "DYLD_INSERT_LIBRARIES",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "LANG",
    "LC_ALL",
  ] as const;
  const previous = new Map(sentinels.map((name) => [name, Deno.env.get(name)]));
  try {
    await Deno.mkdir(bin, { mode: 0o700 });
    await Deno.symlink("/usr/bin/env", probe);
    for (const name of sentinels) Deno.env.set(name, "must-not-reach-child");
    const env = buildResticEnvironment({
      composeRoot: "/tmp/mycelia",
      repository: "rclone:pk-backup:mycelia/restic-v1",
      passwordCommandPath: "/tmp/restic-password-command",
      rcloneConfigPath: "/tmp/rclone.conf",
      homeDir: home,
      inheritedEnvironment: {},
    });
    const expected = Object.entries(env).map(([key, value]) =>
      `${key}=${value}`
    )
      .sort();
    const runner = new DenoRunner();
    for (const argv of [["/usr/bin/env"], ["path-env-probe"]]) {
      const result = await runner.run(argv, {
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        clearEnv: true,
        env,
      });
      assert(result.code === 0 && !result.timedOut, "env probe failed");
      assert(result.stderr.length === 0, "env probe wrote diagnostics");
      const actual = new TextDecoder().decode(result.stdout).trim().split("\n")
        .sort();
      assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        "closed child received a missing, changed, or ambient environment",
      );
    }
  } finally {
    for (const name of sentinels) {
      const value = previous.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("fixed cleared environment resolves the installed restic rclone and Deno tools", async () => {
  const configuredHome = Deno.env.get("HOME");
  assert(configuredHome !== undefined, "test home is unavailable");
  const home = await Deno.realPath(configuredHome);
  const env = buildResticEnvironment({
    composeRoot: "/tmp/mycelia",
    repository: "rclone:pk-backup:mycelia/restic-v1",
    passwordCommandPath: "/tmp/restic-password-command",
    rcloneConfigPath: "/tmp/rclone.conf",
    homeDir: home,
    inheritedEnvironment: {},
  });
  const result = await new DenoRunner().run([
    "/bin/sh",
    "-ceu",
    "command -v restic; command -v rclone; command -v deno",
  ], {
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    clearEnv: true,
    env,
  });
  assert(result.code === 0 && !result.timedOut, "fixed PATH missed a tool");
  const resolvedTools = new TextDecoder().decode(result.stdout).trim().split(
    "\n",
  );
  assert(resolvedTools.length === 3, "tool resolution output changed");
  assert(
    resolvedTools.every((path) => path.startsWith("/")),
    "tool resolution was not absolute",
  );
});

function repositoryDependencies(
  root: string,
  markerWrites: Uint8Array[],
  calls: string[][],
  settings: { existingRepository?: boolean; repositoryId?: string } = {},
): BootstrapDependencies {
  let initialized = settings.existingRepository ?? false;
  let marker: Uint8Array | undefined;
  const repositoryId = settings.repositoryId ?? "5".repeat(64);
  return {
    homeDir: root,
    inheritedEnvironment: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    now: (() => {
      const values = settings.existingRepository
        ? ["2026-09-30T12:00:04.000Z", "2026-09-30T12:00:05.000Z"]
        : ["2026-09-30T12:00:03.000Z", "2026-09-30T12:00:04.000Z"];
      return () => values.shift() ?? "2026-09-30T12:00:05.000Z";
    })(),
    preflight: (options) => {
      assert(options.composeRoot === root, "preflight root changed");
      assert(options.remoteMode === "full", "preflight was not full");
      assert(
        options.expectedInstallationId ===
          "11111111-1111-4111-8111-111111111111",
        "preflight installation changed",
      );
      return resolved({
        schema: 1,
        ok: true,
        remoteVerified: true,
        localVerified: true,
        backupId: "20260930T120003Z",
        namespace: settings.existingRepository || marker
          ? "owned"
          : "reservable",
      });
    },
    transport: () =>
      resolved({
        sshArgv: [
          "/usr/bin/ssh",
          "-F",
          `${root}/.ssh/config`,
          "-o",
          "BatchMode=yes",
          "pk_backup",
        ],
        rcloneConfigPath: `${root}/rclone.conf`,
        sshConfigPath: `${root}/.ssh/config`,
        knownHostsPath: `${root}/.ssh/known_hosts`,
        identityFilePath: `${root}/.ssh/id_rsa`,
      }),
    execute: async (request) => {
      calls.push([...request.argv]);
      for (
        const name of [
          "DYLD_LIBRARY_PATH",
          "SSH_AUTH_SOCK",
          "HTTP_PROXY",
          "HTTPS_PROXY",
        ]
      ) {
        assert(!Object.hasOwn(request.env ?? {}, name), `${name} leaked`);
      }
      const argv = request.argv;
      if (argv[0] === "restic") {
        assertClosedChildEnvironment(request, root, [
          "MYCELIA_BACKUP_COMPOSE_ROOT",
          "RCLONE_CONFIG",
          "RESTIC_PASSWORD_COMMAND",
          "RESTIC_REPOSITORY",
        ]);
        assert(Object.isFrozen(request.env), "restic environment was mutable");
      } else if (argv[0] === "rclone") {
        assertClosedChildEnvironment(request, root, ["RCLONE_CONFIG"]);
        assert(
          request.env?.RCLONE_CONFIG === `${root}/rclone.conf`,
          "direct rclone did not receive the pinned config",
        );
      } else {
        assertClosedChildEnvironment(request, root);
      }
      if (argv.at(-1) === "inspect") {
        return commandResult(0, {
          schema: 1,
          broadCount: 1,
          exactCount: 1,
          itemPersistentRefSha256: "3".repeat(64),
        });
      }
      if (argv[0] === "/usr/bin/ssh" && request.input) {
        assert(
          request.terminationGraceMs === 30_000,
          "marker writer did not receive the mutating-command grace period",
        );
        const state = await readBootstrapState(root);
        assert(
          state?.phase === "recovery_attested" &&
            state.ownerMarkerSha256 !== undefined,
          "marker write ran before durable intent",
        );
        marker = request.input.slice();
        markerWrites.push(marker.slice());
        return textResult(0, "");
      }
      if (argv[0] === "/usr/bin/ssh") return textResult(0, "ok\n");
      if (argv[0] === "rclone" && argv[1] === "cat") {
        return {
          code: marker ? 0 : 1,
          timedOut: false,
          terminationConfirmed: true,
          forcedKill: false,
          stdout: marker?.slice() ?? new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
      if (argv[0] === "rclone" && argv[1] === "lsf") {
        return textResult(0, marker ? "owner-v1.json\n" : "");
      }
      if (argv[0] === "restic" && argv[1] === "cat") {
        return initialized
          ? commandResult(0, { id: repositoryId, version: 2 })
          : commandResult(1, "");
      }
      if (argv[0] === "restic" && argv[1] === "init") {
        assert(
          request.terminationGraceMs === 30_000,
          "restic init did not receive the mutating-command grace period",
        );
        initialized = true;
        return textResult(0, "");
      }
      if (argv[0] === "restic" && argv[1] === "snapshots") {
        return commandResult(0, []);
      }
      throw new Error(`unexpected command ${argv[0]} ${argv[1] ?? ""}`);
    },
  };
}

Deno.test("repository initialization durably reserves the exact marker then verifies restic", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const markerWrites: Uint8Array[] = [];
  const calls: string[][] = [];
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120003Z" },
      (lease) =>
        initializeRepository(
          fixture.root,
          lease,
          repositoryDependencies(fixture.root, markerWrites, calls),
        ),
    );
    const record = await readBootstrapState(fixture.root);
    assert(
      record?.phase === "repository_verified",
      "repository was not verified",
    );
    assert(record.repositoryId === "5".repeat(64), "repository id changed");
    assert(markerWrites.length === 1, "marker was not created exactly once");
    const marker = new TextDecoder().decode(markerWrites[0]);
    assert(
      marker === JSON.stringify({
        schema: 1,
        installationId: fixture.record.installationId,
        createdAtUtc: "2026-09-30T12:00:03.000Z",
        children: ["restic-v1/", "bootstrap-manifests/", "logs/"],
      }),
      "marker bytes were not canonical",
    );
    assert(
      calls.some((argv) => argv[0] === "restic" && argv[1] === "init"),
      "empty namespace did not initialize restic",
    );
    const writer = calls.find((argv) =>
      argv[0] === "/usr/bin/ssh" &&
      argv.some((value) => value.includes("set -C"))
    );
    assert(writer !== undefined, "fixed marker writer was not invoked");
    const destination = writer.lastIndexOf("pk_backup");
    assert(
      destination >= 0 && writer.length === destination + 2,
      "OpenSSH did not receive one safely quoted remote-command argument",
    );
    assert(
      writer[destination + 1].startsWith("/bin/sh -ceu '") &&
        !writer[destination + 1].includes(fixture.record.installationId) &&
        !writer[destination + 1].includes(marker),
      "marker data was interpolated into the fixed remote command",
    );
    const lexical = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        `set -- ${
          writer[destination + 1]
        }; [ "$#" -eq 3 ] || exit 90; printf %s "$3"`,
      ],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const recoveredScript = new TextDecoder().decode(lexical.stdout);
    assert(
      lexical.code === 0 && recoveredScript.startsWith("umask 077\n") &&
        recoveredScript.includes("stat -c '%U'") &&
        recoveredScript.includes("/bin/cat > owner-v1.json"),
      "fixed remote script did not survive OpenSSH shell tokenization",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("marker-intent retry never runs the remote writer and adopts only an open repository", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const createdAt = "2026-09-30T12:00:03.000Z";
  const marker = new TextEncoder().encode(JSON.stringify({
    schema: 1,
    installationId: fixture.record.installationId,
    createdAtUtc: createdAt,
    children: ["restic-v1/", "bootstrap-manifests/", "logs/"],
  }));
  await writeBootstrapStateAtomic(fixture.root, {
    ...fixture.record,
    phaseUpdatedAtUtc: createdAt,
    ownerMarkerCreatedAtUtc: createdAt,
    ownerMarkerSha256: await sha256(marker),
  });
  const markerWrites: Uint8Array[] = [];
  const calls: string[][] = [];
  const deps = repositoryDependencies(fixture.root, markerWrites, calls, {
    existingRepository: true,
  });
  const execute = deps.execute!;
  const retryDeps: BootstrapDependencies = {
    ...deps,
    execute: async (request) => {
      if (request.argv[0] === "rclone" && request.argv[1] === "cat") {
        return {
          code: 0,
          timedOut: false,
          terminationConfirmed: true,
          forcedKill: false,
          stdout: marker.slice(),
          stderr: new Uint8Array(),
        };
      }
      if (request.argv[0] === "rclone" && request.argv[1] === "lsf") {
        return textResult(0, "owner-v1.json\nrestic-v1/\n");
      }
      return await execute(request);
    },
  };
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120004Z" },
      (lease) => initializeRepository(fixture.root, lease, retryDeps),
    );
    assert(markerWrites.length === 0, "retry reran the marker writer");
    assert(
      !calls.some((argv) => argv[0] === "restic" && argv[1] === "init"),
      "retry initialized an existing repository",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("marker-intent retry with no repository never writes or initializes", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const createdAt = "2026-09-30T12:00:03.000Z";
  const marker = new TextEncoder().encode(JSON.stringify({
    schema: 1,
    installationId: fixture.record.installationId,
    createdAtUtc: createdAt,
    children: ["restic-v1/", "bootstrap-manifests/", "logs/"],
  }));
  await writeBootstrapStateAtomic(fixture.root, {
    ...fixture.record,
    phaseUpdatedAtUtc: createdAt,
    ownerMarkerCreatedAtUtc: createdAt,
    ownerMarkerSha256: await sha256(marker),
  });
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls);
  const execute = base.execute!;
  let rejected = false;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120004Z" },
      (lease) =>
        initializeRepository(fixture.root, lease, {
          ...base,
          preflight: () =>
            resolved({
              schema: 1,
              ok: true,
              remoteVerified: true,
              localVerified: true,
              backupId: "20260930T120004Z",
              namespace: "owned",
            }),
          execute: async (request) => {
            if (request.argv[0] === "rclone" && request.argv[1] === "cat") {
              return {
                code: 0,
                timedOut: false,
                terminationConfirmed: true,
                forcedKill: false,
                stdout: marker.slice(),
                stderr: new Uint8Array(),
              };
            }
            if (request.argv[0] === "rclone" && request.argv[1] === "lsf") {
              return textResult(0, "owner-v1.json\n");
            }
            return await execute(request);
          },
        }),
    );
  } catch {
    rejected = true;
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
  assert(rejected, "marker-intent retry initialized a missing repository");
  assert(
    !calls.some((argv) =>
      argv[0] === "/usr/bin/ssh" && argv.some((part) => part.includes("set -C"))
    ),
    "marker-intent retry reran the writer",
  );
  assert(
    !calls.some((argv) => argv[0] === "restic" && argv[1] === "init"),
    "marker-intent retry ran restic init",
  );
});

Deno.test("bootstrap check is read-only and public verified context rejects internal hooks", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const marker = new TextEncoder().encode(JSON.stringify({
    schema: 1,
    installationId: fixture.record.installationId,
    createdAtUtc: "2026-09-30T12:00:03.000Z",
    children: ["restic-v1/", "bootstrap-manifests/", "logs/"],
  }));
  await writeBootstrapStateAtomic(fixture.root, {
    ...fixture.record,
    phaseUpdatedAtUtc: "2026-09-30T12:00:03.000Z",
    ownerMarkerCreatedAtUtc: "2026-09-30T12:00:03.000Z",
    ownerMarkerSha256: await sha256(marker),
  });
  await writeBootstrapStateAtomic(fixture.root, {
    ...fixture.record,
    phaseUpdatedAtUtc: "2026-09-30T12:00:04.000Z",
    ownerMarkerCreatedAtUtc: "2026-09-30T12:00:03.000Z",
    ownerMarkerSha256: await sha256(marker),
    phase: "repository_verified",
    repositoryId: "5".repeat(64),
    repositoryVerifiedAtUtc: "2026-09-30T12:00:04.000Z",
  });
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls, {
    existingRepository: true,
  });
  const execute = base.execute!;
  const deps: BootstrapDependencies = {
    ...base,
    execute: async (request) => {
      if (request.argv[0] === "rclone" && request.argv[1] === "cat") {
        return {
          code: 0,
          timedOut: false,
          terminationConfirmed: true,
          forcedKill: false,
          stdout: marker.slice(),
          stderr: new Uint8Array(),
        };
      }
      if (request.argv[0] === "rclone" && request.argv[1] === "lsf") {
        return textResult(0, "owner-v1.json\nrestic-v1/\n");
      }
      return await execute(request);
    },
  };
  try {
    const before = await Deno.readFile(paths.recordPath);
    await checkBootstrap(fixture.root, deps);
    assert(
      JSON.stringify([...await Deno.readFile(paths.recordPath)]) ===
        JSON.stringify([...before]),
      "read-only check rewrote state",
    );
    let injectedCalls = 0;
    let rejected = false;
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "files", backupId: "20260930T120005Z" },
      async (lease) => {
        try {
          await loadVerifiedResticContext(
            fixture.root,
            lease,
            {
              ...deps,
              execute: async (request: ExternalCommandRequest) => {
                injectedCalls++;
                return await deps.execute!(request);
              },
            } as unknown as { homeDir?: string },
          );
        } catch {
          rejected = true;
        }
      },
    );
    assert(rejected, "public verified context accepted internal hooks");
    assert(injectedCalls === 0, "rejected hooks executed external commands");
    assert(
      !calls.some((argv) => argv[0] === "restic" && argv[1] === "init"),
      "read-only path initialized restic",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("a raced unknown namespace entry fails closed before restic init", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls);
  const execute = base.execute!;
  const deps: BootstrapDependencies = {
    ...base,
    execute: async (request) => {
      if (request.argv[0] === "rclone" && request.argv[1] === "lsf") {
        return textResult(0, "owner-v1.json\nforeign-entry\n");
      }
      return await execute(request);
    },
  };
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) => initializeRepository(fixture.root, lease, deps),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(code === "REMOTE_NAMESPACE_UNKNOWN", "raced entry was not rejected");
    assert(
      !calls.some((argv) => argv[0] === "restic"),
      "restic ran after a namespace race",
    );
    const state = await readBootstrapState(fixture.root);
    assert(
      state?.phase === "recovery_attested" &&
        state.ownerMarkerSha256 !== undefined,
      "durable marker intent was lost after the safe stop",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("interrupted marker writer performs read-only stabilization and leaves manual-stop intent", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls);
  const execute = base.execute!;
  let stabilizationReads = 0;
  let failureCode: string | undefined;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120003Z" },
      (lease) =>
        initializeRepository(fixture.root, lease, {
          ...base,
          execute: async (request) => {
            if (request.argv[0] === "/usr/bin/ssh" && request.input) {
              calls.push([...request.argv]);
              return commandResult(1, "interrupted", true);
            }
            if (request.argv[0] === "rclone" && request.argv[1] === "cat") {
              stabilizationReads++;
              return textResult(1, "");
            }
            return await execute(request);
          },
        }),
    );
  } catch (error) {
    failureCode = (error as { code?: string }).code;
  }
  try {
    assert(
      failureCode === "REMOTE_NAMESPACE_UNKNOWN",
      "interrupted marker writer failure was remapped",
    );
    assert(stabilizationReads === 1, "remote stabilization was not attempted");
    const state = await readBootstrapState(fixture.root);
    assert(
      state?.phase === "recovery_attested" &&
        state.ownerMarkerSha256 !== undefined,
      "interrupted marker writer lost manual-stop intent",
    );
    assert(
      !calls.some((argv) => argv[0] === "restic"),
      "restic ran after interrupted marker writer",
    );
    const quarantine = await readRepositoryQuarantine(paths.stateDir);
    assert(
      quarantine?.reason === "producer_audit_unverified" &&
        quarantine.childTerminationConfirmed === true &&
        quarantine.timedOut === true,
      "graceful timeout did not durably quarantine the uncertain marker write",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("remote mutation audit preserves a typed child termination over the original command failure", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls);
  const execute = base.execute!;
  const terminal = commandTerminationError(true, false, true);
  let writerFailed = false;
  let caught: unknown;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120003Z" },
      (lease) =>
        initializeRepository(fixture.root, lease, {
          ...base,
          execute: async (request) => {
            if (request.argv[0] === "/usr/bin/ssh" && request.input) {
              writerFailed = true;
              return textResult(1, "writer failed");
            }
            if (
              writerFailed && request.argv[0] === "rclone" &&
              request.argv[1] === "cat"
            ) throw terminal;
            return await execute(request);
          },
        }),
    );
  } catch (error) {
    caught = error;
  }
  try {
    assert(Object.is(caught, terminal), "audit termination was downgraded");
    const quarantine = await readRepositoryQuarantine(paths.stateDir);
    assert(
      quarantine?.reason === "child_status_unconfirmed" &&
        quarantine.childTerminationConfirmed === false &&
        quarantine.timedOut === true,
      "audit termination did not take quarantine precedence",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("remote mutation and audit termination facts use unconfirmed-before-forced precedence", async () => {
  for (
    const scenario of [
      {
        original: commandTerminationError(false, true, true),
        audit: commandTerminationError(true, false, true),
        expected: "audit" as const,
      },
      {
        original: commandTerminationError(true, false, true),
        audit: commandTerminationError(false, true, true),
        expected: "original" as const,
      },
    ]
  ) {
    const fixture = await preparedRecoveryRoot();
    const paths = bootstrapStatePaths(fixture.root);
    const base = repositoryDependencies(fixture.root, [], []);
    const execute = base.execute!;
    let writerAttempted = false;
    let caught: unknown;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) =>
          initializeRepository(fixture.root, lease, {
            ...base,
            execute: async (request) => {
              if (request.argv[0] === "/usr/bin/ssh" && request.input) {
                writerAttempted = true;
                throw scenario.original;
              }
              if (
                writerAttempted && request.argv[0] === "rclone" &&
                request.argv[1] === "cat"
              ) throw scenario.audit;
              return await execute(request);
            },
          }),
      );
    } catch (error) {
      caught = error;
    }
    try {
      const selected = scenario.expected === "audit"
        ? scenario.audit
        : scenario.original;
      assert(Object.is(caught, selected), "termination precedence changed");
      const quarantine = await readRepositoryQuarantine(paths.stateDir);
      assert(
        quarantine?.reason === "child_status_unconfirmed" &&
          quarantine.childTerminationConfirmed === false,
        "unconfirmed termination did not win quarantine precedence",
      );
    } finally {
      await Deno.remove(fixture.root, { recursive: true });
    }
  }
});

Deno.test("restic init failure leaves a no-delete manual-stop state", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const calls: string[][] = [];
  const markerWrites: Uint8Array[] = [];
  const base = repositoryDependencies(fixture.root, markerWrites, calls);
  const execute = base.execute!;
  const deps: BootstrapDependencies = {
    ...base,
    execute: async (request) => {
      if (request.argv[0] === "restic" && request.argv[1] === "init") {
        calls.push([...request.argv]);
        return textResult(1, "partial initialization details");
      }
      return await execute(request);
    },
  };
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) => initializeRepository(fixture.root, lease, deps),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(code === "RESTIC_INIT_FAILED", "init failure was remapped");
    assert(
      calls.filter((argv) => argv[0] === "rclone" && argv[1] === "cat")
        .length >= 2,
      "failed restic init did not perform remote stabilization",
    );
    const state = await readBootstrapState(fixture.root);
    assert(
      state?.phase === "recovery_attested" &&
        state.ownerMarkerSha256 !== undefined,
      "partial init incorrectly advanced or erased state",
    );
    assert(
      markerWrites.length === 1,
      "ownership marker was not committed first",
    );
    const quarantine = await readRepositoryQuarantine(paths.stateDir);
    assert(
      quarantine?.reason === "producer_audit_unverified" &&
        quarantine.childTerminationConfirmed === true &&
        quarantine.timedOut === false,
      "nonzero restic init did not durably quarantine the uncertain write",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("repository bootstrap rejects unexpected preexisting snapshots", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const base = repositoryDependencies(fixture.root, [], []);
  const execute = base.execute!;
  const deps: BootstrapDependencies = {
    ...base,
    execute: async (request) => {
      if (request.argv[0] === "restic" && request.argv[1] === "snapshots") {
        return commandResult(0, [{ id: "unexpected-existing-snapshot" }]);
      }
      return await execute(request);
    },
  };
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) => initializeRepository(fixture.root, lease, deps),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(
      code === "RESTIC_VERIFY_FAILED",
      "bootstrap accepted a repository with snapshots",
    );
    assert(
      (await readBootstrapState(fixture.root))?.phase === "recovery_attested",
      "unexpected snapshots advanced bootstrap state",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("same-inode password-wrapper mutation is rejected immediately before restic", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const calls: string[][] = [];
  const base = repositoryDependencies(fixture.root, [], calls);
  const execute = base.execute!;
  let mutated = false;
  const deps: BootstrapDependencies = {
    ...base,
    execute: async (request) => {
      if (
        !mutated && request.argv[0] === "rclone" && request.argv[1] === "lsf"
      ) {
        mutated = true;
        await Deno.writeTextFile(
          `${fixture.root}/scripts/restic-password-command`,
          "#!/bin/sh\nexit 0\n",
        );
        await Deno.chmod(
          `${fixture.root}/scripts/restic-password-command`,
          0o755,
        );
      }
      return await execute(request);
    },
  };
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) => initializeRepository(fixture.root, lease, deps),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(mutated, "wrapper mutation hook did not run");
    assert(
      code === "KEYCHAIN_PROVENANCE_MISMATCH",
      "same-inode wrapper mutation was accepted",
    );
    assert(
      !calls.some((argv) => argv[0] === "restic"),
      "restic ran with the mutated wrapper",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("ambient backup overrides stop repository bootstrap before external effects", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  let externalCalls = 0;
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) =>
          initializeRepository(fixture.root, lease, {
            inheritedEnvironment: { RESTIC_HOST: "override" },
            preflight: () => {
              externalCalls++;
              return Promise.reject(new Error("must not run"));
            },
            execute: () => {
              externalCalls++;
              return Promise.reject(new Error("must not run"));
            },
          }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(code === "CONFIG_INVALID", "ambient override was not rejected");
    assert(externalCalls === 0, "unexpected subprocess ran with an override");
    assert(
      (await readBootstrapState(fixture.root))?.phase === "recovery_attested",
      "state advanced",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("repository bootstrap rejects unsafe rclone config metadata before remote effects", async () => {
  for (const kind of ["0644", "0660", "symlink", "noncanonical"] as const) {
    const fixture = await preparedRecoveryRoot();
    const paths = bootstrapStatePaths(fixture.root);
    const configPath = `${fixture.root}/rclone.conf`;
    const calls: string[][] = [];
    const base = repositoryDependencies(fixture.root, [], calls);
    let transport = base.transport;
    if (kind === "0644" || kind === "0660") {
      await Deno.chmod(configPath, kind === "0644" ? 0o644 : 0o660);
    } else if (kind === "symlink") {
      const target = `${fixture.root}/rclone-target.conf`;
      await Deno.writeTextFile(target, "reviewed rclone config\n", {
        mode: 0o600,
      });
      await Deno.remove(configPath);
      await Deno.symlink(target, configPath);
    } else {
      transport = async () => ({
        ...await base.transport!(),
        rcloneConfigPath: `${fixture.root}/scripts/../rclone.conf`,
      });
    }
    let rejected = false;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120003Z" },
        (lease) =>
          initializeRepository(fixture.root, lease, {
            ...base,
            transport,
          }),
      );
    } catch {
      rejected = true;
    } finally {
      await Deno.remove(fixture.root, { recursive: true });
    }
    assert(rejected, `${kind} rclone config was accepted`);
    assert(
      !calls.some((argv) =>
        argv[0] === "/usr/bin/ssh" || argv[0] === "rclone" ||
        argv[0] === "restic"
      ),
      `${kind} rclone config reached a remote command`,
    );
  }
});

Deno.test("repository bootstrap rechecks rclone config identity between every remote child", async () => {
  for (const race of ["replacement", "same-inode"] as const) {
    for (const after of ["writer", "cat", "lsf", "init"] as const) {
      const fixture = await preparedRecoveryRoot();
      const paths = bootstrapStatePaths(fixture.root);
      const configPath = `${fixture.root}/rclone.conf`;
      const original = await Deno.readFile(configPath);
      const calls: string[][] = [];
      const base = repositoryDependencies(fixture.root, [], calls);
      const execute = base.execute!;
      let mutated = false;
      let rcloneCalls = 0;
      let rejected = false;
      try {
        await withLock(
          `${paths.stateDir}/backup.lock`,
          { command: "bootstrap", backupId: "20260930T120003Z" },
          (lease) =>
            initializeRepository(fixture.root, lease, {
              ...base,
              execute: async (request) => {
                if (request.argv[0] === "rclone") rcloneCalls++;
                const result = await execute(request);
                const point = request.argv[0] === "/usr/bin/ssh" &&
                    request.input
                  ? "writer"
                  : request.argv[0] === "rclone" &&
                      request.argv[1] === "cat"
                  ? "cat"
                  : request.argv[0] === "rclone" &&
                      request.argv[1] === "lsf"
                  ? "lsf"
                  : request.argv[0] === "restic" &&
                      request.argv[1] === "init"
                  ? "init"
                  : undefined;
                if (!mutated && point === after) {
                  mutated = true;
                  if (race === "replacement") {
                    const replacement = `${configPath}.replacement`;
                    await Deno.writeFile(replacement, original, {
                      mode: 0o600,
                    });
                    await Deno.chmod(replacement, 0o600);
                    await Deno.rename(replacement, configPath);
                  } else {
                    await Deno.writeFile(
                      configPath,
                      new Uint8Array(original.length).fill(0x78),
                    );
                  }
                }
                return result;
              },
            }),
        );
      } catch {
        rejected = true;
      } finally {
        await Deno.remove(fixture.root, { recursive: true });
      }
      assert(mutated, `${race}/${after} rclone race hook did not run`);
      assert(rejected, `${race}/${after} rclone config race was accepted`);
      const expectedRcloneCalls = after === "writer"
        ? 0
        : after === "cat"
        ? 1
        : 2;
      assert(
        rcloneCalls === expectedRcloneCalls,
        `${race}/${after} reached another direct rclone child`,
      );
      const resticCalls = calls.filter((argv) => argv[0] === "restic");
      assert(
        resticCalls.length === (after === "init" ? 1 : 0) &&
          (after !== "init" || resticCalls[0][1] === "init"),
        `${race}/${after} reached another restic child`,
      );
    }
  }
});

Deno.test("read-only verification rejects a different live repository id", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  const markerWrites: Uint8Array[] = [];
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120003Z" },
      (lease) =>
        initializeRepository(
          fixture.root,
          lease,
          repositoryDependencies(fixture.root, markerWrites, []),
        ),
    );
    const marker = markerWrites[0];
    assert(marker !== undefined, "marker missing");
    const base = repositoryDependencies(fixture.root, [], [], {
      existingRepository: true,
      repositoryId: "6".repeat(64),
    });
    const execute = base.execute!;
    let code: string | undefined;
    try {
      await checkBootstrap(fixture.root, {
        ...base,
        execute: async (request) => {
          if (request.argv[0] === "rclone" && request.argv[1] === "cat") {
            return {
              code: 0,
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
              stdout: marker.slice(),
              stderr: new Uint8Array(),
            };
          }
          if (request.argv[0] === "rclone" && request.argv[1] === "lsf") {
            return textResult(0, "owner-v1.json\nrestic-v1/\n");
          }
          return await execute(request);
        },
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(
      code === "REPOSITORY_ID_MISMATCH",
      "wrong repository id was accepted",
    );
    assert(
      (await readBootstrapState(fixture.root))?.phase === "repository_verified",
      "read-only mismatch changed state",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("password command uses exact pinned security argv and writes only 64 lowercase hex bytes", async () => {
  const createdHome = await Deno.makeTempDir();
  const home = await Deno.realPath(createdHome);
  const calls: readonly string[][] = [];
  const output: Uint8Array[] = [];
  const dependencies: PasswordCommandDependencies = {
    loadContext: (_root, selectedHome) => {
      assert(selectedHome === home, "password context received another HOME");
      return resolved({
        account: "mycelia",
        service: "tech.mycelia.backup.restic",
        label: "tech.mycelia.backup.restic",
        installationId: "11111111-1111-4111-8111-111111111111",
        credentialGenerationId: "22222222-2222-4222-8222-222222222222",
        keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
      });
    },
    securityLookup: (argv, environment) => {
      assert(
        JSON.stringify(environment) === JSON.stringify({
          HOME: home,
          PATH: `${home}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        }),
        "security lookup did not receive the exact closed base environment",
      );
      (calls as string[][]).push([...argv]);
      return resolved({
        code: 0,
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
        stdout: new TextEncoder().encode("a".repeat(64) + "\n"),
        stderr: new Uint8Array(),
      });
    },
    write: (bytes) => {
      output.push(bytes.slice());
      return Promise.resolve(bytes.length);
    },
  };
  try {
    const code = await passwordCommandMain(
      [],
      { MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia", HOME: home },
      dependencies,
    );
    assert(code === 0, "password command failed");
    assert(
      JSON.stringify(calls) === JSON.stringify([[
        "/usr/bin/security",
        "find-generic-password",
        "-w",
        "-a",
        "mycelia",
        "-s",
        "tech.mycelia.backup.restic",
        "-l",
        "tech.mycelia.backup.restic",
        "-G",
        "22222222-2222-4222-8222-222222222222",
        "-j",
        "11111111-1111-4111-8111-111111111111",
        "/Users/test/Library/Keychains/login.keychain-db",
      ]]),
      "security lookup was not exactly pinned",
    );
    assert(output.length === 1, "password was not written once");
    assert(
      new TextDecoder().decode(output[0]) === "a".repeat(64),
      "password output changed",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("password command writes all 64 bytes across partial stdout writes", async () => {
  const createdHome = await Deno.makeTempDir();
  const home = await Deno.realPath(createdHome);
  const written: number[] = [];
  try {
    const code = await passwordCommandMain(
      [],
      { MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia", HOME: home },
      {
        loadContext: () =>
          resolved({
            account: "mycelia",
            service: "tech.mycelia.backup.restic",
            label: "tech.mycelia.backup.restic",
            installationId: "11111111-1111-4111-8111-111111111111",
            credentialGenerationId: "22222222-2222-4222-8222-222222222222",
            keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
          }),
        securityLookup: () =>
          resolved({
            code: 0,
            timedOut: false,
            terminationConfirmed: true,
            forcedKill: false,
            stdout: new TextEncoder().encode("a".repeat(64)),
            stderr: new Uint8Array(),
          }),
        write: (bytes: Uint8Array) => {
          const count = Math.min(7, bytes.length);
          written.push(...bytes.subarray(0, count));
          return Promise.resolve(count);
        },
      },
    );
    assert(code === 0, "partial stdout writes failed");
    assert(
      new TextDecoder().decode(new Uint8Array(written)) === "a".repeat(64),
      "password command did not complete every partial write",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("password command rejects a zero-byte write and scrubs captured secret buffers", async () => {
  const createdHome = await Deno.makeTempDir();
  const home = await Deno.realPath(createdHome);
  const lookupBytes = new TextEncoder().encode("b".repeat(64));
  let pendingWrite: Uint8Array | undefined;
  try {
    const code = await passwordCommandMain(
      [],
      { MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia", HOME: home },
      {
        loadContext: () =>
          resolved({
            account: "mycelia",
            service: "tech.mycelia.backup.restic",
            label: "tech.mycelia.backup.restic",
            installationId: "11111111-1111-4111-8111-111111111111",
            credentialGenerationId: "22222222-2222-4222-8222-222222222222",
            keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
          }),
        securityLookup: () =>
          resolved({
            code: 0,
            timedOut: false,
            terminationConfirmed: true,
            forcedKill: false,
            stdout: lookupBytes,
            stderr: new Uint8Array(),
          }),
        write: (bytes: Uint8Array) => {
          pendingWrite = bytes;
          return Promise.resolve(0);
        },
      },
    );
    assert(code === 1, "zero-byte stdout write was accepted");
    assert(pendingWrite !== undefined, "stdout writer was not called");
    assert(
      pendingWrite.every((byte) => byte === 0) &&
        lookupBytes.every((byte) => byte === 0),
      "failed password output retained secret bytes",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("password command fails silently for bad invocation lookup or secret output", async () => {
  const createdHome = await Deno.makeTempDir();
  const home = await Deno.realPath(createdHome);
  const writes: Uint8Array[] = [];
  const base: PasswordCommandDependencies = {
    loadContext: () =>
      resolved({
        account: "mycelia",
        service: "tech.mycelia.backup.restic",
        label: "tech.mycelia.backup.restic",
        installationId: "11111111-1111-4111-8111-111111111111",
        credentialGenerationId: "22222222-2222-4222-8222-222222222222",
        keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
      }),
    securityLookup: () =>
      resolved({
        code: 0,
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
        stdout: new TextEncoder().encode("A".repeat(64)),
        stderr: new TextEncoder().encode("secret-error"),
      }),
    write: (bytes) => {
      writes.push(bytes.slice());
      return Promise.resolve(bytes.length);
    },
  };
  try {
    for (
      const [args, env, dependencies] of [
        [["secret"], {
          MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia",
          HOME: home,
        }, base],
        [[], { HOME: home }, base],
        [[], {
          MYCELIA_BACKUP_COMPOSE_ROOT: "relative-secret",
          HOME: home,
        }, base],
        [[], { MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia" }, base],
        [[], {
          MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia",
          HOME: "/tmp/../tmp",
        }, base],
        [[], {
          MYCELIA_BACKUP_COMPOSE_ROOT: "/tmp/mycelia",
          HOME: home,
        }, base],
      ] as const
    ) {
      assert(
        await passwordCommandMain(args, env, dependencies) === 1,
        "unsafe password invocation succeeded",
      );
    }
    assert(writes.length === 0, "failed password invocation wrote bytes");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("password context requires attested closed state and exact helper provenance", async () => {
  const fixture = await preparedRecoveryRoot();
  try {
    const context = await loadPasswordContext(fixture.root, fixture.root);
    assert(context.account === fixture.record.account, "account changed");
    assert(context.service === fixture.record.service, "service changed");
    assert(context.label === fixture.record.label, "label changed");
    assert(
      context.credentialGenerationId === fixture.record.credentialGenerationId,
      "generation changed",
    );
    await Deno.writeTextFile(fixture.sourcePath, "tampered source\n");
    let rejected = false;
    try {
      await loadPasswordContext(fixture.root, fixture.root);
    } catch {
      rejected = true;
    }
    assert(rejected, "tampered helper source was accepted");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("password context rejects every duplicate backup assignment including identical values", async () => {
  const fixture = await preparedRecoveryRoot();
  try {
    await Deno.writeTextFile(
      `${fixture.root}/.env.backup`,
      "BACKUP_RESTIC_KEYCHAIN_ACCOUNT=mycelia\nBACKUP_RESTIC_KEYCHAIN_ACCOUNT=mycelia\n",
    );
    await Deno.chmod(`${fixture.root}/.env.backup`, 0o600);
    let rejected = false;
    try {
      await loadPasswordContext(fixture.root, fixture.root);
    } catch {
      rejected = true;
    }
    assert(rejected, "identical duplicate assignment was accepted");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("keychain initialization persists pending before add and advances only after exact post-inspect", async () => {
  const root = await freshBootstrapRoot();
  const paths = bootstrapStatePaths(root);
  let inspectCalls = 0;
  let createCalls = 0;
  let ceremonies = 0;
  const dependencies: BootstrapDependencies = {
    homeDir: root,
    inheritedEnvironment: {},
    uuid: (() => {
      const values = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ];
      return () => values.shift()!;
    })(),
    now: (() => {
      const values = [
        "2026-09-30T12:00:00.000Z",
        "2026-09-30T12:00:01.000Z",
      ];
      return () => values.shift()!;
    })(),
    compileHelper: async (_source, output) => {
      await Deno.writeTextFile(output, "compiled helper\n", { mode: 0o700 });
      await Deno.chmod(output, 0o700);
    },
    ceremony: (purpose) => {
      assert(purpose === "create-keychain", "wrong ceremony purpose");
      ceremonies++;
      return Promise.resolve();
    },
    execute: async (request) => {
      assertClosedChildEnvironment(request, root);
      const { argv } = request;
      const mode = argv.at(-1);
      if (mode === "resolve-default") {
        return commandResult(0, {
          schema: 1,
          keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
        });
      }
      if (mode === "inspect") {
        inspectCalls++;
        return inspectCalls === 1
          ? commandResult(1, {
            schema: 1,
            code: "KEYCHAIN_ITEM_MISSING",
            broadCount: 0,
            exactCount: 0,
          })
          : commandResult(0, {
            schema: 1,
            broadCount: 1,
            exactCount: 1,
            itemPersistentRefSha256: "3".repeat(64),
          });
      }
      if (mode === "create") {
        createCalls++;
        const state = await readBootstrapState(root);
        assert(
          state?.phase === "creation_pending",
          "add ran before durable pending state",
        );
        return commandResult(0, { schema: 1, created: true });
      }
      throw new Error("unexpected command");
    },
  };
  try {
    await withLock(
      paths.stateDir + "/backup.lock",
      { command: "bootstrap", backupId: "20260930T120000Z" },
      (lease) => initializeKeychain(root, lease, dependencies),
    );
    const record = await readBootstrapState(root);
    assert(
      record?.phase === "created_unconfirmed",
      "credential was not confirmed",
    );
    assert(
      record.itemPersistentRefSha256 === "3".repeat(64),
      "persistent ref hash lost",
    );
    assert(
      createCalls === 1 && inspectCalls === 2,
      "wrong helper call sequence",
    );
    assert(ceremonies === 1, "visible ceremony missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initial keychain bootstrap never overwrites an unexpected helper", async () => {
  const root = await freshBootstrapRoot();
  const paths = bootstrapStatePaths(root);
  const unexpected = new TextEncoder().encode("unexpected helper\n");
  await Deno.writeFile(paths.helperPath, unexpected, { mode: 0o700 });
  await Deno.chmod(paths.helperPath, 0o700);
  let compileCalls = 0;
  let executeCalls = 0;
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120000Z" },
        (lease) =>
          initializeKeychain(root, lease, {
            homeDir: root,
            inheritedEnvironment: {},
            compileHelper: () => {
              compileCalls++;
              return Promise.resolve();
            },
            execute: () => {
              executeCalls++;
              return Promise.reject(new Error("must not execute"));
            },
          }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(
      code === "KEYCHAIN_PROVENANCE_MISMATCH",
      "unexpected helper was not rejected",
    );
    assert(
      compileCalls === 0 && executeCalls === 0,
      "bootstrap touched the helper",
    );
    assert(
      JSON.stringify([...await Deno.readFile(paths.helperPath)]) ===
        JSON.stringify([...unexpected]),
      "unexpected helper was overwritten",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("helper installation loses an atomic no-clobber race without replacing the winner", async () => {
  const root = await freshBootstrapRoot();
  const paths = bootstrapStatePaths(root);
  const winner = new TextEncoder().encode("competing helper\n");
  let executeCalls = 0;
  try {
    let code: string | undefined;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120000Z" },
        (lease) =>
          initializeKeychain(root, lease, {
            homeDir: root,
            inheritedEnvironment: {},
            compileHelper: async (_source, output) => {
              await Deno.writeTextFile(output, "compiled helper\n", {
                mode: 0o700,
              });
              await Deno.chmod(output, 0o700);
              await Deno.writeFile(paths.helperPath, winner, { mode: 0o700 });
              await Deno.chmod(paths.helperPath, 0o700);
            },
            execute: () => {
              executeCalls++;
              return Promise.reject(new Error("must not execute"));
            },
          }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assert(
      code === "KEYCHAIN_PROVENANCE_MISMATCH",
      "helper installation race was not rejected",
    );
    assert(executeCalls === 0, "raced helper was executed");
    assert(
      JSON.stringify([...await Deno.readFile(paths.helperPath)]) ===
        JSON.stringify([...winner]),
      "atomic install overwrote the competing helper",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("helper compilation uses captured source and rejects canonical replacement before execution", async () => {
  for (const race of ["replacement", "same-inode"] as const) {
    const root = await freshBootstrapRoot();
    const paths = bootstrapStatePaths(root);
    const canonical = `${root}/scripts/backup/keychain-helper.swift`;
    const original = await Deno.readFile(canonical);
    let compiledFromCapturedCopy = false;
    let executeCalls = 0;
    let rejected = false;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120000Z" },
        (lease) =>
          initializeKeychain(root, lease, {
            homeDir: root,
            inheritedEnvironment: {},
            compileHelper: async (source, output) => {
              compiledFromCapturedCopy = source !== canonical;
              assert(
                JSON.stringify([...await Deno.readFile(source)]) ===
                  JSON.stringify([...original]),
                "compiler did not receive the captured source bytes",
              );
              await Deno.writeTextFile(output, "compiled helper\n", {
                mode: 0o700,
              });
              await Deno.chmod(output, 0o700);
              const changed = new Uint8Array(original.length).fill(0x78);
              if (race === "replacement") {
                const replacement = `${canonical}.replacement`;
                await Deno.writeFile(replacement, changed, { mode: 0o600 });
                await Deno.rename(replacement, canonical);
              } else {
                await Deno.writeFile(canonical, changed);
              }
            },
            execute: () => {
              executeCalls++;
              return Promise.reject(new Error("mutated source must stop"));
            },
          }),
      );
    } catch {
      rejected = true;
    } finally {
      await Deno.remove(root, { recursive: true });
    }
    assert(rejected, `${race} source race was accepted`);
    assert(compiledFromCapturedCopy, `${race} compiled the canonical pathname`);
    assert(executeCalls === 0, `${race} source race executed the helper`);
  }
});

Deno.test("helper compilation uses a fresh protected module cache and ignores an unrelated fixed-name symlink", async () => {
  const root = await freshBootstrapRoot();
  const outside = await Deno.makeTempDir();
  const paths = bootstrapStatePaths(root);
  await Deno.symlink(outside, `${paths.binDir}/swift-module-cache`);
  let moduleCache = "";
  let inspectCalls = 0;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120000Z" },
      (lease) =>
        initializeKeychain(root, lease, {
          homeDir: root,
          inheritedEnvironment: {},
          uuid: (() => {
            const values = [
              "11111111-1111-4111-8111-111111111111",
              "22222222-2222-4222-8222-222222222222",
            ];
            return () => values.shift()!;
          })(),
          now: (() => {
            const values = [
              "2026-09-30T12:00:00.000Z",
              "2026-09-30T12:00:01.000Z",
            ];
            return () => values.shift()!;
          })(),
          ceremony: () => Promise.resolve(),
          execute: async (request) => {
            assertClosedChildEnvironment(request, root);
            if (request.argv[0] === "/usr/bin/swiftc") {
              const cacheFlag = request.argv.indexOf("-module-cache-path");
              const outputFlag = request.argv.indexOf("-o");
              moduleCache = request.argv[cacheFlag + 1];
              const cache = await Deno.lstat(moduleCache);
              assert(
                moduleCache.startsWith(
                  `${paths.binDir}/.swift-module-cache-`,
                ) &&
                  cache.isDirectory && !cache.isSymlink &&
                  cache.mode !== null && (cache.mode & 0o7777) === 0o700,
                "module cache was not fresh and protected",
              );
              await Deno.writeTextFile(
                request.argv[outputFlag + 1],
                "compiled helper\n",
                { mode: 0o700 },
              );
              return textResult(0, "");
            }
            const mode = request.argv.at(-1);
            if (mode === "resolve-default") {
              return commandResult(0, {
                schema: 1,
                keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
              });
            }
            if (mode === "inspect") {
              inspectCalls++;
              return inspectCalls === 1
                ? commandResult(1, {
                  schema: 1,
                  code: "KEYCHAIN_ITEM_MISSING",
                  broadCount: 0,
                  exactCount: 0,
                })
                : commandResult(0, {
                  schema: 1,
                  broadCount: 1,
                  exactCount: 1,
                  itemPersistentRefSha256: "3".repeat(64),
                });
            }
            if (mode === "create") {
              return commandResult(0, { schema: 1, created: true });
            }
            throw new Error("unexpected command");
          },
        }),
    );
    assert(moduleCache !== "", "compiler did not receive a module cache");
    let removed = false;
    try {
      await Deno.lstat(moduleCache);
    } catch (error) {
      removed = error instanceof Deno.errors.NotFound;
    }
    assert(removed, "fresh module cache was left behind");
    assert(
      (await Deno.lstat(`${paths.binDir}/swift-module-cache`)).isSymlink,
      "unrelated fixed-name cache symlink was followed or replaced",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("pending keychain retry adopts only its exact item without creating again", async () => {
  const root = await freshBootstrapRoot();
  const paths = bootstrapStatePaths(root);
  const sourceBytes = await Deno.readFile(
    `${root}/scripts/backup/keychain-helper.swift`,
  );
  const helperBytes = new TextEncoder().encode("compiled helper\n");
  await Deno.writeFile(paths.helperPath, helperBytes, { mode: 0o700 });
  await Deno.chmod(paths.helperPath, 0o700);
  const pending: BootstrapRecord = {
    schema: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    credentialGenerationId: "22222222-2222-4222-8222-222222222222",
    account: "mycelia",
    service: "tech.mycelia.backup.restic",
    label: "tech.mycelia.backup.restic",
    keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
    helperSourceSha256: await sha256(sourceBytes),
    helperExecutableSha256: await sha256(helperBytes),
    bootstrapStartedAtUtc: "2026-09-30T12:00:00.000Z",
    phaseUpdatedAtUtc: "2026-09-30T12:00:00.000Z",
    phase: "creation_pending",
  };
  await writeBootstrapStateAtomic(root, pending);
  let calls = 0;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120000Z" },
      (lease) =>
        initializeKeychain(root, lease, {
          homeDir: root,
          inheritedEnvironment: {},
          now: () => "2026-09-30T12:00:01.000Z",
          ceremony: () => Promise.reject(new Error("retry must not prompt")),
          execute: (request) => {
            assertClosedChildEnvironment(request, root);
            const { argv } = request;
            calls++;
            assert(
              argv.at(-1) === "inspect",
              "retry invoked create or resolve",
            );
            return resolved(commandResult(0, {
              schema: 1,
              broadCount: 1,
              exactCount: 1,
              itemPersistentRefSha256: "3".repeat(64),
            }));
          },
        }),
    );
    assert(calls === 1, "retry did not use one metadata inspection");
    assert(
      (await readBootstrapState(root))?.phase === "created_unconfirmed",
      "retry not reconciled",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("recovery attestation rechecks the exact item before the separate visible transition", async () => {
  const fixture = await preparedCreatedRoot();
  const paths = bootstrapStatePaths(fixture.root);
  let ceremonies = 0;
  try {
    await withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120000Z" },
      (lease) =>
        attestRecovery(fixture.root, lease, "receipt-1234", {
          homeDir: fixture.root,
          inheritedEnvironment: {},
          now: () => "2026-09-30T12:00:02.000Z",
          ceremony: (purpose) => {
            assert(purpose === "attest-recovery", "wrong ceremony purpose");
            ceremonies++;
            return Promise.resolve();
          },
          execute: (request) => {
            assertClosedChildEnvironment(request, fixture.root);
            const { argv } = request;
            assert(
              argv.at(-1) === "inspect",
              "attestation used a mutating helper mode",
            );
            return resolved(commandResult(0, {
              schema: 1,
              broadCount: 1,
              exactCount: 1,
              itemPersistentRefSha256: "3".repeat(64),
            }));
          },
        }),
    );
    const record = await readBootstrapState(fixture.root);
    assert(record?.phase === "recovery_attested", "receipt was not recorded");
    assert(record.recoveryReceiptId === "receipt-1234", "receipt changed");
    assert(ceremonies === 1, "attestation ceremony missing");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("recovery attestation refuses a replaced credential without prompting or advancing", async () => {
  const fixture = await preparedCreatedRoot();
  const paths = bootstrapStatePaths(fixture.root);
  let prompted = false;
  try {
    let rejected = false;
    try {
      await withLock(
        `${paths.stateDir}/backup.lock`,
        { command: "bootstrap", backupId: "20260930T120000Z" },
        (lease) =>
          attestRecovery(fixture.root, lease, "receipt-1234", {
            homeDir: fixture.root,
            inheritedEnvironment: {},
            ceremony: () => {
              prompted = true;
              return Promise.resolve();
            },
            execute: (request) => {
              assertClosedChildEnvironment(request, fixture.root);
              return resolved(commandResult(0, {
                schema: 1,
                broadCount: 1,
                exactCount: 1,
                itemPersistentRefSha256: "4".repeat(64),
              }));
            },
          }),
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "replaced credential was attested");
    assert(!prompted, "prompt occurred before credential verification");
    assert(
      (await readBootstrapState(fixture.root))?.phase === "created_unconfirmed",
      "state advanced",
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

async function installTestRepositoryQuarantine(
  root: string,
  trigger: Extract<RepositoryTrigger, "files" | "mongo-bootstrap">,
): Promise<void> {
  const paths = bootstrapStatePaths(root);
  const quarantineId = trigger === "files"
    ? "11111111-1111-4111-8111-111111111111"
    : "22222222-2222-4222-8222-222222222222";
  await withLock(
    `${paths.stateDir}/backup.lock`,
    {
      command: trigger,
      backupId: "20260930T120000Z",
      recoveryAttempt: {
        quarantineId,
        reservedAtUtc: "2026-09-30T12:00:00.000Z",
      },
    },
    async (lease) => {
      const record = {
        schema: 1 as const,
        kind: "repository-quarantine" as const,
        quarantineId,
        repository: { kind: "not_yet_verified" as const },
        triggeringCommand: trigger,
        backupId: "20260930T120000Z",
        reason: "producer_audit_unverified" as const,
        childTerminationConfirmed: true,
        timedOut: false,
        createdAtUtc: "2026-09-30T12:00:00.000Z",
      };
      await retainLeaseForRepositoryRecovery(paths.stateDir, lease, record);
      await activateRepositoryQuarantine(paths.stateDir, lease, record);
      await allowLeaseReleaseAfterRepositoryQuarantine(
        paths.stateDir,
        lease,
        quarantineId,
      );
    },
  );
}

Deno.test("files and Mongo quarantine block every Task 5 mutating bootstrap entrypoint before effects", async () => {
  for (const trigger of ["files", "mongo-bootstrap"] as const) {
    const fixture = await preparedRecoveryRoot();
    try {
      await installTestRepositoryQuarantine(fixture.root, trigger);
      let effects = 0;
      const dependencies: BootstrapDependencies = {
        homeDir: fixture.root,
        inheritedEnvironment: {},
        compileHelper: () => {
          effects++;
          return Promise.reject(new Error("must not compile"));
        },
        ceremony: () => {
          effects++;
          return Promise.reject(new Error("must not prompt"));
        },
        execute: () => {
          effects++;
          return Promise.reject(new Error("must not spawn"));
        },
        preflight: () => {
          effects++;
          return Promise.reject(new Error("must not preflight"));
        },
        transport: () => {
          effects++;
          return Promise.reject(new Error("must not resolve transport"));
        },
      };
      for (
        const invoke of [
          (lease: Parameters<typeof initializeKeychain>[1]) =>
            initializeKeychain(fixture.root, lease, dependencies),
          (lease: Parameters<typeof attestRecovery>[1]) =>
            attestRecovery(
              fixture.root,
              lease,
              "receipt-5678",
              dependencies,
            ),
          (lease: Parameters<typeof initializeRepository>[1]) =>
            initializeRepository(fixture.root, lease, dependencies),
        ]
      ) {
        const error = await expectFailure(withLock(
          `${bootstrapStatePaths(fixture.root).stateDir}/backup.lock`,
          { command: "bootstrap", backupId: "20260930T120100Z" },
          invoke,
        ));
        assert(
          error.code === "REPOSITORY_QUARANTINED",
          `${trigger} quarantine did not block bootstrap mutation`,
        );
      }
      assert(effects === 0, `${trigger} quarantine allowed an external effect`);
    } finally {
      await Deno.remove(fixture.root, { recursive: true });
    }
  }
});

Deno.test("unconfirmed bootstrap child durably quarantines before the owned lease unwinds", async () => {
  const fixture = await preparedRecoveryRoot();
  const paths = bootstrapStatePaths(fixture.root);
  try {
    const error = await expectFailure(withLock(
      `${paths.stateDir}/backup.lock`,
      { command: "bootstrap", backupId: "20260930T120200Z" },
      (lease) =>
        initializeRepository(fixture.root, lease, {
          homeDir: fixture.root,
          inheritedEnvironment: {},
          execute: () =>
            Promise.reject(commandTerminationError(true, false, true)),
        }),
    ));
    assert(
      error.code === "COMMAND_TERMINATION_UNCONFIRMED",
      "typed termination failure was replaced",
    );
    const quarantine = await readRepositoryQuarantine(paths.stateDir);
    assert(quarantine !== undefined, "quarantine was not activated");
    assert(
      quarantine.backupId === "20260930T120200Z" &&
        quarantine.triggeringCommand === "bootstrap" &&
        quarantine.reason === "child_status_unconfirmed" &&
        quarantine.childTerminationConfirmed === false,
      "quarantine receipt did not preserve the closed termination facts",
    );
    await expectFailure(assertRepositoryWritable(paths.stateDir)).then(
      (blocked) =>
        assert(
          blocked.code === "REPOSITORY_QUARANTINED",
          "future writer was not blocked",
        ),
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});
