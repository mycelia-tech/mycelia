import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { finalizeBody, transfer } from "./backup-mongo-bastion.ts";

function child(script: string, input = false) {
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
}

Deno.test("stream requires successful producer and receiver, even after bytes arrive", async () => {
  for (const [dumpExit, receiveExit] of [[0, 0], [1, 0], [0, 1]]) {
    const producer = child(
      `await Deno.stdout.write(new TextEncoder().encode('backup')); Deno.exit(${dumpExit});`,
    );
    const receiver = child(
      `for await (const _ of Deno.stdin.readable) {} Deno.exit(${receiveExit});`,
      true,
    );
    if (dumpExit || receiveExit) {
      await assert.rejects(() => transfer(producer, receiver));
    } else {
      assert.deepEqual(await transfer(producer, receiver), {
        bytes: 6,
        sha256: createHash("sha256").update("backup").digest("hex"),
      });
    }
  }
});

Deno.test("remote finalization keeps partial on mismatch and never overwrites accepted archive", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${base}/run`);
    await Deno.writeTextFile(`${base}/run/mongo.archive.gz.partial`, "backup");
    const sha = createHash("sha256").update("backup").digest("hex");
    const finalize = async (expected: string) => {
      return await new Deno.Command("python3", {
        args: [
          "-c",
          `import os, sys, stat, json, hashlib\nbase = ${
            JSON.stringify(base)
          }\nrun_id = 'run'\nexpected_bytes = 6\nexpected_sha256 = '${expected}'\nmanifest = {'state':'transfer_verified','restoreVerified':False}\n` +
          finalizeBody,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
    };
    assert.equal((await finalize("wrong")).success, false);
    await assert.rejects(() => Deno.stat(`${base}/run/manifest.json`));
    assert.equal(
      await Deno.readTextFile(`${base}/run/mongo.archive.gz.partial`),
      "backup",
    );
    const accepted = await finalize(sha);
    assert.equal(
      accepted.success,
      true,
      new TextDecoder().decode(accepted.stderr),
    );
    assert.equal(
      await Deno.readTextFile(`${base}/run/mongo.archive.gz`),
      "backup",
    );
    assert.equal(
      JSON.parse(await Deno.readTextFile(`${base}/run/manifest.json`))
        .restoreVerified,
      false,
    );
    await Deno.writeTextFile(`${base}/run/mongo.archive.gz.partial`, "backup");
    assert.equal((await finalize(sha)).success, false);
    assert.equal(
      await Deno.readTextFile(`${base}/run/mongo.archive.gz`),
      "backup",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
