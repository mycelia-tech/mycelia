import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import {
  boundedJson,
  closedObject,
  failureError,
  invalidState,
  isBackupId,
  isUtc,
  MAX_RECORD_BYTES,
  ownData,
} from "./redact.ts";
import {
  allowOwnedLockLeaseRelease,
  assertOwnedLockLease,
  assertOwnedLockLeaseRetained,
  ownedLockContext,
  type OwnedLockLease,
  readEffectiveUid,
  readRepositoryRecoveryLockRetention,
  type RecoveryLockIdentity,
  type RepositoryRecoveryLockPersistenceDependencies,
  retainOwnedLockLease,
  withAdoptedRepositoryRecoveryLock,
} from "./state.ts";
export type { RecoveryLockIdentity } from "./state.ts";

export const REPOSITORY_RECOVERY_REASONS = [
  "retention_publication_interrupted",
  "child_status_unconfirmed",
  "forced_kill_descendants_unproved",
  "producer_survived",
  "producer_audit_unverified",
] as const;

export type RepositoryRecoveryReason =
  (typeof REPOSITORY_RECOVERY_REASONS)[number];

export type RepositoryIdentity =
  | Readonly<{ kind: "not_yet_verified" }>
  | Readonly<{ kind: "verified"; repositoryId: string }>;

export type RepositoryTrigger =
  | "bootstrap"
  | "files"
  | "mongo-bootstrap"
  | "verify";

export type ActiveRepositoryQuarantine = Readonly<{
  schema: 1;
  kind: "repository-quarantine";
  quarantineId: string;
  repository: RepositoryIdentity;
  triggeringCommand: RepositoryTrigger;
  backupId: string;
  reason: RepositoryRecoveryReason;
  childTerminationConfirmed: boolean;
  timedOut: boolean;
  createdAtUtc: string;
}>;

export type RepositoryRecoveryAudit = Readonly<{
  schema: 1;
  kind: "repository-recovery-audit";
  quarantineId: string;
  quarantineRecordSha256: string;
  repository: RepositoryIdentity;
  triggeringCommand: RepositoryTrigger;
  backupId: string;
  reason: RepositoryRecoveryReason;
  childTerminationConfirmed: boolean;
  quarantineCreatedAtUtc: string;
  auditedAtUtc: string;
  controllerGone: true;
  hostDescendantsGone: true;
  containerProducerGone: true;
  producerArtifactsGone: true;
  snapshotResolution:
    | "not_applicable"
    | "exactly_zero"
    | "one_unaccepted_files"
    | "one_policy_rejected";
  snapshotId?: string;
}>;

declare const repositoryRecoveryLeaseBrand: unique symbol;
export type RepositoryRecoveryLease =
  & OwnedLockLease
  & Readonly<{
    command: "recover-repository";
    quarantineId: string;
    [repositoryRecoveryLeaseBrand]: true;
  }>;

export type RepositorySafetyInterlock = Readonly<{
  phase: "activation_pending" | "active";
  record: ActiveRepositoryQuarantine;
}>;

export type RecoveryOwnershipObservation = Readonly<{
  schema: 1;
  quarantineId: string;
  lock: RecoveryLockIdentity;
  sequence: "first" | "second";
  observedAtUtc: string;
  controllerGone: true;
  hostDescendantsGone: true;
  containerProducerGone: true;
}>;

export type RepositoryRecoveryDependencies = Readonly<{
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeout?: <T>(operation: Promise<T>, milliseconds: number) => Promise<T>;
  lockPersistence?: RepositoryRecoveryLockPersistenceDependencies;
}>;

export type RepositorySafetyPersistenceFaultPoint =
  | "after_lock_retained"
  | "after_recovery_stage_create"
  | "after_recovery_stage_truncate"
  | "after_recovery_stage_write"
  | "after_recovery_stage_fsync"
  | "after_recovery_stage_directory_fsync"
  | "after_recovery_alias_cleanup"
  | "after_recovery_publish"
  | "after_recovery_publish_fsync"
  | "after_stage_create"
  | "after_stage_truncate"
  | "after_stage_write"
  | "after_stage_fsync"
  | "after_publish"
  | "after_publish_fsync"
  | "after_stage_cleanup"
  | "after_cleanup_fsync"
  | "after_intent_remove"
  | "after_intent_remove_fsync"
  | "after_active_remove"
  | "after_active_remove_fsync";

export type RepositorySafetyPersistenceDependencies = Readonly<{
  fault?: (
    point: RepositorySafetyPersistenceFaultPoint,
  ) => void | Promise<void>;
}>;

export const REPOSITORY_RECOVERY_DEAD_PROBE_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;
const OWNERSHIP_PROOF_TIMEOUT_MS = 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const triggers = new Set<RepositoryTrigger>([
  "bootstrap",
  "files",
  "mongo-bootstrap",
  "verify",
]);
const reasons = new Set<RepositoryRecoveryReason>(
  REPOSITORY_RECOVERY_REASONS,
);
const activatedLeases = new WeakMap<object, string>();
const recoveryLeaseOwners = new WeakMap<object, OwnedLockLease>();

function validateStateDirPath(stateDir: string): void {
  if (
    stateDir.length <= 1 || stateDir.length > 4_096 ||
    !isAbsolute(stateDir) || normalize(stateDir) !== stateDir ||
    [...stateDir].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) invalidState();
}

async function validateExistingStateDirectory(
  stateDir: string,
): Promise<boolean> {
  validateStateDirPath(stateDir);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(stateDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    invalidState();
  }
  try {
    const uid = await readEffectiveUid();
    if (
      !info.isDirectory || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o7777) !== 0o700 ||
      await Deno.realPath(stateDir) !== stateDir
    ) invalidState();
  } catch {
    invalidState();
  }
  return true;
}

export function repositoryQuarantinePath(stateDir: string): string {
  validateStateDirPath(stateDir);
  return join(stateDir, "repository-quarantine-v1.json");
}

export function repositoryQuarantineIntentPath(
  stateDir: string,
  quarantineId: string,
): string {
  validateStateDirPath(stateDir);
  if (!UUID.test(quarantineId)) invalidState();
  return join(
    stateDir,
    "repository-quarantine-intents",
    `${quarantineId}.json`,
  );
}

export function repositoryRecoveryAuditPath(
  stateDir: string,
  quarantineId: string,
): string {
  validateStateDirPath(stateDir);
  if (!UUID.test(quarantineId)) invalidState();
  return join(
    stateDir,
    "repository-recovery-audits",
    `${quarantineId}.json`,
  );
}

function validateRepositoryIdentity(
  value: unknown,
): asserts value is RepositoryIdentity {
  const identity = closedObject(value, ["kind", "repositoryId"]);
  if (identity.kind === "not_yet_verified") {
    if (Object.hasOwn(identity, "repositoryId")) invalidState();
    return;
  }
  if (
    identity.kind !== "verified" ||
    typeof identity.repositoryId !== "string" ||
    !HASH.test(identity.repositoryId)
  ) invalidState();
}

function validateQuarantine(
  value: unknown,
): asserts value is ActiveRepositoryQuarantine {
  const record = closedObject(value, [
    "schema",
    "kind",
    "quarantineId",
    "repository",
    "triggeringCommand",
    "backupId",
    "reason",
    "childTerminationConfirmed",
    "timedOut",
    "createdAtUtc",
  ]);
  if (
    record.schema !== 1 || record.kind !== "repository-quarantine" ||
    typeof record.quarantineId !== "string" ||
    !UUID.test(record.quarantineId) ||
    !triggers.has(record.triggeringCommand as RepositoryTrigger) ||
    !isBackupId(record.backupId) ||
    !reasons.has(record.reason as RepositoryRecoveryReason) ||
    typeof record.childTerminationConfirmed !== "boolean" ||
    typeof record.timedOut !== "boolean" || !isUtc(record.createdAtUtc)
  ) invalidState();
  validateRepositoryIdentity(record.repository);
  const validPair = record.reason === "child_status_unconfirmed" ||
      record.reason === "retention_publication_interrupted"
    ? record.childTerminationConfirmed === false
    : record.childTerminationConfirmed === true;
  if (!validPair) invalidState();
  boundedJson(record);
}

function canonicalQuarantine(record: ActiveRepositoryQuarantine): string {
  validateQuarantine(record);
  return boundedJson({
    schema: 1,
    kind: "repository-quarantine",
    quarantineId: record.quarantineId,
    repository: record.repository.kind === "verified"
      ? { kind: "verified", repositoryId: record.repository.repositoryId }
      : { kind: "not_yet_verified" },
    triggeringCommand: record.triggeringCommand,
    backupId: record.backupId,
    reason: record.reason,
    childTerminationConfirmed: record.childTerminationConfirmed,
    timedOut: record.timedOut,
    createdAtUtc: record.createdAtUtc,
  });
}

function validateAudit(
  value: unknown,
  quarantine: ActiveRepositoryQuarantine,
): asserts value is RepositoryRecoveryAudit {
  const audit = closedObject(value, [
    "schema",
    "kind",
    "quarantineId",
    "quarantineRecordSha256",
    "repository",
    "triggeringCommand",
    "backupId",
    "reason",
    "childTerminationConfirmed",
    "quarantineCreatedAtUtc",
    "auditedAtUtc",
    "controllerGone",
    "hostDescendantsGone",
    "containerProducerGone",
    "producerArtifactsGone",
    "snapshotResolution",
    "snapshotId",
  ]);
  validateRepositoryIdentity(audit.repository);
  const canonical = canonicalQuarantine(quarantine);
  const digest = createHash("sha256").update(canonical).digest("hex");
  const oneSnapshot = audit.snapshotResolution === "one_unaccepted_files" ||
    audit.snapshotResolution === "one_policy_rejected";
  const resolutionAllowed = quarantine.triggeringCommand === "bootstrap" ||
      quarantine.triggeringCommand === "verify"
    ? audit.snapshotResolution === "not_applicable"
    : quarantine.triggeringCommand === "files"
    ? audit.snapshotResolution === "exactly_zero" ||
      audit.snapshotResolution === "one_unaccepted_files"
    : audit.snapshotResolution === "exactly_zero" ||
      audit.snapshotResolution === "one_policy_rejected";
  if (
    audit.schema !== 1 || audit.kind !== "repository-recovery-audit" ||
    audit.quarantineId !== quarantine.quarantineId ||
    audit.quarantineRecordSha256 !== digest ||
    JSON.stringify(audit.repository) !==
      JSON.stringify(quarantine.repository) ||
    audit.triggeringCommand !== quarantine.triggeringCommand ||
    audit.backupId !== quarantine.backupId ||
    audit.reason !== quarantine.reason ||
    audit.childTerminationConfirmed !==
      quarantine.childTerminationConfirmed ||
    audit.quarantineCreatedAtUtc !== quarantine.createdAtUtc ||
    !isUtc(audit.auditedAtUtc) ||
    audit.auditedAtUtc < quarantine.createdAtUtc ||
    audit.controllerGone !== true ||
    audit.hostDescendantsGone !== true ||
    audit.containerProducerGone !== true ||
    audit.producerArtifactsGone !== true ||
    ![
      "not_applicable",
      "exactly_zero",
      "one_unaccepted_files",
      "one_policy_rejected",
    ].includes(audit.snapshotResolution as string) ||
    !resolutionAllowed ||
    (oneSnapshot
      ? typeof audit.snapshotId !== "string" || !HASH.test(audit.snapshotId)
      : Object.hasOwn(audit, "snapshotId"))
  ) invalidState();
  boundedJson(audit);
}

function canonicalAudit(audit: RepositoryRecoveryAudit): string {
  const base: Record<string, unknown> = {
    schema: 1,
    kind: "repository-recovery-audit",
    quarantineId: audit.quarantineId,
    quarantineRecordSha256: audit.quarantineRecordSha256,
    repository: audit.repository.kind === "verified"
      ? { kind: "verified", repositoryId: audit.repository.repositoryId }
      : { kind: "not_yet_verified" },
    triggeringCommand: audit.triggeringCommand,
    backupId: audit.backupId,
    reason: audit.reason,
    childTerminationConfirmed: audit.childTerminationConfirmed,
    quarantineCreatedAtUtc: audit.quarantineCreatedAtUtc,
    auditedAtUtc: audit.auditedAtUtc,
    controllerGone: true,
    hostDescendantsGone: true,
    containerProducerGone: true,
    producerArtifactsGone: true,
    snapshotResolution: audit.snapshotResolution,
  };
  if (audit.snapshotId !== undefined) base.snapshotId = audit.snapshotId;
  return boundedJson(base);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

async function assertProtectedDirectory(path: string): Promise<void> {
  try {
    const [info, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
    if (
      !info.isDirectory || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o7777) !== 0o700
    ) invalidState();
  } catch {
    invalidState();
  }
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { mode: 0o700 });
    await syncDirectory(join(path, ".."));
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) invalidState();
  }
  await assertProtectedDirectory(path);
}

async function readProtectedCanonical<T>(
  path: string,
  validate: (value: unknown) => asserts value is T,
  canonical: (value: T) => string,
): Promise<Readonly<{ value: T; text: string }> | undefined> {
  let before: Deno.FileInfo;
  let uid: number;
  try {
    [before, uid] = await Promise.all([
      Deno.lstat(path),
      readEffectiveUid(),
    ]);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    invalidState();
  }
  if (
    !before.isFile || before.isSymlink || before.uid !== uid ||
    before.mode === null || (before.mode & 0o7777) !== 0o600 ||
    before.size > MAX_RECORD_BYTES || before.dev === null ||
    before.ino === null
  ) invalidState();
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    invalidState();
  }
  try {
    const [opened, afterOpen] = await Promise.all([
      file.stat(),
      Deno.lstat(path),
    ]);
    if (
      !opened.isFile || opened.isSymlink || opened.uid !== uid ||
      opened.mode === null || (opened.mode & 0o7777) !== 0o600 ||
      opened.size > MAX_RECORD_BYTES || opened.dev !== before.dev ||
      opened.ino !== before.ino || !afterOpen.isFile ||
      afterOpen.isSymlink || afterOpen.uid !== uid ||
      afterOpen.mode === null || (afterOpen.mode & 0o7777) !== 0o600 ||
      afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino ||
      afterOpen.size !== opened.size
    ) invalidState();
    const bytes = new Uint8Array(MAX_RECORD_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes.subarray(count));
      if (read === null) break;
      count += read;
    }
    if (count > MAX_RECORD_BYTES || count !== opened.size) invalidState();
    const afterRead = await Deno.lstat(path);
    if (
      !afterRead.isFile || afterRead.isSymlink || afterRead.uid !== uid ||
      afterRead.mode === null || (afterRead.mode & 0o7777) !== 0o600 ||
      afterRead.dev !== opened.dev || afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size
    ) invalidState();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count),
    );
    const value = JSON.parse(text);
    validate(value);
    if (text !== canonical(value)) invalidState();
    return { value, text };
  } catch {
    invalidState();
  } finally {
    file.close();
  }
}

async function persistCreateNew(
  directory: string,
  path: string,
  text: string,
  dependencies: RepositorySafetyPersistenceDependencies = {},
): Promise<void> {
  const staging = `${path}.pending`;
  let stagingExists = false;
  let injectedCrash = false;
  const fault = async (
    point: Exclude<
      RepositorySafetyPersistenceFaultPoint,
      "after_lock_retained"
    >,
  ): Promise<void> => {
    if (!dependencies.fault) return;
    try {
      await dependencies.fault(point);
    } catch (error) {
      injectedCrash = true;
      throw error;
    }
  };
  try {
    const uid = await readEffectiveUid();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_RECORD_BYTES) invalidState();
    let file: Deno.FsFile;
    try {
      file = await Deno.open(staging, {
        createNew: true,
        read: true,
        write: true,
        mode: 0o600,
      });
      stagingExists = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const before = await Deno.lstat(staging);
      if (
        !before.isFile || before.isSymlink || before.uid !== uid ||
        before.mode === null || (before.mode & 0o7777) !== 0o600 ||
        before.size > MAX_RECORD_BYTES || before.dev === null ||
        before.ino === null
      ) invalidState();
      file = await Deno.open(staging, { read: true, write: true });
      const opened = await file.stat();
      if (
        opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || opened.mode === null ||
        (opened.mode & 0o7777) !== 0o600
      ) {
        file.close();
        invalidState();
      }
      stagingExists = true;
    }
    try {
      const opened = await file.stat();
      const named = await Deno.lstat(staging);
      if (
        !opened.isFile || opened.isSymlink || opened.uid !== uid ||
        opened.mode === null || (opened.mode & 0o7777) !== 0o600 ||
        opened.dev === null || opened.ino === null ||
        !named.isFile || named.isSymlink || named.uid !== uid ||
        named.mode === null || (named.mode & 0o7777) !== 0o600 ||
        named.dev !== opened.dev || named.ino !== opened.ino
      ) invalidState();
      let publishedAlias = false;
      try {
        const published = await Deno.lstat(path);
        if (
          !published.isFile || published.isSymlink || published.uid !== uid ||
          published.mode === null || (published.mode & 0o7777) !== 0o600 ||
          published.dev !== opened.dev || published.ino !== opened.ino ||
          published.size !== bytes.length || opened.size !== bytes.length
        ) invalidState();
        await file.seek(0, Deno.SeekMode.Start);
        const actual = new Uint8Array(bytes.length + 1);
        let count = 0;
        while (count < actual.length) {
          const read = await file.read(actual.subarray(count));
          if (read === null) break;
          count += read;
        }
        const after = await Deno.lstat(path);
        if (
          count !== bytes.length || after.dev !== opened.dev ||
          after.ino !== opened.ino || after.size !== bytes.length
        ) invalidState();
        for (let index = 0; index < bytes.length; index++) {
          if (actual[index] !== bytes[index]) invalidState();
        }
        publishedAlias = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await fault("after_stage_create");
      if (!publishedAlias) {
        await file.truncate(0);
        await fault("after_stage_truncate");
        await file.seek(0, Deno.SeekMode.Start);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await file.write(bytes.subarray(offset));
          if (written <= 0) invalidState();
          offset += written;
        }
        await fault("after_stage_write");
        await file.sync();
        await fault("after_stage_fsync");
      }
      const written = await file.stat();
      const stillNamed = await Deno.lstat(staging);
      if (
        written.dev !== opened.dev || written.ino !== opened.ino ||
        written.size !== bytes.length || stillNamed.dev !== opened.dev ||
        stillNamed.ino !== opened.ino || stillNamed.size !== bytes.length ||
        stillNamed.uid !== uid || stillNamed.mode === null ||
        (stillNamed.mode & 0o7777) !== 0o600
      ) invalidState();
    } finally {
      file.close();
    }
    try {
      await Deno.link(staging, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const [source, published] = await Promise.all([
        Deno.lstat(staging),
        Deno.lstat(path),
      ]);
      if (
        !published.isFile || published.isSymlink ||
        published.dev !== source.dev || published.ino !== source.ino
      ) invalidState();
    }
    await fault("after_publish");
    const [source, published] = await Promise.all([
      Deno.lstat(staging),
      Deno.lstat(path),
    ]);
    if (
      !published.isFile || published.isSymlink || published.uid !== uid ||
      published.mode === null || (published.mode & 0o7777) !== 0o600 ||
      published.size !== bytes.length || published.dev !== source.dev ||
      published.ino !== source.ino
    ) invalidState();
    await syncDirectory(directory);
    await fault("after_publish_fsync");
    await Deno.remove(staging);
    stagingExists = false;
    await fault("after_stage_cleanup");
    await syncDirectory(directory);
    await fault("after_cleanup_fsync");
  } catch {
    invalidState();
  } finally {
    try {
      if (stagingExists && !injectedCrash) {
        await Deno.remove(staging);
        await syncDirectory(directory);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) invalidState();
    }
  }
}

async function hasProtectedStaging(path: string): Promise<boolean> {
  try {
    const [info, uid] = await Promise.all([
      Deno.lstat(`${path}.pending`),
      readEffectiveUid(),
    ]);
    if (
      !info.isFile || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o7777) !== 0o600 ||
      info.size > MAX_RECORD_BYTES
    ) invalidState();
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function readIntent(
  stateDir: string,
): Promise<
  Readonly<{
    published?: Readonly<{
      value: ActiveRepositoryQuarantine;
      text: string;
    }>;
    staging: boolean;
    quarantineId?: string;
  }>
> {
  const directory = join(stateDir, "repository-quarantine-intents");
  try {
    await assertProtectedDirectory(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { staging: false };
    try {
      await Deno.lstat(directory);
    } catch (missing) {
      if (missing instanceof Deno.errors.NotFound) return { staging: false };
    }
    throw error;
  }
  let publishedName: string | undefined;
  let stagingName: string | undefined;
  let id: string | undefined;
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || entry.isSymlink) invalidState();
    const isStaging = entry.name.endsWith(".json.pending");
    const suffix = isStaging ? ".json.pending" : ".json";
    if (!entry.name.endsWith(suffix)) invalidState();
    const candidate = entry.name.slice(0, -suffix.length);
    if (!UUID.test(candidate) || (id !== undefined && id !== candidate)) {
      invalidState();
    }
    id = candidate;
    if (isStaging) {
      if (stagingName !== undefined) invalidState();
      stagingName = entry.name;
    } else {
      if (publishedName !== undefined) invalidState();
      publishedName = entry.name;
    }
  }
  if (stagingName) {
    const [staging, uid] = await Promise.all([
      Deno.lstat(join(directory, stagingName)),
      readEffectiveUid(),
    ]);
    if (
      !staging.isFile || staging.isSymlink || staging.uid !== uid ||
      staging.mode === null || (staging.mode & 0o7777) !== 0o600 ||
      staging.size > MAX_RECORD_BYTES
    ) invalidState();
  }
  if (!publishedName) {
    return {
      staging: stagingName !== undefined,
      ...(id === undefined ? {} : { quarantineId: id }),
    };
  }
  const result = await readProtectedCanonical(
    join(directory, publishedName),
    validateQuarantine,
    canonicalQuarantine,
  );
  if (!result || result.value.quarantineId !== id) invalidState();
  return {
    published: result,
    staging: stagingName !== undefined,
    quarantineId: id,
  };
}

async function readLockRetention(
  stateDir: string,
): Promise<
  | Readonly<{
    value: ActiveRepositoryQuarantine;
    text: string;
    fallback: boolean;
  }>
  | undefined
> {
  let retention;
  try {
    retention = await readRepositoryRecoveryLockRetention(
      join(stateDir, "backup.lock"),
    );
  } catch {
    invalidState();
  }
  if (!retention) return undefined;
  try {
    if ("kind" in retention) {
      const value: ActiveRepositoryQuarantine = {
        schema: 1,
        kind: "repository-quarantine",
        quarantineId: retention.quarantineId,
        repository: { kind: "not_yet_verified" },
        triggeringCommand: retention.triggeringCommand,
        backupId: retention.backupId,
        reason: "retention_publication_interrupted",
        childTerminationConfirmed: false,
        timedOut: false,
        createdAtUtc: retention.reservedAtUtc,
      };
      const text = canonicalQuarantine(value);
      return { value, text, fallback: true };
    }
    const value: unknown = JSON.parse(retention.quarantineRecord);
    validateQuarantine(value);
    const text = canonicalQuarantine(value);
    if (
      text !== retention.quarantineRecord ||
      value.quarantineId !== retention.quarantineId ||
      value.backupId !== retention.backupId ||
      value.triggeringCommand !== retention.triggeringCommand ||
      (retention.reservedAtUtc !== undefined &&
        value.createdAtUtc !== retention.reservedAtUtc)
    ) invalidState();
    return { value, text, fallback: false };
  } catch {
    invalidState();
  }
}

export async function readRepositoryQuarantine(
  stateDir: string,
): Promise<ActiveRepositoryQuarantine | undefined> {
  if (!await validateExistingStateDirectory(stateDir)) return undefined;
  const result = await readProtectedCanonical(
    repositoryQuarantinePath(stateDir),
    validateQuarantine,
    canonicalQuarantine,
  );
  return result?.value;
}

export async function readRepositorySafetyInterlock(
  stateDir: string,
): Promise<RepositorySafetyInterlock | undefined> {
  if (!await validateExistingStateDirectory(stateDir)) return undefined;
  const [active, activeStaging, intentState, retention] = await Promise.all([
    readProtectedCanonical(
      repositoryQuarantinePath(stateDir),
      validateQuarantine,
      canonicalQuarantine,
    ),
    hasProtectedStaging(repositoryQuarantinePath(stateDir)),
    readIntent(stateDir),
    readLockRetention(stateDir),
  ]);
  const intent = intentState.published;
  if (!active && !intent && !retention) {
    if (activeStaging || intentState.staging) invalidState();
    return undefined;
  }
  // A normal mutating lock is a pre-mutation WAL and therefore a fallback
  // interlock on its own. Once an intent or active quarantine exists, that
  // complete durable record is authoritative; a newly attempted writer's WAL
  // must not turn an existing quarantine into malformed state. Exact retained
  // recovery records still have to agree byte-for-byte.
  const comparedRetention = retention?.fallback && (active || intent)
    ? undefined
    : retention;
  const records = [active, intent, comparedRetention].filter((value) =>
    value !== undefined
  );
  if (records.some((value) => value!.text !== records[0]!.text)) invalidState();
  if (
    intentState.quarantineId !== undefined &&
    intentState.quarantineId !== records[0]!.value.quarantineId
  ) invalidState();
  return {
    phase: active ? "active" : "activation_pending",
    record: (active ?? intent ?? retention)!.value,
  };
}

export async function assertRepositoryWritable(
  stateDir: string,
  lease?: OwnedLockLease,
): Promise<void> {
  const interlock = await readRepositorySafetyInterlock(stateDir);
  if (!interlock) return;
  if (
    lease && interlock.phase === "activation_pending" &&
    interlock.record.reason === "retention_publication_interrupted"
  ) {
    await assertOwnedLockLease(join(stateDir, "backup.lock"), lease);
    const context = ownedLockContext(lease);
    if (
      context.command === interlock.record.triggeringCommand &&
      context.backupId === interlock.record.backupId &&
      context.recoveryAttempt?.quarantineId ===
        interlock.record.quarantineId &&
      context.recoveryAttempt.reservedAtUtc === interlock.record.createdAtUtc
    ) return;
  }
  throw Object.assign(new Error("Repository is quarantined"), {
    code: "REPOSITORY_QUARANTINED" as const,
    quarantineId: interlock.record.quarantineId,
    reason: interlock.record.reason,
  });
}

export async function retainLeaseForRepositoryRecovery(
  stateDir: string,
  lease: OwnedLockLease,
  record: ActiveRepositoryQuarantine,
  dependencies: RepositorySafetyPersistenceDependencies = {},
): Promise<void> {
  if (!await validateExistingStateDirectory(stateDir)) invalidState();
  const candidateId = ownData(record, "quarantineId");
  validateQuarantine(record);
  const context = ownedLockContext(lease);
  if (
    context.command !== record.triggeringCommand ||
    context.backupId !== record.backupId ||
    context.recoveryAttempt?.quarantineId !== record.quarantineId ||
    context.recoveryAttempt.reservedAtUtc !== record.createdAtUtc
  ) invalidState();
  const canonical = canonicalQuarantine(record);
  await retainOwnedLockLease(
    join(stateDir, "backup.lock"),
    lease,
    {
      quarantineId: typeof candidateId === "string" ? candidateId : "invalid",
      triggeringCommand: record.triggeringCommand,
      backupId: record.backupId,
      quarantineRecord: canonical,
    },
    { fault: dependencies.fault },
  );
  await dependencies.fault?.("after_lock_retained");
  await assertProtectedDirectory(stateDir);
  const directory = join(stateDir, "repository-quarantine-intents");
  await ensureProtectedDirectory(directory);
  const existing = await readRepositorySafetyInterlock(stateDir);
  if (existing) {
    if (canonicalQuarantine(existing.record) !== canonical) invalidState();
    const intentState = await readIntent(stateDir);
    if (intentState.published?.text === canonical) {
      if (intentState.staging) {
        await persistCreateNew(
          directory,
          repositoryQuarantineIntentPath(stateDir, record.quarantineId),
          canonical,
          dependencies,
        );
      }
      return;
    }
  }
  await persistCreateNew(
    directory,
    repositoryQuarantineIntentPath(stateDir, record.quarantineId),
    canonical,
    dependencies,
  );
}

export async function activateRepositoryQuarantine(
  stateDir: string,
  lease: OwnedLockLease,
  record: ActiveRepositoryQuarantine,
): Promise<void> {
  validateQuarantine(record);
  await assertOwnedLockLeaseRetained(
    join(stateDir, "backup.lock"),
    lease,
    record.quarantineId,
  );
  const interlock = await readRepositorySafetyInterlock(stateDir);
  if (
    !interlock ||
    canonicalQuarantine(interlock.record) !== canonicalQuarantine(record)
  ) {
    invalidState();
  }
  const activePath = repositoryQuarantinePath(stateDir);
  const active = await readProtectedCanonical(
    activePath,
    validateQuarantine,
    canonicalQuarantine,
  );
  const activeStaging = await hasProtectedStaging(activePath);
  if (!active || activeStaging) {
    await persistCreateNew(
      stateDir,
      activePath,
      canonicalQuarantine(record),
    );
  } else if (active.text !== canonicalQuarantine(record)) {
    invalidState();
  }
  activatedLeases.set(lease, record.quarantineId);
}

export async function allowLeaseReleaseAfterRepositoryQuarantine(
  stateDir: string,
  lease: OwnedLockLease,
  quarantineId: string,
): Promise<void> {
  if (activatedLeases.get(lease) !== quarantineId) {
    throw failureError("LOCK_HELD");
  }
  const active = await readRepositoryQuarantine(stateDir);
  if (!active || active.quarantineId !== quarantineId) {
    throw failureError("LOCK_HELD");
  }
  await allowOwnedLockLeaseRelease(
    join(stateDir, "backup.lock"),
    lease,
    quarantineId,
  );
  activatedLeases.delete(lease);
}

function validateRecoveryLockIdentity(
  value: unknown,
): asserts value is RecoveryLockIdentity {
  const lock = closedObject(value, [
    "kind",
    "pid",
    "processStartedAtUtc",
    "command",
    "backupId",
    "quarantineId",
    "reservedAtUtc",
    "triggeringCommand",
    "quarantineRecordSha256",
    "dev",
    "ino",
  ]);
  if (lock.kind === "missing") {
    if (Object.keys(lock).length !== 1) invalidState();
    return;
  }
  if (
    lock.kind !== "present" || !Number.isSafeInteger(lock.pid) ||
    (lock.pid as number) <= 0 || (lock.pid as number) > 2147483647 ||
    !isUtc(lock.processStartedAtUtc) ||
    (!triggers.has(lock.command as RepositoryTrigger) &&
      lock.command !== "recover-repository") ||
    !isBackupId(lock.backupId) || !Number.isSafeInteger(lock.dev) ||
    (lock.dev as number) < 0 || !Number.isSafeInteger(lock.ino) ||
    (lock.ino as number) <= 0
  ) invalidState();
  if (lock.command === "recover-repository") {
    if (
      Object.hasOwn(lock, "reservedAtUtc") ||
      typeof lock.quarantineId !== "string" ||
      !UUID.test(lock.quarantineId) ||
      !triggers.has(lock.triggeringCommand as RepositoryTrigger) ||
      typeof lock.quarantineRecordSha256 !== "string" ||
      !HASH.test(lock.quarantineRecordSha256)
    ) invalidState();
  } else if (
    typeof lock.quarantineId !== "string" ||
    !UUID.test(lock.quarantineId) || !isUtc(lock.reservedAtUtc) ||
    Object.hasOwn(lock, "triggeringCommand") ||
    Object.hasOwn(lock, "quarantineRecordSha256")
  ) invalidState();
}

function sameRecoveryLockIdentity(
  left: RecoveryLockIdentity,
  right: RecoveryLockIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  if (left.pid !== right.pid) return false;
  if (
    left.processStartedAtUtc !== right.processStartedAtUtc ||
    left.command !== right.command || left.backupId !== right.backupId ||
    left.dev !== right.dev || left.ino !== right.ino
  ) return false;
  if (left.command !== "recover-repository") {
    return right.command !== "recover-repository" &&
      left.quarantineId === right.quarantineId &&
      left.reservedAtUtc === right.reservedAtUtc;
  }
  return right.command === "recover-repository" &&
    left.quarantineId === right.quarantineId &&
    left.triggeringCommand === right.triggeringCommand &&
    left.quarantineRecordSha256 === right.quarantineRecordSha256;
}

function validateObservation(
  value: unknown,
  quarantineId: string,
  expectedLock: RecoveryLockIdentity,
  expectedSequence: RecoveryOwnershipObservation["sequence"],
): asserts value is RecoveryOwnershipObservation {
  const observation = closedObject(value, [
    "schema",
    "quarantineId",
    "lock",
    "sequence",
    "observedAtUtc",
    "controllerGone",
    "hostDescendantsGone",
    "containerProducerGone",
  ]);
  validateRecoveryLockIdentity(observation.lock);
  if (
    observation.schema !== 1 || observation.quarantineId !== quarantineId ||
    observation.sequence !== expectedSequence ||
    !isUtc(observation.observedAtUtc) ||
    !sameRecoveryLockIdentity(observation.lock, expectedLock) ||
    observation.controllerGone !== true ||
    observation.hostDescendantsGone !== true ||
    observation.containerProducerGone !== true
  ) invalidState();
}

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(failureError("STATE_INVALID")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withRepositoryRecoveryLease<T>(
  stateDir: string,
  quarantineId: string,
  probeOwnerAndDescendants: (
    expectedLock: RecoveryLockIdentity,
    sequence: RecoveryOwnershipObservation["sequence"],
  ) => Promise<RecoveryOwnershipObservation>,
  action: (lease: RepositoryRecoveryLease) => Promise<T>,
  dependencies: RepositoryRecoveryDependencies = {},
): Promise<T> {
  if (!UUID.test(quarantineId)) invalidState();
  const interlock = await readRepositorySafetyInterlock(stateDir);
  if (!interlock || interlock.record.quarantineId !== quarantineId) {
    invalidState();
  }
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const readMonotonic = (): number => {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) invalidState();
    return value;
  };
  const sleep = dependencies.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeout = dependencies.timeout ?? bounded;
  return await withAdoptedRepositoryRecoveryLock(
    join(stateDir, "backup.lock"),
    {
      backupId: interlock.record.backupId,
      quarantineId,
      triggeringCommand: interlock.record.triggeringCommand,
      quarantineRecord: canonicalQuarantine(interlock.record),
      requirePresent: interlock.phase === "activation_pending",
    },
    async (expectedLock) => {
      const current = await readRepositorySafetyInterlock(stateDir);
      if (
        !current || current.phase !== interlock.phase ||
        canonicalQuarantine(current.record) !==
          canonicalQuarantine(interlock.record)
      ) invalidState();
      const started = readMonotonic();
      const deadline = started + OWNERSHIP_PROOF_TIMEOUT_MS;
      const stepBudget = (now: number, maximum: number): number => {
        if (now < started) invalidState();
        const remaining = deadline - now;
        if (!Number.isFinite(remaining) || remaining <= 0) invalidState();
        return Math.min(maximum, remaining);
      };
      const firstBudget = stepBudget(started, PROBE_TIMEOUT_MS);
      const first = await timeout(
        probeOwnerAndDescendants(expectedLock, "first"),
        firstBudget,
      );
      validateObservation(first, quarantineId, expectedLock, "first");
      const firstSettled = readMonotonic();
      if (firstSettled < started) invalidState();
      const sleepBudget = stepBudget(
        firstSettled,
        REPOSITORY_RECOVERY_DEAD_PROBE_INTERVAL_MS,
      );
      await timeout(
        sleep(REPOSITORY_RECOVERY_DEAD_PROBE_INTERVAL_MS),
        sleepBudget,
      );
      const secondStarted = readMonotonic();
      if (
        secondStarted - firstSettled <
          REPOSITORY_RECOVERY_DEAD_PROBE_INTERVAL_MS ||
        secondStarted >= deadline
      ) invalidState();
      const secondBudget = stepBudget(secondStarted, PROBE_TIMEOUT_MS);
      const second = await timeout(
        probeOwnerAndDescendants(expectedLock, "second"),
        secondBudget,
      );
      validateObservation(second, quarantineId, expectedLock, "second");
      if (
        Date.parse(second.observedAtUtc) <= Date.parse(first.observedAtUtc) ||
        readMonotonic() >= deadline
      ) invalidState();
    },
    async (ownedLease) => {
      const current = await readRepositorySafetyInterlock(stateDir);
      if (!current || current.record.quarantineId !== quarantineId) {
        invalidState();
      }
      const canonical = canonicalQuarantine(current.record);
      const intentDirectory = join(
        stateDir,
        "repository-quarantine-intents",
      );
      await ensureProtectedDirectory(intentDirectory);
      const intentState = await readIntent(stateDir);
      if (!intentState.published || intentState.staging) {
        if (
          intentState.published && intentState.published.text !== canonical
        ) invalidState();
        await persistCreateNew(
          intentDirectory,
          repositoryQuarantineIntentPath(stateDir, quarantineId),
          canonical,
        );
      } else if (intentState.published.text !== canonical) {
        invalidState();
      }
      const activePath = repositoryQuarantinePath(stateDir);
      const active = await readProtectedCanonical(
        activePath,
        validateQuarantine,
        canonicalQuarantine,
      );
      const activeStaging = await hasProtectedStaging(activePath);
      if (!active || activeStaging) {
        if (active && active.text !== canonical) invalidState();
        await persistCreateNew(stateDir, activePath, canonical);
      } else if (active.text !== canonical) {
        invalidState();
      }
      const recoveryLease = Object.freeze({
        path: ownedLease.path,
        dev: ownedLease.dev,
        ino: ownedLease.ino,
        command: "recover-repository" as const,
        quarantineId,
      }) as RepositoryRecoveryLease;
      recoveryLeaseOwners.set(recoveryLease, ownedLease);
      try {
        return await action(recoveryLease);
      } finally {
        recoveryLeaseOwners.delete(recoveryLease);
      }
    },
    dependencies.lockPersistence,
  );
}

export async function writeRepositoryRecoveryAudit(
  stateDir: string,
  lease: RepositoryRecoveryLease,
  audit: RepositoryRecoveryAudit,
): Promise<void> {
  const ownedLease = recoveryLeaseOwners.get(lease);
  if (!ownedLease || lease.command !== "recover-repository") {
    throw failureError("LOCK_HELD");
  }
  await assertOwnedLockLease(join(stateDir, "backup.lock"), ownedLease);
  const interlock = await readRepositorySafetyInterlock(stateDir);
  if (
    !interlock || interlock.phase !== "active" ||
    interlock.record.quarantineId !== lease.quarantineId
  ) invalidState();
  validateAudit(audit, interlock.record);
  const directory = join(stateDir, "repository-recovery-audits");
  await ensureProtectedDirectory(directory);
  const path = repositoryRecoveryAuditPath(stateDir, lease.quarantineId);
  const existing = await readProtectedCanonical(
    path,
    (value): asserts value is RepositoryRecoveryAudit =>
      validateAudit(value, interlock.record),
    canonicalAudit,
  );
  const canonical = canonicalAudit(audit);
  if (existing) {
    if (existing.text !== canonical) invalidState();
    if (await hasProtectedStaging(path)) {
      await persistCreateNew(directory, path, canonical);
    }
    return;
  }
  await persistCreateNew(directory, path, canonical);
}

export async function clearRepositoryQuarantine(
  stateDir: string,
  lease: RepositoryRecoveryLease,
  audit: RepositoryRecoveryAudit,
  dependencies: RepositorySafetyPersistenceDependencies = {},
): Promise<void> {
  const ownedLease = recoveryLeaseOwners.get(lease);
  if (!ownedLease || lease.command !== "recover-repository") {
    throw failureError("LOCK_HELD");
  }
  await assertOwnedLockLease(join(stateDir, "backup.lock"), ownedLease);
  const interlock = await readRepositorySafetyInterlock(stateDir);
  if (
    !interlock || interlock.phase !== "active" ||
    interlock.record.quarantineId !== lease.quarantineId
  ) invalidState();
  validateAudit(audit, interlock.record);
  const auditDirectory = join(stateDir, "repository-recovery-audits");
  await assertProtectedDirectory(auditDirectory);
  const receipt = await readProtectedCanonical(
    repositoryRecoveryAuditPath(stateDir, lease.quarantineId),
    (value): asserts value is RepositoryRecoveryAudit =>
      validateAudit(value, interlock.record),
    canonicalAudit,
  );
  if (!receipt || receipt.text !== canonicalAudit(audit)) invalidState();

  const intent = (await readIntent(stateDir)).published;
  if (intent) {
    if (intent.text !== canonicalQuarantine(interlock.record)) invalidState();
    await Deno.remove(
      repositoryQuarantineIntentPath(stateDir, lease.quarantineId),
    );
    await dependencies.fault?.("after_intent_remove");
    await syncDirectory(join(stateDir, "repository-quarantine-intents"));
    await dependencies.fault?.("after_intent_remove_fsync");
  }
  const active = await readProtectedCanonical(
    repositoryQuarantinePath(stateDir),
    validateQuarantine,
    canonicalQuarantine,
  );
  if (!active || active.text !== canonicalQuarantine(interlock.record)) {
    invalidState();
  }
  await Deno.remove(repositoryQuarantinePath(stateDir));
  await dependencies.fault?.("after_active_remove");
  await syncDirectory(stateDir);
  await dependencies.fault?.("after_active_remove_fsync");
  await allowOwnedLockLeaseRelease(
    join(stateDir, "backup.lock"),
    ownedLease,
    lease.quarantineId,
  );
}
