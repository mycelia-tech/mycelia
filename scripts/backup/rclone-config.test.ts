import {
  assertRcloneConfigIdentity,
  pinRcloneConfig,
} from "./rclone-config.ts";

Deno.test("rclone pins a dotfiles ancestor alias and refuses retargeting or a leaf symlink", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    for (const name of ["one", "two"]) {
      await Deno.mkdir(`${root}/${name}`, { mode: 0o700 });
      await Deno.writeTextFile(
        `${root}/${name}/rclone.conf`,
        "[test]\ntype = local\n",
        { mode: 0o600 },
      );
    }
    await Deno.symlink(`${root}/one`, `${root}/config`);
    const identity = await pinRcloneConfig(`${root}/config/rclone.conf`);
    await assertRcloneConfigIdentity(identity);
    await Deno.remove(`${root}/config`);
    await Deno.symlink(`${root}/two`, `${root}/config`);
    let refused = false;
    try {
      await assertRcloneConfigIdentity(identity);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("retargeted ancestor accepted");
    await Deno.symlink(`${root}/one/rclone.conf`, `${root}/leaf`);
    refused = false;
    try {
      await pinRcloneConfig(`${root}/leaf`);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("leaf symlink accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
