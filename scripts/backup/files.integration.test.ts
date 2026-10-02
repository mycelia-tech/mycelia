import { join } from "node:path";
import {
  type FilesDependencies,
  runFilesBackup,
  verifyAcceptedFiles,
} from "./files.ts";
import { DenoRunner } from "./runner.ts";
import { buildResticEnvironment } from "./restic.ts";
import {
  backupStatusPath,
  ownedLockContext,
  readState,
  withLock,
} from "./state.ts";
import type { Runner, StreamingCommandOptions } from "./types.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test({
  name:
    "local restic A-to-B backup uses accepted parent and readback, failed C preserves accepted B",
  ignore: Deno.env.get("BACKUP_INTEGRATION") !== "1",
  fn: async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "mycelia-backup-integration-" }),
    );
    const composeRoot = join(root, "source"),
      repository = join(root, "repository");
    const real = new DenoRunner();
    const commands: string[][] = [];
    let corruptDump = false;
    try {
      await Deno.mkdir(composeRoot, { mode: 0o700 });
      await Deno.writeTextFile(
        join(composeRoot, "docker-compose.yml"),
        "services: {}\n",
        { mode: 0o600 },
      );
      await Deno.writeTextFile(join(composeRoot, "media.txt"), "version A\n", {
        mode: 0o600,
      });
      const localEnv = {
        HOME: root,
        PATH: Deno.env.get("PATH")!,
        RESTIC_PASSWORD: "disposable-test-password",
        RESTIC_REPOSITORY: repository,
      };
      const init = await real.run(["restic", "init", "--json"], {
        env: localEnv,
        clearEnv: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      });
      assert(init.code === 0, "local init failed");
      const cat = await real.run(["restic", "cat", "config"], {
        env: localEnv,
        clearEnv: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      });
      const repositoryId = JSON.parse(new TextDecoder().decode(cat.stdout)).id;
      const runner: Runner = {
        run(argv, options) {
          if (argv[0] === "git") {
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode(
                argv.includes("rev-parse") ? "a".repeat(40) + "\n" : "",
              ),
              stderr: new Uint8Array(),
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
            });
          }
          return real.run(argv, options);
        },
        spawn(argv, options: StreamingCommandOptions) {
          assert(
            options.clearEnv === true &&
              Object.keys(options.env ?? {}).length === 6,
            "production environment widened",
          );
          commands.push([...argv]);
          if (corruptDump && argv.includes("dump")) {
            return {
              stdin: new WritableStream(),
              stdout: new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("wrong bytes"));
                  c.close();
                },
              }),
              stderr: new ReadableStream({
                start(c) {
                  c.close();
                },
              }),
              status: Promise.resolve({
                code: 0,
                timedOut: false,
                terminationConfirmed: true,
                forcedKill: false,
              }),
              kill() {},
            };
          }
          // Test-only transport adapter. No production repository or Keychain.
          return real.spawn(argv, {
            ...options,
            timeoutMs: 60_000,
            env: localEnv,
            clearEnv: true,
          });
        },
      };
      const env = buildResticEnvironment({
        composeRoot,
        repository: "rclone:pk-backup:mycelia/restic-v1",
        passwordCommandPath: join(composeRoot, "password-command"),
        rcloneConfigPath: join(root, "rclone.conf"),
        homeDir: root,
        inheritedEnvironment: {},
      });
      const deps: FilesDependencies = {
        runner,
        homeDir: root,
        loadResticContext: (_root, lease) =>
          Promise.resolve({
            env,
            repositoryId,
            assertUnchanged: () => Promise.resolve(),
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
            labels: [{ label: "tracked-config", canonicalRoot: composeRoot }],
            files: [
              join(composeRoot, "docker-compose.yml"),
              join(composeRoot, "media.txt"),
            ],
            coverage: {
              total: 0,
              covered: 0,
              missing: 0,
              unreadable: 0,
              invalid: 0,
              outsideRoots: 0,
              complete: true,
            },
          }),
      };
      const a = await runFilesBackup({ composeRoot }, deps);
      assert(
        a.state === "complete",
        `A failed: ${a.failure?.code}; last command: ${
          commands.at(-1)?.slice(0, 6).join(" ")
        }`,
      );
      assert(
        a.accepted?.sourceCounts.files === 2 &&
          a.accepted.sourceCounts.total === 0,
        "source and coverage counts conflated",
      );
      await Deno.writeTextFile(join(composeRoot, "media.txt"), "version B\n");
      const b = await runFilesBackup({ composeRoot }, deps);
      assert(b.state === "complete", `B failed: ${b.failure?.code}`);
      assert(
        b.accepted?.verificationOrdinal === 2 && b.snapshotId !== a.snapshotId,
        "B acceptance incorrect",
      );
      const backups = commands.filter((argv) => argv.includes("backup"));
      assert(
        backups[0].includes("--force") && !backups[0].includes("--parent"),
        "first backup implicit parent",
      );
      assert(
        backups[1][backups[1].indexOf("--parent") + 1] === a.snapshotId,
        "second backup parent not accepted A",
      );
      const stateDir = join(composeRoot, ".local/backup");
      assert(
        ![...Deno.readDirSync(stateDir)].some((e) =>
          /^files-(input|manifest)/.test(e.name)
        ),
        "plaintext artifact leaked",
      );
      await withLock(
        join(stateDir, "backup.lock"),
        { command: "verify", backupId: "20261002T120000Z" },
        (lease) =>
          verifyAcceptedFiles(
            { composeRoot, lockLease: lease },
            b.accepted!,
            deps,
          ),
      );
      const restoreRoot = join(root, "restore");
      const restored = await real.run([
        "restic",
        "restore",
        b.snapshotId!,
        "--target",
        restoreRoot,
        "--verify",
      ], {
        env: localEnv,
        clearEnv: true,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
      });
      assert(
        restored.code === 0 &&
          await Deno.readTextFile(
              join(restoreRoot, composeRoot.slice(1), "media.txt"),
            ) === "version B\n",
        "isolated restore did not reproduce B",
      );
      corruptDump = true;
      const c = await runFilesBackup({ composeRoot }, deps);
      assert(
        c.state === "failed" && c.failure?.code === "RESTIC_VERIFY_FAILED",
        "corrupt readback accepted",
      );
      assert(
        JSON.stringify(c.accepted) === JSON.stringify(b.accepted) &&
          c.snapshotId !== b.snapshotId,
        "failure lost accepted B/candidate C",
      );
      assert(
        (await readState(backupStatusPath(stateDir, "files")))?.state ===
          "failed",
        "terminal state missing",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
