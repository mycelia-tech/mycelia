import {
  assertProtectedExecutableIdentity,
  type BootstrapRecord,
  bootstrapStatePaths,
  ensureBootstrapDirectories,
  readBootstrapState,
  validateBootstrapDirectories,
  validateProtectedExecutable,
  writeBootstrapStateAtomic,
} from "./bootstrap-state.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

async function rejectsState(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error && error.message === "STATE_INVALID");
    return;
  }
  throw new Error("expected STATE_INVALID");
}

async function canonicalTempDir(): Promise<string> {
  return await Deno.realPath(await Deno.makeTempDir());
}

async function effectiveUidForTest(): Promise<number> {
  const output = await new Deno.Command("/usr/bin/id", {
    args: ["-u"],
    clearEnv: true,
    env: {},
    stdout: "piped",
    stderr: "piped",
  }).output();
  return Number(new TextDecoder().decode(output.stdout).trim());
}

function records(root: string) {
  const pending: BootstrapRecord = {
    schema: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    credentialGenerationId: "22222222-2222-4222-8222-222222222222",
    account: "mycelia",
    service: "tech.mycelia.backup.restic",
    label: "tech.mycelia.backup.restic",
    keychainPath: `${root}/login.keychain-db`,
    helperSourceSha256: "a".repeat(64),
    helperExecutableSha256: "b".repeat(64),
    bootstrapStartedAtUtc: "2026-09-30T12:00:00.000Z",
    phaseUpdatedAtUtc: "2026-09-30T12:00:00.000Z",
    phase: "creation_pending",
  };
  const created: BootstrapRecord = {
    ...pending,
    phase: "created_unconfirmed",
    phaseUpdatedAtUtc: "2026-09-30T12:01:00.000Z",
    credentialCreatedAtUtc: "2026-09-30T12:01:00.000Z",
    itemPersistentRefSha256: "c".repeat(64),
  };
  const attested: BootstrapRecord = {
    ...created,
    phase: "recovery_attested",
    phaseUpdatedAtUtc: "2026-09-30T12:02:00.000Z",
    recoveryReceiptId: "receipt:20260930",
    recoveryAttestedAtUtc: "2026-09-30T12:02:00.000Z",
  };
  const intended: BootstrapRecord = {
    ...attested,
    phaseUpdatedAtUtc: "2026-09-30T12:03:00.000Z",
    ownerMarkerCreatedAtUtc: "2026-09-30T12:03:00.000Z",
    ownerMarkerSha256: "d".repeat(64),
  };
  const verified: BootstrapRecord = {
    ...intended,
    phase: "repository_verified",
    phaseUpdatedAtUtc: "2026-09-30T12:04:00.000Z",
    repositoryId: "e".repeat(64),
    repositoryVerifiedAtUtc: "2026-09-30T12:04:00.000Z",
  };
  return { pending, created, attested, intended, verified };
}

Deno.test("bootstrap state creates a protected directory chain and atomically preserves canonical bytes", async () => {
  const root = await canonicalTempDir();
  try {
    const paths = await ensureBootstrapDirectories(root);
    assert(
      JSON.stringify(paths) === JSON.stringify(bootstrapStatePaths(root)),
      "unstable bootstrap paths",
    );
    for (const directory of [paths.stateDir, paths.binDir]) {
      const info = await Deno.lstat(directory);
      assert(info.isDirectory && !info.isSymlink);
      assert((info.mode! & 0o7777) === 0o700, "directory mode is not 0700");
      assert(
        info.uid === await effectiveUidForTest(),
        "directory owner differs",
      );
    }
    const pending = records(root).pending;
    await writeBootstrapStateAtomic(root, pending);
    const before = await Deno.readTextFile(paths.recordPath);
    await writeBootstrapStateAtomic(root, { ...pending });
    const after = await Deno.readTextFile(paths.recordPath);
    assert(before === after, "idempotent write changed canonical bytes");
    assert(JSON.stringify(await readBootstrapState(root)) === before);
    const info = await Deno.lstat(paths.recordPath);
    assert(info.isFile && !info.isSymlink && (info.mode! & 0o7777) === 0o600);
    assert(
      [...Deno.readDirSync(paths.stateDir)].every((entry) =>
        entry.name === "bin" || entry.name === "bootstrap-v1.json"
      ),
      "atomic temporary survived",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bootstrap read-only validation never creates a missing protected chain", async () => {
  const root = await canonicalTempDir();
  try {
    await rejectsState(() => validateBootstrapDirectories(root));
    await rejectsState(() => readBootstrapState(root));
    let localExists = true;
    try {
      await Deno.lstat(`${root}/.local`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) localExists = false;
      else throw error;
    }
    assert(!localExists, "read-only bootstrap validation created storage");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bootstrap storage rejects writable roots, symlink components, wrong modes, malformed records, and oversized records", async () => {
  const root = await canonicalTempDir();
  const outside = await canonicalTempDir();
  try {
    await Deno.chmod(root, 0o770);
    await rejectsState(() => ensureBootstrapDirectories(root));
    await Deno.chmod(root, 0o700);

    await Deno.symlink(outside, `${root}/.local`);
    await rejectsState(() => ensureBootstrapDirectories(root));
    await Deno.remove(`${root}/.local`);

    await Deno.mkdir(`${root}/.local`, { mode: 0o755 });
    await rejectsState(() => ensureBootstrapDirectories(root));
    await Deno.chmod(`${root}/.local`, 0o700);
    const paths = await ensureBootstrapDirectories(root);

    await writeBootstrapStateAtomic(root, records(root).pending);
    await Deno.chmod(paths.recordPath, 0o644);
    await rejectsState(() => readBootstrapState(root));
    await Deno.writeTextFile(paths.recordPath, "{}", { mode: 0o600 });
    await Deno.chmod(paths.recordPath, 0o600);
    await rejectsState(() => readBootstrapState(root));
    await Deno.writeTextFile(paths.recordPath, "x".repeat(8193), {
      mode: 0o600,
    });
    await rejectsState(() => readBootstrapState(root));
    await Deno.remove(paths.recordPath);
    await Deno.symlink(`${root}/.env`, paths.recordPath);
    await rejectsState(() => readBootstrapState(root));
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("bootstrap discriminated union rejects unknown, partial, unsafe, and phase-inconsistent fields", async () => {
  const root = await canonicalTempDir();
  try {
    const { pending, created, attested, intended, verified } = records(root);
    const invalid: unknown[] = [
      { ...pending, unknown: "secret" },
      { ...pending, installationId: "not-a-uuid" },
      { ...pending, helperSourceSha256: "A".repeat(64) },
      { ...pending, account: "unsafe account" },
      { ...pending, label: "different.label" },
      { ...pending, keychainPath: `${root}/../login.keychain-db` },
      { ...pending, phaseUpdatedAtUtc: "2026-09-30T12:00:00Z" },
      { ...pending, credentialCreatedAtUtc: created.credentialCreatedAtUtc },
      { ...created, itemPersistentRefSha256: undefined },
      { ...attested, recoveryReceiptId: "short" },
      {
        ...attested,
        ownerMarkerCreatedAtUtc: intended.ownerMarkerCreatedAtUtc,
      },
      { ...attested, ownerMarkerSha256: intended.ownerMarkerSha256 },
      { ...intended, ownerMarkerSha256: undefined },
      { ...verified, repositoryId: "not-a-repository-id" },
      { ...verified, ownerMarkerSha256: undefined },
    ];
    for (const record of invalid) {
      await rejectsState(() =>
        writeBootstrapStateAtomic(root, record as BootstrapRecord)
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bootstrap phases advance monotonically, allow one marker intent, and keep identity immutable", async () => {
  const root = await canonicalTempDir();
  try {
    const { pending, created, attested, intended, verified } = records(root);
    await writeBootstrapStateAtomic(root, pending);
    await writeBootstrapStateAtomic(root, created);
    await writeBootstrapStateAtomic(root, attested);
    await rejectsState(() => writeBootstrapStateAtomic(root, verified));
    await writeBootstrapStateAtomic(root, intended);
    await writeBootstrapStateAtomic(root, { ...intended });
    await writeBootstrapStateAtomic(root, verified);
    await rejectsState(() => writeBootstrapStateAtomic(root, intended));
    await rejectsState(() =>
      writeBootstrapStateAtomic(root, {
        ...verified,
        installationId: "33333333-3333-4333-8333-333333333333",
      })
    );

    const root2 = await canonicalTempDir();
    try {
      const second = records(root2);
      await writeBootstrapStateAtomic(root2, second.pending);
      await rejectsState(() =>
        writeBootstrapStateAtomic(root2, second.attested)
      );
      await writeBootstrapStateAtomic(root2, second.created);
      await rejectsState(() =>
        writeBootstrapStateAtomic(root2, {
          ...second.created,
          phaseUpdatedAtUtc: "2026-09-30T12:01:01.000Z",
        })
      );
    } finally {
      await Deno.remove(root2, { recursive: true });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("protected executable requires an owned regular 0700 inode and exact SHA-256", async () => {
  const root = await canonicalTempDir();
  try {
    const { helperPath } = await ensureBootstrapDirectories(root);
    await Deno.writeTextFile(helperPath, "helper", { mode: 0o700 });
    const expected =
      "e81d3b0e9d82feaaf5f6e55bdff24731d7eee08632ffa63801e6397290c5d20a";
    const identity = await validateProtectedExecutable(helperPath, expected);
    assert(identity.sha256 === expected);
    assert(
      Object.isFrozen(identity) && identity.path === helperPath &&
        Number.isSafeInteger(identity.dev) &&
        Number.isSafeInteger(identity.ino) && identity.size === 6,
      "protected executable identity is incomplete or mutable",
    );
    await rejectsState(() =>
      validateProtectedExecutable(helperPath, "f".repeat(64))
    );
    await Deno.chmod(helperPath, 0o755);
    await rejectsState(() => validateProtectedExecutable(helperPath));
    await Deno.remove(helperPath);
    await Deno.writeTextFile(`${root}/other`, "helper", { mode: 0o700 });
    await Deno.symlink(`${root}/other`, helperPath);
    await rejectsState(() => validateProtectedExecutable(helperPath));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("protected executable validation rejects deterministic pathname replacement during hashing", async () => {
  const root = await canonicalTempDir();
  try {
    const { helperPath } = await ensureBootstrapDirectories(root);
    await Deno.writeTextFile(helperPath, "original", { mode: 0o700 });
    await rejectsState(() =>
      validateProtectedExecutable(helperPath, undefined, {
        afterHash: async () => {
          await Deno.rename(helperPath, `${helperPath}.original`);
          await Deno.writeTextFile(helperPath, "replacement", { mode: 0o700 });
        },
      })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("protected executable identity recheck rejects same-content replacement before execution", async () => {
  const root = await canonicalTempDir();
  try {
    const { helperPath } = await ensureBootstrapDirectories(root);
    await Deno.writeTextFile(helperPath, "helper", { mode: 0o700 });
    const identity = await validateProtectedExecutable(helperPath);
    await assertProtectedExecutableIdentity(identity);
    await Deno.rename(helperPath, `${helperPath}.validated`);
    await Deno.writeTextFile(helperPath, "helper", { mode: 0o700 });
    await rejectsState(() => assertProtectedExecutableIdentity(identity));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
