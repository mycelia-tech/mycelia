/** Opt-in real binaries, synthetic data, no published ports or user SSH config.
 * MYCELIA_MONGO_BACKUP_INTEGRATION=1 deno test --allow-read --allow-write
 *   --allow-env --allow-run this-file
 * Optional absolute binaries: MYCELIA_BACKUP_TEST_AGE / _AGE_KEYGEN.
 * Stops its containers and retains all volumes, receipts and the private age key.
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import {
  mongoBackupMain,
  type MongoBackupReceipt,
} from "./backup-mongo-bastion.ts";
import { DenoRunner } from "./backup/runner.ts";
import type { Runner } from "./backup/types.ts";

const enableVariable = "MYCELIA_MONGO_BACKUP_INTEGRATION";
const allowed = await Deno.permissions.query({
  name: "env",
  variable: enableVariable,
});
const enabled = allowed.state === "granted" &&
  Deno.env.get(enableVariable) === "1";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

Deno.test({
  name:
    "synthetic Mongo archive is age-encrypted, restored and fully validated by real binaries",
  ignore: !enabled,
  fn: async () => {
    const real = new DenoRunner();
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "mycelia-mongo-backup-integration-" }),
    );
    await Deno.chmod(root, 0o700);
    const id = crypto.randomUUID();
    const prefix = `mycelia-backup-it-${id}`;
    const source = `${prefix}-source`;
    const seed = `${prefix}-seed`;
    const receiver = `${prefix}-receiver`;
    const sourceVolume = `${prefix}-source-data`;
    const receiverVolume = `${prefix}-encrypted`;
    const created: string[] = [];
    const age = Deno.env.get("MYCELIA_BACKUP_TEST_AGE") || "age";
    const keygen = Deno.env.get("MYCELIA_BACKUP_TEST_AGE_KEYGEN") ||
      "age-keygen";
    const run = async (argv: string[], timeoutMs = 90_000) => {
      const result = await real.run(argv, {
        timeoutMs,
        maxOutputBytes: 128 * 1024,
      });
      assert.equal(
        result.code,
        0,
        `${argv[0]} ${argv[1]} failed: ${decoder.decode(result.stderr)}`,
      );
      return decoder.decode(result.stdout).trim();
    };
    const image = async (tag: string) => {
      const digest = await run([
        "docker",
        "image",
        "inspect",
        tag,
        "--format",
        "{{index .RepoDigests 0}}",
      ]);
      assert.match(digest, /^[\w./:-]+@sha256:[a-f0-9]{64}$/);
      return digest;
    };
    const mongo = await image("mongo:8.0");
    const python = await image("python:3.14-slim");
    const identity = join(root, "identity.agekey");
    await run([keygen, "--output", identity]);
    await Deno.chmod(identity, 0o600);
    const recipient = await run([keygen, "-y", identity]);
    const mongoContainer = async (name: string, replSet = false) => {
      await run([
        "docker",
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `tech.mycelia.backup-integration=${id}`,
        "--network",
        "none",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/data/configdb",
        "--mount",
        `type=volume,source=${sourceVolume},target=/data/db`,
        mongo,
        "mongod",
        "--bind_ip",
        "127.0.0.1",
        "--wiredTigerCacheSizeGB",
        "0.25",
        ...(replSet ? ["--replSet", "fixture"] : []),
      ]);
      created.push(name);
      await run([
        "docker",
        "exec",
        name,
        "mongosh",
        "--nodb",
        "--quiet",
        "--eval",
        "let ready=false;for(let i=0;i<60;i++){try{if(new Mongo('mongodb://127.0.0.1:27017').getDB('admin').runCommand({ping:1}).ok===1){ready=true;break;}}catch(_){}sleep(500);}if(!ready)quit(1);",
      ]);
    };
    const stateDir = join(root, "state");
    await Deno.mkdir(stateDir, { mode: 0o700 });
    const configPath = join(root, "config.json");
    let receipt: MongoBackupReceipt | undefined;
    const snapshotPath = join(root, "retained-resources.json");
    const record = async () =>
      await Deno.writeTextFile(
        snapshotPath,
        JSON.stringify(
          {
            syntheticOnly: true,
            root,
            mongoImage: mongo,
            receiverImage: python,
            containers: created,
            sourceVolume,
            receiverVolume,
            restoreContainer: receipt?.restore?.container,
            restoreVolume: receipt?.restore?.volume,
            receipt: receipt && join(stateDir, `${receipt.runId}.json`),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    try {
      for (const volume of [sourceVolume, receiverVolume]) {
        const absent = await real.run(["docker", "volume", "inspect", volume], {
          timeoutMs: 10_000,
          maxOutputBytes: 4096,
        });
        assert.notEqual(absent.code, 0, "fixture volume must be new");
        await run([
          "docker",
          "volume",
          "create",
          "--label",
          `tech.mycelia.backup-integration=${id}`,
          volume,
        ]);
      }
      await mongoContainer(seed);
      // A standalone fixture seeds an older noop, so the real replica-set
      // preflight can enforce its one-hour oplog window without an hour's wait.
      await run([
        "docker",
        "exec",
        seed,
        "mongosh",
        "--quiet",
        "--eval",
        `
        const local=db.getSiblingDB('local');
        if(local.createCollection('oplog.rs',{capped:true,size:16777216}).ok!==1)quit(1);
        if(!local.oplog.rs.insertOne({ts:Timestamp({t:Math.floor(Date.now()/1000)-7200,i:1}),t:Long('-1'),v:2,op:'n',ns:'',o:{msg:'synthetic old noop'}}).acknowledged)quit(1);
        const fixture=db.getSiblingDB('backup_fixture');
        if(!fixture.events.insertMany([{_id:'a',text:'synthetic alpha',at:ISODate('2020-01-02T03:04:05Z')},{_id:'b',text:'synthetic beta',value:42}]).acknowledged)quit(1);
        fixture.events.createIndex({text:1},{name:'fixture_text'});
        if(!fixture.sources.insertOne({_id:'source',filename:'synthetic.wav',bytes:1234}).acknowledged)quit(1);
      `,
      ]);
      await run(["docker", "stop", "--time", "30", seed]);
      await mongoContainer(source, true);
      await run([
        "docker",
        "exec",
        source,
        "mongosh",
        "--quiet",
        "--eval",
        `
        if(rs.initiate({_id:'fixture',members:[{_id:0,host:'127.0.0.1:27017'}]}).ok!==1)quit(1);
        let ready=false;for(let i=0;i<60;i++){if(db.hello().isWritablePrimary){ready=true;break;}sleep(500);}if(!ready)quit(1);
        const fs=require('fs');fs.writeFileSync('/tmp/backup.json',JSON.stringify({uri:'mongodb://127.0.0.1:27017/?replicaSet=fixture'}),{mode:0o600});
      `,
      ]);
      await run([
        "docker",
        "run",
        "--detach",
        "--name",
        receiver,
        "--label",
        `tech.mycelia.backup-integration=${id}`,
        "--network",
        "none",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--mount",
        `type=volume,source=${receiverVolume},target=/mnt/backup`,
        python,
        "python3",
        "-c",
        "import time; time.sleep(86400)",
      ]);
      created.push(receiver);
      await run([
        "docker",
        "exec",
        receiver,
        "python3",
        "-c",
        "import os;os.mkdir('/mnt/backup/mongo',0o700)",
      ]);
      await record();

      // Substitute transport only. Receiver scripts, age, Mongo tools, checksums
      // and restore validation all execute unchanged production commands.
      const map = (argv: readonly string[]) =>
        argv[0] === "age"
          ? [age, ...argv.slice(1)]
          : argv[0] === "ssh"
          ? ["docker", "exec", "-i", receiver, "sh", "-c", argv.at(-1)!]
          : [...argv];
      const runner: Runner = {
        async run(argv, options) {
          if (argv[0] === "ssh" && argv[1] === "-G") {
            return Promise.resolve({
              code: 0,
              stdout: encoder.encode(
                "hostname fixture.invalid\nuser fixture\n",
              ),
              stderr: new Uint8Array(),
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
            });
          }
          const result = await real.run(map(argv), options);
          if (
            result.code !== 0 &&
            !(argv[1] === "volume" && argv[2] === "inspect")
          ) {
            console.error(
              "Synthetic command failure",
              argv.slice(0, 2),
              decoder.decode(result.stderr),
            );
          }
          return result;
        },
        spawn: (argv, options) => real.spawn(map(argv), options),
      };
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          sourceContainer: source,
          sourceConfigPath: "/tmp/backup.json",
          sshHost: "fixture",
          expectedSshHostname: "fixture.invalid",
          expectedSshUser: "fixture",
          remoteRoot: "/mnt/backup/mongo",
          remoteMount: "/mnt/backup",
          stateDir,
          ageRecipient: recipient,
          restoreImage: mongo,
          minFreeBytes: 1024 * 1024,
          timeoutSeconds: 300,
        }),
        { mode: 0o600 },
      );
      await mongoBackupMain(["backup", "--config", configPath], runner);
      const entries = await Array.fromAsync(Deno.readDir(stateDir));
      const saved = entries.find((entry) =>
        /^mongo-.*\.json$/.test(entry.name)
      );
      assert.ok(saved);
      const receiptPath = join(stateDir, saved.name);
      receipt = JSON.parse(await Deno.readTextFile(receiptPath));
      assert.ok(
        receipt?.transferVerified && receipt.integrityVerified &&
          !receipt.restoreVerified,
      );
      await mongoBackupMain([
        "verify",
        "--config",
        configPath,
        "--run-id",
        receipt.runId,
      ], runner);
      await mongoBackupMain([
        "restore-drill",
        "--config",
        configPath,
        "--run-id",
        receipt.runId,
        "--identity-file",
        identity,
        "--disposable",
      ], runner);
      receipt = JSON.parse(await Deno.readTextFile(receiptPath));
      assert.ok(receipt?.restoreVerified);
      assert.equal(receipt.restore?.state, "verified_stopped");
      assert.ok(receipt.restore.checkedCollections! >= 2);
      assert.ok(receipt.restore.checkedDocuments! >= 3);
      // Assert actual values and indexes, beyond the CLI's full collection validate.
      await run(["docker", "start", receipt.restore.container]);
      try {
        await run([
          "docker",
          "exec",
          receipt.restore.container,
          "mongosh",
          "--nodb",
          "--quiet",
          "--eval",
          `
          let target;for(let i=0;i<60;i++){try{target=new Mongo('mongodb://127.0.0.1:27017').getDB('backup_fixture');if(target.runCommand({ping:1}).ok===1)break;}catch(_){}sleep(500);}
          if(target.events.countDocuments({})!==2||target.events.findOne({_id:'b'}).value!==42)quit(1);
          if(target.events.findOne({_id:'a'}).at.toISOString()!=='2020-01-02T03:04:05.000Z')quit(1);
          if(target.sources.findOne({_id:'source'}).filename!=='synthetic.wav')quit(1);
          if(!target.events.getIndexes().some(i=>i.name==='fixture_text'))quit(1);
        `,
        ]);
      } finally {
        await run([
          "docker",
          "stop",
          "--time",
          "30",
          receipt.restore.container,
        ]);
      }
      assert.equal((await Deno.stat(receiptPath)).mode! & 0o077, 0);
      console.log(`Synthetic restore evidence retained: ${snapshotPath}`);
    } finally {
      // Keep failure receipts and partially-created restore targets discoverable.
      for await (const entry of Deno.readDir(stateDir)) {
        if (/^mongo-.*\.json$/.test(entry.name)) {
          receipt = JSON.parse(
            await Deno.readTextFile(join(stateDir, entry.name)),
          );
        }
      }
      for (const container of [...created].reverse()) {
        await run(["docker", "stop", "--time", "30", container]);
      }
      await record();
      console.log(
        `Synthetic resources retained (not deleted): ${snapshotPath}`,
      );
    }
  },
});
