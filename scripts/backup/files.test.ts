import { join } from "node:path";
import { type FilesDependencies, runFilesBackup } from "./files.ts";
import { buildResticEnvironment } from "./restic.ts";
import {
  backupStatusPath,
  ownedLockContext,
  preserveOwnedLockForRecovery,
  readState,
  withLock,
  writeStateAtomic,
} from "./state.ts";
import { readRepositorySafetyInterlock } from "./repository-safety.ts";
import { commandTerminationError } from "./runner.ts";
import type { Runner } from "./types.ts";
import { failureError } from "./redact.ts";
import { assertFingerprint, fingerprint } from "./file-artifacts.ts";

function assert(v: unknown, message: string): asserts v {
  if (!v) throw new Error(message);
}
const encoder = new TextEncoder();
const bytesStream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

async function fixture() {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "files-unit-" }),
  );
  await Deno.writeTextFile(join(root, "docker-compose.yml"), "services: {}\n", {
    mode: 0o600,
  });
  const stateDir = join(root, ".local/backup");
  const env = buildResticEnvironment({
    homeDir: root,
    composeRoot: root,
    repository: "rclone:pk-backup:mycelia/restic-v1",
    rcloneConfigPath: join(root, "rclone.conf"),
    passwordCommandPath: join(root, "password-command"),
    inheritedEnvironment: {},
  });
  const control = { mode: "ok", calls: 0, sequence: 0 };
  const snapshots = new Map<
    string,
    {
      paths: string[];
      backupId: string;
      time: string;
      files: Map<string, Uint8Array>;
    }
  >();
  const runner: Runner = {
    run(argv) {
      assert(argv[0] === "git", "unexpected command");
      return Promise.resolve({
        code: 0,
        stdout: encoder.encode(
          argv.includes("rev-parse") ? "a".repeat(40) + "\n" : "",
        ),
        stderr: new Uint8Array(),
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
      });
    },
    spawn(argv, options) {
      control.calls++;
      assert(
        options.env === env && options.clearEnv === true,
        "environment not reused exactly",
      );
      const execute = async (): Promise<Uint8Array> => {
        if (argv.includes("backup")) {
          if (control.mode === "force") {
            throw commandTerminationError(true, true, true);
          }
          const raw = await Deno.readFile(
            argv[argv.indexOf("--files-from-raw") + 1],
          );
          assert(
            raw.at(-1) === 0 &&
              !new TextDecoder().decode(raw).includes("files-input-"),
            "invalid NUL input",
          );
          const paths = new TextDecoder().decode(raw).slice(0, -1).split("\0");
          const id = (++control.sequence).toString(16).padStart(64, "0");
          const backupId = argv.find((s) => s.startsWith("backup-id="))!.slice(
            10,
          );
          const files = new Map<string, Uint8Array>();
          for (const p of paths) files.set(p, await Deno.readFile(p));
          const time = new Date().toISOString();
          snapshots.set(id, { paths, backupId, time, files });
          if (control.mode === "mutate") {
            await Deno.writeTextFile(
              join(root, "docker-compose.yml"),
              "changed during backup\n",
            );
          }
          return encoder.encode(
            JSON.stringify({
              message_type: "summary",
              snapshot_id: id,
              total_files_processed: paths.length,
              total_bytes_processed: [...files.values()].reduce(
                (n, b) => n + b.length,
                0,
              ),
              backup_start: time,
              backup_end: time,
            }) + "\n",
          );
        }
        if (argv.includes("snapshots")) {
          const id = argv.at(-1)!;
          const snapshot = snapshots.get(id)!;
          return encoder.encode(
            JSON.stringify([{
              id,
              hostname: "mycelia-11111111-1111-4111-8111-111111111111",
              tags: ["mycelia-files", `backup-id=${snapshot.backupId}`],
              paths: snapshot.paths,
              time: snapshot.time,
            }]),
          );
        }
        if (argv.includes("check")) {
          return encoder.encode(
            JSON.stringify({
              message_type: "summary",
              num_errors: control.mode === "check-fail" ? 1 : 0,
              broken_packs: null,
            }) + "\n",
          );
        }
        if (argv.includes("dump")) {
          return snapshots.get(argv[argv.indexOf("dump") + 1])!.files.get(
            argv.at(-1)!,
          )!;
        }
        throw new Error("unexpected command");
      };
      const outcome = execute();
      const stdout = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            c.enqueue(await outcome);
            c.close();
          } catch (e) {
            c.error(e);
          }
        },
      });
      const status = outcome.then(() => ({
        code: 0,
        timedOut: false as const,
        terminationConfirmed: true as const,
        forcedKill: false as const,
      }));
      return {
        stdin: new WritableStream(),
        stdout,
        stderr: bytesStream(encoder.encode("private://secret")),
        status,
        kill() {},
      };
    },
  };
  const deps: FilesDependencies = {
    runner,
    homeDir: root,
    loadResticContext: (_root, lease) =>
      Promise.resolve({
        env,
        assertUnchanged: () => Promise.resolve(),
        repositoryId: "b".repeat(64),
        installationId: "11111111-1111-4111-8111-111111111111",
        preflight: {
          schema: 1,
          ok: true,
          localVerified: true,
          remoteVerified: true,
          backupId: ownedLockContext(lease).backupId,
          versions: { restic: "0.19.1", rclone: "1.75.0" },
          sourceCoverage: { complete: true, total: 0, covered: 0 },
        },
      }),
    collectSourceManifest: ({ backupId }) =>
      Promise.resolve({
        backupId,
        labels: [{ label: "tracked-config", canonicalRoot: root }],
        files: [join(root, "docker-compose.yml")],
        coverage: {
          total: 0,
          covered: 0,
          missing: 0,
          unreadable: 0,
          outsideRoots: 0,
          invalid: 0,
          complete: true,
        },
      }),
  };
  return { root, stateDir, control, deps, snapshots };
}

Deno.test("files acceptance preserves accepted snapshot across failed candidate and rejects replacement receipts", async () => {
  const f = await fixture();
  try {
    const a = await runFilesBackup({ composeRoot: f.root }, f.deps);
    assert(a.state === "complete", "first snapshot failed");
    f.control.mode = "check-fail";
    const b = await runFilesBackup({ composeRoot: f.root }, f.deps);
    assert(
      b.state === "failed" && b.snapshotId && b.snapshotId !== a.snapshotId,
      "candidate not retained",
    );
    assert(
      JSON.stringify(a.accepted) === JSON.stringify(b.accepted),
      "accepted receipt changed",
    );
    assert(
      !JSON.stringify(b).includes(f.root) &&
        !JSON.stringify(b).includes("private://"),
      "plaintext status leaked",
    );
    let failed = false;
    try {
      await writeStateAtomic(backupStatusPath(f.stateDir, "files"), {
        ...b,
        accepted: { ...b.accepted!, snapshotId: b.snapshotId },
      });
    } catch {
      failed = true;
    }
    assert(failed, "failed attempt replaced accepted receipt");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("source mutation prevents acceptance and cleans only generated artifacts", async () => {
  const f = await fixture();
  try {
    f.control.mode = "mutate";
    const state = await runFilesBackup({ composeRoot: f.root }, f.deps);
    assert(
      state.state === "failed" &&
        state.failure?.code === "SOURCE_COVERAGE_INCOMPLETE" &&
        state.snapshotId && !state.accepted,
      "mutation accepted",
    );
    assert(
      ![...Deno.readDirSync(f.stateDir)].some((e) =>
        /^files-(input|manifest)/.test(e.name)
      ),
      "artifacts leaked",
    );
    assert(
      await Deno.readTextFile(join(f.root, "docker-compose.yml")) ===
        "changed during backup\n",
      "source modified by cleanup",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("forced termination creates global quarantine and blocks the next writer", async () => {
  const f = await fixture();
  try {
    f.control.mode = "force";
    const state = await runFilesBackup({ composeRoot: f.root }, f.deps);
    assert(
      state.failure?.code === "COMMAND_TERMINATION_UNCONFIRMED",
      "typed failure lost",
    );
    const interlock = await readRepositorySafetyInterlock(f.stateDir);
    assert(
      interlock?.record.reason === "forced_kill_descendants_unproved",
      "quarantine missing",
    );
    const calls = f.control.calls;
    let error;
    try {
      await runFilesBackup({ composeRoot: f.root }, f.deps);
    } catch (e) {
      error = e;
    }
    assert(
      (error as { code?: string })?.code === "REPOSITORY_QUARANTINED" &&
        calls === f.control.calls,
      "quarantine allowed effects",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("terminal state failure preserves durable WAL and prior running candidate", async () => {
  const f = await fixture();
  try {
    const deps = {
      ...f.deps,
      writeState: async (path: string, state: unknown) => {
        if (
          (state as { state?: string }).state === "complete"
        ) throw failureError("STATE_INVALID");
        await writeStateAtomic(path, state);
      },
    };
    let error;
    try {
      await runFilesBackup({ composeRoot: f.root }, deps);
    } catch (e) {
      error = e;
    }
    assert(
      (error as { code?: string })?.code === "STATE_INVALID",
      "failed status commit reported success",
    );
    assert(
      (await readState(backupStatusPath(f.stateDir, "files")))?.state ===
        "running",
      "candidate lost",
    );
    assert(
      (await readRepositorySafetyInterlock(f.stateDir))?.record.reason ===
        "retention_publication_interrupted",
      "write failure released WAL",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("existing mutation WAL blocks files before context/source calls", async () => {
  const f = await fixture();
  try {
    await Deno.mkdir(f.stateDir, { recursive: true, mode: 0o700 });
    await withLock(join(f.stateDir, "backup.lock"), {
      command: "mongo-bootstrap",
      backupId: "20261002T120000Z",
    }, preserveOwnedLockForRecovery);
    let error;
    try {
      await runFilesBackup({ composeRoot: f.root }, f.deps);
    } catch (e) {
      error = e;
    }
    assert(
      (error as { code?: string })?.code === "REPOSITORY_QUARANTINED" &&
        f.control.calls === 0,
      "cross-stage WAL ignored",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("fingerprint rejects metadata changes, inode replacement and symlinks", async () => {
  const f = await fixture();
  const path = join(f.root, "docker-compose.yml");
  try {
    for (
      const change of [async () => await Deno.chmod(path, 0o640), async () => {
        await Deno.remove(path);
        await Deno.writeTextFile(path, "services: {}\n");
      }, async () => {
        await Deno.remove(path);
        await Deno.symlink(join(f.root, "other"), path);
      }]
    ) {
      const before = await fingerprint(path);
      await change();
      let rejected = false;
      try {
        await assertFingerprint({ path, fingerprint: before });
      } catch {
        rejected = true;
      }
      assert(rejected, "source change missed");
      await Deno.remove(path);
      await Deno.writeTextFile(path, "services: {}\n", { mode: 0o600 });
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
