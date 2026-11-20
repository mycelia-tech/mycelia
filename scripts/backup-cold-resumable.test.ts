import { strict as assert } from "node:assert";
import { cloneTree, inventory } from "./backup-cold-resumable.ts";

Deno.test({
  name: "APFS snapshot is independent and rejects symlinks",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(root + "/source");
      await Deno.writeTextFile(root + "/source/data", "original");
      await cloneTree(root + "/source", root + "/snapshot");
      await Deno.writeTextFile(root + "/source/data", "changed");
      assert.equal(
        await Deno.readTextFile(root + "/snapshot/data"),
        "original",
      );
      assert.equal(
        (await Deno.stat(root + "/snapshot/data")).mode! & 0o777,
        0o400,
      );
      await Deno.symlink(root + "/source/data", root + "/source/link");
      await assert.rejects(() => inventory(root + "/source"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("rsync reuses a partial file and Python verifier detects corruption", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/source");
    await Deno.mkdir(root + "/dest/.rsync-partial", { recursive: true });
    const data = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 65536) {
      crypto.getRandomValues(data.subarray(i, i + 65536));
    }
    await Deno.writeFile(root + "/source/data", data);
    await Deno.writeFile(
      root + "/dest/.rsync-partial/data",
      data.subarray(0, 1024 * 1024),
    );
    const rsync = await new Deno.Command("/opt/homebrew/bin/rsync", {
      args: [
        "-rt",
        "--no-whole-file",
        "--partial-dir=.rsync-partial",
        "--stats",
        root + "/source/",
        root + "/dest/",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(rsync.success, true, new TextDecoder().decode(rsync.stderr));
    assert.match(new TextDecoder().decode(rsync.stdout), /Matched data: [1-9]/);
    assert.deepEqual(await Deno.readFile(root + "/dest/data"), data);
    const worker = new URL("./backup/cold-worker.py", import.meta.url).pathname;
    const test = await new Deno.Command("python3", {
      args: [
        "-c",
        "import importlib.util,sys,json,hashlib,pathlib; s=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(s);s.loader.exec_module(w);p=pathlib.Path(sys.argv[2]);d=(p/'data').read_bytes();m={'files':[{'path':'data','size':len(d),'sha256':hashlib.sha256(d).hexdigest()}]};(p/'manifest.json').write_text(json.dumps(m));w.verify(p,m);(p/'data').write_bytes(b'X'+d[1:]);\ntry:w.verify(p,m)\nexcept AssertionError:sys.exit(0)\nsys.exit(1)",
        worker,
        root + "/dest",
      ],
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(test.success, true, new TextDecoder().decode(test.stderr));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
