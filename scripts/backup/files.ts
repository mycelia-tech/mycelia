import { join } from "node:path";
import { loadBackupConfig } from "./config.ts";
import {
  ensureBootstrapDirectories,
  validateBootstrapDirectories,
} from "./bootstrap-state.ts";
import { collectCurrentSourceManifest } from "./preflight.ts";
import {
  loadVerifiedResticContext,
  type VerifiedResticContext,
} from "./restic.ts";
import {
  assertOwnedLockLease,
  backupStatusPath,
  ownedLockContext,
  type OwnedLockLease,
  preserveOwnedLockForRecovery,
  readState,
  validateFilesReceipt,
  withLock,
  writeStateAtomic,
} from "./state.ts";
import {
  activateRepositoryQuarantine,
  type ActiveRepositoryQuarantine,
  allowLeaseReleaseAfterRepositoryQuarantine,
  assertRepositoryWritable,
  retainLeaseForRepositoryRecovery,
} from "./repository-safety.ts";
import { DenoRunner, isCommandTerminationError } from "./runner.ts";
import type { BackupStatus, FilesAcceptedReceipt, Runner } from "./types.ts";
import { failureError, redactError } from "./redact.ts";
import {
  assertFingerprint,
  cleanupArtifact,
  cleanupStaleArtifacts,
  manifestPath,
  prepareFileArtifacts,
} from "./file-artifacts.ts";
import {
  checkRepository,
  dumpDigest,
  readSnapshot,
  runResticJsonBackup,
} from "./restic-io.ts";
import { RESTIC_BACKUP_TIMEOUT_MS } from "./limits.ts";

export type FilesDependencies = {
  runner?: Runner;
  homeDir?: string;
  now?: () => Date;
  randomUUID?: () => string;
  loadResticContext?: typeof loadVerifiedResticContext;
  collectSourceManifest?: typeof collectCurrentSourceManifest;
  writeState?: typeof writeStateAtomic;
};

async function quarantine(
  stateDir: string,
  lease: OwnedLockLease,
  error: unknown,
  repositoryId?: string,
): Promise<boolean> {
  if (!isCommandTerminationError(error)) return false;
  const c = ownedLockContext(lease);
  if (!c.recoveryAttempt || (c.command !== "files" && c.command !== "verify")) {
    throw failureError("LOCK_HELD");
  }
  const record: ActiveRepositoryQuarantine = {
    schema: 1,
    kind: "repository-quarantine",
    quarantineId: c.recoveryAttempt.quarantineId,
    repository: repositoryId
      ? { kind: "verified", repositoryId }
      : { kind: "not_yet_verified" },
    triggeringCommand: c.command,
    backupId: c.backupId,
    reason: error.terminationConfirmed
      ? "forced_kill_descendants_unproved"
      : "child_status_unconfirmed",
    childTerminationConfirmed: error.terminationConfirmed,
    timedOut: error.timedOut,
    createdAtUtc: c.recoveryAttempt.reservedAtUtc,
  };
  await retainLeaseForRepositoryRecovery(stateDir, lease, record);
  await activateRepositoryQuarantine(stateDir, lease, record);
  await allowLeaseReleaseAfterRepositoryQuarantine(
    stateDir,
    lease,
    record.quarantineId,
  );
  return true;
}

export async function runFilesBackup(
  options: { composeRoot: string },
  deps: FilesDependencies = {},
): Promise<BackupStatus> {
  const { composeRoot } = options;
  const homeDir = deps.homeDir ?? Deno.env.get("HOME") ?? composeRoot;
  const config = await loadBackupConfig(composeRoot, homeDir);
  await assertRepositoryWritable(config.stateDir);
  await ensureBootstrapDirectories(composeRoot);
  const now = deps.now ?? (() => new Date());
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID());
  const startedAtUtc = now().toISOString();
  const backupId = startedAtUtc.replace(/[-:.]/g, "") + "-" +
    uuid().slice(0, 8);
  const runner = deps.runner ?? new DenoRunner();
  return await withLock(
    config.lockPath,
    { command: "files", backupId },
    async (lease) => {
      const assertLease = () => assertOwnedLockLease(config.lockPath, lease);
      await assertRepositoryWritable(config.stateDir, lease);
      const path = backupStatusPath(config.stateDir, "files");
      const previous = await readState(path);
      let state: BackupStatus = {
        schema: 1,
        stage: "files",
        state: "running",
        backupId,
        startedAtUtc,
        ...(previous?.accepted ? { accepted: previous.accepted } : {}),
      };
      let stateWriteFailed = false;
      const save = async () => {
        await assertLease();
        try {
          await (deps.writeState ?? writeStateAtomic)(path, state);
        } catch (error) {
          stateWriteFailed = true;
          await preserveOwnedLockForRecovery(lease);
          throw error;
        }
        await assertLease();
      };
      let context: VerifiedResticContext | undefined;
      let artifacts:
        | Awaited<ReturnType<typeof prepareFileArtifacts>>
        | undefined;
      let cleaned = false;
      const cleanup = async () => {
        if (!artifacts || cleaned) return;
        await assertLease();
        await cleanupArtifact(artifacts.input, config.stateDir);
        await assertLease();
        await cleanupArtifact(artifacts.inventory, config.stateDir);
        cleaned = true;
      };
      try {
        await save();
        context = await (deps.loadResticContext ?? loadVerifiedResticContext)(
          composeRoot,
          lease,
          { runner, homeDir },
        );
        if (
          !context.preflight.ok || !context.preflight.localVerified ||
          !context.preflight.remoteVerified ||
          context.preflight.backupId !== backupId ||
          !context.preflight.sourceCoverage?.complete
        ) throw failureError("SOURCE_COVERAGE_INCOMPLETE");
        if (
          previous?.accepted &&
          previous.accepted.repositoryId !== context.repositoryId
        ) throw failureError("REPOSITORY_ID_MISMATCH");
        const guard = context.assertUnchanged;
        const beforeChild = async () => {
          await assertLease();
          await guard();
          await assertRepositoryWritable(config.stateDir, lease);
        };
        await assertLease();
        const manifest =
          await (deps.collectSourceManifest ?? collectCurrentSourceManifest)({
            composeRoot,
            backupId,
          }, { runner, homeDir });
        if (manifest.backupId !== backupId) {
          throw failureError(
            "SOURCE_COVERAGE_INCOMPLETE",
          );
        }
        await assertLease();
        await cleanupStaleArtifacts(config.stateDir);
        artifacts = await prepareFileArtifacts({
          composeRoot,
          stateDir: config.stateDir,
          manifest,
          context,
          startedAtUtc,
          runner,
          uuid: uuid(),
          assertLease,
        });
        state.sourceCounts = {
          files: artifacts.files.length,
          bytes: artifacts.sourceBytes,
          total: manifest.coverage.total,
          covered: manifest.coverage.covered,
          missing: 0,
          unreadable: 0,
          outsideRoots: 0,
          invalid: 0,
        };
        await save();
        // Catch changes that happened while the inventory or representative was read.
        for (
          const file of [
            ...artifacts.files,
            artifacts.inventory,
            artifacts.input,
          ]
        ) await assertFingerprint(file);
        await beforeChild();
        const execution = await runResticJsonBackup(runner, [
          "restic",
          "--json",
          "--quiet",
          "--no-cache",
          "backup",
          "--host",
          `mycelia-${context.installationId}`,
          "--tag",
          "mycelia-files",
          "--tag",
          `backup-id=${backupId}`,
          ...(previous?.accepted
            ? ["--parent", previous.accepted.snapshotId]
            : ["--force"]),
          "--files-from-raw",
          artifacts.input.path,
        ], { env: context.env, timeoutMs: RESTIC_BACKUP_TIMEOUT_MS });
        await assertLease();
        if (execution.summary) {
          state.snapshotId = execution.summary.snapshotId;
          await save();
        }
        if (execution.exitCode !== 0 || !execution.summary) {
          throw failureError(
            "FILES_BACKUP_FAILED",
          );
        }
        if (
          execution.summary.totalFilesProcessed !==
            artifacts.files.length + 1 ||
          execution.summary.totalBytesProcessed !==
            artifacts.sourceBytes + artifacts.inventoryDigest.byteCount
        ) throw failureError("SOURCE_COVERAGE_INCOMPLETE");
        for (
          const file of [
            ...artifacts.files,
            artifacts.inventory,
            artifacts.input,
          ]
        ) await assertFingerprint(file);
        const ordinal = (previous?.accepted?.verificationOrdinal ?? 0) + 1;
        const part = ((ordinal - 1) % 100) + 1;
        await beforeChild();
        await readSnapshot(runner, context.env, {
          snapshotId: state.snapshotId!,
          host: `mycelia-${context.installationId}`,
          backupId,
          paths: [...manifest.files, artifacts.inventory.path],
          startedAtUtc,
          endedAtUtc: now().toISOString(),
        });
        await beforeChild();
        await checkRepository(runner, context.env, part);
        for (
          const [path, digest] of [[
            artifacts.inventory.path,
            artifacts.inventoryDigest,
          ], [
            join(composeRoot, "docker-compose.yml"),
            artifacts.representativeDigest,
          ]] as const
        ) {
          await beforeChild();
          const readback = await dumpDigest(
            runner,
            context.env,
            state.snapshotId!,
            path,
          );
          if (
            readback.sha256Hex !== digest.sha256Hex ||
            readback.byteCount !== digest.byteCount
          ) throw failureError("RESTIC_VERIFY_FAILED");
        }
        await cleanup();
        const accepted: FilesAcceptedReceipt = {
          schema: 1,
          kind: "files",
          repositoryId: context.repositoryId,
          backupId,
          snapshotId: state.snapshotId!,
          acceptedAtUtc: now().toISOString(),
          verificationOrdinal: ordinal,
          checkSubsetPart: part,
          manifestSha256: artifacts.inventoryDigest.sha256Hex,
          manifestBytes: artifacts.inventoryDigest.byteCount,
          representativeSha256: artifacts.representativeDigest.sha256Hex,
          representativeBytes: artifacts.representativeDigest.byteCount,
          sourceCounts: state
            .sourceCounts as FilesAcceptedReceipt["sourceCounts"],
          transportVerified: true,
        };
        state = {
          ...state,
          state: "complete",
          endedAtUtc: accepted.acceptedAtUtc,
          accepted,
        };
        await save();
        return state;
      } catch (error) {
        if (stateWriteFailed) throw error;
        const quarantined = await quarantine(
          config.stateDir,
          lease,
          error,
          context?.repositoryId,
        );
        let failure = error;
        if (!quarantined) {
          try {
            await cleanup();
          } catch (cleanupError) {
            failure = cleanupError;
          }
        }
        state = {
          ...state,
          state: "failed",
          endedAtUtc: now().toISOString(),
          failure: redactError(failure, {
            stage: "files",
            backupId,
            tool: "backupctl",
            timestampUtc: now().toISOString(),
          }),
        };
        await save();
        return state;
      }
    },
  );
}

export async function verifyAcceptedFiles(
  options: { composeRoot: string; lockLease: OwnedLockLease },
  receipt: FilesAcceptedReceipt,
  deps: FilesDependencies = {},
): Promise<void> {
  validateFilesReceipt(receipt);
  const paths = await validateBootstrapDirectories(options.composeRoot);
  const runner = deps.runner ?? new DenoRunner();
  let context: VerifiedResticContext | undefined;
  try {
    await assertRepositoryWritable(paths.stateDir, options.lockLease);
    context = await (deps.loadResticContext ?? loadVerifiedResticContext)(
      options.composeRoot,
      options.lockLease,
      { runner, ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) },
    );
    if (context.repositoryId !== receipt.repositoryId) {
      throw failureError("REPOSITORY_ID_MISMATCH");
    }
    const guard = context.assertUnchanged;
    const before = async () => {
      await assertOwnedLockLease(
        join(paths.stateDir, "backup.lock"),
        options.lockLease,
      );
      await guard();
    };
    await before();
    await readSnapshot(runner, context.env, {
      snapshotId: receipt.snapshotId,
      backupId: receipt.backupId,
      host: `mycelia-${context.installationId}`,
    });
    await before();
    await checkRepository(runner, context.env, receipt.checkSubsetPart);
    for (
      const [path, sha256, count] of [[
        manifestPath(paths.stateDir, receipt.backupId),
        receipt.manifestSha256,
        receipt.manifestBytes,
      ], [
        join(options.composeRoot, "docker-compose.yml"),
        receipt.representativeSha256,
        receipt.representativeBytes,
      ]] as const
    ) {
      await before();
      const result = await dumpDigest(
        runner,
        context.env,
        receipt.snapshotId,
        path,
      );
      if (result.sha256Hex !== sha256 || result.byteCount !== count) {
        throw failureError("RESTIC_VERIFY_FAILED");
      }
    }
    await before();
  } catch (error) {
    await quarantine(
      paths.stateDir,
      options.lockLease,
      error,
      context?.repositoryId,
    );
    throw error;
  }
}
