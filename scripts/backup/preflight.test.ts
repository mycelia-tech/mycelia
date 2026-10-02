import {
  type DeploymentContext,
  discoverDeployment,
  MONGO_PREFLIGHT_SCRIPT,
  resolveManifestOptions,
  resolvePkBackupSshTransport,
  runPreflight,
} from "./preflight.ts";
import { loadBackupConfig } from "./config.ts";
import { buildSourceManifest } from "./sources.ts";
import { withLock } from "./state.ts";
import type {
  BufferedCommandOptions,
  Runner,
  StreamingCommandOptions,
} from "./types.ts";
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const enc = new TextEncoder();
const goodMongo = {
  authorization: "disabled",
  ping: true,
  writablePrimary: true,
  firstOplogSeconds: 100,
  lastOplogSeconds: 7300,
  oplogWindowSeconds: 7200,
  databaseBytes: 200,
};
const healthy = [{
  ID: "a".repeat(64),
  Service: "mongo",
  State: "running",
  Health: "healthy",
}, {
  ID: "b".repeat(64),
  Service: "redis",
  State: "running",
  Health: "healthy",
}];
function fake(changes: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const runs: Array<{
    argv: string[];
    options: BufferedCommandOptions;
  }> = [];
  const scripts: string[] = [];
  const runner: Runner = {
    run(argv: readonly string[], opts: BufferedCommandOptions) {
      calls.push([...argv]);
      runs.push({ argv: [...argv], options: opts });
      assert(
        opts.timeoutMs > 0 && opts.maxOutputBytes > 0,
        "unbounded command",
      );
      let out: string;
      if (argv[0] === "restic" && argv[1] === "version") {
        out = String(
          changes.restic ??
            "restic 0.19.0 compiled with go1.25 on darwin/arm64",
        );
      } else if (argv[0] === "rclone" && argv[1] === "version") {
        out = String(changes.rclone ?? "rclone v1.75.0\n- os/version: darwin");
      } else if (argv[0] === "docker" && argv[1] === "info") out = '"29.1.3"';
      else if (argv.includes("ps")) {
        out = String(changes.ps ?? JSON.stringify(healthy));
      } else if (argv.includes("mongodump")) {
        out = String(
          changes.mongodump ?? "mongodump version: 100.17.0\ngit version: test",
        );
      } else if (argv[0] === "git" && argv.includes("ls-files")) out = "";
      else if (argv[0] === "rclone" && argv[1] === "lsf") out = "";
      else if (argv[0] === "rclone" && argv[1] === "about") {
        out = '{"free":1000000000000}';
      } else throw new Error("unexpected or mutating command");
      if (changes.fail === argv[0]) {
        return Promise.reject(new Error("secret raw failure"));
      }
      return Promise.resolve({
        code: 0,
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
        stdout: enc.encode(out),
        stderr: enc.encode("secret ignored"),
      });
    },
    spawn(argv: readonly string[], opts: StreamingCommandOptions) {
      calls.push([...argv]);
      assert(
        argv[0] === "docker" && argv.includes("mongosh") &&
          argv.includes("/dev/stdin") && opts.timeoutMs > 0,
        "unexpected mutating spawn",
      );
      let script = "";
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return {
        stdin: new WritableStream({
          write(chunk) {
            script += new TextDecoder().decode(chunk);
          },
          close() {
            scripts.push(script);
            controller.enqueue(
              enc.encode(
                script.includes('getCollection("source_files")')
                  ? String(changes.sources ?? '{"type":"count","count":0}\n')
                  : String(changes.mongo ?? JSON.stringify(goodMongo)),
              ),
            );
            controller.close();
          },
        }),
        stdout,
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        status: Promise.resolve({
          code: Number(changes.mongoExit ?? 0),
          timedOut: false,
          terminationConfirmed: true,
          forcedKill: false,
        }),
        kill() {},
      };
    },
  };
  return { runner, calls, runs, scripts };
}
async function fixture(
  fn: (root: string, context: DeploymentContext) => Promise<void> | void,
) {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${root}/.env`, "", { mode: 0o600 });
    const rcloneConfig = await writeDefaultRcloneConfig(root);
    await Deno.mkdir(`${root}/archive`);
    const inactive = { active: false };
    const context: DeploymentContext = {
      mongo: [{ Type: "volume", Source: "mongo", Destination: "/data/db" }],
      redis: [{ Type: "volume", Source: "redis", Destination: "/data" }],
      rag: { active: false },
      archiveRoot: `${root}/archive`,
      picturesImportRoot: `${root}/absent`,
      protectedConfig: {
        media: inactive,
        rag: inactive,
        tls: inactive,
        rclone: {
          active: true,
          config: rcloneConfig,
          knownHosts: `${root}/.env`,
        },
        provider: inactive,
        mongoKeyfile: inactive,
        pbm: inactive,
        icloudArchive: { active: true, path: `${root}/.env` },
      },
    };
    await fn(root, context);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function writeDefaultRcloneConfig(
  root: string,
  text = "pinned config\n",
): Promise<string> {
  const directory = `${root}/.config/rclone`;
  const path = `${directory}/rclone.conf`;
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(path, text, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
  return path;
}

function deps(
  root: string,
  context: DeploymentContext,
  f: ReturnType<typeof fake>,
) {
  return {
    runner: f.runner,
    homeDir: root,
    tempFreeBytes: () => Promise.resolve(2 * 1024 ** 3),
    context: () => Promise.resolve(context),
  };
}

Deno.test("preflight rechecks pinned rclone config before consecutive rclone and restic children", async () => {
  for (
    const race of ["content", "replacement", "symlink", "mode"] as const
  ) {
    await fixture(async (root, context) => {
      const configPath = await writeDefaultRcloneConfig(root);
      context.protectedConfig.rclone = {
        active: true,
        config: configPath,
        knownHosts: `${root}/.env`,
      };
      const f = fake();
      let protectedChildren = 0;
      let mutated = false;
      const runner: Runner = {
        run: async (argv, options) => {
          const result = await f.runner.run(argv, options);
          if (argv[0] === "rclone" || argv[0] === "restic") {
            protectedChildren++;
            if (!mutated) {
              mutated = true;
              if (race === "content") {
                await Deno.writeTextFile(configPath, "tamper config\n");
              } else if (race === "replacement") {
                const replacement = `${configPath}.replacement`;
                await Deno.writeTextFile(replacement, "pinned config\n", {
                  mode: 0o600,
                });
                await Deno.chmod(replacement, 0o600);
                await Deno.rename(replacement, configPath);
              } else if (race === "symlink") {
                const target = `${configPath}.target`;
                await Deno.writeTextFile(target, "pinned config\n", {
                  mode: 0o600,
                });
                await Deno.chmod(target, 0o600);
                await Deno.remove(configPath);
                await Deno.symlink(target, configPath);
              } else {
                await Deno.chmod(configPath, 0o644);
              }
            }
          }
          return result;
        },
        spawn: (argv, options) => f.runner.spawn(argv, options),
      };
      const report = await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        {
          ...deps(root, context, f),
          runner,
        },
      );
      assert(mutated, `${race} race hook did not run`);
      assert(!report.ok, `${race} rclone config race was accepted`);
      assert(
        protectedChildren === 1,
        `${race} reached a second rclone/restic child`,
      );
    });
  }
});

Deno.test("preflight pins a canonical owned exact-0600 rclone config before protected children", async () => {
  for (const kind of ["0644", "0660", "symlink", "noncanonical"] as const) {
    await fixture(async (root, context) => {
      const configPath = `${root}/.config/rclone/rclone.conf`;
      if (kind === "0644" || kind === "0660") {
        await Deno.chmod(configPath, kind === "0644" ? 0o644 : 0o660);
      } else if (kind === "symlink") {
        const target = `${configPath}.target`;
        await Deno.writeTextFile(target, "pinned config\n", { mode: 0o600 });
        await Deno.chmod(target, 0o600);
        await Deno.remove(configPath);
        await Deno.symlink(target, configPath);
      }
      const f = fake();
      const configured = deps(root, context, f);
      const report = await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        {
          ...configured,
          ...(kind === "noncanonical" ? { homeDir: `${root}/.` } : {}),
        },
      );
      assert(!report.ok, `${kind} rclone config was accepted`);
      assert(
        !f.calls.some((argv) => argv[0] === "rclone" || argv[0] === "restic"),
        `${kind} rclone config reached a protected child`,
      );
    });
  }
});

function sshConfigText() {
  return `AddKeysToAgent yes

Host pk_backup
  HostName 77.51.198.164
  Port 22126
  User pk
  IdentityFile ~/.ssh/id_rsa
  IdentitiesOnly yes
  IdentityAgent none
  UseKeychain yes
  StrictHostKeyChecking yes

Host *
  UseKeychain yes

Host unrelated
  IdentityFile ~/.ssh/unrelated
  ForwardAgent yes

Host *
  IdentityAgent "~/Library/Group Containers/example/agent.sock"
`;
}

async function sshTransportFiles(
  root: string,
  changes: { ssh?: string; config?: string; rclone?: string } = {},
) {
  await Deno.mkdir(`${root}/.ssh`, { recursive: true });
  const sshConfig = `${root}/.ssh/config`;
  const knownHosts = `${root}/.ssh/known_hosts`;
  const identity = `${root}/.ssh/id_rsa`;
  for (
    const [file, text] of [
      [sshConfig, changes.config ?? sshConfigText()],
      [knownHosts, "[host]:22126 ssh-ed25519 AAAATEST\n"],
      [identity, "test-fixture-private-key-not-a-real-key\n"],
    ]
  ) {
    await Deno.writeTextFile(file, text, { mode: 0o600 });
  }
  const ssh = changes.ssh ??
    `/usr/bin/ssh -F ${sshConfig} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts} -o ConnectTimeout=12 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 pk_backup`;
  const rclone = changes.rclone ??
    `[pk-backup]\ntype = sftp\nssh = ${ssh}\nknown_hosts_file = ${knownHosts}\nshell_type = unix\nmd5sum_command = md5sum\nsha1sum_command = sha1sum\n`;
  const rcloneConfig = await writeDefaultRcloneConfig(root, rclone);
  const calls: string[][] = [];
  const runner: Runner = {
    run(argv, options) {
      calls.push([...argv]);
      assert(options.timeoutMs > 0 && options.maxOutputBytes > 0);
      assert(argv.join(" ") === "rclone config file");
      assert(options.clearEnv === true, "rclone inherited ambient env");
      assert(
        JSON.stringify(options.env) === JSON.stringify({
          HOME: root,
          PATH: `${root}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        }),
        "rclone config discovery did not receive the exact closed env",
      );
      return Promise.resolve({
        code: 0,
        timedOut: false,
        terminationConfirmed: true,
        forcedKill: false,
        stdout: enc.encode(
          `Configuration file is stored at:\n${rcloneConfig}\n`,
        ),
        stderr: new Uint8Array(),
      });
    },
    spawn() {
      throw new Error("SSH must never be executed while resolving transport");
    },
  };
  return {
    runner,
    calls,
    ssh,
    sshConfig,
    knownHosts,
    identity,
    rcloneConfig,
  };
}

async function rejectsCoverage(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof Error && error.message === "SOURCE_COVERAGE_INCOMPLETE",
    );
    return;
  }
  throw new Error("expected SOURCE_COVERAGE_INCOMPLETE");
}

Deno.test("preflight rejects inherited rclone overrides before local discovery or remote commands", async () => {
  await fixture(async (root, context) => {
    const previous = Deno.env.get("RCLONE_EXCLUDE");
    Deno.env.set("RCLONE_EXCLUDE", "/mycelia/**");
    try {
      for (const remoteMode of ["full", "skip"] as const) {
        const f = fake();
        const report = await runPreflight(
          { composeRoot: root, remoteMode },
          deps(root, context, f),
        );
        assert(report.failure === "CONFIG_INVALID", "rclone filter accepted");
        assert(!report.ok && !report.localVerified && !report.remoteVerified);
        assert(f.calls.length === 0, "untrusted environment reached a command");
        assert(
          !JSON.stringify(report).includes("mycelia/"),
          "filter value leaked",
        );
      }
    } finally {
      if (previous === undefined) Deno.env.delete("RCLONE_EXCLUDE");
      else Deno.env.set("RCLONE_EXCLUDE", previous);
    }
  });
});
Deno.test("preflight full passes measured protected-config coverage while skip never contacts remote or claims readiness", async () => {
  await fixture(async (root, context) => {
    for (const remoteMode of ["full", "skip"] as const) {
      const f = fake();
      const report = await runPreflight(
        {
          composeRoot: root,
          remoteMode,
          backupId: "20261002T120000Z-abcdef12",
        },
        deps(root, context, f),
      );
      assert(report.ok === (remoteMode === "full"));
      assert(
        report.backupId === "20261002T120000Z-abcdef12",
        "caller operation ID replaced",
      );
      assert(report.remoteVerified === (remoteMode === "full"));
      assert(report.localVerified);
      assert(report.databaseBytes === 200 && report.fileBytes === 14);
      assert(
        report.sourceCoverage?.complete && report.sourceCoverage.total === 0,
      );
      assert(
        !JSON.stringify(report).includes(root) &&
          !JSON.stringify(report).includes("secret"),
      );
      assert(!f.calls.some((c) => c.includes("pbm")));
      if (remoteMode === "skip") {
        assert(
          !f.calls.some((c) => c.some((a) => a.includes("pk-backup:"))),
          "remote called in skip",
        );
      } else {
        const remoteRuns = f.runs.filter(({ argv }) =>
          argv[0] === "rclone" && ["lsf", "about", "cat"].includes(argv[1])
        );
        assert(remoteRuns.length === 2, "unexpected remote probe count");
        for (const { options } of remoteRuns) {
          assert(options.clearEnv === true, "remote inherited ambient env");
          assert(
            JSON.stringify(options.env) === JSON.stringify({
              HOME: root,
              PATH:
                `${root}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
              RCLONE_CONFIG: `${root}/.config/rclone/rclone.conf`,
            }),
            "remote did not receive the exact validated rclone env",
          );
        }
      }
    }
  });
});

Deno.test("preflight accepts its active exact lock lease and rejects the same lock without that capability", async () => {
  await fixture(async (root, context) => {
    await Deno.mkdir(`${root}/.local/backup`, { recursive: true });
    const config = await loadBackupConfig(root, root);
    const options = {
      command: "bootstrap" as const,
      backupId: "20260930T120000Z",
    };
    await withLock(config.lockPath, options, async (lockLease) => {
      const rejected = await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, fake()),
      );
      assert(rejected.failure === "LOCK_HELD");
      const accepted = await runPreflight(
        { composeRoot: root, remoteMode: "full", lockLease },
        deps(root, context, fake()),
      );
      assert(accepted.ok && accepted.localVerified && accepted.remoteVerified);
    });
  });
});

Deno.test("pk_backup transport resolver accepts only the pinned external-SSH alias shape without executing SSH", async () => {
  await fixture(async (root) => {
    const files = await sshTransportFiles(root);
    const transport = await resolvePkBackupSshTransport(files.runner, root);
    assert(
      JSON.stringify(transport.sshArgv) ===
        JSON.stringify(files.ssh.split(" ")),
    );
    assert(transport.rcloneConfigPath === files.rcloneConfig);
    assert(transport.sshConfigPath === files.sshConfig);
    assert(transport.knownHostsPath === files.knownHosts);
    assert(transport.identityFilePath === files.identity);
    assert(
      JSON.stringify(files.calls) ===
        JSON.stringify([["rclone", "config", "file"]]),
      "resolver executed anything beyond read-only rclone config discovery",
    );
  });
});

Deno.test("pk_backup transport rejects raw-IP bypass, incomplete or duplicated argv, and adversarial matching SSH config", async () => {
  await fixture(async (root) => {
    const base = await sshTransportFiles(root);
    const commandCases = [
      base.ssh.replace(/pk_backup$/, "pk@77.51.198.164"),
      base.ssh.replace(" -o ConnectTimeout=12", ""),
      base.ssh.replace(
        " -o StrictHostKeyChecking=yes",
        " -o BatchMode=yes -o StrictHostKeyChecking=yes",
      ),
      `${base.ssh} -v`,
      base.ssh.replace(` -F ${base.sshConfig}`, ""),
    ];
    for (const ssh of commandCases) {
      const files = await sshTransportFiles(root, { ssh });
      await rejectsCoverage(() =>
        resolvePkBackupSshTransport(files.runner, root)
      );
    }

    const exact = sshConfigText();
    const configCases = [
      `Host *\n  UseKeychain yes\n${exact}`,
      exact.replace("  IdentityAgent none\n", ""),
      exact.replace(
        "  StrictHostKeyChecking yes\n",
        "  StrictHostKeyChecking yes\n  IdentityFile ~/.ssh/second\n",
      ),
      `Host pk_*\n  User nobody\n${exact}`,
      `Include ~/.ssh/generated\n${exact}`,
      exact.replace("  User pk\n", "  User pk\n  ProxyJump host\n"),
      exact.replace("  User pk\n", "  User pk\n  ForwardAgent yes\n"),
      exact.replace(
        "Host pk_backup\n",
        "Host pk_backup other-alias\n",
      ),
      `HostName 77.51.198.164\n${exact}`,
      exact.replace(
        "Host *\n  UseKeychain yes\n",
        "Host *\n  UseKeychain yes\n  IdentityFile ~/.ssh/extra\n",
      ),
      exact.replace("Host unrelated", "Match host pk_backup\nHost unrelated"),
    ];
    for (const config of configCases) {
      const files = await sshTransportFiles(root, { config });
      await rejectsCoverage(() =>
        resolvePkBackupSshTransport(files.runner, root)
      );
    }
  });
});

Deno.test("pk_backup transport accepts exactly the current closed rclone section and rejects wrong duplicate missing or unknown keys", async () => {
  await fixture(async (root) => {
    const valid = await sshTransportFiles(root);
    const accepted = await resolvePkBackupSshTransport(valid.runner, root);
    assert(accepted.knownHostsPath === valid.knownHosts);

    const base = await Deno.readTextFile(valid.rcloneConfig);
    const rcloneCases = [
      base.replace("shell_type = unix", "shell_type = windows"),
      base.replace(
        "md5sum_command = md5sum",
        "md5sum_command = md5sum\nmd5sum_command = md5sum",
      ),
      base.replace("sha1sum_command = sha1sum\n", ""),
      `${base}unknown_safe_looking_key = value\n`,
      base.replace(
        `known_hosts_file = ${valid.knownHosts}`,
        `known_hosts_file = ${root}/different-known-hosts`,
      ),
    ];
    for (const rclone of rcloneCases) {
      const files = await sshTransportFiles(root, { rclone });
      await rejectsCoverage(() =>
        resolvePkBackupSshTransport(files.runner, root)
      );
    }
  });
});

Deno.test("pk_backup transport requires owned regular mode-0600 SSH config, identity, and known-hosts files", async () => {
  await fixture(async (root) => {
    for (const slot of ["sshConfig", "identity", "knownHosts"] as const) {
      const files = await sshTransportFiles(root);
      await Deno.chmod(files[slot], 0o644);
      await rejectsCoverage(() =>
        resolvePkBackupSshTransport(files.runner, root)
      );
    }
    const files = await sshTransportFiles(root);
    await Deno.rename(files.identity, `${files.identity}.real`);
    await Deno.symlink(`${files.identity}.real`, files.identity);
    await rejectsCoverage(() =>
      resolvePkBackupSshTransport(files.runner, root)
    );
  });
});
Deno.test("preflight fails missing malformed and old tools before filesystem Docker or remote checks", async () => {
  await fixture(async (root, context) => {
    for (
      const changes of [
        { restic: "no version" },
        { restic: "restic 0.18.9" },
        { rclone: "rclone v1.74.9" },
        { rclone: "bad" },
        { fail: "restic" },
      ]
    ) {
      const f = fake(changes);
      const report = await runPreflight({
        composeRoot: root,
        remoteMode: "full",
      }, deps(root, context, f));
      assert(report.failure === "COMMAND_FAILED");
      assert(!f.calls.some((c) => c[0] === "docker"));
    }
    for (
      const changes of [{ restic: "restic 1.0.0", rclone: "rclone v2.0.0" }]
    ) {
      const f = fake(changes);
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "skip" },
          deps(root, context, f),
        )).localVerified,
      );
    }
  });
});
Deno.test("preflight refuses unsafe env mode type malformed and conflicting assignments", async () => {
  await fixture(async (root, context) => {
    for (const mode of [0o644, 0o400, 0o1600]) {
      await Deno.chmod(`${root}/.env`, mode);
      const f = fake();
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "full" },
          deps(root, context, f),
        )).failure === "CONFIG_INVALID",
      );
      assert(f.calls.length === 0);
    }
    await Deno.chmod(`${root}/.env`, 0o600);
    for (const text of ["export bad", "X=a\nX=b", "PASSWORD='unfinished"]) {
      await Deno.writeTextFile(`${root}/.env`, text);
      const f = fake();
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "full" },
          deps(root, context, f),
        )).failure === "CONFIG_INVALID",
      );
    }
    await Deno.remove(`${root}/.env`);
    await Deno.mkdir(`${root}/.env`);
    assert(
      (await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, fake()),
      )).failure === "CONFIG_INVALID",
    );
  });
});
Deno.test("preflight rejects low unknown temp capacity and every present lock without modifying it", async () => {
  await fixture(async (root, context) => {
    for (const free of [0, 1, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const f = fake();
      const r = await runPreflight({ composeRoot: root, remoteMode: "full" }, {
        ...deps(root, context, f),
        tempFreeBytes: () => Promise.resolve(free),
      });
      assert(r.failure === "CONFIG_INVALID");
      assert(f.calls.length === 2);
    }
    await Deno.mkdir(`${root}/.local/backup`, { recursive: true });
    for (
      const text of ["malformed", '{"pid":2147483647}', `{"pid":${Deno.pid}}`]
    ) {
      await Deno.writeTextFile(`${root}/.local/backup/backup.lock`, text);
      const f = fake();
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "full" },
          deps(root, context, f),
        )).failure === "LOCK_HELD",
      );
      assert(
        await Deno.readTextFile(`${root}/.local/backup/backup.lock`) === text,
      );
      assert(f.calls.length === 2);
    }
  });
});
Deno.test("preflight rejects Docker failure unhealthy or ambiguous Mongo and old dump version before Mongo and remote", async () => {
  await fixture(async (root, context) => {
    for (
      const changes of [
        { fail: "docker" },
        { ps: "invalid" },
        { ps: "[]" },
        { ps: JSON.stringify([...healthy, healthy[0]]) },
        { ps: JSON.stringify([{ ...healthy[0], Health: "starting" }]) },
        { mongodump: "mongodump version: 100.16.9" },
        { mongodump: "invalid" },
      ]
    ) {
      const f = fake(changes);
      assert(
        !(await runPreflight(
          { composeRoot: root, remoteMode: "full" },
          deps(root, context, f),
        )).ok,
      );
      assert(
        !f.calls.some((c) => c.includes("mongosh") || c.includes("pk-backup:")),
      );
    }
  });
});
Deno.test("preflight validates Mongo closed record primary oplog window and numeric database size", async () => {
  await fixture(async (root, context) => {
    for (
      const [mongo, code] of [
        [{ ...goodMongo, writablePrimary: false }, "MONGO_NOT_PRIMARY"],
        [
          { ...goodMongo, lastOplogSeconds: 200, oplogWindowSeconds: 100 },
          "OPLOG_WINDOW_SHORT",
        ],
        [{ ...goodMongo, firstOplogSeconds: -1 }, "COMMAND_FAILED"],
        [{ ...goodMongo, oplogWindowSeconds: 1 }, "COMMAND_FAILED"],
        [{ ...goodMongo, databaseBytes: 9007199254740992 }, "COMMAND_FAILED"],
        [{ ...goodMongo, authorization: "unknown" }, "COMMAND_FAILED"],
        [{ ...goodMongo, ping: false }, "COMMAND_FAILED"],
        [{ ...goodMongo, secret: "value" }, "COMMAND_FAILED"],
        [null, "COMMAND_FAILED"],
      ] as const
    ) {
      const f = fake({ mongo: JSON.stringify(mongo) });
      const r = await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, f),
      );
      assert(r.failure === code, `${r.failure} != ${code}`);
      assert(f.scripts.length === 1);
      assert(!f.calls.some((c) => c.includes("pk-backup:")));
    }
    const f = fake({ mongo: "garbage secret" });
    assert(
      (await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, f),
      )).failure === "COMMAND_FAILED",
    );
  });
});
Deno.test("preflight source query uses auth without fallback and refuses incomplete or unconfirmed empty coverage", async () => {
  await fixture(async (root, context) => {
    for (const authorization of ["enabled", "disabled"]) {
      const f = fake({
        mongo: JSON.stringify({ ...goodMongo, authorization }),
      });
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "skip" },
          deps(root, context, f),
        )).localVerified,
      );
      assert(f.scripts.length === 2);
      assert(
        f.scripts[1].includes(".auth(user, password)") ===
          (authorization === "enabled"),
      );
    }
    for (
      const sources of [
        '{"type":"count","count":1}\n',
        '{"type":"count","count":1}\n{"_id":1,"path":"/missing-secret"}\n',
        "",
        "[]",
      ]
    ) {
      const f = fake({ sources });
      const r = await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, f),
      );
      assert(r.failure === "SOURCE_COVERAGE_INCOMPLETE");
      assert(!f.calls.some((c) => c.includes("pk-backup:")));
    }
    const f = fake({ mongoExit: 1 });
    const r = await runPreflight(
      { composeRoot: root, remoteMode: "full" },
      deps(root, context, f),
    );
    assert(r.failure === "COMMAND_FAILED" && f.scripts.length === 1);
  });
});
Deno.test("resolver requires effective runtime mounts and explicit activation of every protected config slot", async () => {
  await fixture((root, context) => {
    assert(
      resolveManifestOptions(context).runtimeRoots.mongo.kind ===
        "named-volume",
    );
    const bound = {
      ...context,
      mongo: [{
        Type: "bind",
        Source: `${root}/mongo`,
        Destination: "/data/db",
      }],
      rag: {
        active: true as const,
        qdrant: [{
          Type: "volume",
          Source: "qdrant",
          Destination: "/qdrant/storage",
        }],
        service: [{
          Type: "bind",
          Source: `${root}/state`,
          Destination: "/data",
        }, { Type: "volume", Source: "models", Destination: "/models" }],
      },
      protectedConfig: {
        ...context.protectedConfig,
        rag: { active: true, path: `${root}/.env` },
      },
    };
    assert(resolveManifestOptions(bound).runtimeRoots.rag.active);
    for (
      const bad of [
        { ...context, mongo: [] },
        {
          ...context,
          mongo: [{ Type: "tmpfs", Source: "", Destination: "/data/db" }],
        },
        { ...context, redis: undefined },
        { ...context, rag: {} },
        { ...context, protectedConfig: {} },
        {
          ...context,
          protectedConfig: {
            ...context.protectedConfig,
            tls: { active: true },
          },
        },
        { ...bound, rag: { active: true, qdrant: [], service: [] } },
      ]
    ) {
      let rejected = false;
      try {
        resolveManifestOptions(bad as DeploymentContext);
      } catch {
        rejected = true;
      }
      assert(rejected, "unsafe context accepted");
    }
  });
});
Deno.test("preflight requires active protected config to be readable and excludes effective runtime bytes", async () => {
  await fixture(async (root, context) => {
    context.protectedConfig.media = { active: true, path: `${root}/missing` };
    const f = fake();
    assert(
      (await runPreflight(
        { composeRoot: root, remoteMode: "full" },
        deps(root, context, f),
      )).failure === "SOURCE_COVERAGE_INCOMPLETE",
    );
    context.protectedConfig.media = { active: false };
    await Deno.mkdir(`${root}/archive/mongo`);
    await Deno.writeTextFile(
      `${root}/archive/mongo/database`,
      "excluded bytes",
    );
    await Deno.writeTextFile(`${root}/archive/original`, "abc");
    context.mongo = [{
      Type: "bind",
      Source: `${root}/archive/mongo`,
      Destination: "/data/db",
    }];
    const report = await runPreflight(
      { composeRoot: root, remoteMode: "skip" },
      deps(root, context, fake()),
    );
    assert(report.localVerified && report.fileBytes === 17);
  });
});

Deno.test("overlapping runtime mounts fail coverage before any source or remote command for Mongo Redis and RAG", async () => {
  await fixture(async (root, base) => {
    for (
      const runtime of [
        "mongo",
        "redis",
        "qdrant",
        "state",
        "modelCache",
      ] as const
    ) {
      for (const type of ["bind", "volume", "tmpfs"]) {
        const context: DeploymentContext = {
          ...base,
          mongo: [...base.mongo],
          redis: [...base.redis],
          rag: {
            active: true,
            qdrant: [{
              Type: "volume",
              Source: "qdrant",
              Destination: "/qdrant/storage",
            }],
            service: [
              { Type: "volume", Source: "state", Destination: "/data" },
              { Type: "volume", Source: "models", Destination: "/models" },
            ],
          },
          protectedConfig: {
            ...base.protectedConfig,
            rag: { active: true, path: `${root}/.env` },
          },
        };
        assert(context.rag.active);
        const target = {
          mongo: "/data/db",
          redis: "/data",
          qdrant: "/qdrant/storage",
          state: "/data",
          modelCache: "/models",
        }[runtime];
        const mounts = runtime === "mongo"
          ? context.mongo
          : runtime === "redis"
          ? context.redis
          : runtime === "qdrant"
          ? context.rag.qdrant
          : context.rag.service;
        // Real source under an otherwise eligible archive root: accepting the
        // parent volume alone would allow runtime bytes into file snapshots.
        const source = `${root}/archive/private-runtime`;
        await Deno.mkdir(source, { recursive: true });
        await Deno.writeTextFile(`${source}/WiredTiger`, "live-runtime-bytes");
        mounts.push({
          Type: type,
          Source: source,
          Destination: `${target}/journal`,
        });
        const f = fake();
        const report = await runPreflight({
          composeRoot: root,
          remoteMode: "full",
        }, deps(root, context, f));
        assert(
          report.failure === "SOURCE_COVERAGE_INCOMPLETE",
          "nested runtime mount accepted",
        );
        assert(!report.ok && !report.localVerified && !report.remoteVerified);
        assert(report.fileBytes === undefined);
        assert(
          !f.calls.some((c) =>
            c[0] === "git" || c.some((a) => a.includes("pk-backup:"))
          ),
          "unsafe topology reached discovery or remote",
        );
        assert(f.scripts.length === 1, "unsafe topology reached source query");
        assert(
          !JSON.stringify(report).includes(root) &&
            !JSON.stringify(report).includes("WiredTiger"),
          "runtime path leaked",
        );
      }
    }
  });
});

Deno.test("runtime resolver refuses overlapping parent mounts but accepts adjacent mount names", async () => {
  await fixture((root, base) => {
    for (const destination of ["/data", "/"]) {
      let rejected = false;
      try {
        resolveManifestOptions({
          ...base,
          mongo: [...base.mongo, {
            Type: "bind",
            Source: root,
            Destination: destination,
          }],
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "overlapping ancestor mount accepted");
    }
    assert(
      resolveManifestOptions({
        ...base,
        mongo: [...base.mongo, {
          Type: "bind",
          Source: root,
          Destination: "/data/db-other",
        }],
      }).runtimeRoots.mongo.kind === "named-volume",
      "adjacent path confused with a nested runtime mount",
    );
  });
});

Deno.test("production discovery inspects bounded mount and Compose labels and pins explicit SSH configuration", async () => {
  await fixture(async (temporaryRoot) => {
    const root = await Deno.realPath(temporaryRoot);
    const config = await loadBackupConfig(root, root);
    const base = `${root}/docker-compose.yml`;
    const mediaUat = `${root}/docker-compose.media-uat.yml`;
    const mediaDisks = `${root}/docker-compose.media-disks.yml`;
    const ragFile = `${root}/docker-compose.rag.yml`;
    const ragEnvFile = `${root}/.env.rag.local`;
    const validRagEnv =
      "RAG_COMPOSE_PROJECT_NAME=mycelia-rag-full\nRAG_IMAGE_TAG=full-test\n";
    const items = [...healthy, {
      ID: "c".repeat(64),
      Service: "backend",
      State: "running",
      Health: "healthy",
    }, {
      ID: "d".repeat(64),
      Service: "nginx",
      State: "running",
      Health: "",
    }, {
      ID: "e".repeat(64),
      Service: "frontend",
      State: "running",
      Health: "healthy",
    }, {
      ID: "f".repeat(64),
      Service: "python-worker",
      State: "running",
      Health: "",
    }];
    await Deno.writeTextFile(
      base,
      "services:\n  backend:\n    env_file:\n      - .env\n",
    );
    await Deno.writeTextFile(mediaUat, "services:\n  backend: {}\n");
    await Deno.writeTextFile(mediaDisks, "services:\n  backend: {}\n");
    await Deno.writeTextFile(ragFile, "services:\n  rag: {}\n  qdrant: {}\n");
    await Deno.writeTextFile(ragEnvFile, validRagEnv, { mode: 0o600 });
    const rcloneConfig = await writeDefaultRcloneConfig(
      root,
      `[pk-backup]\ntype = sftp\nssh = /usr/bin/ssh -F ${root}/.ssh/config -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${root}/known_hosts -o ConnectTimeout=12 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 pk_backup\nknown_hosts_file = ${root}/known_hosts\nshell_type = unix\nmd5sum_command = md5sum\nsha1sum_command = sha1sum\n`,
    );
    await Deno.mkdir(`${root}/.ssh`);
    await Deno.writeTextFile(`${root}/.ssh/config`, sshConfigText(), {
      mode: 0o600,
    });
    await Deno.writeTextFile(`${root}/.ssh/id_rsa`, "fixture", {
      mode: 0o600,
    });
    await Deno.writeTextFile(`${root}/known_hosts`, "fixture", {
      mode: 0o600,
    });
    await Deno.writeTextFile(
      `${root}/mongo.conf`,
      "storage:\n  dbPath: /data/db\nreplication:\n  replSetName: rs0\n",
    );
    await Deno.mkdir(`${root}/templates`);
    await Deno.writeTextFile(
      `${root}/templates/site.conf.template`,
      "ssl_certificate /etc/nginx/ssl/fullchain.pem;\nssl_certificate_key /etc/nginx/ssl/privkey.pem;\n",
    );
    const observed: Record<string, unknown> = {
      [items[0].ID]: {
        mounts: [{ Type: "volume", Source: "mongo", Destination: "/data/db" }, {
          Type: "bind",
          Source: `${root}/mongo.conf`,
          Destination: "/etc/mongod.conf",
        }],
        files: base,
        workingDir: root,
        envFile: "",
        command: ["mongod", "--config", "/etc/mongod.conf"],
      },
      [items[1].ID]: {
        mounts: [{ Type: "volume", Source: "redis", Destination: "/data" }],
        files: base,
        workingDir: root,
        envFile: "",
        command: null,
      },
      [items[2].ID]: {
        mounts: [],
        files: `${base},${mediaUat},${mediaDisks}`,
        workingDir: root,
        envFile: "",
        command: null,
      },
      [items[3].ID]: {
        mounts: [{
          Type: "bind",
          Source: `${root}/templates`,
          Destination: "/etc/nginx/templates",
        }, {
          Type: "bind",
          Source: `${root}/ssl`,
          Destination: "/etc/nginx/ssl",
        }],
        files: base,
        workingDir: root,
        envFile: "",
        command: null,
      },
      [items[4].ID]: {
        mounts: [],
        files: `${base},${mediaUat}`,
        workingDir: root,
        envFile: "",
        command: null,
      },
      [items[5].ID]: {
        mounts: [{
          Type: "volume",
          Source: "worker",
          Destination: "/root/.cache",
        }],
        files: `${base},${mediaUat},${mediaDisks}`,
        workingDir: root,
        envFile: "",
        command: null,
      },
    };
    const tracked = new Set([
      "docker-compose.yml",
      "docker-compose.media-uat.yml",
      "docker-compose.media-disks.yml",
      "docker-compose.rag.yml",
    ]);
    let projects: Array<{
      Name: string;
      ConfigFiles: string;
      Status: string;
    }> = [];
    let ragItems: Array<{
      ID: string;
      Service: string;
      State: string;
      Health: string;
    }> = [];
    const runner: Runner = {
      run(argv, opts) {
        assert(opts.maxOutputBytes > 0 && opts.timeoutMs > 0);
        let out: string;
        let code = 0;
        if (argv[0] === "docker" && argv[1] === "inspect") {
          out = JSON.stringify(observed[argv.at(-1)!]);
        } else if (argv[0] === "docker" && argv.includes("ls")) {
          out = JSON.stringify(projects);
        } else if (
          argv[0] === "docker" && argv.includes("ps") &&
          argv.includes(ragFile)
        ) {
          assert(
            JSON.stringify(argv) === JSON.stringify([
              "docker",
              "compose",
              "--project-directory",
              root,
              "--project-name",
              "mycelia-rag-full",
              "--env-file",
              ragEnvFile,
              "-f",
              ragFile,
              "ps",
              "--all",
              "--format",
              "json",
            ]),
            "RAG ps did not pin its exact project and env file",
          );
          assert(opts.clearEnv === true, "RAG ps inherited ambient env");
          assert(
            JSON.stringify(opts.env) === JSON.stringify({
              HOME: root,
              PATH:
                `${root}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
            }),
            "RAG ps did not receive the exact closed env",
          );
          out = JSON.stringify(ragItems);
        } else if (argv[0] === "git") {
          if (
            JSON.stringify(argv) === JSON.stringify([
              "git",
              "-C",
              root,
              "ls-files",
              "-z",
            ])
          ) {
            out = [...tracked].join("\0") + "\0";
            return Promise.resolve({
              stdout: enc.encode(out),
              stderr: new Uint8Array(),
              code,
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
            });
          }
          assert(
            JSON.stringify(argv.slice(0, -1)) === JSON.stringify([
              "git",
              "-C",
              root,
              "ls-files",
              "--error-unmatch",
              "-z",
              "--",
            ]),
            "unexpected Git provenance query",
          );
          const requested = argv.at(-1)!;
          code = tracked.has(requested) ? 0 : 1;
          out = code === 0 ? `${requested}\0` : "";
        } else if (argv.join(" ") === "rclone config file") {
          assert(opts.clearEnv === true, "rclone config inherited ambient env");
          assert(
            JSON.stringify(opts.env) === JSON.stringify({
              HOME: root,
              PATH:
                `${root}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
            }),
            "rclone config discovery did not receive the exact closed env",
          );
          out = `Configuration file is stored at:\n${rcloneConfig}\n`;
        } else throw new Error("unexpected mutating command");
        return Promise.resolve({
          stdout: enc.encode(out),
          stderr: new Uint8Array(),
          code,
          timedOut: false,
          terminationConfirmed: true,
          forcedKill: false,
        });
      },
      spawn() {
        throw new Error("unexpected spawn");
      },
    };
    const context = await discoverDeployment(config, items, runner);
    assert(resolveManifestOptions(context).runtimeRoots.rag.active === false);
    assert(
      context.protectedConfig.rclone?.knownHosts === `${root}/known_hosts`,
    );
    assert(
      context.protectedConfig.tls?.certificate === `${root}/ssl/fullchain.pem`,
    );
    const setFiles = (id: string, files: string) => {
      (observed[id] as { files: string }).files = files;
    };
    const backendId = items[2].ID;
    const currentBackendFiles = `${base},${mediaUat},${mediaDisks}`;
    for (
      const files of [
        `${base},${mediaUat},${mediaUat}`,
        `${base},${mediaDisks},${mediaUat}`,
        `${base},${mediaDisks}`,
        `${base},${root}/docker-compose.media-dev.yml`,
        `${base},${root}/../outside.yml`,
        `${base},${ragFile}`,
        `${base},`,
        `${base}\n`,
        `${base},${"x".repeat(4096)}`,
      ]
    ) {
      setFiles(backendId, files);
      await rejectsCoverage(() => discoverDeployment(config, items, runner));
    }
    setFiles(backendId, currentBackendFiles);

    tracked.delete("docker-compose.media-uat.yml");
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    tracked.add("docker-compose.media-uat.yml");

    await Deno.rename(mediaUat, `${mediaUat}.tracked`);
    await Deno.symlink(`${mediaUat}.tracked`, mediaUat);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.remove(mediaUat);
    await Deno.rename(`${mediaUat}.tracked`, mediaUat);

    await Deno.writeTextFile(mediaDisks, "x".repeat(1024 * 1024 + 1));
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.writeTextFile(mediaDisks, "services:\n  backend: {}\n");

    const ragService = {
      ID: "1".repeat(64),
      Service: "rag",
      State: "running",
      Health: "healthy",
    };
    const qdrant = {
      ID: "2".repeat(64),
      Service: "qdrant",
      State: "running",
      Health: "",
    };
    ragItems = [ragService, qdrant];
    observed[ragService.ID] = {
      mounts: [{ Type: "volume", Source: "rag-state", Destination: "/data" }, {
        Type: "volume",
        Source: "rag-models",
        Destination: "/models",
      }],
      files: ragFile,
      workingDir: root,
      envFile: ragEnvFile,
      command: null,
    };
    observed[qdrant.ID] = {
      mounts: [{
        Type: "volume",
        Source: "qdrant",
        Destination: "/qdrant/storage",
      }],
      files: ragFile,
      workingDir: root,
      // A targeted RAG-only recreate must not require restarting the durable
      // Qdrant service solely to add this informational Compose label.
      envFile: null,
      command: null,
    };
    projects = [{
      Name: "mycelia-rag-full",
      ConfigFiles: ragFile,
      Status: "running(2)",
    }];
    const previousComposeProject = Deno.env.get("COMPOSE_PROJECT_NAME");
    Deno.env.set("COMPOSE_PROJECT_NAME", "ambient-wrong-project");
    let activeContext: DeploymentContext;
    try {
      activeContext = await discoverDeployment(config, items, runner);
    } finally {
      if (previousComposeProject === undefined) {
        Deno.env.delete("COMPOSE_PROJECT_NAME");
      } else {
        Deno.env.set("COMPOSE_PROJECT_NAME", previousComposeProject);
      }
    }
    assert(activeContext.rag.active);
    assert(
      activeContext.protectedConfig.rag?.active &&
        activeContext.protectedConfig.rag.path === ragEnvFile,
      "RAG protected config did not preserve the exact dedicated env file",
    );
    await Deno.mkdir(`${root}/ssl`);
    await Deno.writeTextFile(`${root}/ssl/fullchain.pem`, "fixture cert\n");
    await Deno.writeTextFile(`${root}/ssl/privkey.pem`, "fixture key\n");
    await Deno.mkdir(`${root}/claude-cowork/icloud-archive-tool`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/claude-cowork/icloud-archive-tool/config.env`,
      "ARCHIVE_FIXTURE=1\n",
    );
    const manifest = await buildSourceManifest(
      config,
      "rag-env-source-proof",
      resolveManifestOptions({
        ...activeContext,
        archiveRoot: `${root}/archive`,
        picturesImportRoot: `${root}/absent`,
      }),
      runner,
    );
    assert(manifest.coverage.complete, "active RAG source manifest incomplete");
    assert(
      manifest.files.includes(ragEnvFile),
      "active RAG env file omitted from source manifest",
    );

    projects[0].Name = "mycelia-rag";
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    projects[0].Name = "Bad.Project";
    await Deno.writeTextFile(
      ragEnvFile,
      validRagEnv.replace("mycelia-rag-full", "Bad.Project"),
    );
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    projects[0].Name = "mycelia-rag-full";
    await Deno.writeTextFile(ragEnvFile, validRagEnv);

    const setEnvFile = (id: string, envFile: string | null) => {
      (observed[id] as { envFile: string | null }).envFile = envFile;
    };
    for (const serviceEnv of ["", `${root}/.env`, `${root}/outside.env`]) {
      setEnvFile(ragService.ID, serviceEnv);
      await rejectsCoverage(() => discoverDeployment(config, items, runner));
    }
    setEnvFile(ragService.ID, ragEnvFile);

    for (
      const qdrantEnv of [
        `${root}/.env`,
        `${ragEnvFile},${root}/.env`,
        `${root}/outside.env`,
      ]
    ) {
      setEnvFile(qdrant.ID, qdrantEnv);
      await rejectsCoverage(() => discoverDeployment(config, items, runner));
    }
    for (const absentLabel of [null, ""] as const) {
      setEnvFile(qdrant.ID, absentLabel);
      assert(
        (await discoverDeployment(config, items, runner)).rag.active,
        "missing Qdrant environment_file label should remain valid",
      );
    }
    setEnvFile(qdrant.ID, ragEnvFile);
    assert(
      (await discoverDeployment(config, items, runner)).rag.active,
      "exact Qdrant environment_file label should remain valid",
    );

    await Deno.remove(ragEnvFile);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.writeTextFile(ragEnvFile, validRagEnv, { mode: 0o600 });

    await Deno.chmod(ragEnvFile, 0o644);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.chmod(ragEnvFile, 0o600);

    await Deno.rename(ragEnvFile, `${ragEnvFile}.real`);
    await Deno.symlink(`${ragEnvFile}.real`, ragEnvFile);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.remove(ragEnvFile);
    await Deno.rename(`${ragEnvFile}.real`, ragEnvFile);

    for (
      const invalidEnv of [
        "RAG_IMAGE_TAG=full-test\n",
        `${validRagEnv}RAG_COMPOSE_PROJECT_NAME=mycelia-rag-full\n`,
        `${validRagEnv}RAG_IMAGE_TAG=full-test\n`,
        `${validRagEnv}RAG_IMAGE_TAG=other\n`,
        `${validRagEnv}not an assignment\n`,
      ]
    ) {
      await Deno.writeTextFile(ragEnvFile, invalidEnv);
      await rejectsCoverage(() => discoverDeployment(config, items, runner));
    }
    await Deno.writeTextFile(ragEnvFile, "x".repeat(1024 * 1024 + 1));
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    await Deno.writeTextFile(ragEnvFile, validRagEnv);

    setFiles(ragService.ID, `${base},${ragFile}`);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    setFiles(ragService.ID, ragFile);
    setFiles(qdrant.ID, `${base},${ragFile}`);
    await rejectsCoverage(() => discoverDeployment(config, items, runner));
    setFiles(qdrant.ID, ragFile);
    projects = [];
    const previousArchive = Deno.env.get("MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT");
    Deno.env.set("MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT", `${root}/archive`);
    const stagedAudio =
      `${root}/Library/mycelia/voice-memos-staging/audio-original`;
    const archiveAudio = `${root}/archive/data/voice-memos/audio-original`;
    await Deno.mkdir(stagedAudio, { recursive: true });
    await Deno.mkdir(archiveAudio, { recursive: true });
    await Deno.writeTextFile(
      `${root}/Library/mycelia/voice-memos-staging/sync-status.json`,
      JSON.stringify({
        schema: 1,
        published_audio_root: await Deno.realPath(stagedAudio),
        archive_audio_root: await Deno.realPath(archiveAudio),
        published_at_utc: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    try {
      const withReceipt = await discoverDeployment(config, items, runner);
      assert(
        withReceipt.voiceMemos?.publishedAudioRoot === stagedAudio,
        "default staging receipt was ignored",
      );
    } finally {
      if (previousArchive === undefined) {
        Deno.env.delete("MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT");
      } else Deno.env.set("MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT", previousArchive);
    }
    const previousOverride = Deno.env.get("RCLONE_SFTP_SSH");
    Deno.env.set("RCLONE_SFTP_SSH", "test-unreviewed-override");
    try {
      let overrideRejected = false;
      try {
        await discoverDeployment(config, items, runner);
      } catch {
        overrideRejected = true;
      }
      assert(
        overrideRejected,
        "effective SSH override bypassed pin validation",
      );
    } finally {
      if (previousOverride === undefined) Deno.env.delete("RCLONE_SFTP_SSH");
      else Deno.env.set("RCLONE_SFTP_SSH", previousOverride);
    }
    await Deno.writeTextFile(
      rcloneConfig,
      `[pk-backup]\ntype = sftp\nssh = /usr/bin/ssh -F ${root}/.ssh/config -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 pk_backup\nknown_hosts_file = ${root}/known_hosts\nshell_type = unix\nmd5sum_command = md5sum\nsha1sum_command = sha1sum\n`,
    );
    let rejected = false;
    try {
      await discoverDeployment(config, items, runner);
    } catch {
      rejected = true;
    }
    assert(rejected, "ambiguous host pin accepted");
  });
});

Deno.test("fixed Mongo probe authenticates only via container env and never retries failed auth anonymously", () => {
  for (
    const mode of ["enabled", "disabled", "disabled-with-credentials", "failed"]
  ) {
    let auth = 0;
    const commands: string[] = [];
    let printed = "";
    const admin = {
      auth(user: string, password: string) {
        auth++;
        assert(user === "private-user" && password === "private-password");
        return mode === "failed" ? 0 : 1;
      },
      runCommand(command: Record<string, unknown>) {
        commands.push(Object.keys(command)[0]);
        if (command.getCmdLineOpts) {
          if ((mode === "enabled" || mode === "failed") && auth === 0) {
            return { ok: 0, code: 13 };
          }
          return {
            ok: 1,
            parsed: {
              security: {
                authorization: mode.startsWith("disabled")
                  ? "disabled"
                  : "enabled",
              },
            },
          };
        }
        return { ok: 1, isWritablePrimary: true, setName: "rs0" };
      },
    };
    let reads = 0;
    const db = {
      getSiblingDB(name: string) {
        return name === "admin" ? admin : {
          getCollection() {
            return {
              find() {
                return {
                  sort() {
                    return {
                      limit() {
                        return {
                          next() {
                            return {
                              ts: {
                                getHighBitsUnsigned() {
                                  return reads++ === 0 ? 100 : 7300;
                                },
                              },
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      runCommand() {
        return { ok: 1, totalSize: 200 };
      },
    };
    const execute = new Function(
      "db",
      "process",
      "print",
      "quit",
      MONGO_PREFLIGHT_SCRIPT,
    );
    try {
      execute(
        db,
        {
          env: mode === "disabled" ? {} : {
            MONGO_INITDB_ROOT_USERNAME: "private-user",
            MONGO_INITDB_ROOT_PASSWORD: "private-password",
          },
        },
        (s: string) => printed = s,
        () => {
          throw new Error("quit");
        },
      );
    } catch { /* fixed script fails closed */ }
    assert(auth === (mode.startsWith("disabled") ? 0 : 1));
    if (mode === "failed") {
      assert(!printed && commands.join(",") === "getCmdLineOpts");
    } else {
      assert(
        JSON.parse(printed).authorization ===
          (mode.startsWith("disabled") ? "disabled" : "enabled"),
      );
      assert(!printed.includes("private"));
    }
  }
});

Deno.test("configured database name reaches both Mongo queries and invalid names fail before Docker", async () => {
  await fixture(async (root, context) => {
    await Deno.writeTextFile(
      `${root}/.env`,
      "DATABASE_NAME=canonical_private\n",
    );
    const f = fake();
    const report = await runPreflight(
      { composeRoot: root, remoteMode: "skip" },
      deps(root, context, f),
    );
    assert(report.localVerified);
    assert(f.calls.filter((c) => c.includes("mongosh")).length === 2);
    assert(
      f.calls.filter((c) => c.includes("mongosh")).every((c) =>
        c.includes("canonical_private")
      ),
      "database name ignored",
    );
    assert(!JSON.stringify(report).includes("canonical_private"));
    for (const value of ["mongodb://secret", "bad name", "", "--eval"]) {
      await Deno.writeTextFile(`${root}/.env`, `DATABASE_NAME=${value}\n`);
      const bad = fake();
      assert(
        (await runPreflight(
          { composeRoot: root, remoteMode: "skip" },
          deps(root, context, bad),
        )).failure === "CONFIG_INVALID",
      );
      assert(!bad.calls.some((c) => c[0] === "docker"));
    }
  });
});
