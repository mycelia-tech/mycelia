import { createHash } from "node:crypto";
import {
  activateRepositoryQuarantine,
  type ActiveRepositoryQuarantine,
  allowLeaseReleaseAfterRepositoryQuarantine,
  assertRepositoryWritable,
  clearRepositoryQuarantine,
  readRepositoryQuarantine,
  readRepositorySafetyInterlock,
  type RecoveryLockIdentity,
  type RecoveryOwnershipObservation,
  repositoryQuarantineIntentPath,
  repositoryQuarantinePath,
  type RepositoryRecoveryAudit,
  repositoryRecoveryAuditPath,
  retainLeaseForRepositoryRecovery,
  withRepositoryRecoveryLease,
  writeRepositoryRecoveryAudit,
} from "./repository-safety.ts";
import { clearStaleLock, withLock } from "./state.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const quarantineId = "11111111-1111-4111-8111-111111111111";
const backupId = "20260930T120000Z";
const createdAtUtc = "2026-09-30T12:00:00.000Z";

function record(
  triggeringCommand: ActiveRepositoryQuarantine["triggeringCommand"] = "files",
): ActiveRepositoryQuarantine {
  return {
    schema: 1,
    kind: "repository-quarantine",
    quarantineId,
    repository: { kind: "not_yet_verified" },
    triggeringCommand,
    backupId,
    reason: "child_status_unconfirmed",
    childTerminationConfirmed: false,
    timedOut: true,
    createdAtUtc,
  };
}

function lockOptions(
  expected: ActiveRepositoryQuarantine = record(),
): Readonly<{
  command: ActiveRepositoryQuarantine["triggeringCommand"];
  backupId: string;
  recoveryAttempt: Readonly<{ quarantineId: string; reservedAtUtc: string }>;
}> {
  return {
    command: expected.triggeringCommand,
    backupId: expected.backupId,
    recoveryAttempt: {
      quarantineId: expected.quarantineId,
      reservedAtUtc: expected.createdAtUtc,
    },
  };
}

function observation(
  lock: RecoveryLockIdentity,
  sequence: RecoveryOwnershipObservation["sequence"],
): RecoveryOwnershipObservation {
  return {
    schema: 1,
    quarantineId,
    lock,
    sequence,
    observedAtUtc: sequence === "first"
      ? "2026-09-30T12:01:00.000Z"
      : "2026-09-30T12:01:02.000Z",
    controllerGone: true,
    hostDescendantsGone: true,
    containerProducerGone: true,
  };
}

function recoveryAudit(
  expected: ActiveRepositoryQuarantine,
): RepositoryRecoveryAudit {
  return {
    schema: 1,
    kind: "repository-recovery-audit",
    quarantineId: expected.quarantineId,
    quarantineRecordSha256: createHash("sha256")
      .update(JSON.stringify(expected))
      .digest("hex"),
    repository: expected.repository,
    triggeringCommand: expected.triggeringCommand,
    backupId: expected.backupId,
    reason: expected.reason,
    childTerminationConfirmed: expected.childTerminationConfirmed,
    quarantineCreatedAtUtc: expected.createdAtUtc,
    auditedAtUtc: "2026-09-30T12:02:00.000Z",
    controllerGone: true,
    hostDescendantsGone: true,
    containerProducerGone: true,
    producerArtifactsGone: true,
    snapshotResolution: "exactly_zero",
  };
}

async function withStateDir(
  action: (stateDir: string, lockPath: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const stateDir = `${root}/.local/backup`;
  const lockPath = `${stateDir}/backup.lock`;
  try {
    await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await Deno.chmod(`${root}/.local`, 0o700);
    await Deno.chmod(stateDir, 0o700);
    await action(stateDir, lockPath);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function installActiveQuarantineWithDeadOwner(
  stateDir: string,
  lockPath: string,
  expected: ActiveRepositoryQuarantine = record(),
): Promise<void> {
  await withLock(
    lockPath,
    lockOptions(expected),
    async (lease) => {
      await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
      await activateRepositoryQuarantine(stateDir, lease, expected);
      throw new Error("simulate controller crash with recovery lock retained");
    },
  ).catch(() => undefined);
  const retained = JSON.parse(await Deno.readTextFile(lockPath));
  await Deno.writeTextFile(
    lockPath,
    JSON.stringify({
      ...retained,
      pid: 2147483647,
      processStartedAtUtc: "2026-09-30T11:59:00.000Z",
    }),
  );
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<Error & Record<string, unknown>> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected ${code}`);
  assert(
    (caught as Error & { code?: string }).code === code,
    `expected ${code}`,
  );
  return caught as Error & Record<string, unknown>;
}

Deno.test("pending intent globally blocks writers and is durable before a retained lock can unwind", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await expectCode(
      withLock(
        lockPath,
        lockOptions(expected),
        async (lease) => {
          await assertRepositoryWritable(stateDir, lease);
          await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
          const interlock = await readRepositorySafetyInterlock(stateDir);
          assert(
            interlock?.phase === "activation_pending",
            "intent not visible",
          );
          const error = await expectCode(
            assertRepositoryWritable(stateDir),
            "REPOSITORY_QUARANTINED",
          );
          assert(
            error.quarantineId === quarantineId &&
              error.reason === "child_status_unconfirmed",
            "quarantine error lost its closed identity",
          );
          assert(
            JSON.stringify(Object.keys(error).sort()) ===
              JSON.stringify(["code", "quarantineId", "reason"]),
            "quarantine error exposed unexpected fields",
          );
          throw new Error("simulated crash before activation");
        },
      ),
      "COMMAND_FAILED",
    ).catch(() => undefined);
    const lock = await Deno.lstat(lockPath);
    assert(lock.isFile, "retained lock was removed during unwind");
    assert(
      (await Deno.readTextFile(repositoryQuarantineIntentPath(
        stateDir,
        quarantineId,
      ))) === JSON.stringify(expected),
      "intent bytes changed",
    );
  });
});

Deno.test("durable recovery lock blocks after a crash between retention and intent publication", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await expectCode(
      withLock(
        lockPath,
        lockOptions(expected),
        (lease) =>
          (retainLeaseForRepositoryRecovery as unknown as (
            stateDir: string,
            lease: Parameters<typeof retainLeaseForRepositoryRecovery>[1],
            record: ActiveRepositoryQuarantine,
            dependencies: Readonly<{
              fault: (point: string) => void;
            }>,
          ) => Promise<void>)(stateDir, lease, expected, {
            fault: (point: string) => {
              if (point === "after_lock_retained") {
                throw new Error("simulated process crash");
              }
            },
          }),
      ),
      "COMMAND_FAILED",
    ).catch(() => undefined);

    const onDisk = JSON.parse(await Deno.readTextFile(lockPath));
    assert(
      onDisk.command === "recover-repository" &&
        onDisk.quarantineId === quarantineId &&
        onDisk.triggeringCommand === "files",
      "retention was not durable before intent I/O",
    );
    const interlock = await readRepositorySafetyInterlock(stateDir);
    assert(
      interlock?.phase === "activation_pending" &&
        interlock.record.quarantineId === quarantineId,
      "fresh module state could not recover the lock-only interlock",
    );
    await expectCode(
      clearStaleLock(lockPath, onDisk.pid, () => false),
      "REPOSITORY_QUARANTINED",
    );
  });
});

Deno.test("a pre-reserved mutating WAL alone is disk-recoverable and never generic-stale-clearable", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({
        pid: 2147483647,
        processStartedAtUtc: "2026-09-30T11:59:00.000Z",
        command: "files",
        backupId,
        recoveryAttempt: {
          quarantineId,
          reservedAtUtc: createdAtUtc,
        },
      }),
      { createNew: true, mode: 0o600 },
    );
    const interlock = await readRepositorySafetyInterlock(stateDir);
    assert(
      interlock?.phase === "activation_pending" &&
        interlock.record.reason === "retention_publication_interrupted" &&
        interlock.record.quarantineId === quarantineId &&
        interlock.record.createdAtUtc === createdAtUtc,
      "mutating WAL did not produce its exact disk-only fallback",
    );
    await expectCode(
      clearStaleLock(lockPath, 2147483647, () => false),
      "REPOSITORY_QUARANTINED",
    );
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      async (lease) => {
        const audit = recoveryAudit(interlock.record);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: () => Promise.resolve(),
      },
    );
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "WAL-only dedicated recovery left an interlock",
    );
  });
});

Deno.test("partial pending bytes recover only through their exact disk WAL", async () => {
  for (const partial of ["", "{", '{"pid":2147483647']) {
    await withStateDir(async (stateDir, lockPath) => {
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          pid: 2147483647,
          processStartedAtUtc: "2026-09-30T11:59:00.000Z",
          command: "files",
          backupId,
          recoveryAttempt: {
            quarantineId,
            reservedAtUtc: createdAtUtc,
          },
        }),
        { createNew: true, mode: 0o600 },
      );
      await Deno.writeTextFile(
        `${lockPath}.recovery-pending`,
        partial,
        { createNew: true, mode: 0o600 },
      );
      const interlock = await readRepositorySafetyInterlock(stateDir);
      assert(
        interlock?.record.reason === "retention_publication_interrupted" &&
          interlock.record.quarantineId === quarantineId,
        "partial pending did not bind to the on-disk WAL",
      );
      await withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        async (lease) => {
          const audit = recoveryAudit(interlock.record);
          await writeRepositoryRecoveryAudit(stateDir, lease, audit);
          await clearRepositoryQuarantine(stateDir, lease, audit);
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      );
      assert(
        await readRepositorySafetyInterlock(stateDir) === undefined,
        "partial pending recovery left an interlock",
      );
    });
  }
});

Deno.test("every durable recovery-lock publication prefix is a disk-only quarantine interlock", async () => {
  const points = [
    "after_recovery_stage_create",
    "after_recovery_stage_truncate",
    "after_recovery_stage_write",
    "after_recovery_stage_fsync",
    "after_recovery_stage_directory_fsync",
    "after_recovery_publish",
    "after_recovery_publish_fsync",
  ] as const;
  for (const point of points) {
    await withStateDir(async (stateDir, lockPath) => {
      let hit = false;
      await withLock(
        lockPath,
        lockOptions(),
        (lease) =>
          retainLeaseForRepositoryRecovery(stateDir, lease, record(), {
            fault: (observed) => {
              if (observed === point) {
                hit = true;
                throw new Error(`simulated process crash:${point}`);
              }
            },
          }),
      ).catch(() => undefined);
      assert(hit, `${point} fault seam was not reached`);

      const before = await Deno.readTextFile(lockPath);
      const safety = await expectCode(
        assertRepositoryWritable(stateDir),
        "REPOSITORY_QUARANTINED",
      );
      assert(
        safety.quarantineId === quarantineId,
        `${point} lost the pre-reserved quarantine ID`,
      );
      await expectCode(
        clearStaleLock(lockPath, Deno.pid, () => false),
        "REPOSITORY_QUARANTINED",
      );
      assert(
        await Deno.readTextFile(lockPath) === before,
        `${point} changed the retained lock during generic recovery`,
      );
      const entries = [...Deno.readDirSync(stateDir)].map((entry) =>
        entry.name
      );
      assert(
        entries.every((name) =>
          [
            "backup.lock",
            "backup.lock.guard",
            "backup.lock.recovery-pending",
          ].includes(name)
        ),
        `${point} left an unrecognized recovery-lock artifact`,
      );
    });
  }
});

Deno.test("earliest single pending recovery-lock stage is retryable", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, record(), {
          fault: (point) => {
            if (point === "after_recovery_stage_create") {
              throw new Error("simulated earliest crash");
            }
          },
        }).catch(() => undefined);
        assert(
          (await Deno.lstat(`${lockPath}.recovery-pending`)).size === 0,
          "fixture did not reach the earliest durable prefix",
        );
        await retainLeaseForRepositoryRecovery(stateDir, lease, record());
      },
    );
    const interlock = await readRepositorySafetyInterlock(stateDir);
    assert(
      interlock?.record.quarantineId === quarantineId,
      "retry did not recover the earliest durable prefix",
    );
  });
});

Deno.test("dedicated recovery derives interrupted publication provenance from disk after restart", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await (async () => {
      const volatileRecord = record();
      await withLock(
        lockPath,
        lockOptions(volatileRecord),
        (lease) =>
          retainLeaseForRepositoryRecovery(stateDir, lease, volatileRecord, {
            fault: (point) => {
              if (point === "after_recovery_stage_create") {
                throw new Error("simulated process crash");
              }
            },
          }),
      ).catch(() => undefined);
    })();
    const original = JSON.parse(await Deno.readTextFile(lockPath));
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({
        ...original,
        pid: 2147483647,
        processStartedAtUtc: "2026-09-30T11:59:00.000Z",
      }),
    );
    await expectCode(
      clearStaleLock(lockPath, 2147483647, () => false),
      "REPOSITORY_QUARANTINED",
    );

    const diskInterlock = await readRepositorySafetyInterlock(stateDir);
    assert(
      diskInterlock?.phase === "activation_pending" &&
        diskInterlock.record.reason === "retention_publication_interrupted" &&
        diskInterlock.record.quarantineId ===
          original.recoveryAttempt.quarantineId &&
        diskInterlock.record.createdAtUtc ===
          original.recoveryAttempt.reservedAtUtc,
      "restart did not derive the fallback record solely from the WAL lock",
    );

    await withRepositoryRecoveryLease(
      stateDir,
      diskInterlock.record.quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      async (lease) => {
        const audit = recoveryAudit(diskInterlock.record);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: () => Promise.resolve(),
      },
    );
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "interrupted pre-publication recovery left an interlock",
    );
    for (
      const path of [
        lockPath,
        `${lockPath}.recovery-pending`,
      ]
    ) {
      let exists = true;
      try {
        await Deno.lstat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) exists = false;
        else throw error;
      }
      assert(!exists, "interrupted publication artifact survived recovery");
    }
  });
});

Deno.test("retention cannot publish a quarantine ID different from the lock WAL", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    const different = {
      ...expected,
      quarantineId: "22222222-2222-4222-8222-222222222222",
    };
    await withLock(lockPath, lockOptions(expected), async (lease) => {
      await expectCode(
        retainLeaseForRepositoryRecovery(stateDir, lease, different),
        "STATE_INVALID",
      );
      const lock = JSON.parse(await Deno.readTextFile(lockPath));
      assert(
        lock.recoveryAttempt.quarantineId === quarantineId,
        "mismatched retention changed the WAL attempt",
      );
      let pendingExists = true;
      try {
        await Deno.lstat(`${lockPath}.recovery-pending`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) pendingExists = false;
        else throw error;
      }
      assert(!pendingExists, "mismatched retention created a pending record");
    });
  });
});

Deno.test("published hard-link aliases are never truncated by persistence retry", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, record());

        const lockPending = `${lockPath}.recovery-pending`;
        await Deno.link(lockPath, lockPending);
        const lockBytes = await Deno.readTextFile(lockPath);
        let lockTruncated = false;
        await retainLeaseForRepositoryRecovery(stateDir, lease, record(), {
          fault: (point) => {
            if (point === "after_recovery_stage_truncate") {
              lockTruncated = true;
              throw new Error("second recovery-lock write failed");
            }
          },
        }).catch(() => undefined);
        assert(
          !lockTruncated,
          "published recovery lock was rewritten in place",
        );
        assert(
          await Deno.readTextFile(lockPath) === lockBytes,
          "recovery-lock retry corrupted the published inode",
        );

        const intentPath = repositoryQuarantineIntentPath(
          stateDir,
          quarantineId,
        );
        const intentPending = `${intentPath}.pending`;
        const intentBefore = await Deno.readTextFile(intentPath);
        await Deno.link(intentPath, intentPending);
        let intentTruncated = false;
        await retainLeaseForRepositoryRecovery(stateDir, lease, record(), {
          fault: (point) => {
            if (point === "after_stage_truncate") {
              intentTruncated = true;
              throw new Error("second intent write failed");
            }
          },
        }).catch(() => undefined);
        assert(!intentTruncated, "published intent was rewritten in place");
        assert(
          await Deno.readTextFile(intentPath) === intentBefore,
          "intent retry corrupted the published inode",
        );
        let pendingExists = true;
        try {
          await Deno.lstat(intentPending);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) pendingExists = false;
          else throw error;
        }
        assert(!pendingExists, "verified intent alias was not cleaned up");
      },
    );
  });
});

Deno.test("a new recovery controller never truncates an old published hard-link inode", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    const timing = () => ({
      monotonicNow: (() => {
        const values = [10_000, 10_000, 12_000, 12_000];
        return () => values.shift() ?? 12_000;
      })(),
      sleep: () => Promise.resolve(),
    });
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      () => Promise.reject(new Error("simulated old controller crash")),
      timing(),
    ).catch(() => undefined);
    const previous = JSON.parse(await Deno.readTextFile(lockPath));
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({
        ...previous,
        pid: 2147483647,
        processStartedAtUtc: "2026-09-30T11:59:00.000Z",
      }),
    );
    const publishedBytes = await Deno.readTextFile(lockPath);
    const pending = `${lockPath}.recovery-pending`;
    await Deno.link(lockPath, pending);

    let aliasFault = false;
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      () => Promise.resolve(),
      {
        ...timing(),
        lockPersistence: {
          fault: (point) => {
            if (point === "after_recovery_alias_cleanup") {
              aliasFault = true;
              throw new Error("simulated crash after safe alias unlink");
            }
          },
        },
      },
    ).catch(() => undefined);
    assert(aliasFault, "alias cleanup fault seam was not reached");
    assert(
      await Deno.readTextFile(lockPath) === publishedBytes,
      "alias cleanup changed the published recovery lock",
    );

    let secondFault = false;
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      () => Promise.resolve(),
      {
        ...timing(),
        lockPersistence: {
          fault: (point) => {
            if (point === "after_recovery_stage_truncate") {
              secondFault = true;
              throw new Error("simulated second controller write failure");
            }
          },
        },
      },
    ).catch(() => undefined);
    assert(secondFault, "fresh-inode write fault seam was not reached");
    assert(
      await Deno.readTextFile(lockPath) === publishedBytes,
      "fresh staging failure changed the published recovery lock",
    );

    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      async (lease) => {
        const audit = recoveryAudit(expected);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      timing(),
    );
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "hard-link recovery retry left an interlock",
    );
  });
});

Deno.test("generic preflight and status locks remain readable and stale-clearable", async () => {
  for (const command of ["preflight", "status"] as const) {
    await withStateDir(async (stateDir, lockPath) => {
      const pid = 2147483647;
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          pid,
          processStartedAtUtc: "2026-09-30T11:59:00.000Z",
          command,
          backupId,
        }),
        { createNew: true, mode: 0o600 },
      );
      await Deno.writeTextFile(
        `${lockPath}.recovery-pending`,
        "",
        { createNew: true, mode: 0o600 },
      );
      await expectCode(
        assertRepositoryWritable(stateDir),
        "STATE_INVALID",
      );
      await expectCode(
        clearStaleLock(lockPath, pid, () => false),
        "STATE_INVALID",
      );
      await Deno.remove(`${lockPath}.recovery-pending`);
      await assertRepositoryWritable(stateDir);
      await clearStaleLock(lockPath, pid, () => false);
      let exists = true;
      try {
        await Deno.lstat(lockPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) exists = false;
        else throw error;
      }
      assert(!exists, `${command} stale lock was not cleared`);
    });
  }
});

Deno.test("dedicated recovery resumes a durable pending recovery-lock rewrite bound to its dead trigger owner", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await withLock(
      lockPath,
      lockOptions(),
      (lease) =>
        retainLeaseForRepositoryRecovery(stateDir, lease, record(), {
          fault: (point) => {
            if (point === "after_recovery_stage_directory_fsync") {
              throw new Error("simulated process crash");
            }
          },
        }),
    ).catch(() => undefined);

    const pendingPath = `${lockPath}.recovery-pending`;
    const deadOwner = {
      pid: 2147483647,
      processStartedAtUtc: "2026-09-30T11:59:00.000Z",
    };
    const trigger = JSON.parse(await Deno.readTextFile(lockPath));
    const pending = JSON.parse(await Deno.readTextFile(pendingPath));
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({ ...trigger, ...deadOwner }),
    );
    await Deno.writeTextFile(
      pendingPath,
      JSON.stringify({ ...pending, ...deadOwner }),
    );

    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      async (lease) => {
        const audit = recoveryAudit(record());
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: () => Promise.resolve(),
      },
    );
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "recovered pending lock rewrite left an interlock",
    );
    for (const path of [lockPath, pendingPath]) {
      let exists = true;
      try {
        await Deno.lstat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) exists = false;
        else throw error;
      }
      assert(!exists, "recovery lock artifact survived authorized clear");
    }
  });
});

Deno.test("every intent publication crash prefix leaves a recognized recoverable interlock", async () => {
  const points = [
    "after_stage_create",
    "after_stage_write",
    "after_stage_fsync",
    "after_publish",
    "after_publish_fsync",
    "after_stage_cleanup",
    "after_cleanup_fsync",
  ] as const;
  for (const point of points) {
    await withStateDir(async (stateDir, lockPath) => {
      const expected = record();
      let hit = false;
      await withLock(
        lockPath,
        lockOptions(expected),
        (lease) =>
          retainLeaseForRepositoryRecovery(stateDir, lease, expected, {
            fault: (observed: string) => {
              if (observed === point) {
                hit = true;
                throw new Error(`crash:${point}`);
              }
            },
          } as never),
      ).catch(() => undefined);

      assert(hit, `${point} fault seam was not reached`);

      const interlock = await readRepositorySafetyInterlock(stateDir);
      assert(
        interlock?.record.quarantineId === quarantineId,
        `${point} made the repository writable`,
      );
      const lock = JSON.parse(await Deno.readTextFile(lockPath));
      await expectCode(
        clearStaleLock(lockPath, lock.pid, () => false),
        "REPOSITORY_QUARANTINED",
      );
      const intentDirectory = `${stateDir}/repository-quarantine-intents`;
      const names = [...Deno.readDirSync(intentDirectory)].map((entry) =>
        entry.name
      );
      assert(
        names.every((name) =>
          name === `${quarantineId}.json` ||
          name === `${quarantineId}.json.pending`
        ),
        `${point} left an unrecognized temporary entry`,
      );
    });
  }
});

Deno.test("recovery resumes every intent publication crash prefix and clears only after durable audit", async () => {
  const points = [
    "after_stage_create",
    "after_stage_write",
    "after_stage_fsync",
    "after_publish",
    "after_publish_fsync",
    "after_stage_cleanup",
    "after_cleanup_fsync",
  ] as const;
  for (const point of points) {
    await withStateDir(async (stateDir, lockPath) => {
      const expected = record();
      await withLock(
        lockPath,
        lockOptions(expected),
        (lease) =>
          retainLeaseForRepositoryRecovery(stateDir, lease, expected, {
            fault: (observed) => {
              if (observed === point) throw new Error("simulated crash");
            },
          }),
      ).catch(() => undefined);
      const retained = JSON.parse(await Deno.readTextFile(lockPath));
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          ...retained,
          pid: 2147483647,
          processStartedAtUtc: "2026-09-30T11:59:00.000Z",
        }),
      );

      await withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        async (lease) => {
          const audit = recoveryAudit(expected);
          await writeRepositoryRecoveryAudit(stateDir, lease, audit);
          await clearRepositoryQuarantine(stateDir, lease, audit);
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      );
      let finalInterlock;
      try {
        finalInterlock = await readRepositorySafetyInterlock(stateDir);
      } catch (error) {
        throw new Error(`${point} recovery left invalid safety state`, {
          cause: error,
        });
      }
      assert(
        finalInterlock === undefined,
        `${point} intent stage remained after recovery`,
      );
      const intentEntries = [
        ...Deno.readDirSync(`${stateDir}/repository-quarantine-intents`),
      ];
      assert(
        intentEntries.length === 0,
        `${point} recovery left intent artifacts`,
      );
    });
  }
});

Deno.test("activation is byte-stable, permits release only after fsync, and every trigger label blocks", async () => {
  for (
    const trigger of [
      "bootstrap",
      "files",
      "mongo-bootstrap",
      "verify",
    ] as const
  ) {
    await withStateDir(async (stateDir, lockPath) => {
      const expected = record(trigger);
      await withLock(
        lockPath,
        lockOptions(expected),
        async (lease) => {
          await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
          await activateRepositoryQuarantine(stateDir, lease, expected);
          await activateRepositoryQuarantine(stateDir, lease, expected);
          const active = await readRepositoryQuarantine(stateDir);
          assert(
            JSON.stringify(active) === JSON.stringify(expected),
            `active record changed for ${trigger}`,
          );
          await allowLeaseReleaseAfterRepositoryQuarantine(
            stateDir,
            lease,
            quarantineId,
          );
        },
      );
      await expectCode(
        assertRepositoryWritable(stateDir),
        "REPOSITORY_QUARANTINED",
      );
      let missing = false;
      try {
        await Deno.lstat(lockPath);
      } catch (error) {
        missing = error instanceof Deno.errors.NotFound;
      }
      assert(missing, "proved active quarantine did not release the lock");
    });
  }
});

Deno.test("closed records reject invalid reason pairs, unknown fields, symlinks, and multiple intents", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const invalid = {
      ...record(),
      childTerminationConfirmed: true,
      unexpected: true,
    };
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        await expectCode(
          retainLeaseForRepositoryRecovery(stateDir, lease, invalid as never),
          "STATE_INVALID",
        );
      },
    ).catch(() => undefined);
  });
  await withStateDir(async (stateDir) => {
    await Deno.symlink(
      `${stateDir}/missing-target`,
      repositoryQuarantinePath(stateDir),
    );
    await expectCode(readRepositorySafetyInterlock(stateDir), "STATE_INVALID");
  });
  await withStateDir(async (stateDir) => {
    const intents = `${stateDir}/repository-quarantine-intents`;
    await Deno.mkdir(intents, { mode: 0o700 });
    await Deno.writeTextFile(
      `${intents}/${quarantineId}.json`,
      JSON.stringify(record()),
      {
        createNew: true,
        mode: 0o600,
      },
    );
    await Deno.writeTextFile(
      `${intents}/22222222-2222-4222-8222-222222222222.json`,
      JSON.stringify({
        ...record(),
        quarantineId: "22222222-2222-4222-8222-222222222222",
      }),
      { createNew: true, mode: 0o600 },
    );
    await expectCode(readRepositorySafetyInterlock(stateDir), "STATE_INVALID");
  });
});

Deno.test("recovery lock and observed identity reject opposite-branch WAL fields", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await Deno.writeTextFile(
      lockPath,
      JSON.stringify({
        pid: 2147483647,
        processStartedAtUtc: "2026-09-30T11:59:00.000Z",
        command: "recover-repository",
        backupId,
        quarantineId,
        triggeringCommand: "files",
        quarantineRecord: JSON.stringify(expected),
        recoveryAttempt: {
          quarantineId,
          reservedAtUtc: createdAtUtc,
        },
      }),
      { createNew: true, mode: 0o600 },
    );
    await expectCode(readRepositorySafetyInterlock(stateDir), "STATE_INVALID");
  });

  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) =>
          Promise.resolve({
            ...observation(lock, sequence),
            lock: {
              ...lock,
              reservedAtUtc: createdAtUtc,
            },
          } as RecoveryOwnershipObservation),
        () => Promise.resolve(),
        {
          monotonicNow: () => 10_000,
          sleep: () => Promise.resolve(),
        },
      ),
      "STATE_INVALID",
    );
  });
});

Deno.test("repository safety validates an existing state directory but permits a missing initial directory", async () => {
  const root = await Deno.makeTempDir();
  const stateDir = `${root}/.local/backup`;
  try {
    await assertRepositoryWritable(stateDir);
    let created = true;
    try {
      await Deno.lstat(stateDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) created = false;
      else throw error;
    }
    assert(
      !created,
      "read-only safety check created the initial state directory",
    );

    await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await Deno.chmod(stateDir, 0o755);
    await expectCode(assertRepositoryWritable(stateDir), "STATE_INVALID");
    await Deno.remove(stateDir, { recursive: true });
    await Deno.mkdir(`${root}/target`, { mode: 0o700 });
    await Deno.symlink(`${root}/target`, stateDir);
    await expectCode(assertRepositoryWritable(stateDir), "STATE_INVALID");
    await expectCode(
      assertRepositoryWritable("relative/state"),
      "STATE_INVALID",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retention rejects a noncanonical state directory before changing the owned lock", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        const before = await Deno.lstat(lockPath);
        const bytes = await Deno.readTextFile(lockPath);
        const alias = `${stateDir}/../backup`;
        await expectCode(
          retainLeaseForRepositoryRecovery(alias, lease, record()),
          "STATE_INVALID",
        );
        const after = await Deno.lstat(lockPath);
        assert(
          after.dev === before.dev && after.ino === before.ino &&
            await Deno.readTextFile(lockPath) === bytes,
          "invalid state directory rewrote the owned lock",
        );
        const names = [...Deno.readDirSync(stateDir)].map((entry) =>
          entry.name
        );
        assert(
          names.every((name) =>
            name === "backup.lock" || name === "backup.lock.guard"
          ),
          "invalid state directory created retention artifacts",
        );
      },
    );
  });
});

Deno.test("repository safety path helpers reject an invalid quarantine id", () => {
  for (
    const helper of [
      repositoryQuarantineIntentPath,
      repositoryRecoveryAuditPath,
    ]
  ) {
    let caught: unknown;
    try {
      helper("/tmp/root/.local/backup", "../escape");
    } catch (error) {
      caught = error;
    }
    assert(
      caught instanceof Error &&
        (caught as Error & { code?: string }).code === "STATE_INVALID",
      "invalid quarantine ID reached path construction",
    );
  }
});

Deno.test("generic stale recovery preserves retained lock and quarantine bytes", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await withLock(
      lockPath,
      lockOptions(expected),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
        await activateRepositoryQuarantine(stateDir, lease, expected);
        throw new Error("leave the recovery lock retained");
      },
    ).catch(() => undefined);
    const beforeLock = await Deno.readTextFile(lockPath);
    const beforeIntent = await Deno.readTextFile(
      repositoryQuarantineIntentPath(stateDir, quarantineId),
    );
    const beforeActive = await Deno.readTextFile(
      repositoryQuarantinePath(stateDir),
    );
    const lock = JSON.parse(beforeLock);
    await expectCode(
      clearStaleLock(lockPath, lock.pid, () => false),
      "REPOSITORY_QUARANTINED",
    );
    assert(await Deno.readTextFile(lockPath) === beforeLock, "lock changed");
    assert(
      await Deno.readTextFile(repositoryQuarantineIntentPath(
        stateDir,
        quarantineId,
      )) === beforeIntent,
      "intent changed",
    );
    assert(
      await Deno.readTextFile(repositoryQuarantinePath(stateDir)) ===
        beforeActive,
      "active quarantine changed",
    );
  });
});

Deno.test("active quarantine recovery publishes and removes a no-clobber recovery lock when no trigger lock remains", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await withLock(
      lockPath,
      lockOptions(expected),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
        await activateRepositoryQuarantine(stateDir, lease, expected);
        await allowLeaseReleaseAfterRepositoryQuarantine(
          stateDir,
          lease,
          quarantineId,
        );
      },
    );
    let probeKind: RecoveryLockIdentity["kind"] | undefined;
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => {
        probeKind = lock.kind;
        return Promise.resolve(observation(lock, sequence));
      },
      async (lease) => {
        const audit = recoveryAudit(expected);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: () => Promise.resolve(),
      },
    );
    assert(probeKind === "missing", "recovery did not pin missing lock state");
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "missing-lock recovery left an interlock",
    );
    const names = [...Deno.readDirSync(stateDir)].map((entry) => entry.name);
    assert(
      !names.includes("backup.lock") &&
        !names.includes("backup.lock.recovery-pending"),
      "missing-lock recovery left lock publication artifacts",
    );
  });
});

Deno.test("only a branded recovery lease with two separated probes and a matching durable audit can clear", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);

    const fakeLease = {
      path: lockPath,
      dev: 1,
      ino: 1,
      command: "recover-repository",
      quarantineId,
    };
    await expectCode(
      clearRepositoryQuarantine(
        stateDir,
        fakeLease as never,
        {} as never,
      ),
      "LOCK_HELD",
    );

    let probeCalls = 0;
    const sleeps: number[] = [];
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (expectedLock, sequence) => {
        probeCalls++;
        assert(
          expectedLock.kind === "present",
          "retained owner was not pinned",
        );
        assert(
          expectedLock.command === "recover-repository" &&
            expectedLock.triggeringCommand === "files",
          "wrong triggering command pinned",
        );
        assert(expectedLock.backupId === backupId, "wrong backup ID pinned");
        return Promise.resolve(observation(expectedLock, sequence));
      },
      async (lease) => {
        const canonical = JSON.stringify(expected);
        const audit: RepositoryRecoveryAudit = {
          schema: 1,
          kind: "repository-recovery-audit",
          quarantineId,
          quarantineRecordSha256: createHash("sha256")
            .update(canonical)
            .digest("hex"),
          repository: expected.repository,
          triggeringCommand: expected.triggeringCommand,
          backupId,
          reason: expected.reason,
          childTerminationConfirmed: expected.childTerminationConfirmed,
          quarantineCreatedAtUtc: expected.createdAtUtc,
          auditedAtUtc: "2026-09-30T12:02:00.000Z",
          controllerGone: true,
          hostDescendantsGone: true,
          containerProducerGone: true,
          producerArtifactsGone: true,
          snapshotResolution: "exactly_zero",
        };
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await expectCode(
          writeRepositoryRecoveryAudit(stateDir, lease, {
            ...audit,
            auditedAtUtc: "2026-09-30T12:03:00.000Z",
          }),
          "STATE_INVALID",
        );
        await clearRepositoryQuarantine(stateDir, lease, audit);
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      },
    );
    assert(probeCalls === 2, "ownership proof was not repeated");
    assert(
      JSON.stringify(sleeps) === "[2000]",
      "dead-owner probes were not separated by the full interval",
    );
    assert(
      await readRepositorySafetyInterlock(stateDir) === undefined,
      "interlock remained after durable recovery",
    );
    const audit = await Deno.readTextFile(
      repositoryRecoveryAuditPath(stateDir, quarantineId),
    );
    assert(audit.includes(quarantineId), "audit receipt was removed");
    let lockMissing = false;
    try {
      await Deno.lstat(lockPath);
    } catch (error) {
      lockMissing = error instanceof Deno.errors.NotFound;
    }
    assert(lockMissing, "recovery lock was not released after clear");
  });
});

Deno.test("recovery audit snapshot resolution is closed over the triggering command", async () => {
  for (
    const scenario of [
      { trigger: "bootstrap", resolution: "exactly_zero" },
      { trigger: "files", resolution: "not_applicable" },
      { trigger: "mongo-bootstrap", resolution: "one_unaccepted_files" },
      { trigger: "verify", resolution: "exactly_zero" },
    ] as const
  ) {
    await withStateDir(async (stateDir, lockPath) => {
      const expected = record(scenario.trigger);
      await installActiveQuarantineWithDeadOwner(
        stateDir,
        lockPath,
        expected,
      );
      await withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        async (lease) => {
          const base = recoveryAudit(expected);
          const invalid = {
            ...base,
            snapshotResolution: scenario.resolution,
            ...(scenario.resolution === "one_unaccepted_files"
              ? { snapshotId: "a".repeat(64) }
              : {}),
          } as RepositoryRecoveryAudit;
          await expectCode(
            writeRepositoryRecoveryAudit(stateDir, lease, invalid),
            "STATE_INVALID",
          );
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      );
      assert(
        (await readRepositorySafetyInterlock(stateDir))?.record
          .triggeringCommand === scenario.trigger,
        `${scenario.trigger} invalid resolution cleared the interlock`,
      );
    });
  }
});

Deno.test("recovery guard excludes stale-clear and writers through quarantine unlink and lock cleanup", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recovery = withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      async (lease) => {
        const audit = recoveryAudit(expected);
        await writeRepositoryRecoveryAudit(stateDir, lease, audit);
        await clearRepositoryQuarantine(stateDir, lease, audit);
        entered.resolve();
        await release.promise;
      },
      {
        monotonicNow: (() => {
          const values = [10_000, 10_000, 12_000, 12_000];
          return () => values.shift() ?? 12_000;
        })(),
        sleep: () => Promise.resolve(),
      },
    );
    try {
      await entered.promise;
      const onDisk = JSON.parse(await Deno.readTextFile(lockPath));
      assert(
        onDisk.command === "recover-repository" &&
          onDisk.quarantineId === quarantineId,
        "recovery action did not own a durable recovery lock",
      );
      await expectCode(
        clearStaleLock(lockPath, onDisk.pid, () => false),
        "REPOSITORY_QUARANTINED",
      );
      await expectCode(
        withLock(
          lockPath,
          { command: "files", backupId: "20260930T120001Z" },
          () => Promise.resolve(),
        ),
        "LOCK_HELD",
      );
    } finally {
      release.resolve();
      await recovery;
    }
    let missing = false;
    try {
      await Deno.lstat(lockPath);
    } catch (error) {
      missing = error instanceof Deno.errors.NotFound;
    }
    assert(missing, "recovery lock cleanup escaped the held guard");
  });
});

Deno.test("every quarantine-clear crash prefix retains a durable recovery lock and is retryable", async () => {
  const points = [
    "after_intent_remove",
    "after_intent_remove_fsync",
    "after_active_remove",
    "after_active_remove_fsync",
  ] as const;
  for (const point of points) {
    await withStateDir(async (stateDir, lockPath) => {
      const expected = record();
      await installActiveQuarantineWithDeadOwner(
        stateDir,
        lockPath,
        expected,
      );
      const audit = recoveryAudit(expected);
      let hit = false;
      await withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        async (lease) => {
          await writeRepositoryRecoveryAudit(stateDir, lease, audit);
          await clearRepositoryQuarantine(stateDir, lease, audit, {
            fault: (observed) => {
              if (observed === point) {
                hit = true;
                throw new Error(`simulated process crash:${point}`);
              }
            },
          });
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      ).catch(() => undefined);
      assert(hit, `${point} fault seam was not reached`);
      await expectCode(
        assertRepositoryWritable(stateDir),
        "REPOSITORY_QUARANTINED",
      );
      const retained = JSON.parse(await Deno.readTextFile(lockPath));
      assert(
        retained.command === "recover-repository" &&
          retained.quarantineId === quarantineId,
        `${point} did not retain the recovery lock`,
      );
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          ...retained,
          pid: 2147483647,
          processStartedAtUtc: "2026-09-30T11:59:00.000Z",
        }),
      );

      await withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        async (lease) => {
          await writeRepositoryRecoveryAudit(stateDir, lease, audit);
          await clearRepositoryQuarantine(stateDir, lease, audit);
        },
        {
          monotonicNow: (() => {
            const values = [20_000, 20_000, 22_000, 22_000];
            return () => values.shift() ?? 22_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      );
      assert(
        await readRepositorySafetyInterlock(stateDir) === undefined,
        `${point} recovery retry left an interlock`,
      );
    });
  }
});

Deno.test("recovery caps every ownership step by one remaining 60 second deadline", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const budgets: number[] = [];
    const values = [0, 55_000, 57_000, 59_999];
    const dependencies = {
      monotonicNow: () => values.shift() ?? 59_999,
      sleep: () => Promise.resolve(),
      timeout: async <T>(operation: Promise<T>, milliseconds: number) => {
        budgets.push(milliseconds);
        return await operation;
      },
    };
    let actionRan = false;
    await withRepositoryRecoveryLease(
      stateDir,
      quarantineId,
      (lock, sequence) => Promise.resolve(observation(lock, sequence)),
      () => {
        actionRan = true;
        throw new Error("leave the recovered lock retained");
      },
      dependencies,
    ).catch(() => undefined);
    assert(actionRan, "valid proof did not reach the recovery action");
    assert(
      JSON.stringify(budgets) === "[10000,2000,3000]",
      `step deadlines were reset: ${JSON.stringify(budgets)}`,
    );
  });
});

Deno.test("recovery refuses to start a step after the overall deadline is exhausted", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const budgets: number[] = [];
    const values = [0, 59_900, 61_900];
    const dependencies = {
      monotonicNow: () => values.shift() ?? 61_900,
      sleep: () => Promise.resolve(),
      timeout: async <T>(operation: Promise<T>, milliseconds: number) => {
        budgets.push(milliseconds);
        return await operation;
      },
    };
    let actionRan = false;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => Promise.resolve(observation(lock, sequence)),
        () => {
          actionRan = true;
          return Promise.resolve();
        },
        dependencies,
      ),
      "STATE_INVALID",
    );
    assert(!actionRan, "expired ownership proof reached recovery action");
    assert(
      JSON.stringify(budgets) === "[10000,100]",
      `expired deadline was not applied to the sleep: ${
        JSON.stringify(budgets)
      }`,
    );
  });
});

Deno.test("recovery never constructs a wait or probe at the exact overall deadline", async () => {
  for (
    const scenario of [
      {
        values: [0, 60_000],
        expectedBudgets: [10_000],
        expectedSleepCalls: 0,
      },
      {
        values: [0, 58_000, 60_000],
        expectedBudgets: [10_000, 2_000],
        expectedSleepCalls: 1,
      },
    ]
  ) {
    await withStateDir(async (stateDir, lockPath) => {
      await installActiveQuarantineWithDeadOwner(stateDir, lockPath, record());
      const values = [...scenario.values];
      const budgets: number[] = [];
      let sleepCalls = 0;
      let secondProbeCalls = 0;
      await expectCode(
        withRepositoryRecoveryLease(
          stateDir,
          quarantineId,
          (lock, sequence) => {
            if (sequence === "second") secondProbeCalls++;
            return Promise.resolve(observation(lock, sequence));
          },
          () => Promise.reject(new Error("action must not run")),
          {
            monotonicNow: () => values.shift() ?? 60_000,
            sleep: () => {
              sleepCalls++;
              return Promise.resolve();
            },
            timeout: async <T>(operation: Promise<T>, milliseconds: number) => {
              budgets.push(milliseconds);
              return await operation;
            },
          },
        ),
        "STATE_INVALID",
      );
      assert(
        JSON.stringify(budgets) ===
          JSON.stringify(scenario.expectedBudgets),
        "deadline budget changed",
      );
      assert(
        sleepCalls === scenario.expectedSleepCalls,
        "expired wait was constructed",
      );
      assert(secondProbeCalls === 0, "expired second probe was invoked");
    });
  }
});

Deno.test("recovery refuses a retained lock owned by this still-live process even when a probe lies", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
        await activateRepositoryQuarantine(stateDir, lease, expected);
        throw new Error("retain while this process remains live");
      },
    ).catch(() => undefined);
    const before = await Deno.readTextFile(lockPath);
    let probes = 0;
    let actionRan = false;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => {
          probes++;
          return Promise.resolve(observation(lock, sequence));
        },
        () => {
          actionRan = true;
          return Promise.resolve();
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      ),
      "LOCK_HELD",
    );
    assert(probes === 0 && !actionRan, "live lock reached recovery probes");
    assert(await Deno.readTextFile(lockPath) === before, "live lock changed");
    assert(
      (await readRepositorySafetyInterlock(stateDir))?.record.quarantineId ===
        quarantineId,
      "live-lock rejection cleared the interlock",
    );
  });
});

Deno.test("recovery binds both observations to one exact lock owner identity", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const before = await Deno.readTextFile(lockPath);
    let calls = 0;
    let actionRan = false;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => {
          calls++;
          const proof = observation(lock, sequence);
          if (calls === 2 && lock.kind === "present") {
            return Promise.resolve({
              ...proof,
              lock: {
                ...lock,
                processStartedAtUtc: "2026-09-30T11:59:59.000Z",
              },
            });
          }
          return Promise.resolve(proof);
        },
        () => {
          actionRan = true;
          return Promise.resolve();
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      ),
      "STATE_INVALID",
    );
    assert(!actionRan, "mismatched PID/start proof reached recovery action");
    assert(await Deno.readTextFile(lockPath) === before, "owner lock changed");
    assert(
      (await readRepositorySafetyInterlock(stateDir))?.record.quarantineId ===
        quarantineId,
      "identity mismatch cleared the interlock",
    );
  });
});

Deno.test("recovery detects lock pathname replacement between proof and adoption", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const bytes = await Deno.readTextFile(lockPath);
    let calls = 0;
    let actionRan = false;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        async (lock, sequence) => {
          calls++;
          if (calls === 2) {
            await Deno.remove(lockPath);
            await Deno.writeTextFile(lockPath, bytes, {
              createNew: true,
              mode: 0o600,
            });
          }
          return observation(lock, sequence);
        },
        () => {
          actionRan = true;
          return Promise.resolve();
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      ),
      "LOCK_HELD",
    );
    assert(!actionRan, "replacement lock was adopted");
    assert(await Deno.readTextFile(lockPath) === bytes, "replacement changed");
    assert(
      (await readRepositorySafetyInterlock(stateDir))?.record.quarantineId ===
        quarantineId,
      "replacement rejection cleared the interlock",
    );
  });
});

Deno.test("recovery detects same-inode PID-start identity reuse after the second proof", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await installActiveQuarantineWithDeadOwner(stateDir, lockPath, expected);
    const beforeInfo = await Deno.lstat(lockPath);
    const original = JSON.parse(await Deno.readTextFile(lockPath));
    let calls = 0;
    let actionRan = false;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        async (lock, sequence) => {
          calls++;
          if (calls === 2) {
            await Deno.writeTextFile(
              lockPath,
              JSON.stringify({
                ...original,
                processStartedAtUtc: "2026-09-30T11:58:00.000Z",
              }),
            );
          }
          return observation(lock, sequence);
        },
        () => {
          actionRan = true;
          return Promise.resolve();
        },
        {
          monotonicNow: (() => {
            const values = [10_000, 10_000, 12_000, 12_000];
            return () => values.shift() ?? 12_000;
          })(),
          sleep: () => Promise.resolve(),
        },
      ),
      "LOCK_HELD",
    );
    const afterInfo = await Deno.lstat(lockPath);
    assert(
      beforeInfo.dev === afterInfo.dev && beforeInfo.ino === afterInfo.ino,
      "test did not exercise same-inode identity reuse",
    );
    assert(!actionRan, "changed process-start identity was adopted");
    assert(
      (await readRepositorySafetyInterlock(stateDir))?.record.quarantineId ===
        quarantineId,
      "PID-reuse rejection cleared the interlock",
    );
  });
});

Deno.test("pending-only recovery requires the retained triggering lock", async () => {
  await withStateDir(async (stateDir, lockPath) => {
    const expected = record();
    await withLock(
      lockPath,
      lockOptions(),
      async (lease) => {
        await retainLeaseForRepositoryRecovery(stateDir, lease, expected);
        throw new Error("retain pending recovery lock");
      },
    ).catch(() => undefined);
    await Deno.remove(lockPath);
    const beforeIntent = await Deno.readTextFile(
      repositoryQuarantineIntentPath(stateDir, quarantineId),
    );
    let probes = 0;
    await expectCode(
      withRepositoryRecoveryLease(
        stateDir,
        quarantineId,
        (lock, sequence) => {
          probes++;
          return Promise.resolve(observation(lock, sequence));
        },
        () => Promise.resolve(),
      ),
      "LOCK_HELD",
    );
    assert(probes === 0, "missing pending lock reached ownership probes");
    assert(
      await Deno.readTextFile(
        repositoryQuarantineIntentPath(stateDir, quarantineId),
      ) === beforeIntent,
      "pending intent changed after missing-lock rejection",
    );
  });
});
