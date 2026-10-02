import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DenoRunner } from "./runner.ts";
import type {
  BackupStatus,
  BufferedCommandOptions,
  CommandResult,
  FilesAcceptedReceipt,
} from "./types.ts";
import {
  boundedJson,
  closedObject,
  failureError,
  invalidState,
  isBackupId,
  isStage,
  isUtc,
  MAX_RECORD_BYTES,
  validateCounters,
  validateFailure,
} from "./redact.ts";

export function validateFilesReceipt(
  value: unknown,
): asserts value is FilesAcceptedReceipt {
  const r = closedObject(value, [
    "schema",
    "kind",
    "repositoryId",
    "backupId",
    "snapshotId",
    "acceptedAtUtc",
    "verificationOrdinal",
    "checkSubsetPart",
    "manifestSha256",
    "manifestBytes",
    "representativeSha256",
    "representativeBytes",
    "sourceCounts",
    "transportVerified",
  ]);
  if (
    r.schema !== 1 || r.kind !== "files" || !isBackupId(r.backupId) ||
    !isUtc(r.acceptedAtUtc) || r.transportVerified !== true
  ) invalidState();
  for (
    const key of [
      "repositoryId",
      "snapshotId",
      "manifestSha256",
      "representativeSha256",
    ]
  ) {
    if (
      typeof r[key] !== "string" || !/^[a-f0-9]{64}$/.test(r[key] as string)
    ) invalidState();
  }
  for (
    const key of [
      "verificationOrdinal",
      "checkSubsetPart",
      "manifestBytes",
      "representativeBytes",
    ]
  ) {
    if (
      !Number.isSafeInteger(r[key]) ||
      (r[key] as number) < (key === "representativeBytes" ? 0 : 1)
    ) invalidState();
  }
  if (
    r.checkSubsetPart !== (((r.verificationOrdinal as number) - 1) % 100) + 1
  ) invalidState();
  validateCounters(r.sourceCounts);
  const c = r.sourceCounts;
  if (
    Object.keys(c).length !== 8 || !c.files || c.bytes === undefined ||
    c.total === undefined || c.total !== c.covered ||
    [c.missing, c.unreadable, c.outsideRoots, c.invalid].some((v) => v !== 0)
  ) invalidState();
}

export function backupStatusPath(
  stateDir: string,
  stage: "files" | "mongo-bootstrap",
): string {
  const names = {
    files: "files-status-v1.json",
    "mongo-bootstrap": "mongo-bootstrap-status-v1.json",
  };
  if (!Object.hasOwn(names, stage)) invalidState();
  return join(stateDir, names[stage]);
}

function validateState(value: unknown): asserts value is BackupStatus {
  const record = closedObject(value, [
    "schema",
    "stage",
    "state",
    "backupId",
    "startedAtUtc",
    "endedAtUtc",
    "snapshotId",
    "failure",
    "sourceCounts",
    "accepted",
  ]);
  if (
    record.schema !== 1 || !isStage(record.stage) ||
    !["not_started", "running", "complete", "failed", "stale"].includes(
      record.state as string,
    ) || !isBackupId(record.backupId) || !isUtc(record.startedAtUtc)
  ) invalidState();
  if (
    Object.hasOwn(record, "endedAtUtc") &&
    (!isUtc(record.endedAtUtc) || record.endedAtUtc < record.startedAtUtc)
  ) invalidState();
  if (
    Object.hasOwn(record, "snapshotId") &&
    (typeof record.snapshotId !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.snapshotId))
  ) invalidState();
  if (
    record.state === "complete" &&
    ["files", "mongo-bootstrap"].includes(record.stage) && !record.snapshotId
  ) invalidState();
  if (Object.hasOwn(record, "sourceCounts")) {
    validateCounters(record.sourceCounts);
  }
  if (Object.hasOwn(record, "accepted")) {
    if (record.stage !== "files") invalidState();
    validateFilesReceipt(record.accepted);
    if (
      record.state === "complete" &&
      (record.accepted.backupId !== record.backupId ||
        record.accepted.snapshotId !== record.snapshotId)
    ) invalidState();
  }
  if (record.stage === "files" && record.state === "complete") {
    validateFilesReceipt(record.accepted);
    if (
      !record.accepted || record.endedAtUtc !== record.accepted.acceptedAtUtc ||
      record.accepted.acceptedAtUtc < record.startedAtUtc ||
      JSON.stringify(record.sourceCounts) !==
        JSON.stringify(record.accepted.sourceCounts)
    ) invalidState();
  }
  if (Object.hasOwn(record, "failure")) {
    validateFailure(record.failure);
    if (
      record.state !== "failed" ||
      record.failure.backupId !== record.backupId ||
      record.failure.stage !== record.stage
    ) invalidState();
  }
  boundedJson(record);
}
async function readRecord(path: string): Promise<unknown> {
  const before = await Deno.lstat(path);
  if (
    !before.isFile || before.isSymlink ||
    before.uid !== await readEffectiveUid() || before.mode === null ||
    (before.mode & 0o7777) !== 0o600
  ) invalidState();
  const file = await Deno.open(path, { read: true });
  try {
    const info = await file.stat();
    if (
      !info.isFile || info.size > MAX_RECORD_BYTES || info.dev !== before.dev ||
      info.ino !== before.ino
    ) invalidState();
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
export async function readState(path: string): Promise<BackupStatus | null> {
  try {
    const record = await readRecord(path);
    validateState(record);
    return record;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    invalidState();
  }
}
function transition(previous: BackupStatus | null, next: BackupStatus): void {
  if (previous && previous.stage !== next.stage) invalidState();
  if (
    previous?.state === "complete" && previous.backupId === next.backupId &&
    JSON.stringify(previous.accepted) !== JSON.stringify(next.accepted)
  ) invalidState();
  if (next.stage === "files") {
    if (next.state === "complete") {
      if (
        !next.accepted || next.accepted.backupId !== next.backupId ||
        next.accepted.snapshotId !== next.snapshotId
      ) invalidState();
      if (
        previous?.state !== "complete" &&
        next.accepted.verificationOrdinal !==
          (previous?.accepted?.verificationOrdinal ?? 0) + 1
      ) invalidState();
      if (
        previous?.accepted &&
        next.accepted.repositoryId !== previous.accepted.repositoryId
      ) invalidState();
    } else if (
      JSON.stringify(next.accepted) !== JSON.stringify(previous?.accepted)
    ) invalidState();
  }
  if (!previous || previous.backupId !== next.backupId) {
    if (
      previous?.state === "running" ||
      !["not_started", "running"].includes(next.state)
    ) invalidState();
    return;
  }
  if (
    previous.stage !== next.stage || previous.startedAtUtc !== next.startedAtUtc
  ) invalidState();
  if (
    previous.snapshotId !== undefined && next.snapshotId !== previous.snapshotId
  ) invalidState();
  const allowed: Record<
    BackupStatus["state"],
    readonly BackupStatus["state"][]
  > = {
    not_started: ["not_started", "running"],
    running: ["running", "complete", "failed", "stale"],
    complete: ["complete"],
    failed: ["failed"],
    stale: ["stale"],
  };
  if (!allowed[previous.state].includes(next.state)) invalidState();
  if (
    previous.state === "complete" && previous.snapshotId !== next.snapshotId
  ) invalidState();
}
async function syncDirectory(directory: string): Promise<void> {
  const dir = await Deno.open(directory, { read: true });
  try {
    await dir.sync();
  } finally {
    dir.close();
  }
}
async function writeAll(file: Deno.FsFile, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
  await file.sync();
}
// Callers hold withLock across read/transition/write for serialized updates.
export async function writeStateAtomic(
  path: string,
  state: unknown,
): Promise<void> {
  let temp: string | undefined;
  try {
    validateState(state);
    const json = boundedJson(state);
    const captured: BackupStatus = JSON.parse(json);
    transition(await readState(path), captured);
    const directory = dirname(path);
    temp = join(directory, `.backup-state-${crypto.randomUUID()}.tmp`);
    const file = await Deno.open(temp, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      await writeAll(file, json);
    } finally {
      file.close();
    }
    await Deno.rename(temp, path);
    temp = undefined;
    await syncDirectory(directory);
  } catch {
    invalidState();
  } finally {
    if (temp) {
      try {
        await Deno.remove(temp);
      } catch { /* Preserve original safe error. */ }
    }
  }
}

type NormalLockCommand =
  | "preflight"
  | "bootstrap"
  | "files"
  | "mongo-bootstrap"
  | "status"
  | "verify";
type RecoveryTrigger = "bootstrap" | "files" | "mongo-bootstrap" | "verify";
export type RecoveryAttempt = Readonly<{
  quarantineId: string;
  reservedAtUtc: string;
}>;
type NormalLockRecord = {
  pid: number;
  processStartedAtUtc: string;
  command: NormalLockCommand;
  backupId: string;
  recoveryAttempt?: RecoveryAttempt;
};
type RepositoryRecoveryLockRecord = {
  pid: number;
  processStartedAtUtc: string;
  command: "recover-repository";
  backupId: string;
  quarantineId: string;
  triggeringCommand: RecoveryTrigger;
  quarantineRecord: string;
};
type LockRecord = NormalLockRecord | RepositoryRecoveryLockRecord;
export type RepositoryRecoveryLockRetention = Readonly<
  Pick<
    RepositoryRecoveryLockRecord,
    "backupId" | "quarantineId" | "triggeringCommand" | "quarantineRecord"
  > & { reservedAtUtc?: string }
>;
export type InterruptedRepositoryRecoveryLockRetention = Readonly<{
  kind: "retention-publication-interrupted";
  backupId: string;
  quarantineId: string;
  triggeringCommand: RecoveryTrigger;
  reservedAtUtc: string;
}>;
export type RepositoryRecoveryLockPersistenceFaultPoint =
  | "after_recovery_stage_create"
  | "after_recovery_stage_truncate"
  | "after_recovery_stage_write"
  | "after_recovery_stage_fsync"
  | "after_recovery_stage_directory_fsync"
  | "after_recovery_alias_cleanup"
  | "after_recovery_publish"
  | "after_recovery_publish_fsync";
export type RepositoryRecoveryLockPersistenceDependencies = Readonly<{
  fault?: (
    point: RepositoryRecoveryLockPersistenceFaultPoint,
  ) => void | Promise<void>;
}>;
export type RecoveryLockIdentity =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
    kind: "present";
    pid: number;
    processStartedAtUtc: string;
    command: RecoveryTrigger;
    backupId: string;
    quarantineId: string;
    reservedAtUtc: string;
    dev: number;
    ino: number;
  }>
  | Readonly<{
    kind: "present";
    pid: number;
    processStartedAtUtc: string;
    command: "recover-repository";
    backupId: string;
    quarantineId: string;
    triggeringCommand: RecoveryTrigger;
    quarantineRecordSha256: string;
    dev: number;
    ino: number;
  }>;
type ProcessProbe = (pid: number) => boolean | Promise<boolean>;
type LockOptions = Pick<NormalLockRecord, "command" | "backupId"> & {
  isProcessAlive?: ProcessProbe;
  recoveryAttempt?: RecoveryAttempt;
};
declare const ownedLockLeaseBrand: unique symbol;
export type OwnedLockLease = Readonly<{
  path: string;
  dev: number;
  ino: number;
  [ownedLockLeaseBrand]: true;
}>;
const activeLockLeases = new WeakSet<object>();
const activeLockIdentities = new Set<string>();
const retainedLockLeases = new WeakMap<object, string>();
const lockLeaseIdentities = new WeakMap<
  object,
  Readonly<{ dev: number; ino: number }>
>();
const lockLeaseMetadata = new WeakMap<
  object,
  Readonly<{
    command: LockRecord["command"];
    backupId: string;
    recoveryAttempt?: RecoveryAttempt;
  }>
>();
let effectiveUidPromise: Promise<number> | undefined;
export type EffectiveUidCommand = (
  options: BufferedCommandOptions,
) => Promise<CommandResult>;
const effectiveUidRunner = new DenoRunner();
const defaultEffectiveUidCommand: EffectiveUidCommand = (options) =>
  // Invoke the fixed absolute id(1) path in a genuinely cleared OS
  // environment while delegating timeout, aggregate output limiting,
  // termination, draining, and status waiting to the shared bounded runner.
  effectiveUidRunner.run(["/usr/bin/id", "-u"], options);

async function lookupEffectiveUid(command: EffectiveUidCommand) {
  try {
    const output = await command({
      timeoutMs: 1_000,
      maxOutputBytes: 32,
      clearEnv: true,
      env: {},
    });
    try {
      if (output.code !== 0 || output.timedOut) invalidState();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        output.stdout,
      ).trim();
      const uid = Number(text);
      if (!/^\d{1,10}$/.test(text) || !Number.isSafeInteger(uid) || uid < 0) {
        invalidState();
      }
      return uid;
    } finally {
      output.stdout.fill(0);
      output.stderr.fill(0);
    }
  } catch {
    invalidState();
  }
}

export function readEffectiveUid(
  command: EffectiveUidCommand = defaultEffectiveUidCommand,
): Promise<number> {
  if (command !== defaultEffectiveUidCommand) {
    return lookupEffectiveUid(command);
  }
  effectiveUidPromise ??= lookupEffectiveUid(command);
  return effectiveUidPromise;
}
// Runtime time origin identifies this process invocation without invoking ps or
// persisting its command line. Live PIDs are never cleared, including PID reuse.
const processStartedAtUtc = new Date(Date.now() - performance.now())
  .toISOString();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isRecoveryTrigger(value: unknown): value is RecoveryTrigger {
  return ["bootstrap", "files", "mongo-bootstrap", "verify"].includes(
    String(value),
  );
}
function validateLock(value: unknown): asserts value is LockRecord {
  const lock = closedObject(value, [
    "pid",
    "processStartedAtUtc",
    "command",
    "backupId",
    "recoveryAttempt",
    "quarantineId",
    "triggeringCommand",
    "quarantineRecord",
  ]);
  if (
    !Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0 ||
    (lock.pid as number) > 2147483647 || !isUtc(lock.processStartedAtUtc) ||
    !isBackupId(lock.backupId) ||
    (!isStage(lock.command) && lock.command !== "status" &&
      lock.command !== "verify" && lock.command !== "recover-repository")
  ) invalidState();
  if (lock.command === "recover-repository") {
    if (
      Object.hasOwn(lock, "recoveryAttempt") ||
      !UUID.test(String(lock.quarantineId)) ||
      !["bootstrap", "files", "mongo-bootstrap", "verify"].includes(
        String(lock.triggeringCommand),
      ) || typeof lock.quarantineRecord !== "string" ||
      lock.quarantineRecord.length === 0 ||
      new TextEncoder().encode(lock.quarantineRecord).length > MAX_RECORD_BYTES
    ) invalidState();
  } else {
    if (
      Object.hasOwn(lock, "quarantineId") ||
      Object.hasOwn(lock, "triggeringCommand") ||
      Object.hasOwn(lock, "quarantineRecord")
    ) invalidState();
    const mutating = isRecoveryTrigger(lock.command);
    if (mutating) {
      const attempt = closedObject(lock.recoveryAttempt, [
        "quarantineId",
        "reservedAtUtc",
      ]);
      if (
        !UUID.test(String(attempt.quarantineId)) ||
        !isUtc(attempt.reservedAtUtc)
      ) invalidState();
    } else if (Object.hasOwn(lock, "recoveryAttempt")) invalidState();
  }
  boundedJson(lock);
}
function isProcessAlive(pid: number): boolean {
  if (pid === Deno.pid) return true;
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    // Permissions or unknown process status must never authorize removal.
    return true;
  }
}
async function readLock(path: string): Promise<LockRecord> {
  try {
    const lock = await readRecord(path);
    validateLock(lock);
    return lock;
  } catch {
    throw failureError("LOCK_HELD");
  }
}

type PinnedRecoveryLock =
  | Readonly<{ identity: Readonly<{ kind: "missing" }> }>
  | Readonly<{
    identity: Extract<RecoveryLockIdentity, { kind: "present" }>;
    file: Deno.FsFile;
    info: Deno.FileInfo;
    record: LockRecord;
  }>;

type PinnedLock =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
    kind: "present";
    file: Deno.FsFile;
    info: Deno.FileInfo;
    record: LockRecord;
  }>;

type PinnedLockFile =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
    kind: "present";
    file: Deno.FsFile;
    info: Deno.FileInfo;
  }>;

function lockIdentityKey(path: string, dev: number, ino: number): string {
  return `${path}\0${dev}\0${ino}`;
}

async function readOpenLock(file: Deno.FsFile): Promise<LockRecord> {
  await file.seek(0, Deno.SeekMode.Start);
  const bytes = new Uint8Array(MAX_RECORD_BYTES + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = await file.read(bytes.subarray(count));
    if (read === null) break;
    count += read;
  }
  if (count > MAX_RECORD_BYTES) invalidState();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, count),
  );
  const record: unknown = JSON.parse(text);
  validateLock(record);
  if (text !== boundedJson(record)) invalidState();
  return record;
}

async function pinLockFile(path: string): Promise<PinnedLockFile> {
  let named: Deno.FileInfo;
  try {
    named = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { kind: "missing" };
    }
    throw failureError("LOCK_HELD");
  }
  let file: Deno.FsFile | undefined;
  try {
    const uid = await readEffectiveUid();
    if (
      !named.isFile || named.isSymlink || named.uid !== uid ||
      named.mode === null || (named.mode & 0o7777) !== 0o600 ||
      named.size > MAX_RECORD_BYTES || named.dev === null || named.ino === null
    ) throw failureError("LOCK_HELD");
    file = await Deno.open(path, { read: true, write: true });
    const opened = await file.stat();
    if (
      !opened.isFile || opened.isSymlink || opened.uid !== uid ||
      opened.mode === null || (opened.mode & 0o7777) !== 0o600 ||
      opened.size !== named.size || opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) throw failureError("LOCK_HELD");
    const after = await Deno.lstat(path);
    if (
      !after.isFile || after.isSymlink || after.uid !== uid ||
      after.mode === null || (after.mode & 0o7777) !== 0o600 ||
      after.size !== named.size || after.dev !== named.dev ||
      after.ino !== named.ino
    ) throw failureError("LOCK_HELD");
    return { kind: "present", file, info: opened };
  } catch {
    file?.close();
    throw failureError("LOCK_HELD");
  }
}

async function pinLock(path: string): Promise<PinnedLock> {
  const pinned = await pinLockFile(path);
  if (pinned.kind === "missing") return pinned;
  try {
    const record = await readOpenLock(pinned.file);
    const after = await Deno.lstat(path);
    if (
      after.dev !== pinned.info.dev || after.ino !== pinned.info.ino ||
      after.size !== pinned.info.size
    ) throw failureError("LOCK_HELD");
    return { ...pinned, record };
  } catch {
    pinned.file.close();
    throw failureError("LOCK_HELD");
  }
}

async function pinRecoveryLock(path: string): Promise<PinnedRecoveryLock> {
  const pinned = await pinLock(path);
  if (pinned.kind === "missing") {
    return { identity: Object.freeze({ kind: "missing" as const }) };
  }
  try {
    const { record } = pinned;
    if (
      record.command !== "recover-repository" &&
      !isRecoveryTrigger(record.command)
    ) throw failureError("LOCK_HELD");
    if (pinned.info.dev === null || pinned.info.ino === null) {
      throw failureError("LOCK_HELD");
    }
    const identity: Extract<RecoveryLockIdentity, { kind: "present" }> =
      record.command === "recover-repository"
        ? Object.freeze({
          kind: "present" as const,
          pid: record.pid,
          processStartedAtUtc: record.processStartedAtUtc,
          command: "recover-repository" as const,
          backupId: record.backupId,
          quarantineId: record.quarantineId,
          triggeringCommand: record.triggeringCommand,
          quarantineRecordSha256: createHash("sha256")
            .update(record.quarantineRecord)
            .digest("hex"),
          dev: pinned.info.dev,
          ino: pinned.info.ino,
        })
        : Object.freeze({
          kind: "present" as const,
          pid: record.pid,
          processStartedAtUtc: record.processStartedAtUtc,
          command: record.command as RecoveryTrigger,
          backupId: record.backupId,
          quarantineId: record.recoveryAttempt!.quarantineId,
          reservedAtUtc: record.recoveryAttempt!.reservedAtUtc,
          dev: pinned.info.dev,
          ino: pinned.info.ino,
        });
    return {
      identity,
      file: pinned.file,
      info: pinned.info,
      record,
    };
  } catch {
    pinned.file.close();
    throw failureError("LOCK_HELD");
  }
}

async function revalidatePinnedRecoveryLock(
  path: string,
  pinned: PinnedRecoveryLock,
): Promise<void> {
  if (pinned.identity.kind === "missing") {
    try {
      await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
    }
    throw failureError("LOCK_HELD");
  }
  if (!("file" in pinned)) throw failureError("LOCK_HELD");
  try {
    const [named, opened, record, uid] = await Promise.all([
      Deno.lstat(path),
      pinned.file.stat(),
      readOpenLock(pinned.file),
      readEffectiveUid(),
    ]);
    const identity = pinned.identity;
    if (
      !named.isFile || named.isSymlink || named.uid !== uid ||
      named.mode === null || (named.mode & 0o7777) !== 0o600 ||
      named.dev !== identity.dev || named.ino !== identity.ino ||
      opened.dev !== identity.dev || opened.ino !== identity.ino ||
      opened.size !== named.size || named.size > MAX_RECORD_BYTES ||
      record.pid !== identity.pid ||
      record.processStartedAtUtc !== identity.processStartedAtUtc ||
      record.command !== identity.command ||
      record.backupId !== identity.backupId ||
      (identity.command !== "recover-repository" &&
        (record.command === "recover-repository" ||
          record.recoveryAttempt?.quarantineId !== identity.quarantineId ||
          record.recoveryAttempt?.reservedAtUtc !== identity.reservedAtUtc)) ||
      (identity.command === "recover-repository" &&
        (record.command !== "recover-repository" ||
          record.quarantineId !== identity.quarantineId ||
          record.triggeringCommand !== identity.triggeringCommand ||
          createHash("sha256").update(record.quarantineRecord).digest("hex") !==
            identity.quarantineRecordSha256))
    ) throw failureError("LOCK_HELD");
  } catch {
    throw failureError("LOCK_HELD");
  }
}
// This stable, empty inode is never unlinked: replacing it would split the
// advisory lock domain. Its existence conveys no ownership. The OS releases
// the actual guard when the handle closes, including after a process crash.
async function withGuard<T>(
  path: string,
  action: () => Promise<T>,
  wait = false,
): Promise<T> {
  let guard: Deno.FsFile;
  const guardPath = `${path}.guard`;
  try {
    try {
      guard = await Deno.open(guardPath, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const [existing, uid] = await Promise.all([
        Deno.lstat(guardPath),
        readEffectiveUid(),
      ]);
      if (
        !existing.isFile || existing.isSymlink || existing.uid !== uid ||
        existing.mode === null || (existing.mode & 0o7777) !== 0o600 ||
        existing.size !== 0
      ) throw failureError("LOCK_HELD");
      guard = await Deno.open(guardPath, { write: true });
    }
  } catch {
    throw failureError("LOCK_HELD");
  }
  try {
    const uid = await readEffectiveUid();
    const [named, opened] = await Promise.all([
      Deno.lstat(guardPath),
      guard.stat(),
    ]);
    if (
      !named.isFile || named.isSymlink || named.uid !== uid ||
      named.mode === null || (named.mode & 0o7777) !== 0o600 ||
      named.size !== 0 || named.dev === null || named.ino === null ||
      opened.dev !== named.dev || opened.ino !== named.ino
    ) throw failureError("LOCK_HELD");
    try {
      if (wait) await guard.lock(true);
      else if (!await guard.tryLock(true)) throw failureError("LOCK_HELD");
    } catch {
      throw failureError("LOCK_HELD");
    }
    const held = await Deno.lstat(guardPath);
    if (
      !held.isFile || held.isSymlink || held.dev !== named.dev ||
      held.ino !== named.ino
    ) throw failureError("LOCK_HELD");
    return await action();
  } finally {
    guard.close();
  }
}
export async function clearStaleLock(
  path: string,
  pid: number,
  probe: ProcessProbe = isProcessAlive,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) {
    throw failureError("STALE_LOCK");
  }
  // The safety module is loaded lazily to avoid making the lock primitive's
  // initialization depend on the higher-level recovery controller.
  const { assertRepositoryWritable } = await import("./repository-safety.ts");
  await assertRepositoryWritable(dirname(path));
  await withGuard(path, async () => {
    await assertRepositoryWritable(dirname(path));
    const lock = await readLock(path);
    if (lock.command === "recover-repository") {
      throw failureError("LOCK_HELD");
    }
    if (lock.pid !== pid) throw failureError("STALE_LOCK");
    if (await probe(pid)) throw failureError("LOCK_HELD");
    // Liveness can change between probes, but participating acquisitions and
    // removals cannot replace this pathname while this advisory guard is held.
    if (await probe(pid)) throw failureError("LOCK_HELD");
    await assertRepositoryWritable(dirname(path));
    try {
      await Deno.remove(path);
      await syncDirectory(dirname(path));
    } catch {
      throw failureError("LOCK_HELD");
    }
  });
}

export function ownedLockContext(
  lease: OwnedLockLease,
): Readonly<{
  command: LockRecord["command"];
  backupId: string;
  recoveryAttempt?: RecoveryAttempt;
}> {
  const metadata = lockLeaseMetadata.get(lease);
  if (!activeLockLeases.has(lease) || !metadata) {
    throw failureError("LOCK_HELD");
  }
  return metadata;
}

async function replaceOwnedLockRecord(
  path: string,
  expected: Readonly<{ dev: number; ino: number }> | undefined,
  record: LockRecord,
  dependencies: RepositoryRecoveryLockPersistenceDependencies = {},
): Promise<Readonly<{ dev: number; ino: number }>> {
  const pending = `${path}.recovery-pending`;
  try {
    validateLock(record);
    const expectedBytes = boundedJson(record);
    if (record.command !== "recover-repository") {
      throw failureError("LOCK_HELD");
    }
    const compatible = (candidate: LockRecord): boolean =>
      candidate.command === "recover-repository" &&
      candidate.backupId === record.backupId &&
      candidate.quarantineId === record.quarantineId &&
      candidate.triggeringCommand === record.triggeringCommand &&
      candidate.quarantineRecord === record.quarantineRecord;
    const currentInfo = async (): Promise<Deno.FileInfo | undefined> => {
      try {
        return await Deno.lstat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }
    };
    const assertExpectedCurrent = async (): Promise<
      Deno.FileInfo | undefined
    > => {
      const current = await currentInfo();
      if (expected) {
        if (
          !current?.isFile || current.isSymlink ||
          current.dev !== expected.dev || current.ino !== expected.ino
        ) throw failureError("LOCK_HELD");
      } else if (current) {
        throw failureError("LOCK_HELD");
      }
      return current;
    };

    const currentBeforeStage = await assertExpectedCurrent();
    const currentRecord = currentBeforeStage ? await readLock(path) : undefined;
    let stage = await pinLockFile(pending);
    let stageRecord: LockRecord | undefined;
    if (stage.kind === "present") {
      try {
        stageRecord = await readOpenLock(stage.file);
        const named = await Deno.lstat(pending);
        if (
          named.dev !== stage.info.dev || named.ino !== stage.info.ino ||
          named.size !== stage.info.size
        ) throw failureError("LOCK_HELD");
      } catch {
        stageRecord = undefined;
      }

      const aliasesPublished = currentBeforeStage !== undefined &&
        currentBeforeStage.dev === stage.info.dev &&
        currentBeforeStage.ino === stage.info.ino;
      if (aliasesPublished) {
        if (
          !stageRecord || !currentRecord ||
          boundedJson(stageRecord) !== boundedJson(currentRecord)
        ) {
          stage.file.close();
          throw failureError("LOCK_HELD");
        }
        const publishedBytes = boundedJson(currentRecord);
        if (publishedBytes !== expectedBytes && !compatible(currentRecord)) {
          stage.file.close();
          throw failureError("LOCK_HELD");
        }
        stage.file.close();
        await Deno.remove(pending);
        await syncDirectory(dirname(path));
        await dependencies.fault?.("after_recovery_alias_cleanup");
        if (publishedBytes === expectedBytes) {
          const published = await Deno.lstat(path);
          if (published.dev === null || published.ino === null) {
            throw failureError("LOCK_HELD");
          }
          return { dev: published.dev, ino: published.ino };
        }
        // Keep the old published recovery record as the interlock while a new
        // controller identity is staged on a fresh inode.
        stage = { kind: "missing" };
        stageRecord = undefined;
      } else if (
        stageRecord && !compatible(stageRecord) &&
        boundedJson(stageRecord) !== expectedBytes
      ) {
        stage.file.close();
        throw failureError("LOCK_HELD");
      }
    }

    if (
      stage.kind === "missing" && currentRecord &&
      boundedJson(currentRecord) === expectedBytes
    ) {
      await syncDirectory(dirname(path));
      const published = await Deno.lstat(path);
      if (published.dev === null || published.ino === null) {
        throw failureError("LOCK_HELD");
      }
      return { dev: published.dev, ino: published.ino };
    }

    let file: Deno.FsFile;
    if (stage.kind === "present") {
      file = stage.file;
    } else {
      file = await Deno.open(pending, {
        createNew: true,
        read: true,
        write: true,
        mode: 0o600,
      });
      await dependencies.fault?.("after_recovery_stage_create");
    }
    try {
      if (!stageRecord || boundedJson(stageRecord) !== expectedBytes) {
        await file.truncate(0);
        await dependencies.fault?.("after_recovery_stage_truncate");
        await file.seek(0, Deno.SeekMode.Start);
        const bytes = new TextEncoder().encode(expectedBytes);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await file.write(bytes.subarray(offset));
          if (written <= 0) throw failureError("LOCK_HELD");
          offset += written;
        }
        await dependencies.fault?.("after_recovery_stage_write");
        await file.sync();
        await dependencies.fault?.("after_recovery_stage_fsync");
      }
    } finally {
      file.close();
    }
    await syncDirectory(dirname(path));
    await dependencies.fault?.("after_recovery_stage_directory_fsync");

    let current: Deno.FileInfo | undefined;
    try {
      current = await Deno.lstat(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (expected) {
      if (
        !current?.isFile || current.isSymlink ||
        current.dev !== expected.dev || current.ino !== expected.ino
      ) throw failureError("LOCK_HELD");
      if (boundedJson(await readLock(path)) === expectedBytes) {
        try {
          await Deno.remove(pending);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      } else await Deno.rename(pending, path);
    } else {
      if (current) throw failureError("LOCK_HELD");
      await Deno.link(pending, path);
    }
    await dependencies.fault?.("after_recovery_publish");
    await syncDirectory(dirname(path));
    await dependencies.fault?.("after_recovery_publish_fsync");
    try {
      const staged = await Deno.lstat(pending);
      const published = await Deno.lstat(path);
      if (staged.dev !== published.dev || staged.ino !== published.ino) {
        throw failureError("LOCK_HELD");
      }
      await Deno.remove(pending);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const [published, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !published.isFile || published.isSymlink || published.uid !== uid ||
      published.mode === null || (published.mode & 0o7777) !== 0o600 ||
      published.dev === null || published.ino === null
    ) throw failureError("LOCK_HELD");
    const reread = await readLock(path);
    if (boundedJson(reread) !== boundedJson(record)) {
      throw failureError("LOCK_HELD");
    }
    return { dev: published.dev, ino: published.ino };
  } catch {
    throw failureError("LOCK_HELD");
  }
}

export async function retainOwnedLockLease(
  path: string,
  lease: OwnedLockLease,
  retention: RepositoryRecoveryLockRetention,
  dependencies: RepositoryRecoveryLockPersistenceDependencies = {},
): Promise<void> {
  await assertOwnedLockLease(path, lease);
  const metadata = lockLeaseMetadata.get(lease);
  const identity = lockLeaseIdentities.get(lease);
  if (
    !metadata || !identity || !UUID.test(retention.quarantineId) ||
    metadata.backupId !== retention.backupId ||
    metadata.command !== retention.triggeringCommand ||
    metadata.recoveryAttempt?.quarantineId !== retention.quarantineId ||
    !isRecoveryTrigger(retention.triggeringCommand)
  ) throw failureError("LOCK_HELD");
  const recovery: RepositoryRecoveryLockRecord = {
    pid: Deno.pid,
    processStartedAtUtc,
    command: "recover-repository",
    backupId: retention.backupId,
    quarantineId: retention.quarantineId,
    triggeringCommand: retention.triggeringCommand,
    quarantineRecord: retention.quarantineRecord,
  };
  validateLock(recovery);
  retainedLockLeases.set(lease, retention.quarantineId);
  await withGuard(path, async () => {
    await assertOwnedLockLease(path, lease);
    const next = await replaceOwnedLockRecord(
      path,
      identity,
      recovery,
      dependencies,
    );
    activeLockIdentities.delete(
      lockIdentityKey(path, identity.dev, identity.ino),
    );
    activeLockIdentities.add(lockIdentityKey(path, next.dev, next.ino));
    lockLeaseIdentities.set(lease, next);
  }, true);
}

export async function readRepositoryRecoveryLockRetention(
  path: string,
): Promise<
  | RepositoryRecoveryLockRetention
  | InterruptedRepositoryRecoveryLockRetention
  | undefined
> {
  const publishedPin = await pinLock(path);
  const published = publishedPin.kind === "present"
    ? publishedPin.record
    : undefined;
  const pendingPin = await pinLockFile(`${path}.recovery-pending`);
  let pendingRecord: LockRecord | undefined;
  let pendingPartial = false;
  try {
    if (pendingPin.kind === "present") {
      try {
        pendingRecord = await readOpenLock(pendingPin.file);
        const named = await Deno.lstat(`${path}.recovery-pending`);
        if (
          named.dev !== pendingPin.info.dev ||
          named.ino !== pendingPin.info.ino ||
          named.size !== pendingPin.info.size
        ) throw failureError("LOCK_HELD");
      } catch {
        pendingPartial = true;
      }
    }
  } finally {
    if (publishedPin.kind === "present") publishedPin.file.close();
    if (pendingPin.kind === "present") pendingPin.file.close();
  }
  if (pendingPin.kind === "missing") {
    if (published?.command === "recover-repository") {
      return Object.freeze({
        backupId: published.backupId,
        quarantineId: published.quarantineId,
        triggeringCommand: published.triggeringCommand,
        quarantineRecord: published.quarantineRecord,
      });
    }
    if (
      published && isRecoveryTrigger(published.command) &&
      published.recoveryAttempt
    ) {
      return Object.freeze({
        kind: "retention-publication-interrupted" as const,
        backupId: published.backupId,
        quarantineId: published.recoveryAttempt.quarantineId,
        triggeringCommand: published.command,
        reservedAtUtc: published.recoveryAttempt.reservedAtUtc,
      });
    }
    return undefined;
  }
  if (published && published.command !== "recover-repository") {
    if (!isRecoveryTrigger(published.command) || !published.recoveryAttempt) {
      throw failureError("LOCK_HELD");
    }
    if (pendingPartial) {
      return Object.freeze({
        kind: "retention-publication-interrupted" as const,
        backupId: published.backupId,
        quarantineId: published.recoveryAttempt.quarantineId,
        triggeringCommand: published.command,
        reservedAtUtc: published.recoveryAttempt.reservedAtUtc,
      });
    }
    if (
      pendingRecord?.command !== "recover-repository" ||
      pendingRecord.backupId !== published.backupId ||
      pendingRecord.quarantineId !== published.recoveryAttempt.quarantineId ||
      pendingRecord.triggeringCommand !== published.command
    ) throw failureError("LOCK_HELD");
  } else if (published?.command === "recover-repository") {
    if (pendingPartial) {
      pendingRecord = published;
    } else if (
      pendingRecord?.command !== "recover-repository" ||
      pendingRecord.backupId !== published.backupId ||
      pendingRecord.quarantineId !== published.quarantineId ||
      pendingRecord.triggeringCommand !== published.triggeringCommand ||
      pendingRecord.quarantineRecord !== published.quarantineRecord
    ) throw failureError("LOCK_HELD");
  } else if (
    pendingPartial || pendingRecord?.command !== "recover-repository"
  ) {
    throw failureError("LOCK_HELD");
  }
  const record = pendingRecord;
  if (!record || record.command !== "recover-repository") {
    throw failureError("LOCK_HELD");
  }
  return Object.freeze({
    backupId: record.backupId,
    quarantineId: record.quarantineId,
    triggeringCommand: record.triggeringCommand,
    quarantineRecord: record.quarantineRecord,
    ...(published?.command !== "recover-repository"
      ? { reservedAtUtc: published?.recoveryAttempt?.reservedAtUtc }
      : {}),
  });
}

export async function assertOwnedLockLeaseRetained(
  path: string,
  lease: OwnedLockLease,
  quarantineId: string,
): Promise<void> {
  await assertOwnedLockLease(path, lease);
  if (retainedLockLeases.get(lease) !== quarantineId) {
    throw failureError("LOCK_HELD");
  }
}

export async function allowOwnedLockLeaseRelease(
  path: string,
  lease: OwnedLockLease,
  quarantineId: string,
): Promise<void> {
  await assertOwnedLockLeaseRetained(path, lease, quarantineId);
  retainedLockLeases.delete(lease);
}

// Keep the already-fsynced mutation WAL if terminal status cannot be persisted.
// A new controller recovers provenance from that WAL through repository recovery.
export async function preserveOwnedLockForRecovery(
  lease: OwnedLockLease,
): Promise<void> {
  await assertOwnedLockLease(lease.path, lease);
  if (!ownedLockContext(lease).recoveryAttempt) throw failureError("LOCK_HELD");
  retainedLockLeases.set(
    lease,
    ownedLockContext(lease).recoveryAttempt!.quarantineId,
  );
}
async function removeOwnedLock(
  path: string,
  identity: Readonly<{ dev: number | null; ino: number | null }>,
): Promise<void> {
  try {
    const existing = await Deno.lstat(path);
    if (
      existing.isFile && existing.dev === identity.dev &&
      existing.ino === identity.ino
    ) {
      await Deno.remove(path);
      await syncDirectory(dirname(path));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw failureError("LOCK_HELD");
    }
  }
}
export async function assertOwnedLockLease(
  path: string,
  lease: OwnedLockLease | undefined,
): Promise<void> {
  try {
    if (
      !lease || typeof lease !== "object" || !activeLockLeases.has(lease) ||
      lease.path !== path
    ) throw failureError("LOCK_HELD");
    const identity = lockLeaseIdentities.get(lease);
    if (!identity) throw failureError("LOCK_HELD");
    const [current, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !current.isFile || current.isSymlink || current.uid !== uid ||
      current.mode === null || (current.mode & 0o7777) !== 0o600 ||
      current.dev !== identity.dev || current.ino !== identity.ino
    ) throw failureError("LOCK_HELD");
  } catch {
    throw failureError("LOCK_HELD");
  }
}
export async function withLock<T>(
  path: string,
  options: LockOptions,
  action: (lease: OwnedLockLease) => Promise<T>,
): Promise<T> {
  const lock: LockRecord = {
    pid: Deno.pid,
    processStartedAtUtc,
    command: options.command,
    backupId: options.backupId,
    ...(isRecoveryTrigger(options.command)
      ? {
        recoveryAttempt: options.recoveryAttempt ?? {
          quarantineId: crypto.randomUUID(),
          reservedAtUtc: new Date().toISOString(),
        },
      }
      : {}),
  };
  validateLock(lock);
  const { file, identity } = await withGuard(path, async () => {
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        const existing = await readLock(path);
        const alive = await (options.isProcessAlive ?? isProcessAlive)(
          existing.pid,
        );
        throw failureError(alive ? "LOCK_HELD" : "STALE_LOCK");
      }
      throw failureError("LOCK_HELD");
    }
    let identity: Deno.FileInfo | undefined;
    try {
      identity = await file.stat();
      await writeAll(file, boundedJson(lock));
      await file.sync();
      await syncDirectory(dirname(path));
      return { file, identity };
    } catch {
      try {
        if (identity) await removeOwnedLock(path, identity);
      } finally {
        file.close();
      }
      throw failureError("LOCK_HELD");
    }
  });
  if (
    !identity.isFile || identity.isSymlink || identity.dev === null ||
    identity.ino === null
  ) {
    file.close();
    throw failureError("LOCK_HELD");
  }
  const lease = Object.freeze({
    path,
    dev: identity.dev,
    ino: identity.ino,
  }) as OwnedLockLease;
  activeLockLeases.add(lease);
  lockLeaseIdentities.set(lease, { dev: lease.dev, ino: lease.ino });
  const activeIdentity = lockIdentityKey(path, lease.dev, lease.ino);
  activeLockIdentities.add(activeIdentity);
  lockLeaseMetadata.set(lease, {
    command: lock.command,
    backupId: lock.backupId,
    ...(lock.command !== "preflight" && lock.command !== "status" &&
        lock.recoveryAttempt
      ? { recoveryAttempt: lock.recoveryAttempt }
      : {}),
  });
  try {
    await assertOwnedLockLease(path, lease);
    const result = await action(lease);
    await assertOwnedLockLease(path, lease);
    return result;
  } finally {
    try {
      // Keep the original inode open until cleanup so it cannot be reused.
      // Remove even a partial write, but never another invocation's file.
      if (!retainedLockLeases.has(lease)) {
        const currentIdentity = lockLeaseIdentities.get(lease) ?? identity;
        await withGuard(
          path,
          () => removeOwnedLock(path, currentIdentity),
          true,
        );
      }
    } finally {
      activeLockLeases.delete(lease);
      activeLockIdentities.delete(activeIdentity);
      const finalIdentity = lockLeaseIdentities.get(lease);
      if (finalIdentity) {
        activeLockIdentities.delete(
          lockIdentityKey(path, finalIdentity.dev, finalIdentity.ino),
        );
      }
      lockLeaseMetadata.delete(lease);
      lockLeaseIdentities.delete(lease);
      retainedLockLeases.delete(lease);
      file.close();
    }
  }
}

export async function withAdoptedRepositoryRecoveryLock<Proof, T>(
  path: string,
  options: Readonly<{
    backupId: string;
    quarantineId: string;
    triggeringCommand: RecoveryTrigger;
    quarantineRecord: string;
    requirePresent: boolean;
  }>,
  proveOwnerGone: (identity: RecoveryLockIdentity) => Promise<Proof>,
  action: (lease: OwnedLockLease, proof: Proof) => Promise<T>,
  dependencies: RepositoryRecoveryLockPersistenceDependencies = {},
): Promise<T> {
  const lock: RepositoryRecoveryLockRecord = {
    pid: Deno.pid,
    processStartedAtUtc,
    command: "recover-repository",
    backupId: options.backupId,
    quarantineId: options.quarantineId,
    triggeringCommand: options.triggeringCommand,
    quarantineRecord: options.quarantineRecord,
  };
  validateLock(lock);
  return await withGuard(path, async () => {
    const pinned = await pinRecoveryLock(path);
    let pinnedClosed = false;
    try {
      if (options.requirePresent && pinned.identity.kind !== "present") {
        throw failureError("LOCK_HELD");
      }
      if ("file" in pinned) {
        const matchesTrigger =
          pinned.identity.command === options.triggeringCommand &&
          pinned.identity.backupId === options.backupId &&
          pinned.identity.quarantineId === options.quarantineId;
        const matchesRecovery =
          pinned.identity.command === "recover-repository" &&
          pinned.identity.backupId === options.backupId &&
          pinned.identity.quarantineId === options.quarantineId &&
          pinned.identity.triggeringCommand === options.triggeringCommand &&
          pinned.record.command === "recover-repository" &&
          pinned.record.quarantineRecord === options.quarantineRecord;
        if (
          (!matchesTrigger && !matchesRecovery) ||
          (pinned.identity.pid === Deno.pid &&
            pinned.identity.processStartedAtUtc === processStartedAtUtc) ||
          activeLockIdentities.has(
            lockIdentityKey(path, pinned.identity.dev, pinned.identity.ino),
          )
        ) throw failureError("LOCK_HELD");
      }
      const proof = await proveOwnerGone(pinned.identity);
      await revalidatePinnedRecoveryLock(path, pinned);
      let currentIdentity: Readonly<{ dev: number; ino: number }>;
      if ("file" in pinned) {
        currentIdentity = await replaceOwnedLockRecord(
          path,
          { dev: pinned.identity.dev, ino: pinned.identity.ino },
          lock,
          dependencies,
        );
        pinned.file.close();
        pinnedClosed = true;
      } else {
        currentIdentity = await replaceOwnedLockRecord(
          path,
          undefined,
          lock,
          dependencies,
        );
      }
      const file = await Deno.open(path, { read: true, write: true });
      const opened = await file.stat();
      try {
        if (
          !opened.isFile || opened.isSymlink ||
          opened.dev !== currentIdentity.dev ||
          opened.ino !== currentIdentity.ino ||
          boundedJson(await readOpenLock(file)) !== boundedJson(lock)
        ) throw failureError("LOCK_HELD");
        const lease = Object.freeze({
          path,
          dev: currentIdentity.dev,
          ino: currentIdentity.ino,
        }) as OwnedLockLease;
        activeLockLeases.add(lease);
        lockLeaseIdentities.set(lease, currentIdentity);
        const activeIdentity = lockIdentityKey(
          path,
          currentIdentity.dev,
          currentIdentity.ino,
        );
        activeLockIdentities.add(activeIdentity);
        lockLeaseMetadata.set(lease, {
          command: "recover-repository",
          backupId: options.backupId,
        });
        retainedLockLeases.set(lease, options.quarantineId);
        try {
          await assertOwnedLockLease(path, lease);
          return await action(lease, proof);
        } finally {
          try {
            if (!retainedLockLeases.has(lease)) {
              await removeOwnedLock(path, currentIdentity);
            }
          } finally {
            activeLockLeases.delete(lease);
            activeLockIdentities.delete(activeIdentity);
            lockLeaseMetadata.delete(lease);
            lockLeaseIdentities.delete(lease);
            retainedLockLeases.delete(lease);
          }
        }
      } finally {
        file.close();
      }
    } finally {
      if (!pinnedClosed && "file" in pinned) pinned.file.close();
    }
  }, true);
}
