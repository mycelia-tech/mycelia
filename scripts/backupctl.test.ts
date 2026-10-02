import { main, parseCli, type ParsedCli } from "./backupctl.ts";

Deno.test("default status reports not_started without creating state or contacting storage", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const original = console.log;
  const output: string[] = [];
  console.log = (value) => output.push(String(value));
  try {
    const code = await main(["status", "--compose-root", root]);
    assert(code === 0 && output.length === 1, "status unavailable");
    const state = JSON.parse(output[0]);
    assert(
      state.bootstrap === "not_started" && state.files === null &&
        state.mongo === null && state.quarantine === null,
      "missing state misreported",
    );
    assert([...Deno.readDirSync(root)].length === 0, "status mutated disk");
  } finally {
    console.log = original;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("default files dispatch refuses an uninitialized repository with a closed failure", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const original = console.log;
  const output: string[] = [];
  console.log = (value) => output.push(String(value));
  try {
    const code = await main(["files", "--compose-root", root]);
    assert(
      code === 1 && output.length === 1,
      "real files controller not dispatched",
    );
    const state = JSON.parse(output[0]);
    assert(
      state.state === "failed" &&
        state.failure.code === "RESTIC_VERIFY_FAILED" && !state.accepted,
      "uninitialized backup claimed success",
    );
    assert(!output[0].includes(root), "path leaked in CLI output");
  } finally {
    console.log = original;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preflight accepts explicit skip/full and default full JSON syntax", () => {
  for (
    const flags of [["--json"], ["--remote-mode", "full", "--json"], [
      "--remote-mode",
      "skip",
      "--json",
    ]]
  ) {
    const parsed = parseCli([
      "preflight",
      "--compose-root",
      "/tmp/private-root",
      ...flags,
    ]);
    assert(parsed.command === "preflight", "preflight form rejected");
  }
});

Deno.test("preflight dispatch carries typed remote/json options and redacts handler failures", async () => {
  let received: ParsedCli | undefined;
  const handlers = Object.fromEntries(
    commands.map((command) => [command, (options: ParsedCli) => {
      received = options;
      return Promise.reject(new Error("secret-path-and-credentials"));
    }]),
  ) as Record<
    (typeof commands)[number],
    (options: ParsedCli) => Promise<number>
  >;
  const errors: string[] = [];
  assert(
    await main(
      [
        "preflight",
        "--compose-root",
        "/private-secret",
        "--remote-mode",
        "skip",
        "--json",
      ],
      handlers,
      (s) => errors.push(s),
    ) === 70,
    "handler failure exit",
  );
  assert(received?.composeRoot === "/private-secret", "root not dispatched");
  assert(
    received?.remoteMode === "skip" && received.json === true,
    "typed options lost",
  );
  assert(!errors.join("").includes("secret"), "handler error leaked");
});

Deno.test("preflight rejects duplicate, missing, unknown and misplaced flags without reflecting values", async () => {
  for (
    const tail of [
      ["--remote-mode"],
      ["--remote-mode", "secret"],
      ["--remote-mode", "skip", "--json", "--json"],
      ["--remote-mode", "skip", "--remote-mode", "full", "--json"],
      ["--json", "--unknown", "secret"],
      ["--json", "--compose-root", "/secret"],
    ]
  ) {
    const errors: string[] = [];
    assert(
      await main(
        ["preflight", "--compose-root", "/secret", ...tail],
        undefined,
        (s) => errors.push(s),
      ) === 64,
      "invalid preflight accepted",
    );
    assert(!errors.join("").includes("secret"), "input leaked");
  }
  for (
    const command of [
      "files",
      "status",
      "bootstrap",
      "verify",
      "mongo-bootstrap",
    ]
  ) {
    assert(
      await main(
        [
          command,
          "--compose-root",
          "/secret",
          "--remote-mode",
          "skip",
          "--json",
        ],
        undefined,
        () => {},
      ) === 64,
      "preflight flags escaped command",
    );
  }
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const commands = [
  "preflight",
  "bootstrap",
  "files",
  "mongo-bootstrap",
  "status",
  "verify",
] as const;
const simpleCommands = commands.filter((command) => command !== "bootstrap");

Deno.test("parseCli accepts the non-bootstrap commands with an absolute compose root", () => {
  for (const command of simpleCommands) {
    const parsed = parseCli([
      command,
      "--compose-root",
      "/tmp/mycelia compose",
    ]);
    assert(parsed.command === command, `wrong command for ${command}`);
    assert(parsed.composeRoot === "/tmp/mycelia compose", "root was altered");
  }
  for (const command of ["", "backup", "restore", "FILES"]) {
    let rejected = false;
    try {
      parseCli([command, "--compose-root", "/tmp/mycelia"]);
    } catch {
      rejected = true;
    }
    assert(rejected, `accepted unsupported command ${command}`);
  }
});

Deno.test("bootstrap accepts exactly four mutually exclusive modes", () => {
  const cases = [
    [["--check"], "check", undefined],
    [["--initialize-keychain"], "initialize-keychain", undefined],
    [
      ["--attest-recovery", "--receipt-id", "receipt-1234"],
      "attest-recovery",
      "receipt-1234",
    ],
    [["--initialize-repository"], "initialize-repository", undefined],
  ] as const;
  for (const [tail, mode, receiptId] of cases) {
    const parsed = parseCli([
      "bootstrap",
      "--compose-root",
      "/tmp/mycelia",
      ...tail,
    ]);
    assert(parsed.command === "bootstrap", "wrong bootstrap command");
    assert(parsed.bootstrapMode === mode, `wrong bootstrap mode for ${mode}`);
    assert(parsed.receiptId === receiptId, `wrong receipt for ${mode}`);
  }
});

Deno.test("bootstrap rejects bare mixed repeated and malformed forms without reflecting input", async () => {
  const invalid = [
    [],
    ["--check", "--initialize-keychain"],
    ["--check", "--check"],
    ["--attest-recovery"],
    ["--attest-recovery", "--receipt-id"],
    ["--attest-recovery", "--receipt-id", "short"],
    ["--attest-recovery", "--receipt-id", "secret value"],
    ["--receipt-id", "receipt-1234", "--attest-recovery"],
    ["--initialize-repository", "--unknown", "secret"],
  ];
  for (const tail of invalid) {
    const errors: string[] = [];
    const code = await main(
      ["bootstrap", "--compose-root", "/private/secret", ...tail],
      undefined,
      (message) => errors.push(message),
    );
    assert(code === 64, `invalid bootstrap form accepted: ${tail.length}`);
    assert(!errors.join(" ").includes("secret"), "bootstrap input leaked");
  }
});

Deno.test("bootstrap permits stale-lock recovery only as a trailing suffix", () => {
  const parsed = parseCli([
    "bootstrap",
    "--compose-root",
    "/tmp/mycelia",
    "--attest-recovery",
    "--receipt-id",
    "receipt-1234",
    "--clear-stale-lock",
    "123",
  ]);
  assert(parsed.bootstrapMode === "attest-recovery", "bootstrap mode lost");
  assert(parsed.receiptId === "receipt-1234", "receipt lost");
  assert(parsed.clearStaleLockPid === 123, "stale pid lost");
  for (
    const argv of [
      [
        "bootstrap",
        "--compose-root",
        "/tmp/mycelia",
        "--clear-stale-lock",
        "123",
        "--check",
      ],
      [
        "bootstrap",
        "--compose-root",
        "/tmp/mycelia",
        "--check",
        "--clear-stale-lock",
        "123",
        "extra",
      ],
    ]
  ) {
    let rejected = false;
    try {
      parseCli(argv);
    } catch {
      rejected = true;
    }
    assert(rejected, "misplaced stale-lock suffix accepted");
  }
});

Deno.test("parseCli requires an absolute compose root and rejects unknown options", () => {
  for (
    const args of [
      ["status"],
      ["status", "--compose-root", "relative/path"],
      ["status", "--compose-root", ""],
      ["status", "--compose-root", "/tmp/mycelia", "--unknown", "secret-value"],
      ["status", "--compose-root", "/tmp/mycelia", "extra"],
    ]
  ) {
    let rejected = false;
    try {
      parseCli(args);
    } catch {
      rejected = true;
    }
    assert(rejected, `accepted invalid argv shape ${args.length}`);
  }
});

Deno.test("main returns usage code 64 without echoing option values", async () => {
  const errors: string[] = [];
  const handlers = Object.fromEntries(
    commands.map((command) => [command, () => Promise.resolve(0)]),
  ) as Record<(typeof commands)[number], () => Promise<number>>;
  const code = await main(
    ["status", "--compose-root", "relative-secret-path"],
    handlers,
    (message: string) => errors.push(message),
  );
  assert(code === 64, "wrong usage exit code");
  assert(errors.length > 0, "no usage error reported");
  assert(
    !errors.join(" ").includes("relative-secret-path"),
    "option value leaked",
  );
});

Deno.test("main dispatches every valid command to exactly its injected handler", async () => {
  for (const command of simpleCommands) {
    const called: string[] = [];
    const handlers = Object.fromEntries(commands.map((name) => [
      name,
      (options: ParsedCli) => {
        called.push(`${name}:${options.composeRoot}`);
        return Promise.resolve(23);
      },
    ])) as Record<
      (typeof commands)[number],
      (options: ParsedCli) => Promise<number>
    >;
    const code = await main(
      [command, "--compose-root", "/tmp/mycelia"],
      handlers,
      () => {
        throw new Error("unexpected error");
      },
    );
    assert(code === 23, "handler result was not returned");
    assert(
      JSON.stringify(called) === JSON.stringify([`${command}:/tmp/mycelia`]),
      "wrong or repeated dispatch",
    );
  }
  const called: ParsedCli[] = [];
  const handlers = Object.fromEntries(commands.map((name) => [
    name,
    (options: ParsedCli) => {
      called.push(options);
      return Promise.resolve(23);
    },
  ])) as Record<
    (typeof commands)[number],
    (options: ParsedCli) => Promise<number>
  >;
  assert(
    await main(
      ["bootstrap", "--compose-root", "/tmp/mycelia", "--check"],
      handlers,
      () => {
        throw new Error("unexpected error");
      },
    ) === 23,
    "bootstrap handler result was not returned",
  );
  assert(
    called.length === 1 && called[0].bootstrapMode === "check",
    "bootstrap mode was not dispatched",
  );
});

Deno.test("clear-stale-lock requires a strict positive pid and never echoes bad input", async () => {
  const parsed = parseCli([
    "files",
    "--compose-root",
    "/tmp/mycelia",
    "--clear-stale-lock",
    "123",
  ]);
  assert(parsed.clearStaleLockPid === 123, "missing explicit pid");
  for (
    const pid of ["0", "-1", "1.5", "1x", "secret", "999999999999999999999"]
  ) {
    const errors: string[] = [];
    assert(
      await main(
        ["files", "--compose-root", "/tmp/mycelia", "--clear-stale-lock", pid],
        undefined,
        (message) => errors.push(message),
      ) === 64,
      "bad pid accepted",
    );
    assert(!errors.join(" ").includes(pid), "raw pid echoed");
  }
});

Deno.test({
  name:
    "explicit stale-lock CLI action clears exact dead pid before handler and refuses live or mismatched locks",
  fn: async () => {
    const root = await Deno.realPath(await Deno.makeTempDir());
    const lockPath = `${root}/.local/backup/backup.lock`;
    try {
      await Deno.mkdir(`${root}/.local`, { mode: 0o700 });
      await Deno.mkdir(`${root}/.local/backup`, { mode: 0o700 });
      let calls = 0;
      const handlers = Object.fromEntries(
        commands.map((command) => [command, async () => {
          calls++;
          try {
            await Deno.stat(lockPath);
            throw new Error("lock still exists");
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          return 0;
        }]),
      ) as Record<(typeof commands)[number], () => Promise<number>>;
      const lock = {
        pid: 2147483647,
        processStartedAtUtc: "2026-09-30T12:00:00.000Z",
        command: "preflight",
        backupId: "20260930T120000Z",
      };
      await Deno.writeTextFile(lockPath, JSON.stringify(lock), { mode: 0o600 });
      assert(
        await main(
          ["files", "--compose-root", root, "--clear-stale-lock", "123"],
          handlers,
          () => {},
        ) === 70,
        "mismatched pid cleared",
      );
      assert(calls === 0, "handler ran before failed recovery");
      assert(
        await main(
          ["files", "--compose-root", root, "--clear-stale-lock", "2147483647"],
          handlers,
          () => {},
        ) === 0,
        "dead lock recovery failed",
      );
      assert(Number(calls) === 1, "handler not invoked after recovery");
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({ ...lock, pid: Deno.pid }),
        { mode: 0o600 },
      );
      assert(
        await main(
          [
            "files",
            "--compose-root",
            root,
            "--clear-stale-lock",
            String(Deno.pid),
          ],
          handlers,
          () => {},
        ) === 70,
        "live lock cleared",
      );
      assert(Number(calls) === 1, "handler ran for live lock");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("generic CLI stale recovery cannot clear a repository quarantine", async () => {
  const root = await Deno.makeTempDir();
  const stateDir = `${root}/.local/backup`;
  const lockPath = `${stateDir}/backup.lock`;
  const quarantinePath = `${stateDir}/repository-quarantine-v1.json`;
  try {
    await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await Deno.chmod(`${root}/.local`, 0o700);
    await Deno.chmod(stateDir, 0o700);
    const lock = JSON.stringify({
      pid: 2147483647,
      processStartedAtUtc: "2026-09-30T12:00:00.000Z",
      command: "preflight",
      backupId: "20260930T120000Z",
    });
    const quarantine = JSON.stringify({
      schema: 1,
      kind: "repository-quarantine",
      quarantineId: "11111111-1111-4111-8111-111111111111",
      repository: { kind: "not_yet_verified" },
      triggeringCommand: "files",
      backupId: "20260930T120000Z",
      reason: "child_status_unconfirmed",
      childTerminationConfirmed: false,
      timedOut: true,
      createdAtUtc: "2026-09-30T12:00:00.000Z",
    });
    await Deno.writeTextFile(lockPath, lock, { mode: 0o600 });
    await Deno.writeTextFile(quarantinePath, quarantine, { mode: 0o600 });
    let calls = 0;
    const handlers = Object.fromEntries(
      commands.map((command) => [command, () => {
        calls++;
        return Promise.resolve(0);
      }]),
    ) as Record<(typeof commands)[number], () => Promise<number>>;
    assert(
      await main(
        ["files", "--compose-root", root, "--clear-stale-lock", "2147483647"],
        handlers,
        () => {},
      ) === 70,
      "quarantined stale lock was cleared",
    );
    assert(calls === 0, "handler ran under quarantine");
    assert(await Deno.readTextFile(lockPath) === lock, "lock bytes changed");
    assert(
      await Deno.readTextFile(quarantinePath) === quarantine,
      "quarantine bytes changed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bootstrap CLI checks quarantine before creating protected directories", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const localDir = `${root}/.local`;
  const stateDir = `${localDir}/backup`;
  const quarantinePath = `${stateDir}/repository-quarantine-v1.json`;
  try {
    await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await Deno.chmod(localDir, 0o700);
    await Deno.chmod(stateDir, 0o700);
    const quarantine = JSON.stringify({
      schema: 1,
      kind: "repository-quarantine",
      quarantineId: "11111111-1111-4111-8111-111111111111",
      repository: { kind: "not_yet_verified" },
      triggeringCommand: "bootstrap",
      backupId: "20260930T120000Z",
      reason: "producer_audit_unverified",
      childTerminationConfirmed: true,
      timedOut: false,
      createdAtUtc: "2026-09-30T12:00:00.000Z",
    });
    await Deno.writeTextFile(quarantinePath, quarantine, { mode: 0o600 });

    assert(
      await main(
        ["bootstrap", "--compose-root", root, "--initialize-keychain"],
        undefined,
        () => {},
      ) === 70,
      "quarantined bootstrap did not fail closed",
    );
    let binCreated = true;
    try {
      await Deno.lstat(`${stateDir}/bin`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) binCreated = false;
      else throw error;
    }
    assert(!binCreated, "bootstrap mutated directories before quarantine gate");
    assert(
      await Deno.readTextFile(quarantinePath) === quarantine,
      "bootstrap changed the quarantine before refusing",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
