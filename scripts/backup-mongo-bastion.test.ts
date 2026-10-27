// deno-lint-ignore-file require-await
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  createMongoBackup,
  finalizeBody,
  type MongoBackupReceipt,
  parseMongoBackupConfig,
  restoreMongoDrill,
  verifyMongoBackup,
} from "./backup-mongo-bastion.ts";
import type {
  Runner,
  RunningCommand,
  RunningCommandStatus,
} from "./backup/types.ts";

const encoder = new TextEncoder();
const header = "age-encryption.org/v1\n";
const plain = encoder.encode("synthetic Mongo archive, no user data");
const config = parseMongoBackupConfig({
  sourceContainer: "fixture-source",
  sourceConfigPath: "/run/secrets/backup.json",
  sshHost: "fixture-bastion",
  expectedSshHostname: "fixture.invalid",
  expectedSshUser: "backup",
  remoteRoot: "/mnt/backup/mongo",
  remoteMount: "/mnt/backup",
  stateDir: "/private/tmp/fixture-state",
  ageRecipient: "age1" + "a".repeat(58),
  restoreImage: "mongo@sha256:" + "1".repeat(64),
});
const empty = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
const status = (code = 0): RunningCommandStatus => ({
  code,
  timedOut: false,
  terminationConfirmed: true,
  forcedKill: false,
});

class FixtureRunner implements Runner {
  calls: string[][] = [];
  remote = new Uint8Array();
  restored = new Uint8Array();
  owner = "";
  failDump = false;
  failFinalize = false;
  failRestore = false;
  failAge = false;
  failReceiver = false;
  failVerify = false;
  tamperDownload = false;
  existingVolume = false;
  async run(argv: readonly string[]) {
    this.calls.push([...argv]);
    let text = "";
    let code = 0;
    if (argv[0] === "ssh" && argv[1] === "-G") {
      text = "hostname fixture.invalid\nuser backup";
    } else if (argv[0] === "age") text = "v1.2.1";
    else if (argv[1] === "inspect") text = "a".repeat(64);
    else if (
      argv.includes("--nodb") && argv.at(-1)!.includes("firstOplogSeconds")
    ) {
      text = JSON.stringify({
        version: "7.0.25",
        firstOplogSeconds: 1,
        lastOplogSeconds: 5000,
        databaseBytes: 100,
      });
    } else if (argv[0] === "ssh" && argv.at(-1)!.includes("os.link(archive")) {
      code = this.failFinalize ? 1 : 0;
    } else if (
      argv[0] === "ssh" && argv.at(-1)!.includes("integrity mismatch")
    ) {
      code = this.failVerify ? 1 : 0;
    } else if (
      argv[1] === "volume" && argv[2] === "inspect" &&
      !argv.includes("--format")
    ) code = this.existingVolume ? 0 : 1;
    else if (argv[1] === "volume" && argv[2] === "create") {
      this.owner = argv[4].split("=")[1];
    } else if (argv[1] === "volume" && argv.includes("--format")) {
      text = this.owner;
    } else if (argv.includes("--nodb")) text = "7.0.25";
    else if (argv.includes("mongosh")) {
      text = JSON.stringify({ collections: 2, documents: 3 });
    }
    return {
      ...status(code),
      stdout: encoder.encode(text),
      stderr: encoder.encode("PRIVATE_ERROR_CANARY"),
    };
  }
  spawn(argv: readonly string[]): RunningCommand {
    this.calls.push([...argv]);
    let resolve!: (value: RunningCommandStatus) => void;
    const completed = new Promise<RunningCommandStatus>((done) => {
      resolve = done;
    });
    const result = (
      stdin: WritableStream<Uint8Array>,
      stdout: ReadableStream<Uint8Array>,
    ) => ({
      stdin,
      stdout,
      stderr: empty(),
      status: completed,
      kill: () => resolve(status(1)),
    });
    if (
      argv.includes("mongodump") ||
      (argv[0] === "ssh" && argv.at(-1)!.includes("sys.stdout.buffer"))
    ) {
      const bytes = argv.includes("mongodump") ? plain : this.remote.slice();
      if (!argv.includes("mongodump") && this.tamperDownload) {
        bytes[bytes.length - 1] ^= 1;
      }
      return result(
        new WritableStream(),
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
            resolve(
              status(argv.includes("mongodump") && this.failDump ? 1 : 0),
            );
          },
        }),
      );
    }
    if (argv[0] === "age") {
      let first = true;
      const fail = this.failAge;
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (argv.includes("--encrypt")) {
            if (first) controller.enqueue(encoder.encode(header));
            controller.enqueue(chunk);
          } else {controller.enqueue(
              first ? chunk.subarray(header.length) : chunk,
            );}
          first = false;
        },
        flush() {
          resolve(status(fail ? 1 : 0));
        },
      });
      return result(transform.writable, transform.readable);
    }
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const chunks: Uint8Array[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    });
    return result(
      new WritableStream({
        write(chunk) {
          chunks.push(chunk);
        },
        close: () => {
          const bytes = new Uint8Array(
            chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          if (argv.includes("mongorestore")) this.restored = bytes;
          else this.remote = bytes;
          output.close();
          resolve(
            status(
              (argv.includes("mongorestore")
                  ? this.failRestore
                  : this.failReceiver)
                ? 1
                : 0,
            ),
          );
        },
      }),
      stream,
    );
  }
}

Deno.test("encrypted backup has distinct transfer/integrity/restore receipts and no destination defaults", async () => {
  const runner = new FixtureRunner();
  const saved: MongoBackupReceipt[] = [];
  const receipt = await createMongoBackup(config, runner, async (value) => {
    saved.push(structuredClone(value));
  });
  assert.equal(receipt.transferVerified, true);
  assert.equal(receipt.integrityVerified, true);
  assert.equal(receipt.restoreVerified, false);
  assert.equal(
    saved.find((item) => item.state === "transferred")!.integrityVerified,
    false,
  );
  assert.equal(
    new TextDecoder().decode(runner.remote).startsWith(header),
    true,
  );
  const dump = runner.calls.find((argv) => argv.includes("mongodump"))!;
  assert.ok(dump.includes("--config=/run/secrets/backup.json"));
  assert.ok(dump.includes("--oplog"));
  assert.ok(
    !dump.some((arg) =>
      arg.includes("mongodb://") || arg.includes("--password")
    ),
  );
  assert.ok(!JSON.stringify(saved).includes("PRIVATE_ERROR_CANARY"));
  assert.throws(() => parseMongoBackupConfig({}), /CONFIG_INVALID/);
  assert.throws(
    () => parseMongoBackupConfig({ ...config, password: "private" }),
    /CONFIG_INVALID/,
  );
});

Deno.test("producer, age, receiver and integrity failures never claim accepted or restored backup", async () => {
  for (const stage of ["dump", "age", "receiver", "finalize"]) {
    const runner = new FixtureRunner();
    runner.failDump = stage === "dump";
    runner.failFinalize = stage === "finalize";
    runner.failAge = stage === "age";
    runner.failReceiver = stage === "receiver";
    let saved!: MongoBackupReceipt;
    await assert.rejects(
      () =>
        createMongoBackup(config, runner, async (value) => {
          saved = structuredClone(value);
        }),
      /BACKUP_FAILED/,
    );
    assert.equal(saved.state, "failed");
    assert.equal(saved.transferVerified, stage === "finalize");
    assert.equal(saved.integrityVerified, false);
    assert.equal(saved.restoreVerified, false);
    assert.ok(!JSON.stringify(saved).includes("PRIVATE_ERROR_CANARY"));
  }
});

Deno.test("restore drill uses only a fresh isolated target and keeps disposable resources", async () => {
  const runner = new FixtureRunner();
  const receipt = await createMongoBackup(config, runner, async () => {});
  await assert.rejects(() =>
    restoreMongoDrill(
      config,
      receipt,
      "/private/fixture.agekey",
      runner,
      async () => {},
      false,
    )
  );
  await restoreMongoDrill(
    config,
    receipt,
    "/private/fixture.agekey",
    runner,
    async () => {},
    true,
  );
  assert.equal(receipt.restoreVerified, true);
  assert.deepEqual(runner.restored, plain);
  const run = runner.calls.find((argv) => argv[1] === "run")!;
  assert.equal(run[run.indexOf("--network") + 1], "none");
  assert.ok(!run.includes("-p") && !run.includes("--publish"));
  assert.ok(run.includes(config.restoreImage));
  assert.ok(!JSON.stringify(run).includes(config.sourceContainer));
  assert.ok(runner.calls.some((argv) => argv[1] === "stop"));
  assert.ok(
    !runner.calls.some((argv) => argv.includes("rm") || argv.includes("prune")),
  );
});

Deno.test("existing restore volume and failed mongorestore fail closed", async () => {
  for (const existingVolume of [true, false]) {
    const runner = new FixtureRunner();
    const receipt = await createMongoBackup(config, runner, async () => {});
    runner.existingVolume = existingVolume;
    runner.failRestore = !existingVolume;
    await assert.rejects(() =>
      restoreMongoDrill(
        config,
        receipt,
        "/private/fixture.agekey",
        runner,
        async () => {},
        true,
      )
    );
    assert.equal(receipt.restoreVerified, false);
    if (existingVolume) {
      assert.ok(!runner.calls.some((argv) => argv[1] === "run"));
    }
  }
});

Deno.test("failed re-verification invalidates earlier verification and never creates a restore target", async () => {
  const runner = new FixtureRunner();
  const receipt = await createMongoBackup(config, runner, async () => {});
  receipt.restoreVerified = true;
  runner.failVerify = true;
  await assert.rejects(
    () => verifyMongoBackup(config, receipt, runner),
    /INTEGRITY_VERIFICATION_FAILED/,
  );
  assert.equal(receipt.integrityVerified, false);
  assert.equal(receipt.restoreVerified, false);
  assert.equal(receipt.state, "failed");
  // The restore preflight must also persist an invalidated prior receipt.
  receipt.integrityVerified = true;
  let saved!: MongoBackupReceipt;
  await assert.rejects(
    () =>
      restoreMongoDrill(
        config,
        receipt,
        "/private/key",
        runner,
        async (value) => {
          saved = structuredClone(value);
        },
        true,
      ),
    /INTEGRITY_VERIFICATION_FAILED/,
  );
  assert.equal(saved.integrityVerified, false);
  assert.equal(saved.restoreVerified, false);
  assert.ok(
    !runner.calls.some((argv) => argv[1] === "volume" || argv[1] === "run"),
  );
});

Deno.test("decryption failure and ciphertext changed during transfer cannot verify a restore", async () => {
  for (const stage of ["decrypt", "download"]) {
    const runner = new FixtureRunner();
    const receipt = await createMongoBackup(config, runner, async () => {});
    runner.failAge = stage === "decrypt";
    runner.tamperDownload = stage === "download";
    await assert.rejects(
      () =>
        restoreMongoDrill(
          config,
          receipt,
          "/private/key",
          runner,
          async () => {},
          true,
        ),
      /RESTORE_DRILL_FAILED/,
    );
    assert.equal(receipt.restoreVerified, false);
    assert.equal(receipt.restore?.state, "failed_stopped");
    if (stage === "download") assert.equal(receipt.integrityVerified, false);
    assert.ok(runner.calls.some((argv) => argv[1] === "stop"));
  }
});

Deno.test("finalization checks ciphertext hash and preserves originals without overwriting", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${base}/run`);
    const bytes = encoder.encode(header + "synthetic encrypted fixture");
    await Deno.writeFile(`${base}/run/mongo.archive.gz.age.partial`, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const finalize = async (digest: string) =>
      await new Deno.Command("python3", {
        args: [
          "-c",
          `import os, stat, hashlib, json\nbase=${
            JSON.stringify(base)
          }\nrun_id='run'\nfilename='mongo.archive.gz.age.partial'\nexpected_bytes=${bytes.length}\nexpected_sha256=${
            JSON.stringify(digest)
          }\nmanifest={'restoreVerified':False}\n` + finalizeBody,
        ],
        stdout: "null",
        stderr: "null",
      }).output();
    assert.equal((await finalize("0".repeat(64))).success, false);
    assert.equal((await finalize(sha)).success, true);
    assert.equal((await finalize(sha)).success, false);
    assert.deepEqual(
      await Deno.readFile(`${base}/run/mongo.archive.gz.age.partial`),
      bytes,
    );
    assert.deepEqual(
      await Deno.readFile(`${base}/run/mongo.archive.gz.age`),
      bytes,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
