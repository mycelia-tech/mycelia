import { isAbsolute, join, normalize } from "node:path";
import {
  boundedJson,
  closedObject,
  invalidState,
  isUtc,
  MAX_RECORD_BYTES,
} from "./redact.ts";
import { readEffectiveUid } from "./state.ts";

type BootstrapCommon = {
  schema: 1;
  installationId: string;
  credentialGenerationId: string;
  account: string;
  service: string;
  label: string;
  keychainPath: string;
  helperSourceSha256: string;
  helperExecutableSha256: string;
  bootstrapStartedAtUtc: string;
  phaseUpdatedAtUtc: string;
};
type CreatedFields = {
  credentialCreatedAtUtc: string;
  itemPersistentRefSha256: string;
};
type RecoveryFields = {
  recoveryReceiptId: string;
  recoveryAttestedAtUtc: string;
};
type MarkerIntent = {
  ownerMarkerCreatedAtUtc: string;
  ownerMarkerSha256: string;
};
type NoMarkerIntent = {
  ownerMarkerCreatedAtUtc?: never;
  ownerMarkerSha256?: never;
};

export type BootstrapRecord =
  & BootstrapCommon
  & (
    | { phase: "creation_pending" }
    | ({ phase: "created_unconfirmed" } & CreatedFields)
    | (
      & { phase: "recovery_attested" }
      & CreatedFields
      & RecoveryFields
      & (NoMarkerIntent | MarkerIntent)
    )
    | (
      & { phase: "repository_verified" }
      & CreatedFields
      & RecoveryFields
      & MarkerIntent
      & {
        repositoryId: string;
        repositoryVerifiedAtUtc: string;
      }
    )
  );

export type BootstrapStatePaths = {
  stateDir: string;
  binDir: string;
  recordPath: string;
  helperPath: string;
};

const RECORD_FIELDS = [
  "schema",
  "installationId",
  "credentialGenerationId",
  "account",
  "service",
  "label",
  "keychainPath",
  "helperSourceSha256",
  "helperExecutableSha256",
  "bootstrapStartedAtUtc",
  "phaseUpdatedAtUtc",
  "phase",
  "credentialCreatedAtUtc",
  "itemPersistentRefSha256",
  "recoveryReceiptId",
  "recoveryAttestedAtUtc",
  "ownerMarkerCreatedAtUtc",
  "ownerMarkerSha256",
  "repositoryId",
  "repositoryVerifiedAtUtc",
] as const;
const COMMON_FIELDS = RECORD_FIELDS.slice(0, 11);
const CREATED_FIELDS = ["credentialCreatedAtUtc", "itemPersistentRefSha256"];
const RECOVERY_FIELDS = ["recoveryReceiptId", "recoveryAttestedAtUtc"];
const MARKER_FIELDS = ["ownerMarkerCreatedAtUtc", "ownerMarkerSha256"];
const REPOSITORY_FIELDS = ["repositoryId", "repositoryVerifiedAtUtc"];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function safeCanonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 &&
    isAbsolute(value) && normalize(value) === value &&
    ![...value].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) && !value.split("/").includes("..");
}

function exactMetadata(
  info: Deno.FileInfo,
  kind: "file" | "directory",
  mode: number,
  uid: number,
): boolean {
  return !info.isSymlink && info.uid === uid && info.mode !== null &&
    (info.mode & 0o7777) === mode &&
    (kind === "file" ? info.isFile : info.isDirectory);
}

function identityMatches(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.dev !== null && left.ino !== null &&
    left.dev === right.dev && left.ino === right.ino;
}

export function bootstrapStatePaths(composeRoot: string): BootstrapStatePaths {
  if (!safeCanonicalPath(composeRoot)) invalidState();
  const stateDir = join(composeRoot, ".local", "backup");
  const binDir = join(stateDir, "bin");
  return {
    stateDir,
    binDir,
    recordPath: join(stateDir, "bootstrap-v1.json"),
    helperPath: join(binDir, "keychain-helper-v1"),
  };
}

export async function validateBootstrapComposeRoot(
  composeRoot: string,
): Promise<string> {
  try {
    bootstrapStatePaths(composeRoot);
    if (await Deno.realPath(composeRoot) !== composeRoot) invalidState();
    const [info, uid] = await Promise.all([
      Deno.lstat(composeRoot),
      readEffectiveUid(),
    ]);
    if (
      !info.isDirectory || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o022) !== 0
    ) invalidState();
    return composeRoot;
  } catch {
    invalidState();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

async function ensureDirectory(parent: string, path: string): Promise<void> {
  const uid = await readEffectiveUid();
  try {
    const info = await Deno.lstat(path);
    if (!exactMetadata(info, "directory", 0o700, uid)) invalidState();
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) invalidState();
  }
  try {
    await Deno.mkdir(path, { mode: 0o700 });
    await syncDirectory(parent);
  } catch {
    invalidState();
  }
  const info = await Deno.lstat(path).catch(() => invalidState());
  if (!exactMetadata(info, "directory", 0o700, uid)) invalidState();
}

export async function ensureBootstrapDirectories(
  composeRoot: string,
): Promise<BootstrapStatePaths> {
  await validateBootstrapComposeRoot(composeRoot);
  const paths = bootstrapStatePaths(composeRoot);
  const local = join(composeRoot, ".local");
  await ensureDirectory(composeRoot, local);
  await ensureDirectory(local, paths.stateDir);
  await ensureDirectory(paths.stateDir, paths.binDir);
  // Recheck the full chain after all mutations so a replaced component cannot
  // be silently accepted as the protected storage root.
  const uid = await readEffectiveUid();
  for (const directory of [local, paths.stateDir, paths.binDir]) {
    const info = await Deno.lstat(directory).catch(() => invalidState());
    if (!exactMetadata(info, "directory", 0o700, uid)) invalidState();
  }
  return paths;
}

export async function validateBootstrapDirectories(
  composeRoot: string,
): Promise<BootstrapStatePaths> {
  await validateBootstrapComposeRoot(composeRoot);
  const paths = bootstrapStatePaths(composeRoot);
  const uid = await readEffectiveUid();
  for (
    const directory of [
      join(composeRoot, ".local"),
      paths.stateDir,
      paths.binDir,
    ]
  ) {
    const info = await Deno.lstat(directory).catch(() => invalidState());
    if (!exactMetadata(info, "directory", 0o700, uid)) invalidState();
  }
  return paths;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function requireFields(
  record: Record<string, unknown>,
  required: readonly string[],
  forbidden: readonly string[],
): void {
  if (required.some((field) => !has(record, field))) invalidState();
  if (forbidden.some((field) => has(record, field))) invalidState();
}

function canonicalRecord(value: unknown): BootstrapRecord {
  const record = closedObject(value, RECORD_FIELDS);
  if (
    record.schema !== 1 || !UUID.test(String(record.installationId)) ||
    !UUID.test(String(record.credentialGenerationId)) ||
    !LABEL.test(String(record.account)) ||
    !LABEL.test(String(record.service)) ||
    record.label !== record.service ||
    !safeCanonicalPath(record.keychainPath) ||
    !HASH.test(String(record.helperSourceSha256)) ||
    !HASH.test(String(record.helperExecutableSha256)) ||
    !isUtc(record.bootstrapStartedAtUtc) || !isUtc(record.phaseUpdatedAtUtc) ||
    record.phaseUpdatedAtUtc < record.bootstrapStartedAtUtc
  ) invalidState();

  const common = Object.fromEntries(
    COMMON_FIELDS.map((field) => [field, record[field]]),
  ) as BootstrapCommon;
  const result: Record<string, unknown> = { ...common, phase: record.phase };
  if (record.phase === "creation_pending") {
    requireFields(record, [], [
      ...CREATED_FIELDS,
      ...RECOVERY_FIELDS,
      ...MARKER_FIELDS,
      ...REPOSITORY_FIELDS,
    ]);
  } else {
    requireFields(record, CREATED_FIELDS, []);
    if (
      !isUtc(record.credentialCreatedAtUtc) ||
      record.credentialCreatedAtUtc < record.bootstrapStartedAtUtc ||
      record.credentialCreatedAtUtc > record.phaseUpdatedAtUtc ||
      !HASH.test(String(record.itemPersistentRefSha256))
    ) invalidState();
    for (const field of CREATED_FIELDS) result[field] = record[field];
    if (record.phase === "created_unconfirmed") {
      requireFields(record, [], [
        ...RECOVERY_FIELDS,
        ...MARKER_FIELDS,
        ...REPOSITORY_FIELDS,
      ]);
    } else {
      requireFields(record, RECOVERY_FIELDS, []);
      if (
        !RECEIPT.test(String(record.recoveryReceiptId)) ||
        !isUtc(record.recoveryAttestedAtUtc) ||
        record.recoveryAttestedAtUtc < record.credentialCreatedAtUtc ||
        record.recoveryAttestedAtUtc > record.phaseUpdatedAtUtc
      ) invalidState();
      for (const field of RECOVERY_FIELDS) result[field] = record[field];
      const markerCount = MARKER_FIELDS.filter((field) => has(record, field))
        .length;
      if (markerCount !== 0 && markerCount !== MARKER_FIELDS.length) {
        invalidState();
      }
      if (markerCount) {
        if (
          !isUtc(record.ownerMarkerCreatedAtUtc) ||
          record.ownerMarkerCreatedAtUtc < record.recoveryAttestedAtUtc ||
          record.ownerMarkerCreatedAtUtc > record.phaseUpdatedAtUtc ||
          !HASH.test(String(record.ownerMarkerSha256))
        ) invalidState();
        for (const field of MARKER_FIELDS) result[field] = record[field];
      }
      if (record.phase === "recovery_attested") {
        requireFields(record, [], REPOSITORY_FIELDS);
      } else if (record.phase === "repository_verified") {
        requireFields(record, [...MARKER_FIELDS, ...REPOSITORY_FIELDS], []);
        const markerCreatedAt = record.ownerMarkerCreatedAtUtc;
        if (
          !HASH.test(String(record.repositoryId)) ||
          !isUtc(record.repositoryVerifiedAtUtc) ||
          !isUtc(markerCreatedAt) ||
          record.repositoryVerifiedAtUtc < markerCreatedAt ||
          record.repositoryVerifiedAtUtc > record.phaseUpdatedAtUtc
        ) invalidState();
        for (const field of REPOSITORY_FIELDS) result[field] = record[field];
      } else invalidState();
    }
  }
  boundedJson(result);
  return result as BootstrapRecord;
}

async function readOwnedRecord(path: string): Promise<unknown> {
  const [before, uid] = await Promise.all([
    Deno.lstat(path),
    readEffectiveUid(),
  ]);
  if (
    !exactMetadata(before, "file", 0o600, uid) ||
    before.size > MAX_RECORD_BYTES
  ) invalidState();
  const file = await Deno.open(path, { read: true });
  try {
    const opened = await file.stat();
    if (!identityMatches(before, opened)) invalidState();
    const bytes = new Uint8Array(MAX_RECORD_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes.subarray(count));
      if (read === null) break;
      count += read;
    }
    if (count > MAX_RECORD_BYTES) invalidState();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, count),
      ),
    );
  } finally {
    file.close();
  }
}

export async function readBootstrapState(
  composeRoot: string,
): Promise<BootstrapRecord | null> {
  const { recordPath } = await validateBootstrapDirectories(composeRoot);
  try {
    return canonicalRecord(await readOwnedRecord(recordPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    invalidState();
  }
}

function immutableEqual(
  previous: BootstrapRecord,
  next: BootstrapRecord,
  fields: readonly string[],
): boolean {
  const left = previous as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  return fields.every((field) => left[field] === right[field]);
}

function validateTransition(
  previous: BootstrapRecord | null,
  next: BootstrapRecord,
): void {
  if (!previous) {
    if (next.phase !== "creation_pending") invalidState();
    return;
  }
  if (boundedJson(previous) === boundedJson(next)) return;
  const immutableCommon = COMMON_FIELDS.filter((field) =>
    field !== "phaseUpdatedAtUtc"
  );
  if (
    !immutableEqual(previous, next, immutableCommon) ||
    next.phaseUpdatedAtUtc <= previous.phaseUpdatedAtUtc
  ) invalidState();
  const phases = [
    "creation_pending",
    "created_unconfirmed",
    "recovery_attested",
    "repository_verified",
  ] as const;
  const from = phases.indexOf(previous.phase);
  const to = phases.indexOf(next.phase);
  if (to === from + 1) {
    if (
      next.phase === "repository_verified" &&
      !has(
        previous as unknown as Record<string, unknown>,
        "ownerMarkerSha256",
      )
    ) invalidState();
    const inherited = from >= 1 ? CREATED_FIELDS : [];
    const recovered = from >= 2 ? RECOVERY_FIELDS : [];
    const marked = from >= 2 && has(
        previous as unknown as Record<string, unknown>,
        "ownerMarkerSha256",
      )
      ? MARKER_FIELDS
      : [];
    if (
      !immutableEqual(previous, next, [...inherited, ...recovered, ...marked])
    ) {
      invalidState();
    }
    return;
  }
  if (
    previous.phase === "recovery_attested" &&
    next.phase === "recovery_attested" &&
    !has(previous as unknown as Record<string, unknown>, "ownerMarkerSha256") &&
    has(next as unknown as Record<string, unknown>, "ownerMarkerSha256") &&
    immutableEqual(previous, next, [...CREATED_FIELDS, ...RECOVERY_FIELDS])
  ) return;
  invalidState();
}

async function writeAll(file: Deno.FsFile, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
  await file.sync();
}

export async function writeBootstrapStateAtomic(
  composeRoot: string,
  next: BootstrapRecord,
): Promise<void> {
  const paths = await ensureBootstrapDirectories(composeRoot);
  const captured = canonicalRecord(next);
  const previous = await readBootstrapState(composeRoot);
  validateTransition(previous, captured);
  const json = boundedJson(captured);
  let temporary = join(
    paths.stateDir,
    `.bootstrap-v1-${crypto.randomUUID()}.tmp`,
  );
  try {
    const file = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      await writeAll(file, json);
      if (
        !exactMetadata(
          await file.stat(),
          "file",
          0o600,
          await readEffectiveUid(),
        )
      ) invalidState();
    } finally {
      file.close();
    }
    const tempInfo = await Deno.lstat(temporary);
    if (
      !exactMetadata(tempInfo, "file", 0o600, await readEffectiveUid())
    ) invalidState();
    await Deno.rename(temporary, paths.recordPath);
    temporary = "";
    await syncDirectory(paths.stateDir);
  } catch {
    invalidState();
  } finally {
    if (temporary) {
      try {
        await Deno.remove(temporary);
      } catch { /* Preserve the safe state error. */ }
    }
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ProtectedExecutableIdentity = Readonly<{
  path: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
}>;

export type ProtectedExecutableValidationHooks = Readonly<{
  afterHash?: () => void | Promise<void>;
}>;

const MAX_PROTECTED_EXECUTABLE_BYTES = 16 * 1024 * 1024;

function protectedExecutableMetadata(
  info: Deno.FileInfo,
  uid: number,
): boolean {
  return exactMetadata(info, "file", 0o700, uid) &&
    info.dev !== null && info.ino !== null &&
    Number.isSafeInteger(info.size) && info.size >= 0 &&
    info.size <= MAX_PROTECTED_EXECUTABLE_BYTES;
}

export async function validateProtectedExecutable(
  path: string,
  expectedSha256?: string,
  hooks: ProtectedExecutableValidationHooks = {},
): Promise<ProtectedExecutableIdentity> {
  try {
    if (!safeCanonicalPath(path)) invalidState();
    if (expectedSha256 !== undefined && !HASH.test(expectedSha256)) {
      invalidState();
    }
    const [before, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !protectedExecutableMetadata(before, uid)
    ) invalidState();
    const file = await Deno.open(path, { read: true });
    try {
      const opened = await file.stat();
      // Validate the opened inode, including its allocation bound, before the
      // size can influence memory allocation.
      if (
        !protectedExecutableMetadata(opened, uid) ||
        !identityMatches(before, opened) || opened.size !== before.size
      ) invalidState();
      const bytes = new Uint8Array(opened.size);
      let sha256: string;
      try {
        let count = 0;
        while (count < bytes.length) {
          const read = await file.read(bytes.subarray(count));
          if (read === null) break;
          count += read;
        }
        if (count !== bytes.length) invalidState();
        sha256 = toHex(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        );
      } finally {
        bytes.fill(0);
      }
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
        invalidState();
      }
      await hooks.afterHash?.();
      const named = await Deno.lstat(path);
      if (
        !protectedExecutableMetadata(named, uid) ||
        !identityMatches(opened, named) || named.size !== opened.size
      ) invalidState();
      return Object.freeze({
        path,
        sha256,
        dev: opened.dev!,
        ino: opened.ino!,
        size: opened.size,
      });
    } finally {
      file.close();
    }
  } catch {
    invalidState();
  }
}

export async function assertProtectedExecutableIdentity(
  expected: ProtectedExecutableIdentity,
): Promise<void> {
  try {
    if (
      !expected || typeof expected !== "object" ||
      Object.keys(expected).sort().join(",") !== "dev,ino,path,sha256,size" ||
      !safeCanonicalPath(expected.path) || !HASH.test(expected.sha256) ||
      !Number.isSafeInteger(expected.dev) || expected.dev < 0 ||
      !Number.isSafeInteger(expected.ino) || expected.ino < 0 ||
      !Number.isSafeInteger(expected.size) || expected.size < 0 ||
      expected.size > MAX_PROTECTED_EXECUTABLE_BYTES
    ) invalidState();
    const current = await validateProtectedExecutable(
      expected.path,
      expected.sha256,
    );
    if (
      current.dev !== expected.dev || current.ino !== expected.ino ||
      current.size !== expected.size || current.sha256 !== expected.sha256
    ) invalidState();
  } catch {
    invalidState();
  }
}
