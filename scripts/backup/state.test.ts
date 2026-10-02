import {
  assertOwnedLockLease,
  clearStaleLock,
  type OwnedLockLease,
  readEffectiveUid,
  readState,
  withLock,
  writeStateAtomic,
} from "./state.ts";
import { redactError, renderFailure } from "./redact.ts";
import { DenoRunner } from "./runner.ts";
import type {
  BackupStatus,
  BufferedCommandOptions,
  FilesAcceptedReceipt,
} from "./types.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function canonicalTempDir(): Promise<string> {
  return await Deno.realPath(await Deno.makeTempDir());
}
async function rejects(action: () => unknown, code = "STATE_INVALID") {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof Error && error.message === code,
      "wrong safe error",
    );
    if (code !== "COMMAND_FAILED") {
      assert(
        redactError(error, {
          stage: "files",
          backupId: "20260930T120000Z",
          tool: "filesystem",
        }).code === code,
        "failure code lost at persistence boundary",
      );
    }
    return;
  }
  throw new Error("expected rejection");
}
const running: BackupStatus = {
  schema: 1,
  stage: "files",
  state: "running",
  backupId: "20260930T120000Z",
  startedAtUtc: "2026-09-30T12:00:00.000Z",
};
const failure = () =>
  redactError({ code: "COMMAND_FAILED" }, {
    stage: "files",
    backupId: running.backupId,
    timestampUtc: running.startedAtUtc,
    tool: "restic",
  });

const accepted: FilesAcceptedReceipt = {
  schema: 1,
  kind: "files",
  repositoryId: "b".repeat(64),
  backupId: running.backupId,
  snapshotId: "a".repeat(64),
  acceptedAtUtc: "2026-09-30T12:01:00.000Z",
  verificationOrdinal: 1,
  checkSubsetPart: 1,
  manifestSha256: "c".repeat(64),
  manifestBytes: 100,
  representativeSha256: "d".repeat(64),
  representativeBytes: 10,
  sourceCounts: {
    files: 1,
    bytes: 10,
    total: 0,
    covered: 0,
    missing: 0,
    unreadable: 0,
    outsideRoots: 0,
    invalid: 0,
  },
  transportVerified: true,
};

Deno.test("atomic replacement preserves prior open inode, mode 0600, and terminal transitions", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/state.json`;
  try {
    assert(await readState(path) === null);
    await writeStateAtomic(path, running);
    const previous = await Deno.open(path);
    try {
      await writeStateAtomic(path, {
        ...running,
        state: "complete",
        endedAtUtc: "2026-09-30T12:01:00.000Z",
        snapshotId: "a".repeat(64),
        sourceCounts: accepted.sourceCounts,
        accepted,
      });
      assert((await readState(path))?.state === "complete");
      const old = await new Response(previous.readable).text();
      assert(JSON.parse(old).state === "running", "state overwritten in place");
    } finally {
      try {
        previous.close();
      } catch { /* stream closes handle */ }
    }
    assert(((await Deno.stat(path)).mode! & 0o777) === 0o600);
    assert([...Deno.readDirSync(root)].length === 1, "temp file left behind");
    await rejects(() => writeStateAtomic(path, running));
    const next = {
      ...running,
      accepted,
      backupId: "20260930T130000Z",
      startedAtUtc: "2026-09-30T13:00:00.000Z",
    };
    await writeStateAtomic(path, next);
    await writeStateAtomic(path, { ...next, state: "failed" });
    assert((await readState(path))?.state === "failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("state writer and reader reject recursive unknown fields, unsafe identifiers, and invalid completion", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/state.json`;
  try {
    for (
      const patch of [
        { unknown: "secret" },
        { backupId: "/Users/private" },
        { state: "complete" },
        { state: "complete", snapshotId: "secret" },
        { sourceCounts: { files: 1, unknown: 2 } },
        { sourceCounts: { bytes: Infinity } },
        { failure: { ...failure(), code: "UNREGISTERED" } },
        { failure: { ...failure(), stderr: "secret" } },
        { failure: { ...failure(), counters: { files: 1, unknown: 2 } } },
        { snapshotId: "x".repeat(9000) },
      ]
    ) {
      const bad = { ...running, ...patch };
      await rejects(() => writeStateAtomic(path, bad));
      await Deno.writeTextFile(path, JSON.stringify(bad));
      await rejects(() => readState(path));
      await Deno.remove(path);
    }
    await writeStateAtomic(path, running);
    await rejects(() =>
      writeStateAtomic(path, { ...running, state: "not_started" })
    );
    await writeStateAtomic(path, {
      ...running,
      state: "failed",
      failure: failure(),
    });
    assert((await readState(path))?.failure?.code === "COMMAND_FAILED");
    await rejects(() =>
      renderFailure({ ...failure(), unknown: "secret" }, "json")
    );
    await rejects(() =>
      renderFailure({ ...failure(), unknown: "secret" }, "human")
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lock excludes another caller, stores only closed metadata, and removes in finally", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const options = { command: "files" as const, backupId: running.backupId };
  try {
    await rejects(() =>
      withLock(path, options, async () => {
        const lock = JSON.parse(await Deno.readTextFile(path));
        assert(
          JSON.stringify(Object.keys(lock).sort()) ===
            '["backupId","command","pid","processStartedAtUtc","recoveryAttempt"]',
        );
        assert(
          lock.pid === Deno.pid &&
            !Number.isNaN(Date.parse(lock.processStartedAtUtc)),
        );
        assert(((await Deno.stat(path)).mode! & 0o777) === 0o600);
        await rejects(
          () => withLock(path, options, () => Promise.resolve()),
          "LOCK_HELD",
        );
        let quarantined: unknown;
        try {
          await clearStaleLock(path, Deno.pid);
        } catch (error) {
          quarantined = error;
        }
        assert(
          quarantined instanceof Error &&
            (quarantined as Error & { code?: string }).code ===
              "REPOSITORY_QUARANTINED",
          "live mutating WAL was generic-stale-clearable",
        );
        throw new Error("COMMAND_FAILED");
      }), "COMMAND_FAILED");
    assert(
      [...Deno.readDirSync(root)].every((entry) =>
        entry.name === "backup.lock.guard"
      ),
    );
    assert(((await Deno.stat(`${path}.guard`)).mode! & 0o777) === 0o600);
    assert(await Deno.readTextFile(`${path}.guard`) === "");
    assert(await withLock(path, options, () => Promise.resolve(42)) === 42);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stale lock requires matching explicit pid and never automatically runs work", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const probe = () => false;
  const options = {
    command: "preflight" as const,
    backupId: running.backupId,
    isProcessAlive: probe,
  };
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        pid: 2147483647,
        processStartedAtUtc: running.startedAtUtc,
        command: "preflight",
        backupId: running.backupId,
      }),
      { mode: 0o600 },
    );
    let ran = false;
    await rejects(() =>
      withLock(path, options, () => {
        ran = true;
        return Promise.resolve();
      }), "STALE_LOCK");
    assert(!ran);
    await rejects(() => clearStaleLock(path, 123, probe), "STALE_LOCK");
    await clearStaleLock(path, 2147483647, probe);
    assert(
      [...Deno.readDirSync(root)].every((entry) =>
        entry.name === "backup.lock.guard"
      ),
    );
    await withLock(path, options, () => {
      ran = true;
      return Promise.resolve();
    });
    assert(ran);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stale clear rechecks a repository quarantine activated while its guard is held", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const stale = {
    pid: 2147483647,
    processStartedAtUtc: running.startedAtUtc,
    command: "preflight",
    backupId: running.backupId,
  };
  const quarantine = {
    schema: 1,
    kind: "repository-quarantine",
    quarantineId: "11111111-1111-4111-8111-111111111111",
    repository: { kind: "not_yet_verified" },
    triggeringCommand: "files",
    backupId: running.backupId,
    reason: "producer_audit_unverified",
    childTerminationConfirmed: true,
    timedOut: false,
    createdAtUtc: running.startedAtUtc,
  };
  try {
    const bytes = JSON.stringify(stale);
    await Deno.writeTextFile(path, bytes, { mode: 0o600 });
    let probes = 0;
    let caught: unknown;
    try {
      await clearStaleLock(path, stale.pid, async () => {
        if (++probes === 2) {
          await Deno.writeTextFile(
            `${root}/repository-quarantine-v1.json`,
            JSON.stringify(quarantine),
            { createNew: true, mode: 0o600 },
          );
        }
        return false;
      });
    } catch (error) {
      caught = error;
    }
    assert(
      caught instanceof Error &&
        (caught as Error & { code?: string }).code ===
          "REPOSITORY_QUARANTINED",
      "quarantine activation did not block stale removal",
    );
    assert(probes === 2, "quarantine was not activated at the removal edge");
    assert(await Deno.readTextFile(path) === bytes, "quarantined lock changed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("state captures validated data before the first asynchronous boundary", async () => {
  const root = await canonicalTempDir();
  try {
    const state: Record<string, unknown> = { ...running };
    const pending = writeStateAtomic(`${root}/state.json`, state);
    state.unexpected = "password=async-secret";
    await pending;
    const text = await Deno.readTextFile(`${root}/state.json`);
    assert(
      !text.includes("async-secret") && !text.includes("unexpected"),
      "mutation leaked unvalidated data",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finally removes its own damaged lock but preserves a replacement lock", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const options = {
    command: "preflight" as const,
    backupId: running.backupId,
  };
  try {
    await rejects(() =>
      withLock(path, options, async () => {
        await Deno.writeTextFile(path, "incomplete lock data");
        throw new Error("COMMAND_FAILED");
      }), "COMMAND_FAILED");
    assert(
      [...Deno.readDirSync(root)].every((entry) =>
        entry.name === "backup.lock.guard"
      ),
      "own damaged lock left behind",
    );
    await rejects(() =>
      withLock(path, options, async () => {
        await Deno.rename(path, `${root}/original.lock`);
        await Deno.writeTextFile(path, "replacement lock");
      }), "LOCK_HELD");
    assert(
      await Deno.readTextFile(path) === "replacement lock",
      "replacement removed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent stale recovery cannot delete a reacquired live lock or overlap callbacks", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const options = { command: "files" as const, backupId: running.backupId };
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const releaseOwner = Promise.withResolvers<void>();
  let first: Promise<void> | undefined;
  let owner: Promise<void> | undefined;
  let active = 0;
  let overlap = false;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        pid: 2147483647,
        processStartedAtUtc: running.startedAtUtc,
        command: "preflight",
        backupId: running.backupId,
      }),
      { mode: 0o600 },
    );
    let probes = 0;
    first = clearStaleLock(path, 2147483647, async () => {
      if (++probes === 2) {
        paused.resolve();
        await resume.promise;
      }
      return false;
    });
    await paused.promise;
    let secondCleared = false;
    try {
      await clearStaleLock(path, 2147483647, () => false);
      secondCleared = true;
    } catch (error) {
      assert(error instanceof Error && error.message === "LOCK_HELD");
    }
    // With the guard, the first clearer must finish before reacquisition. On
    // the old implementation the second clearer has already removed its lock.
    if (!secondCleared) {
      resume.resolve();
      await first;
    }
    owner = withLock(path, options, async () => {
      active++;
      entered.resolve();
      await releaseOwner.promise;
      active--;
    });
    await entered.promise;
    resume.resolve();
    await first;
    let liveLockExists = true;
    try {
      await Deno.stat(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      liveLockExists = false;
    }
    try {
      await withLock(path, options, () => {
        overlap = active > 0;
        return Promise.resolve();
      });
    } catch (error) {
      assert(error instanceof Error && error.message === "LOCK_HELD");
    }
    releaseOwner.resolve();
    await owner;
    assert(
      liveLockExists && !overlap && !secondCleared,
      "concurrent recovery deleted a live replacement and allowed overlapping callbacks",
    );
  } finally {
    resume.resolve();
    releaseOwner.resolve();
    await Promise.allSettled([first, owner]);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("owned lock lease is opaque, active only inside its callback, and bound to the exact regular inode", async () => {
  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const options = { command: "bootstrap" as const, backupId: running.backupId };
  let escaped: OwnedLockLease | undefined;
  try {
    await rejects(() =>
      withLock(path, options, async (lease) => {
        escaped = lease;
        await assertOwnedLockLease(path, lease);
        await rejects(
          () => assertOwnedLockLease(path, {} as OwnedLockLease),
          "LOCK_HELD",
        );
        await Deno.rename(path, `${root}/original.lock`);
        await Deno.writeTextFile(path, "replacement", { mode: 0o600 });
        await rejects(() => assertOwnedLockLease(path, lease), "LOCK_HELD");
        await Deno.remove(path);
        await rejects(() => assertOwnedLockLease(path, lease), "LOCK_HELD");
      }), "LOCK_HELD");
    assert(escaped);
    await rejects(() => assertOwnedLockLease(path, escaped!), "LOCK_HELD");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lock guard must be an owned regular non-symlink mode-0600 inode and remains stable while held", async () => {
  for (const kind of ["wrong-mode", "symlink", "directory"] as const) {
    const root = await canonicalTempDir();
    const path = `${root}/backup.lock`;
    const guard = `${path}.guard`;
    try {
      if (kind === "wrong-mode") {
        await Deno.writeTextFile(guard, "", { mode: 0o644 });
      } else if (kind === "symlink") {
        await Deno.writeTextFile(`${root}/target`, "", { mode: 0o600 });
        await Deno.symlink(`${root}/target`, guard);
      } else {
        await Deno.mkdir(guard, { mode: 0o700 });
      }
      await rejects(
        () =>
          withLock(
            path,
            { command: "bootstrap", backupId: running.backupId },
            () => Promise.resolve(),
          ),
        "LOCK_HELD",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  const root = await canonicalTempDir();
  const path = `${root}/backup.lock`;
  const guard = `${path}.guard`;
  try {
    await Deno.writeTextFile(guard, "", { mode: 0o600 });
    const before = await Deno.lstat(guard);
    await withLock(
      path,
      { command: "bootstrap", backupId: running.backupId },
      async () => {
        const held = await Deno.lstat(guard);
        assert(held.dev === before.dev && held.ino === before.ino);
      },
    );
    const after = await Deno.lstat(guard);
    assert(after.dev === before.dev && after.ino === before.ino);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("effective uid lookup clears ambient env and bounds hangs plus aggregate output", async () => {
  const root = await canonicalTempDir();
  const runner = new DenoRunner();
  const sentinel = "MYCELIA_UID_LOOKUP_AMBIENT_SENTINEL";
  const previousSentinel = Deno.env.get(sentinel);
  Deno.env.set(sentinel, "must-not-reach-child");
  const invoke = (path: string) =>
    readEffectiveUid((options: BufferedCommandOptions) => {
      assert(options.clearEnv === true, "uid lookup did not clear OS env");
      assert(
        JSON.stringify(options.env) === "{}",
        "uid lookup supplied an unexpected environment",
      );
      return runner.run([Deno.execPath(), "run", "--allow-env", path], options);
    });
  try {
    const clean = `${root}/clean.ts`;
    await Deno.writeTextFile(
      clean,
      `console.log(Deno.env.get(${
        JSON.stringify(sentinel)
      }) ? "leaked" : "501");`,
    );
    assert(
      await invoke(clean) === 501,
      "ambient environment reached uid child",
    );

    const hanging = `${root}/hang.ts`;
    await Deno.writeTextFile(hanging, "setInterval(() => {}, 1000);");
    const started = performance.now();
    await rejects(() => invoke(hanging));
    assert(
      performance.now() - started < 2_500,
      "uid lookup did not enforce its timeout",
    );

    const flooding = `${root}/flood.ts`;
    await Deno.writeTextFile(
      flooding,
      "await Deno.stdout.write(new Uint8Array(20)); await Deno.stderr.write(new Uint8Array(20)); setInterval(() => {}, 1000);",
    );
    await rejects(() => invoke(flooding));
  } finally {
    if (previousSentinel === undefined) Deno.env.delete(sentinel);
    else Deno.env.set(sentinel, previousSentinel);
    await Deno.remove(root, { recursive: true });
  }
});
