import { loadBackupConfig } from "./config.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("configuration defaults and overrides expose only selected settings", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/.env`,
      'SECRET_KEY=do-not-return\nMEDIA_SOURCE_HOST_PATH="~/media library"\n',
    );
    const defaults = await loadBackupConfig(root, root);
    assert(defaults.rcloneRemote === "pk-backup:");
    assert(defaults.remoteRoot === "pk-backup:mycelia");
    assert(defaults.resticRepository === "rclone:pk-backup:mycelia/restic-v1");
    assert(defaults.resticKeychainService === "tech.mycelia.backup.restic");
    assert(defaults.resticKeychainAccount === "mycelia");
    assert(defaults.remoteMinFreeBytes > 0);
    assert(defaults.mediaSourceHostPath === `${root}/media library`);
    assert(!JSON.stringify(defaults).includes("do-not-return"));
    await Deno.writeTextFile(
      `${root}/.env.backup`,
      'BACKUP_REMOTE_MIN_FREE_BYTES=4096\nBACKUP_OPERATIONAL_UNTRACKED_JSON=[".env","misc/runtime.json"]\n',
    );
    const configured = await loadBackupConfig(root, root);
    assert(configured.remoteMinFreeBytes === 4096);
    assert(
      JSON.stringify(configured.operationalUntracked) ===
        '[".env","misc/runtime.json"]',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("configuration rejects malformed, conflicting, unsafe, and unknown backup assignments without commands", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cases = [
      ["A=one\nA=two\n", ""],
      ["", "BACKUP_REMOTE_MIN_FREE_BYTES=1\nBACKUP_REMOTE_MIN_FREE_BYTES=2\n"],
      ["BACKUP_REMOTE_MIN_FREE_BYTES=1\n", "BACKUP_REMOTE_MIN_FREE_BYTES=2\n"],
      ["BROKEN KEY=value\n", ""],
      ["", "not an assignment\n"],
      ["", "BACKUP_REMOTE_MIN_FREE_BYTES=-1\n"],
      ["", "BACKUP_REMOTE_MIN_FREE_BYTES=1.5\n"],
      ["", 'BACKUP_OPERATIONAL_UNTRACKED_JSON=["../escape"]\n'],
      ["", 'BACKUP_OPERATIONAL_UNTRACKED_JSON=["/private/file"]\n'],
      ["", "BACKUP_OPERATIONAL_UNTRACKED_JSON={}\n"],
      ["", "BACKUP_RESTIC_PASSWORD=secret-value\n"],
      ["", "BACKUP_REMOTE_ROOT=https://user:pass@host/path\n"],
      ["", "BACKUP_RCLONE_REMOTE=other:\n"],
      ["MEDIA_SOURCE_HOST_PATH=$(touch sentinel)\n", ""],
    ];
    for (const [app, backup] of cases) {
      await Deno.writeTextFile(`${root}/.env`, app);
      await Deno.writeTextFile(`${root}/.env.backup`, backup);
      let caught: unknown;
      try {
        await loadBackupConfig(root, root);
      } catch (error) {
        caught = error;
      }
      assert(
        caught instanceof Error && caught.message === "CONFIG_INVALID",
        "unsafe config accepted or input leaked",
      );
      assert(
        Object.getOwnPropertyDescriptor(caught, "code")?.value ===
          "CONFIG_INVALID",
        "configuration error has no safe machine code",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
