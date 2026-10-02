import { isAbsolute, join, normalize } from "node:path";
import type {
  BaseChildEnvironment,
  ClosedResticEnvironment,
  CommandResult,
  Runner,
} from "./types.ts";
import { failureError } from "./redact.ts";
import { loadBackupConfig } from "./config.ts";
import {
  assertProtectedExecutableIdentity,
  type BootstrapRecord,
  bootstrapStatePaths,
  ensureBootstrapDirectories,
  type ProtectedExecutableIdentity,
  readBootstrapState,
  validateBootstrapDirectories,
  validateProtectedExecutable,
  writeBootstrapStateAtomic,
} from "./bootstrap-state.ts";
import {
  assertOwnedLockLease,
  ownedLockContext,
  type OwnedLockLease,
  readEffectiveUid,
} from "./state.ts";
import { parseEnvText } from "../check-env.ts";
import {
  collectBoundedStream,
  commandTerminationError,
  DenoRunner,
  isCommandTerminationError,
  startManagedStdin,
} from "./runner.ts";
import {
  type PkBackupSshTransport,
  type PreflightOptions,
  type PreflightReport,
  resolvePkBackupSshTransport,
  runPreflight,
} from "./preflight.ts";
import { OWNER_CHILDREN, OWNER_MARKER } from "./remote.ts";
import {
  assertRcloneConfigIdentity,
  pinDefaultRcloneConfig,
  pinRcloneConfig,
  type RcloneConfigIdentity,
} from "./rclone-config.ts";
import {
  activateRepositoryQuarantine,
  type ActiveRepositoryQuarantine,
  allowLeaseReleaseAfterRepositoryQuarantine,
  assertRepositoryWritable,
  retainLeaseForRepositoryRecovery,
} from "./repository-safety.ts";

export type PasswordContext = Readonly<{
  account: string;
  service: string;
  label: string;
  installationId: string;
  credentialGenerationId: string;
  keychainPath: string;
}>;

export type PasswordCommandDependencies = Readonly<{
  loadContext?: (
    composeRoot: string,
    homeDir: string,
  ) => Promise<PasswordContext>;
  securityLookup?: (
    argv: readonly string[],
    environment: BaseChildEnvironment,
  ) => Promise<CommandResult>;
  write?: (bytes: Uint8Array) => Promise<number>;
}>;

export type ExternalCommandRequest = Readonly<{
  argv: readonly string[];
  input?: Uint8Array;
  env?: Readonly<Record<string, string>>;
  clearEnv?: boolean;
  timeoutMs?: number;
  terminationGraceMs?: number;
  terminationConfirmMs?: number;
  maxOutputBytes?: number;
}>;

export type BootstrapDependencies = Readonly<{
  runner?: Runner;
  execute?: (request: ExternalCommandRequest) => Promise<CommandResult>;
  compileHelper?: (sourcePath: string, outputPath: string) => Promise<void>;
  ceremony?: (
    purpose: "create-keychain" | "attest-recovery",
  ) => Promise<void>;
  uuid?: () => string;
  now?: () => string;
  inheritedEnvironment?: Readonly<Record<string, string>>;
  homeDir?: string;
  preflight?: (options: PreflightOptions) => Promise<PreflightReport>;
  transport?: () => Promise<PkBackupSshTransport>;
}>;

export type VerifiedResticContext = Readonly<{
  env: ClosedResticEnvironment;
  repositoryId: string;
  installationId: string;
  preflight: PreflightReport;
  assertUnchanged: () => Promise<void>;
}>;

export type VerifiedResticDependencies = Readonly<{
  runner?: Runner;
  homeDir?: string;
}>;

type RepositoryMutationRisk = Readonly<{
  reason: "producer_survived" | "producer_audit_unverified";
  timedOut: boolean;
}>;
const commandFailureFacts = new WeakMap<
  object,
  Readonly<{ timedOut: boolean }>
>();
const repositoryMutationRisks = new WeakMap<object, RepositoryMutationRisk>();

function rememberCommandFailure(
  error: Error,
  timedOut: boolean,
): Error {
  commandFailureFacts.set(error, Object.freeze({ timedOut }));
  return error;
}

function rememberRepositoryMutationRisk(
  error: unknown,
  reason: RepositoryMutationRisk["reason"],
): void {
  if ((typeof error !== "object" && typeof error !== "function") || !error) {
    return;
  }
  repositoryMutationRisks.set(
    error,
    Object.freeze({
      reason,
      timedOut: commandFailureFacts.get(error)?.timedOut ?? false,
    }),
  );
}

function safeAbsolute(value: string): boolean {
  return value.length > 1 && value.length <= 4096 && isAbsolute(value) &&
    normalize(value) === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function quoteShellWord(value: string): string {
  if (!safeAbsolute(value)) throw failureError("CONFIG_INVALID");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function executeWithRunner(
  runner: Runner,
  request: ExternalCommandRequest,
): Promise<CommandResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024;
  if (!request.input) {
    return await runner.run(request.argv, {
      timeoutMs,
      maxOutputBytes,
      ...(request.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: request.terminationGraceMs }),
      ...(request.terminationConfirmMs === undefined
        ? {}
        : { terminationConfirmMs: request.terminationConfirmMs }),
      ...(request.clearEnv === undefined ? {} : { clearEnv: request.clearEnv }),
      ...(request.env ? { env: request.env } : {}),
    });
  }
  const child = runner.spawn(request.argv, {
    timeoutMs,
    ...(request.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: request.terminationGraceMs }),
    ...(request.terminationConfirmMs === undefined
      ? {}
      : { terminationConfirmMs: request.terminationConfirmMs }),
    ...(request.clearEnv === undefined ? {} : { clearEnv: request.clearEnv }),
    ...(request.env ? { env: request.env } : {}),
  });
  if (!child.stdout || !child.stderr) {
    try {
      child.kill();
    } catch { /* A raced exit must not mask the settled status. */ }
    const [terminal] = await Promise.allSettled([child.status]);
    if (terminal.status === "rejected") {
      if (isCommandTerminationError(terminal.reason)) throw terminal.reason;
    } else {
      if (
        !terminal.value.terminationConfirmed || terminal.value.code === null
      ) {
        throw commandTerminationError(
          terminal.value.timedOut,
          false,
          terminal.value.forcedKill,
        );
      }
      if (terminal.value.forcedKill) {
        throw commandTerminationError(terminal.value.timedOut, true, true);
      }
    }
    throw failureError("COMMAND_FAILED");
  }
  let capturedStdout: Uint8Array | undefined;
  let capturedStderr: Uint8Array | undefined;
  const stdout = collectBoundedStream(child.stdout, maxOutputBytes).then(
    (value) => {
      capturedStdout = value;
      return value;
    },
  );
  const stderr = collectBoundedStream(child.stderr, maxOutputBytes).then(
    (value) => {
      capturedStderr = value;
      return value;
    },
  );
  const status = child.status;
  const managedInput = startManagedStdin(child.stdin, request.input);
  const input = managedInput.operation;
  try {
    const [output, diagnostics, childStatus] = await Promise.all([
      stdout,
      stderr,
      status,
      input,
    ]);
    if (!childStatus.terminationConfirmed || childStatus.code === null) {
      throw commandTerminationError(
        childStatus.timedOut,
        false,
        childStatus.forcedKill,
      );
    }
    if (childStatus.forcedKill) {
      throw commandTerminationError(childStatus.timedOut, true, true);
    }
    return {
      code: childStatus.code,
      timedOut: childStatus.timedOut,
      terminationConfirmed: true,
      forcedKill: false,
      stdout: output,
      stderr: diagnostics,
    };
  } catch (error) {
    managedInput.abort();
    try {
      child.kill();
    } catch { /* The process may already have exited. */ }
    const outcomes = await Promise.allSettled([stdout, stderr, status, input]);
    capturedStdout?.fill(0);
    capturedStderr?.fill(0);
    for (const outcome of outcomes) {
      if (
        outcome.status === "rejected" &&
        isCommandTerminationError(outcome.reason)
      ) throw outcome.reason;
    }
    const terminal = outcomes[2];
    if (terminal.status === "fulfilled") {
      if (
        !terminal.value.terminationConfirmed || terminal.value.code === null
      ) {
        throw commandTerminationError(
          terminal.value.timedOut,
          false,
          terminal.value.forcedKill,
        );
      }
      if (terminal.value.forcedKill) {
        throw commandTerminationError(terminal.value.timedOut, true, true);
      }
    }
    if (isCommandTerminationError(error)) throw error;
    throw failureError("COMMAND_FAILED");
  }
}

function executor(
  dependencies: BootstrapDependencies,
): (request: ExternalCommandRequest) => Promise<CommandResult> {
  if (dependencies.execute) return dependencies.execute;
  const runner = dependencies.runner ?? new DenoRunner();
  return (request) => executeWithRunner(runner, request);
}

type SafeProcessEnvironment = BaseChildEnvironment;

async function validateHomeDirectory(
  home: string,
): Promise<SafeProcessEnvironment> {
  try {
    if (
      !safeAbsolute(home) || home.includes(":") ||
      await Deno.realPath(home) !== home
    ) throw 0;
    const [info, uid] = await Promise.all([
      Deno.lstat(home),
      readEffectiveUid(),
    ]);
    if (
      !info.isDirectory || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o022) !== 0
    ) throw 0;
    return Object.freeze({
      HOME: home,
      PATH: `${home}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    });
  } catch {
    throw failureError("CONFIG_INVALID");
  }
}

async function safeProcessEnvironment(
  composeRoot: string,
  dependencies: BootstrapDependencies,
): Promise<SafeProcessEnvironment> {
  const inherited = dependencies.inheritedEnvironment ?? Deno.env.toObject();
  const home = dependencies.homeDir ?? inherited.HOME ??
    Deno.env.get("HOME") ?? composeRoot;
  return await validateHomeDirectory(home);
}

function closedExecutor(
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): (request: ExternalCommandRequest) => Promise<CommandResult> {
  const execute = executor(dependencies);
  return (request) =>
    execute({
      ...request,
      clearEnv: true,
      env: Object.freeze({ ...base, ...(request.env ?? {}) }),
    });
}

function closedRunner(
  base: SafeProcessEnvironment,
  provided?: Runner,
): Runner {
  const runner = provided ?? new DenoRunner();
  return {
    run: (argv, options) =>
      runner.run(argv, {
        ...options,
        clearEnv: true,
        env: Object.freeze({ ...base, ...(options.env ?? {}) }),
      }),
    spawn: (argv, options) =>
      runner.spawn(argv, {
        ...options,
        clearEnv: true,
        env: Object.freeze({ ...base, ...(options.env ?? {}) }),
      }),
  };
}

export function buildResticEnvironment(
  options: Readonly<{
    composeRoot: string;
    repository: string;
    passwordCommandPath: string;
    rcloneConfigPath: string;
    homeDir: string;
    inheritedEnvironment?: Readonly<Record<string, string>>;
  }>,
): ClosedResticEnvironment {
  const inherited = options.inheritedEnvironment ?? Deno.env.toObject();
  if (
    Object.keys(inherited).some((name) =>
      name.startsWith("RESTIC_") || name.startsWith("RCLONE_")
    ) || !safeAbsolute(options.composeRoot) ||
    !safeAbsolute(options.rcloneConfigPath) ||
    !safeAbsolute(options.homeDir) || options.homeDir.includes(":") ||
    options.repository !== "rclone:pk-backup:mycelia/restic-v1"
  ) throw failureError("CONFIG_INVALID");
  const environment = Object.freeze({
    HOME: options.homeDir,
    PATH:
      `${options.homeDir}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    RESTIC_PASSWORD_COMMAND: `exec ${
      quoteShellWord(options.passwordCommandPath)
    }`,
    RESTIC_REPOSITORY: options.repository,
    MYCELIA_BACKUP_COMPOSE_ROOT: options.composeRoot,
    RCLONE_CONFIG: options.rcloneConfigPath,
  });
  assertClosedResticEnvironment(environment);
  return environment;
}

const CLOSED_RESTIC_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "MYCELIA_BACKUP_COMPOSE_ROOT",
  "RCLONE_CONFIG",
  "RESTIC_PASSWORD_COMMAND",
  "RESTIC_REPOSITORY",
] as const;

export function assertClosedResticEnvironment(
  value: unknown,
): asserts value is ClosedResticEnvironment {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value) ||
    !exactKeys(
      value as Record<string, unknown>,
      [...CLOSED_RESTIC_ENVIRONMENT_KEYS],
    ) ||
    CLOSED_RESTIC_ENVIRONMENT_KEYS.some((key) =>
      typeof (value as Record<string, unknown>)[key] !== "string"
    )
  ) throw failureError("CONFIG_INVALID");
}

const HELPER_CODES = new Set([
  "KEYCHAIN_ITEM_MISSING",
  "KEYCHAIN_DUPLICATE_ITEM",
  "KEYCHAIN_CANCELLED",
  "KEYCHAIN_UNAVAILABLE",
  "KEYCHAIN_RNG_FAILED",
  "KEYCHAIN_CREATE_AMBIGUOUS",
  "KEYCHAIN_CREATE_FAILED",
  "KEYCHAIN_PROVENANCE_MISMATCH",
  "KEYCHAIN_ITEM_AMBIGUOUS",
]);
const HASH = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function parseHelperOutput(result: CommandResult): Record<string, unknown> {
  try {
    if (result.timedOut || result.stdout.length > 64 * 1024) throw 0;
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch {
    throw failureError("KEYCHAIN_UNAVAILABLE");
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

function helperFailure(value: Record<string, unknown>): never {
  const code = value.code;
  if (typeof code === "string" && HELPER_CODES.has(code)) {
    throw failureError(code as Parameters<typeof failureError>[0]);
  }
  throw failureError("KEYCHAIN_UNAVAILABLE");
}

type InspectResult = Readonly<
  | { kind: "missing" }
  | { kind: "exact"; persistentRefSha256: string }
>;

async function callHelper(
  helper: ProtectedExecutableIdentity,
  mode: "resolve-default" | "inspect" | "create",
  input: Record<string, unknown>,
  execute: (request: ExternalCommandRequest) => Promise<CommandResult>,
): Promise<{ code: number; value: Record<string, unknown> }> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  if (bytes.length > 4096) throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  await assertProtectedExecutableIdentity(helper);
  const result = await execute({
    argv: [helper.path, mode],
    input: bytes,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  return { code: result.code, value: parseHelperOutput(result) };
}

function credentialInput(
  record: Pick<
    BootstrapRecord,
    | "account"
    | "service"
    | "label"
    | "installationId"
    | "credentialGenerationId"
    | "keychainPath"
  >,
): Record<string, unknown> {
  return {
    schema: 1,
    account: record.account,
    service: record.service,
    label: record.label,
    installationId: record.installationId,
    credentialGenerationId: record.credentialGenerationId,
    keychainPath: record.keychainPath,
  };
}

async function inspectCredential(
  helper: ProtectedExecutableIdentity,
  record: BootstrapRecord,
  execute: (request: ExternalCommandRequest) => Promise<CommandResult>,
): Promise<InspectResult> {
  const result = await callHelper(
    helper,
    "inspect",
    credentialInput(record),
    execute,
  );
  const value = result.value;
  if (
    result.code === 0 &&
    exactKeys(value, [
      "schema",
      "broadCount",
      "exactCount",
      "itemPersistentRefSha256",
    ]) && value.schema === 1 && value.broadCount === 1 &&
    value.exactCount === 1 && HASH.test(String(value.itemPersistentRefSha256))
  ) {
    return {
      kind: "exact",
      persistentRefSha256: value.itemPersistentRefSha256 as string,
    };
  }
  if (
    result.code !== 0 &&
    exactKeys(value, ["schema", "code", "broadCount", "exactCount"]) &&
    value.schema === 1 && value.code === "KEYCHAIN_ITEM_MISSING" &&
    value.broadCount === 0 && value.exactCount === 0
  ) return { kind: "missing" };
  return helperFailure(value);
}

async function verifyHelperProvenance(
  composeRoot: string,
  record: BootstrapRecord,
): Promise<ProtectedExecutableIdentity> {
  const paths = await validateBootstrapDirectories(composeRoot);
  const [sourceHash, identity] = await Promise.all([
    hashOwnedFile(
      join(composeRoot, "scripts", "backup", "keychain-helper.swift"),
      1024 * 1024,
    ),
    validateProtectedExecutable(
      paths.helperPath,
      record.helperExecutableSha256,
    ),
  ]);
  if (sourceHash !== record.helperSourceSha256) {
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
  return identity;
}

type HelperSourceIdentity = Readonly<{
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
  mode: number;
}>;

async function readHelperSource(
  path: string,
): Promise<{ identity: HelperSourceIdentity; bytes: Uint8Array }> {
  let bytes: Uint8Array | undefined;
  try {
    if (!safeAbsolute(path) || await Deno.realPath(path) !== path) throw 0;
    const [before, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !before.isFile || before.isSymlink || before.uid !== uid ||
      before.mode === null || (before.mode & 0o022) !== 0 ||
      before.dev === null || before.ino === null ||
      !Number.isSafeInteger(before.size) || before.size < 1 ||
      before.size > 1024 * 1024
    ) throw 0;
    const file = await Deno.open(path, { read: true });
    try {
      const opened = await file.stat();
      if (
        !opened.isFile || opened.isSymlink || opened.uid !== uid ||
        opened.mode === null || (opened.mode & 0o022) !== 0 ||
        opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size
      ) throw 0;
      bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = await file.read(bytes.subarray(offset));
        if (count === null) break;
        offset += count;
      }
      if (offset !== bytes.length) throw 0;
      const sha256 = await digestBytes(bytes);
      const named = await Deno.lstat(path);
      if (
        !named.isFile || named.isSymlink || named.uid !== uid ||
        named.mode === null || named.dev !== opened.dev ||
        named.ino !== opened.ino || named.size !== opened.size ||
        (named.mode & 0o7777) !== (opened.mode & 0o7777)
      ) throw 0;
      return {
        identity: Object.freeze({
          path,
          sha256,
          dev: opened.dev!,
          ino: opened.ino!,
          size: opened.size,
          mode: opened.mode & 0o7777,
        }),
        bytes,
      };
    } finally {
      file.close();
    }
  } catch {
    bytes?.fill(0);
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
}

async function assertHelperSourceIdentity(
  expected: HelperSourceIdentity,
): Promise<void> {
  const current = await readHelperSource(expected.path);
  try {
    if (
      current.identity.path !== expected.path ||
      current.identity.sha256 !== expected.sha256 ||
      current.identity.dev !== expected.dev ||
      current.identity.ino !== expected.ino ||
      current.identity.size !== expected.size ||
      current.identity.mode !== expected.mode
    ) throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  } finally {
    current.bytes.fill(0);
  }
}

async function captureHelperSource(
  sourcePath: string,
  binDir: string,
): Promise<{ identity: HelperSourceIdentity; capturedPath: string }> {
  const source = await readHelperSource(sourcePath);
  const capturedPath = join(
    binDir,
    `.keychain-helper-source-${crypto.randomUUID()}.swift`,
  );
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(capturedPath, {
      createNew: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    let offset = 0;
    while (offset < source.bytes.length) {
      offset += await file.write(source.bytes.subarray(offset));
    }
    await file.sync();
    const [opened, named, uid] = await Promise.all([
      file.stat(),
      Deno.lstat(capturedPath),
      readEffectiveUid(),
    ]);
    if (
      !opened.isFile || opened.isSymlink || opened.uid !== uid ||
      opened.mode === null || (opened.mode & 0o7777) !== 0o600 ||
      opened.dev === null || opened.ino === null ||
      !named.isFile || named.isSymlink || named.dev !== opened.dev ||
      named.ino !== opened.ino || named.size !== source.bytes.length ||
      named.mode === null || (named.mode & 0o7777) !== 0o600
    ) throw 0;
    const directory = await Deno.open(binDir, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
    return { identity: source.identity, capturedPath };
  } catch {
    try {
      await Deno.remove(capturedPath);
    } catch { /* Nothing safe to clean up. */ }
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  } finally {
    file?.close();
    source.bytes.fill(0);
  }
}

async function compileHelper(
  composeRoot: string,
  dependencies: BootstrapDependencies,
  run: (request: ExternalCommandRequest) => Promise<CommandResult>,
): Promise<{
  sourceSha256: string;
  executableSha256: string;
  identity: ProtectedExecutableIdentity;
  sourceIdentity: HelperSourceIdentity;
}> {
  const paths = await ensureBootstrapDirectories(composeRoot);
  try {
    await Deno.lstat(paths.helperPath);
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
    }
  }
  const sourcePath = join(
    composeRoot,
    "scripts",
    "backup",
    "keychain-helper.swift",
  );
  const captured = await captureHelperSource(sourcePath, paths.binDir);
  const sourceSha256 = captured.identity.sha256;
  let capturedSource = captured.capturedPath;
  let temporary = join(
    paths.binDir,
    `.keychain-helper-${crypto.randomUUID()}.tmp`,
  );
  let moduleCache = "";
  try {
    if (dependencies.compileHelper) {
      await dependencies.compileHelper(capturedSource, temporary);
    } else {
      moduleCache = join(
        paths.binDir,
        `.swift-module-cache-${crypto.randomUUID()}`,
      );
      await Deno.mkdir(moduleCache, { mode: 0o700 });
      const [cacheInfo, uid] = await Promise.all([
        Deno.lstat(moduleCache),
        readEffectiveUid(),
      ]);
      if (
        !cacheInfo.isDirectory || cacheInfo.isSymlink ||
        cacheInfo.uid !== uid || cacheInfo.mode === null ||
        (cacheInfo.mode & 0o7777) !== 0o700
      ) {
        throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
      }
      const result = await run({
        argv: [
          "/usr/bin/swiftc",
          "-module-cache-path",
          moduleCache,
          "-parse-as-library",
          capturedSource,
          "-o",
          temporary,
        ],
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
      });
      result.stdout.fill(0);
      result.stderr.fill(0);
      if (result.code !== 0 || result.timedOut) {
        throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
      }
    }
    await Deno.chmod(temporary, 0o700);
    const executableSha256 =
      (await validateProtectedExecutable(temporary)).sha256;
    const compiledFile = await Deno.open(temporary, {
      read: true,
      write: true,
    });
    try {
      await compiledFile.sync();
    } finally {
      compiledFile.close();
    }
    await Deno.link(temporary, paths.helperPath);
    await Deno.remove(temporary);
    temporary = "";
    const directory = await Deno.open(paths.binDir, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
    const identity = await validateProtectedExecutable(
      paths.helperPath,
      executableSha256,
    );
    return {
      sourceSha256,
      executableSha256,
      identity,
      sourceIdentity: captured.identity,
    };
  } catch (error) {
    if (isCommandTerminationError(error)) throw error;
    if ((error as { code?: string })?.code === "KEYCHAIN_PROVENANCE_MISMATCH") {
      throw error;
    }
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  } finally {
    if (temporary) {
      try {
        await Deno.remove(temporary);
      } catch { /* Preserve the safe bootstrap result. */ }
    }
    if (moduleCache) {
      try {
        await Deno.remove(moduleCache, { recursive: true });
      } catch { /* Preserve the safe bootstrap result. */ }
    }
    if (capturedSource) {
      try {
        await Deno.remove(capturedSource);
      } catch { /* Preserve the safe bootstrap result. */ }
      capturedSource = "";
    }
  }
}

async function defaultCeremony(
  purpose: "create-keychain" | "attest-recovery",
): Promise<void> {
  let tty: Deno.FsFile;
  try {
    tty = await Deno.open("/dev/tty", { read: true, write: true });
  } catch {
    throw failureError("VISIBLE_TTY_REQUIRED");
  }
  const challengeBytes = new Uint8Array(16);
  crypto.getRandomValues(challengeBytes);
  const challenge = hex(challengeBytes);
  challengeBytes.fill(0);
  const expected = `CONFIRM ${challenge}`;
  const prompt = new TextEncoder().encode(
    `Mycelia backup ${purpose}: type exactly ${expected}\n> `,
  );
  const response = new Uint8Array(129);
  let count = 0;
  try {
    let written = 0;
    while (written < prompt.length) {
      written += await tty.write(prompt.subarray(written));
    }
    while (count < response.length) {
      const read = await tty.read(response.subarray(count, count + 1));
      if (read === null) break;
      if (response[count] === 0x0a) break;
      count += read;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      response.subarray(0, count),
    );
    if (text !== expected) throw failureError("VISIBLE_TTY_REQUIRED");
  } catch {
    throw failureError("VISIBLE_TTY_REQUIRED");
  } finally {
    prompt.fill(0);
    response.fill(0);
    tty.close();
  }
}

async function runMutatingBootstrap<T>(
  composeRoot: string,
  lease: OwnedLockLease,
  action: () => Promise<T>,
): Promise<T> {
  const paths = bootstrapStatePaths(composeRoot);
  const lockPath = join(paths.stateDir, "backup.lock");
  await assertOwnedLockLease(lockPath, lease);
  await assertRepositoryWritable(paths.stateDir, lease);
  try {
    return await action();
  } catch (error) {
    const termination = isCommandTerminationError(error) ? error : undefined;
    const mutationRisk = (typeof error === "object" && error)
      ? repositoryMutationRisks.get(error)
      : undefined;
    if (!termination && !mutationRisk) throw error;
    const context = ownedLockContext(lease);
    if (!context.recoveryAttempt) throw failureError("LOCK_HELD");
    const current = await readBootstrapState(composeRoot).catch(() => null);
    const repository = current?.phase === "repository_verified"
      ? { kind: "verified" as const, repositoryId: current.repositoryId }
      : { kind: "not_yet_verified" as const };
    const quarantine: ActiveRepositoryQuarantine = {
      schema: 1,
      kind: "repository-quarantine",
      quarantineId: context.recoveryAttempt.quarantineId,
      repository,
      triggeringCommand: "bootstrap",
      backupId: context.backupId,
      reason: termination
        ? (termination.terminationConfirmed
          ? "forced_kill_descendants_unproved"
          : "child_status_unconfirmed")
        : mutationRisk!.reason,
      childTerminationConfirmed: termination
        ? termination.terminationConfirmed
        : true,
      timedOut: termination ? termination.timedOut : mutationRisk!.timedOut,
      createdAtUtc: context.recoveryAttempt.reservedAtUtc,
    };
    await retainLeaseForRepositoryRecovery(paths.stateDir, lease, quarantine);
    await activateRepositoryQuarantine(paths.stateDir, lease, quarantine);
    await allowLeaseReleaseAfterRepositoryQuarantine(
      paths.stateDir,
      lease,
      quarantine.quarantineId,
    );
    throw error;
  }
}

async function initializeKeychainMutation(
  composeRoot: string,
  lease: OwnedLockLease,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  const paths = await ensureBootstrapDirectories(composeRoot);
  await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
  const baseEnvironment = await safeProcessEnvironment(
    composeRoot,
    dependencies,
  );
  const run = closedExecutor(dependencies, baseEnvironment);
  const config = await loadBackupConfig(
    composeRoot,
    baseEnvironment.HOME,
  );
  let record = await readBootstrapState(composeRoot);
  let inspection: InspectResult | undefined;
  if (record && record.phase !== "creation_pending") {
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
  if (!record) {
    const compiled = await compileHelper(composeRoot, dependencies, run);
    await assertHelperSourceIdentity(compiled.sourceIdentity);
    const resolveResult = await callHelper(
      compiled.identity,
      "resolve-default",
      { schema: 1 },
      run,
    );
    if (
      resolveResult.code !== 0 ||
      !exactKeys(resolveResult.value, ["schema", "keychainPath"]) ||
      resolveResult.value.schema !== 1 ||
      typeof resolveResult.value.keychainPath !== "string" ||
      !safeAbsolute(resolveResult.value.keychainPath)
    ) helperFailure(resolveResult.value);
    const started = (dependencies.now ?? (() => new Date().toISOString()))();
    const installationId = (dependencies.uuid ?? crypto.randomUUID)();
    const credentialGenerationId = (dependencies.uuid ?? crypto.randomUUID)();
    if (!UUID.test(installationId) || !UUID.test(credentialGenerationId)) {
      throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
    }
    record = {
      schema: 1,
      installationId,
      credentialGenerationId,
      account: config.resticKeychainAccount,
      service: config.resticKeychainService,
      label: config.resticKeychainService,
      keychainPath: resolveResult.value.keychainPath,
      helperSourceSha256: compiled.sourceSha256,
      helperExecutableSha256: compiled.executableSha256,
      bootstrapStartedAtUtc: started,
      phaseUpdatedAtUtc: started,
      phase: "creation_pending",
    };
    const before = await inspectCredential(compiled.identity, record, run);
    if (before.kind !== "missing") {
      throw failureError("KEYCHAIN_ITEM_AMBIGUOUS");
    }
    await writeBootstrapStateAtomic(composeRoot, record);
    inspection = before;
  }

  const helper = await verifyHelperProvenance(composeRoot, record);
  inspection ??= await inspectCredential(helper, record, run);
  if (inspection.kind === "missing") {
    await (dependencies.ceremony ?? defaultCeremony)("create-keychain");
    const created = await callHelper(
      helper,
      "create",
      credentialInput(record),
      run,
    );
    inspection = await inspectCredential(helper, record, run);
    if (inspection.kind !== "exact") helperFailure(created.value);
    if (
      created.code !== 0 ||
      !exactKeys(created.value, ["schema", "created"]) ||
      created.value.schema !== 1 || created.value.created !== true
    ) {
      // The exact metadata inspection is authoritative after any ambiguous
      // post-add result; no update/delete/regeneration is attempted.
      if (inspection.kind !== "exact") helperFailure(created.value);
    }
  }
  if (inspection.kind !== "exact") {
    throw failureError("KEYCHAIN_ITEM_MISSING");
  }
  const updatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  await writeBootstrapStateAtomic(composeRoot, {
    ...record,
    phase: "created_unconfirmed",
    phaseUpdatedAtUtc: updatedAt,
    credentialCreatedAtUtc: updatedAt,
    itemPersistentRefSha256: inspection.persistentRefSha256,
  });
}

export async function initializeKeychain(
  composeRoot: string,
  lease: OwnedLockLease,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  return await runMutatingBootstrap(
    composeRoot,
    lease,
    () => initializeKeychainMutation(composeRoot, lease, dependencies),
  );
}

async function attestRecoveryMutation(
  composeRoot: string,
  lease: OwnedLockLease,
  receiptId: string,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  const paths = await validateBootstrapDirectories(composeRoot);
  await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
  const baseEnvironment = await safeProcessEnvironment(
    composeRoot,
    dependencies,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(receiptId)) {
    throw failureError("RECOVERY_RECEIPT_MISSING");
  }
  const record = await readBootstrapState(composeRoot);
  if (!record || record.phase !== "created_unconfirmed") {
    throw failureError("RECOVERY_RECEIPT_MISSING");
  }
  const helper = await verifyHelperProvenance(composeRoot, record);
  const inspected = await inspectCredential(
    helper,
    record,
    closedExecutor(dependencies, baseEnvironment),
  );
  if (
    inspected.kind !== "exact" ||
    inspected.persistentRefSha256 !== record.itemPersistentRefSha256
  ) throw failureError("KEYCHAIN_ITEM_AMBIGUOUS");
  await (dependencies.ceremony ?? defaultCeremony)("attest-recovery");
  const updatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  await writeBootstrapStateAtomic(composeRoot, {
    ...record,
    phase: "recovery_attested",
    phaseUpdatedAtUtc: updatedAt,
    recoveryReceiptId: receiptId,
    recoveryAttestedAtUtc: updatedAt,
  });
}

export async function attestRecovery(
  composeRoot: string,
  lease: OwnedLockLease,
  receiptId: string,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  return await runMutatingBootstrap(
    composeRoot,
    lease,
    () => attestRecoveryMutation(composeRoot, lease, receiptId, dependencies),
  );
}

const REMOTE_OWNER_MARKER_SCRIPT = `umask 077
if mkdir mycelia 2>/dev/null; then
  :
else
  [ -d mycelia ] && [ ! -L mycelia ]
  [ "$(/usr/bin/stat -c '%U' -- mycelia)" = pk ]
  [ "$(/usr/bin/stat -c '%a' -- mycelia)" = 700 ]
  [ -z "$(/usr/bin/find mycelia -mindepth 1 -maxdepth 1 -print -quit)" ]
fi
cd mycelia
[ -d . ] && [ ! -L . ]
[ "$(/usr/bin/stat -c '%U' -- .)" = pk ]
[ "$(/usr/bin/stat -c '%a' -- .)" = 700 ]
set -C
/bin/cat > owner-v1.json
`;

const REMOTE_OWNER_STAT_SCRIPT = `set -eu
[ -d mycelia ] && [ ! -L mycelia ]
[ "$(/usr/bin/stat -c '%U' -- mycelia)" = pk ]
[ "$(/usr/bin/stat -c '%a' -- mycelia)" = 700 ]
[ -f mycelia/owner-v1.json ] && [ ! -L mycelia/owner-v1.json ]
[ "$(/usr/bin/stat -c '%U' -- mycelia/owner-v1.json)" = pk ]
[ "$(/usr/bin/stat -c '%a' -- mycelia/owner-v1.json)" = 600 ]
printf 'ok\n'
`;

function fixedRemoteShellCommand(script: string): string {
  return `/bin/sh -ceu '${script.replaceAll("'", `'\\''`)}'`;
}

const REMOTE_OWNER_MARKER_COMMAND = fixedRemoteShellCommand(
  REMOTE_OWNER_MARKER_SCRIPT,
);
const MUTATING_TERMINATION_GRACE_MS = 30_000;
const REMOTE_OWNER_STAT_COMMAND = fixedRemoteShellCommand(
  REMOTE_OWNER_STAT_SCRIPT,
);

type PasswordWrapperIdentity = Readonly<{
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
  mode: number;
}>;

function inheritedEnvironment(
  dependencies: BootstrapDependencies,
): Readonly<Record<string, string>> {
  return dependencies.inheritedEnvironment ?? Deno.env.toObject();
}

function assertNoBackupOverrides(dependencies: BootstrapDependencies): void {
  if (
    Object.keys(inheritedEnvironment(dependencies)).some((name) =>
      name.startsWith("RESTIC_") || name.startsWith("RCLONE_")
    )
  ) throw failureError("CONFIG_INVALID");
}

async function validatePasswordWrapper(
  composeRoot: string,
): Promise<PasswordWrapperIdentity> {
  const path = join(composeRoot, "scripts", "restic-password-command");
  try {
    if (!safeAbsolute(path) || await Deno.realPath(path) !== path) throw 0;
    const [info, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !info.isFile || info.isSymlink || info.uid !== uid ||
      info.mode === null ||
      (info.mode & 0o022) !== 0 || (info.mode & 0o500) !== 0o500 ||
      info.dev === null || info.ino === null ||
      !Number.isSafeInteger(info.size) || info.size < 1 ||
      info.size > 1024 * 1024
    ) throw 0;
    const file = await Deno.open(path, { read: true });
    try {
      const opened = await file.stat();
      if (
        !opened.isFile || opened.isSymlink || opened.uid !== uid ||
        opened.mode === null || (opened.mode & 0o022) !== 0 ||
        (opened.mode & 0o500) !== 0o500 || opened.dev !== info.dev ||
        opened.ino !== info.ino || opened.size !== info.size
      ) throw 0;
      const bytes = new Uint8Array(opened.size);
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const count = await file.read(bytes.subarray(offset));
          if (count === null) break;
          offset += count;
        }
        if (offset !== bytes.length) throw 0;
        const sha256 = hex(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes.buffer),
          ),
        );
        const named = await Deno.lstat(path);
        if (
          !named.isFile || named.isSymlink || named.uid !== uid ||
          named.mode === null || named.dev !== opened.dev ||
          named.ino !== opened.ino || named.size !== opened.size ||
          (named.mode & 0o7777) !== (opened.mode & 0o7777)
        ) throw 0;
        return Object.freeze({
          path,
          sha256,
          dev: opened.dev!,
          ino: opened.ino!,
          size: opened.size,
          mode: opened.mode & 0o7777,
        });
      } finally {
        bytes.fill(0);
      }
    } finally {
      file.close();
    }
  } catch {
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
}

async function assertPasswordWrapperIdentity(
  expected: PasswordWrapperIdentity,
): Promise<void> {
  const current = await validatePasswordWrapper(
    expected.path.slice(0, -"/scripts/restic-password-command".length),
  );
  if (
    current.path !== expected.path || current.dev !== expected.dev ||
    current.ino !== expected.ino || current.size !== expected.size ||
    current.mode !== expected.mode || current.sha256 !== expected.sha256
  ) throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  try {
    return hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
    );
  } finally {
    copy.fill(0);
  }
}

function ownerMarkerBytes(
  installationId: string,
  createdAtUtc: string,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: 1,
    installationId,
    createdAtUtc,
    children: [...OWNER_CHILDREN],
  }));
}

async function resolveTransport(
  composeRoot: string,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<
  Readonly<{
    transport: PkBackupSshTransport;
    rcloneConfig: RcloneConfigIdentity;
  }>
> {
  assertNoBackupOverrides(dependencies);
  if (dependencies.transport) {
    const transport = await dependencies.transport();
    return Object.freeze({
      transport,
      rcloneConfig: await pinRcloneConfig(transport.rcloneConfigPath),
    });
  }
  const config = await loadBackupConfig(
    composeRoot,
    base.HOME,
  );
  const rcloneConfig = await pinDefaultRcloneConfig(config.homeDir);
  const transport = await resolvePkBackupSshTransport(
    closedRunner(base, dependencies.runner),
    config.homeDir,
    rcloneConfig,
  );
  return Object.freeze({ transport, rcloneConfig });
}

async function rawCommandOutput(
  run: (request: ExternalCommandRequest) => Promise<CommandResult>,
  request: ExternalCommandRequest,
  code:
    | "REMOTE_NAMESPACE_UNKNOWN"
    | "RESTIC_INIT_FAILED"
    | "RESTIC_VERIFY_FAILED",
): Promise<Uint8Array> {
  const result = await run(request).catch((error) => {
    if (isCommandTerminationError(error)) throw error;
    throw rememberCommandFailure(failureError(code), false);
  });
  try {
    if (!result.terminationConfirmed || result.forcedKill) {
      throw commandTerminationError(
        result.timedOut,
        result.terminationConfirmed,
        result.forcedKill,
      );
    }
    if (result.code !== 0 || result.timedOut) {
      throw rememberCommandFailure(failureError(code), result.timedOut);
    }
    return result.stdout.slice();
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function runOwnerMarkerWriter(
  marker: Uint8Array,
  transport: PkBackupSshTransport,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  const output = await rawCommandOutput(closedExecutor(dependencies, base), {
    argv: [...transport.sshArgv, REMOTE_OWNER_MARKER_COMMAND],
    input: marker,
    timeoutMs: 30_000,
    terminationGraceMs: MUTATING_TERMINATION_GRACE_MS,
    maxOutputBytes: 64 * 1024,
  }, "REMOTE_NAMESPACE_UNKNOWN");
  output.fill(0);
}

function parseListing(bytes: Uint8Array): string[] {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\r") || (!text.endsWith("\n") && text !== "")) {
      throw 0;
    }
    const entries = text === "" ? [] : text.slice(0, -1).split("\n");
    if (
      entries.some((entry) => !entry) ||
      new Set(entries).size !== entries.length
    ) throw 0;
    return entries;
  } catch {
    throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  } finally {
    bytes.fill(0);
  }
}

async function verifyOwnerMarker(
  expected: Uint8Array,
  transport: PkBackupSshTransport,
  rcloneConfig: RcloneConfigIdentity,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<readonly string[]> {
  const run = closedExecutor(dependencies, base);
  const rcloneEnv = Object.freeze({
    ...base,
    RCLONE_CONFIG: transport.rcloneConfigPath,
  });
  assertNoBackupOverrides(dependencies);
  await assertRcloneConfigIdentity(rcloneConfig);
  const actual = await rawCommandOutput(run, {
    argv: ["rclone", "cat", `pk-backup:mycelia/${OWNER_MARKER}`],
    env: rcloneEnv,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  }, "REMOTE_NAMESPACE_UNKNOWN");
  try {
    if (
      actual.length !== expected.length ||
      !actual.every((byte, index) => byte === expected[index])
    ) throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  } finally {
    actual.fill(0);
  }
  assertNoBackupOverrides(dependencies);
  const stat = await rawCommandOutput(run, {
    argv: [...transport.sshArgv, REMOTE_OWNER_STAT_COMMAND],
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  }, "REMOTE_NAMESPACE_UNKNOWN");
  try {
    if (new TextDecoder().decode(stat) !== "ok\n") {
      throw failureError("REMOTE_NAMESPACE_UNKNOWN");
    }
  } finally {
    stat.fill(0);
  }
  assertNoBackupOverrides(dependencies);
  await assertRcloneConfigIdentity(rcloneConfig);
  const listing = parseListing(
    await rawCommandOutput(run, {
      argv: ["rclone", "lsf", "pk-backup:mycelia"],
      env: rcloneEnv,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    }, "REMOTE_NAMESPACE_UNKNOWN"),
  );
  const allowed = new Set<string>([OWNER_MARKER, ...OWNER_CHILDREN]);
  if (
    !listing.includes(OWNER_MARKER) ||
    listing.some((entry) => !allowed.has(entry))
  ) throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  return Object.freeze(listing);
}

type InterruptedRemoteMutationAudit = Readonly<{
  reason: "producer_survived" | "producer_audit_unverified";
}>;

async function attestAfterInterruptedRemoteMutation(
  marker: Uint8Array,
  transport: PkBackupSshTransport,
  rcloneConfig: RcloneConfigIdentity,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<InterruptedRemoteMutationAudit> {
  try {
    await verifyOwnerMarker(
      marker,
      transport,
      rcloneConfig,
      dependencies,
      base,
    );
  } catch (error) {
    if (isCommandTerminationError(error)) throw error;
    return Object.freeze({ reason: "producer_audit_unverified" });
  }
  // Task 5 can read back the marker but has no bounded host/container
  // descendant audit. Marker visibility therefore never proves that every
  // producer is gone; Task 7 owns the concrete recovery audit commands.
  return Object.freeze({ reason: "producer_audit_unverified" });
}

function higherPriorityInterruptedMutationError(
  original: unknown,
  audit: unknown,
): unknown {
  const originalTermination = isCommandTerminationError(original)
    ? original
    : undefined;
  const auditTermination = isCommandTerminationError(audit) ? audit : undefined;
  if (!auditTermination) return original;
  if (!originalTermination) return auditTermination;
  if (!originalTermination.terminationConfirmed) return originalTermination;
  if (!auditTermination.terminationConfirmed) return auditTermination;
  return originalTermination;
}

async function runFullPreflight(
  composeRoot: string,
  record: BootstrapRecord,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
  lease?: OwnedLockLease,
): Promise<PreflightReport> {
  assertNoBackupOverrides(dependencies);
  const report =
    await (dependencies.preflight ?? ((options) =>
      runPreflight(options, {
        runner: closedRunner(base, dependencies.runner),
        homeDir: base.HOME,
      })))({
        composeRoot,
        remoteMode: "full",
        expectedInstallationId: record.installationId,
        ...(lease ? { lockLease: lease } : {}),
        ...(lease ? { backupId: ownedLockContext(lease).backupId } : {}),
      });
  if (!report.ok || !report.localVerified || !report.remoteVerified) {
    throw failureError(report.failure ?? "REMOTE_NAMESPACE_UNKNOWN");
  }
  return report;
}

async function verifyCredential(
  composeRoot: string,
  record: BootstrapRecord,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<void> {
  if (record.phase === "creation_pending") {
    throw failureError("KEYCHAIN_ITEM_MISSING");
  }
  const helper = await verifyHelperProvenance(composeRoot, record);
  const inspected = await inspectCredential(
    helper,
    record,
    closedExecutor(dependencies, base),
  );
  if (
    inspected.kind !== "exact" ||
    inspected.persistentRefSha256 !== record.itemPersistentRefSha256
  ) throw failureError("KEYCHAIN_ITEM_AMBIGUOUS");
}

function resticEnvironment(
  composeRoot: string,
  repository: string,
  wrapper: PasswordWrapperIdentity,
  transport: PkBackupSshTransport,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): ClosedResticEnvironment {
  return buildResticEnvironment({
    composeRoot,
    repository,
    passwordCommandPath: wrapper.path,
    rcloneConfigPath: transport.rcloneConfigPath,
    homeDir: base.HOME,
    inheritedEnvironment: inheritedEnvironment(dependencies),
  });
}

async function runRestic(
  args: readonly string[],
  env: ClosedResticEnvironment,
  wrapper: PasswordWrapperIdentity,
  rcloneConfig: RcloneConfigIdentity,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
  code: "RESTIC_INIT_FAILED" | "RESTIC_VERIFY_FAILED",
): Promise<Uint8Array> {
  assertNoBackupOverrides(dependencies);
  await assertRcloneConfigIdentity(rcloneConfig);
  await assertPasswordWrapperIdentity(wrapper);
  return await rawCommandOutput(closedExecutor(dependencies, base), {
    argv: ["restic", ...args],
    env,
    timeoutMs: 120_000,
    ...(args[0] === "init"
      ? { terminationGraceMs: MUTATING_TERMINATION_GRACE_MS }
      : {}),
    maxOutputBytes: 1024 * 1024,
  }, code);
}

async function readRepositoryId(
  env: ClosedResticEnvironment,
  wrapper: PasswordWrapperIdentity,
  rcloneConfig: RcloneConfigIdentity,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
): Promise<string> {
  const output = await runRestic(
    ["cat", "config"],
    env,
    wrapper,
    rcloneConfig,
    dependencies,
    base,
    "RESTIC_VERIFY_FAILED",
  );
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(output),
    );
    if (!value || typeof value !== "object" || !HASH.test(String(value.id))) {
      throw 0;
    }
    return value.id;
  } catch {
    throw failureError("RESTIC_VERIFY_FAILED");
  } finally {
    output.fill(0);
  }
}

async function verifySnapshots(
  env: ClosedResticEnvironment,
  wrapper: PasswordWrapperIdentity,
  rcloneConfig: RcloneConfigIdentity,
  dependencies: BootstrapDependencies,
  base: SafeProcessEnvironment,
  requireEmpty = false,
): Promise<void> {
  const output = await runRestic(
    ["snapshots", "--json"],
    env,
    wrapper,
    rcloneConfig,
    dependencies,
    base,
    "RESTIC_VERIFY_FAILED",
  );
  try {
    const snapshots = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(output),
    );
    if (!Array.isArray(snapshots) || (requireEmpty && snapshots.length !== 0)) {
      throw 0;
    }
  } catch {
    throw failureError("RESTIC_VERIFY_FAILED");
  } finally {
    output.fill(0);
  }
}

async function initializeRepositoryMutation(
  composeRoot: string,
  lease: OwnedLockLease,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  const paths = await validateBootstrapDirectories(composeRoot);
  await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
  const baseEnvironment = await safeProcessEnvironment(
    composeRoot,
    dependencies,
  );
  let record = await readBootstrapState(composeRoot);
  if (!record || record.phase !== "recovery_attested") {
    throw failureError("RESTIC_VERIFY_FAILED");
  }
  await verifyCredential(composeRoot, record, dependencies, baseEnvironment);
  const preflight = await runFullPreflight(
    composeRoot,
    record,
    dependencies,
    baseEnvironment,
    lease,
  );
  const hasMarkerIntent = record.ownerMarkerSha256 !== undefined;
  if (
    preflight.namespace !== (hasMarkerIntent ? "owned" : "reservable")
  ) throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  const resolvedTransport = await resolveTransport(
    composeRoot,
    dependencies,
    baseEnvironment,
  );
  const { transport, rcloneConfig } = resolvedTransport;
  const wrapper = await validatePasswordWrapper(composeRoot);
  let newlyPersistedMarkerIntent = false;
  let marker: Uint8Array;
  if (!hasMarkerIntent) {
    const createdAtUtc = (dependencies.now ?? (() =>
      new Date().toISOString()))();
    marker = ownerMarkerBytes(record.installationId, createdAtUtc);
    const markerSha256 = await digestBytes(marker);
    const intended: BootstrapRecord = {
      ...record,
      phaseUpdatedAtUtc: createdAtUtc,
      ownerMarkerCreatedAtUtc: createdAtUtc,
      ownerMarkerSha256: markerSha256,
    };
    await writeBootstrapStateAtomic(composeRoot, intended);
    newlyPersistedMarkerIntent = true;
    record = intended;
    await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
    await assertRepositoryWritable(paths.stateDir, lease);
    try {
      await runOwnerMarkerWriter(
        marker,
        transport,
        dependencies,
        baseEnvironment,
      );
    } catch (error) {
      let audit: InterruptedRemoteMutationAudit;
      try {
        audit = await attestAfterInterruptedRemoteMutation(
          marker,
          transport,
          rcloneConfig,
          dependencies,
          baseEnvironment,
        );
      } catch (auditError) {
        throw higherPriorityInterruptedMutationError(error, auditError);
      }
      rememberRepositoryMutationRisk(error, audit.reason);
      throw error;
    }
  } else {
    marker = ownerMarkerBytes(
      record.installationId,
      record.ownerMarkerCreatedAtUtc!,
    );
    if (await digestBytes(marker) !== record.ownerMarkerSha256) {
      marker.fill(0);
      throw failureError("REMOTE_NAMESPACE_UNKNOWN");
    }
  }
  try {
    const entries = await verifyOwnerMarker(
      marker,
      transport,
      rcloneConfig,
      dependencies,
      baseEnvironment,
    );
    const config = await loadBackupConfig(
      composeRoot,
      baseEnvironment.HOME,
    );
    const env = resticEnvironment(
      composeRoot,
      config.resticRepository,
      wrapper,
      transport,
      dependencies,
      baseEnvironment,
    );
    const repositoryPresent = entries.includes("restic-v1/");
    if (!repositoryPresent) {
      if (!newlyPersistedMarkerIntent) {
        throw failureError("RESTIC_INIT_FAILED");
      }
      await assertRepositoryWritable(paths.stateDir, lease);
      const output = await runRestic(
        ["init"],
        env,
        wrapper,
        rcloneConfig,
        dependencies,
        baseEnvironment,
        "RESTIC_INIT_FAILED",
      );
      output.fill(0);
    }
    const repositoryId = await readRepositoryId(
      env,
      wrapper,
      rcloneConfig,
      dependencies,
      baseEnvironment,
    );
    await verifySnapshots(
      env,
      wrapper,
      rcloneConfig,
      dependencies,
      baseEnvironment,
      true,
    );
    await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
    const verifiedAt = (dependencies.now ?? (() => new Date().toISOString()))();
    await writeBootstrapStateAtomic(composeRoot, {
      ...record,
      phase: "repository_verified",
      phaseUpdatedAtUtc: verifiedAt,
      repositoryId,
      repositoryVerifiedAtUtc: verifiedAt,
    });
  } catch (error) {
    if (newlyPersistedMarkerIntent) {
      let audit: InterruptedRemoteMutationAudit;
      try {
        audit = await attestAfterInterruptedRemoteMutation(
          marker,
          transport,
          rcloneConfig,
          dependencies,
          baseEnvironment,
        );
      } catch (auditError) {
        throw higherPriorityInterruptedMutationError(error, auditError);
      }
      rememberRepositoryMutationRisk(error, audit.reason);
    }
    throw error;
  } finally {
    marker.fill(0);
  }
}

export async function initializeRepository(
  composeRoot: string,
  lease: OwnedLockLease,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  assertNoBackupOverrides(dependencies);
  return await runMutatingBootstrap(
    composeRoot,
    lease,
    () => initializeRepositoryMutation(composeRoot, lease, dependencies),
  );
}

async function verifyRepositoryRecord(
  composeRoot: string,
  record: Extract<BootstrapRecord, { phase: "repository_verified" }>,
  dependencies: BootstrapDependencies,
  lease?: OwnedLockLease,
): Promise<VerifiedResticContext> {
  assertNoBackupOverrides(dependencies);
  const paths = await validateBootstrapDirectories(composeRoot);
  const baseEnvironment = await safeProcessEnvironment(
    composeRoot,
    dependencies,
  );
  if (lease) {
    await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
  }
  await verifyCredential(composeRoot, record, dependencies, baseEnvironment);
  const preflight = await runFullPreflight(
    composeRoot,
    record,
    dependencies,
    baseEnvironment,
    lease,
  );
  if (preflight.namespace !== "owned") {
    throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  }
  const resolvedTransport = await resolveTransport(
    composeRoot,
    dependencies,
    baseEnvironment,
  );
  const { transport, rcloneConfig } = resolvedTransport;
  const wrapper = await validatePasswordWrapper(composeRoot);
  const marker = ownerMarkerBytes(
    record.installationId,
    record.ownerMarkerCreatedAtUtc,
  );
  try {
    if (await digestBytes(marker) !== record.ownerMarkerSha256) {
      throw failureError("REMOTE_NAMESPACE_UNKNOWN");
    }
    const entries = await verifyOwnerMarker(
      marker,
      transport,
      rcloneConfig,
      dependencies,
      baseEnvironment,
    );
    if (!entries.includes("restic-v1/")) {
      throw failureError("RESTIC_VERIFY_FAILED");
    }
    const config = await loadBackupConfig(
      composeRoot,
      baseEnvironment.HOME,
    );
    const env = resticEnvironment(
      composeRoot,
      config.resticRepository,
      wrapper,
      transport,
      dependencies,
      baseEnvironment,
    );
    assertClosedResticEnvironment(env);
    const repositoryId = await readRepositoryId(
      env,
      wrapper,
      rcloneConfig,
      dependencies,
      baseEnvironment,
    );
    if (repositoryId !== record.repositoryId) {
      throw failureError("REPOSITORY_ID_MISMATCH");
    }
    await verifySnapshots(
      env,
      wrapper,
      rcloneConfig,
      dependencies,
      baseEnvironment,
    );
    if (lease) {
      await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lease);
    }
    return Object.freeze({
      env,
      repositoryId,
      installationId: record.installationId,
      preflight,
      assertUnchanged: async () => {
        await assertRcloneConfigIdentity(rcloneConfig);
        await assertPasswordWrapperIdentity(wrapper);
        if (lease) {
          await assertOwnedLockLease(
            join(paths.stateDir, "backup.lock"),
            lease,
          );
        }
      },
    });
  } finally {
    marker.fill(0);
  }
}

export async function checkBootstrap(
  composeRoot: string,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  await assertRepositoryWritable(bootstrapStatePaths(composeRoot).stateDir);
  const record = await readBootstrapState(composeRoot);
  if (!record || record.phase !== "repository_verified") {
    throw failureError("RESTIC_VERIFY_FAILED");
  }
  await verifyRepositoryRecord(composeRoot, record, dependencies);
}

export async function loadVerifiedResticContext(
  composeRoot: string,
  lockLease: OwnedLockLease,
  dependencies: VerifiedResticDependencies = {},
): Promise<VerifiedResticContext> {
  if (
    !dependencies || typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    Object.getPrototypeOf(dependencies) !== Object.prototype ||
    Object.keys(dependencies).some((key) =>
      key !== "runner" && key !== "homeDir"
    ) ||
    (dependencies.homeDir !== undefined &&
      typeof dependencies.homeDir !== "string") ||
    (dependencies.runner !== undefined &&
      (typeof dependencies.runner.run !== "function" ||
        typeof dependencies.runner.spawn !== "function"))
  ) throw failureError("CONFIG_INVALID");
  const internalDependencies: BootstrapDependencies = Object.freeze({
    ...(dependencies.runner ? { runner: dependencies.runner } : {}),
    ...(dependencies.homeDir ? { homeDir: dependencies.homeDir } : {}),
  });
  const paths = await validateBootstrapDirectories(composeRoot);
  await assertOwnedLockLease(join(paths.stateDir, "backup.lock"), lockLease);
  const record = await readBootstrapState(composeRoot);
  if (!record || record.phase !== "repository_verified") {
    throw failureError("RESTIC_VERIFY_FAILED");
  }
  return await verifyRepositoryRecord(
    composeRoot,
    record,
    internalDependencies,
    lockLease,
  );
}

function validPasswordContext(value: PasswordContext): boolean {
  const label = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return label.test(value.account) && label.test(value.service) &&
    value.label === value.service && uuid.test(value.installationId) &&
    uuid.test(value.credentialGenerationId) && safeAbsolute(value.keychainPath);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashOwnedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  try {
    const [before, uid, real] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
      Deno.realPath(path),
    ]);
    if (
      real !== path || !before.isFile || before.isSymlink ||
      before.uid !== uid ||
      before.mode === null || (before.mode & 0o022) !== 0 ||
      before.dev === null || before.ino === null || before.size > maximumBytes
    ) throw 0;
    const file = await Deno.open(path, { read: true });
    try {
      const opened = await file.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw 0;
      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = await file.read(bytes.subarray(offset));
        if (count === null) break;
        offset += count;
      }
      if (offset !== bytes.length) throw 0;
      const copy = Uint8Array.from(bytes);
      bytes.fill(0);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", copy.buffer),
      );
      copy.fill(0);
      return hex(digest);
    } finally {
      file.close();
    }
  } catch {
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
}

async function assertStrictBackupEnvironment(
  composeRoot: string,
): Promise<void> {
  const path = join(composeRoot, ".env.backup");
  let text: string;
  try {
    const [info, uid, real] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
      Deno.realPath(path),
    ]);
    if (
      real !== path || !info.isFile || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o7777) !== 0o600 ||
      info.size > 1024 * 1024
    ) throw 0;
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw failureError("CONFIG_INVALID");
  }
  const parsed = parseEnvText(path, text);
  if (parsed.malformed.length) throw failureError("CONFIG_INVALID");
  const names = new Set<string>();
  for (const assignment of parsed.active) {
    if (names.has(assignment.key)) throw failureError("CONFIG_INVALID");
    names.add(assignment.key);
  }
}

export async function loadPasswordContext(
  composeRoot: string,
  homeDir: string,
): Promise<PasswordContext> {
  try {
    if (!safeAbsolute(composeRoot)) throw 0;
    await assertStrictBackupEnvironment(composeRoot);
    const baseEnvironment = await validateHomeDirectory(homeDir);
    const paths = await validateBootstrapDirectories(composeRoot);
    const [config, record] = await Promise.all([
      loadBackupConfig(composeRoot, baseEnvironment.HOME),
      readBootstrapState(composeRoot),
    ]);
    if (
      !record ||
      !["recovery_attested", "repository_verified"].includes(record.phase) ||
      record.account !== config.resticKeychainAccount ||
      record.service !== config.resticKeychainService ||
      record.label !== record.service
    ) throw 0;
    const sourcePath = join(
      composeRoot,
      "scripts",
      "backup",
      "keychain-helper.swift",
    );
    const [sourceHash] = await Promise.all([
      hashOwnedFile(sourcePath, 1024 * 1024),
      validateProtectedExecutable(
        paths.helperPath,
        record.helperExecutableSha256,
      ),
    ]);
    if (sourceHash !== record.helperSourceSha256) throw 0;
    const context: PasswordContext = Object.freeze({
      account: record.account,
      service: record.service,
      label: record.label,
      installationId: record.installationId,
      credentialGenerationId: record.credentialGenerationId,
      keychainPath: record.keychainPath,
    });
    if (!validPasswordContext(context)) throw 0;
    return context;
  } catch (error) {
    if ((error as { code?: string })?.code === "CONFIG_INVALID") throw error;
    throw failureError("KEYCHAIN_PROVENANCE_MISMATCH");
  }
}

export async function runSecurityLookupForTest(
  argv: readonly string[],
  environment: BaseChildEnvironment,
  runner: Runner = new DenoRunner(),
): Promise<CommandResult> {
  if (argv[0] !== "/usr/bin/security") {
    throw failureError("KEYCHAIN_UNAVAILABLE");
  }
  try {
    return await runner.run(argv, {
      timeoutMs: 30_000,
      maxOutputBytes: 128 + 4_096,
      terminationGraceMs: 250,
      terminationConfirmMs: 1_000,
      clearEnv: true,
      env: environment,
    });
  } catch (error) {
    if (isCommandTerminationError(error)) throw error;
    throw failureError("KEYCHAIN_UNAVAILABLE");
  }
}

export async function passwordCommandMain(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: PasswordCommandDependencies = {},
): Promise<number> {
  let stdout: Uint8Array | undefined;
  let stderr: Uint8Array | undefined;
  let password: Uint8Array | undefined;
  try {
    const composeRoot = environment.MYCELIA_BACKUP_COMPOSE_ROOT;
    const homeDir = environment.HOME;
    if (
      args.length !== 0 || !composeRoot || !safeAbsolute(composeRoot) ||
      !homeDir
    ) {
      return 1;
    }
    const baseEnvironment = await validateHomeDirectory(homeDir);
    const context = await (dependencies.loadContext ?? loadPasswordContext)(
      composeRoot,
      baseEnvironment.HOME,
    );
    if (!validPasswordContext(context)) return 1;
    const result = await (
      dependencies.securityLookup ?? runSecurityLookupForTest
    )(
      [
        "/usr/bin/security",
        "find-generic-password",
        "-w",
        "-a",
        context.account,
        "-s",
        context.service,
        "-l",
        context.label,
        "-G",
        context.credentialGenerationId,
        "-j",
        context.installationId,
        context.keychainPath,
      ],
      baseEnvironment,
    );
    stdout = result.stdout;
    stderr = result.stderr;
    if (result.code !== 0 || result.timedOut) return 1;
    const length = stdout.length === 65 && stdout[64] === 0x0a
      ? 64
      : stdout.length;
    if (
      length !== 64 ||
      !stdout.subarray(0, length).every((byte) =>
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)
      )
    ) return 1;
    password = stdout.slice(0, 64);
    const write = dependencies.write ??
      ((bytes: Uint8Array) => Deno.stdout.write(bytes));
    let offset = 0;
    while (offset < password.length) {
      const count = await write(password.subarray(offset));
      if (
        !Number.isSafeInteger(count) || count <= 0 ||
        count > password.length - offset
      ) throw failureError("KEYCHAIN_UNAVAILABLE");
      offset += count;
    }
    return 0;
  } catch {
    return 1;
  } finally {
    stdout?.fill(0);
    stderr?.fill(0);
    password?.fill(0);
  }
}
