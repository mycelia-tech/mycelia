/** Encrypted logical backups; independent of restic/PITR and never retention. */
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { collectBoundedStream, DenoRunner } from "./backup/runner.ts";
import type { Runner, RunningCommand } from "./backup/types.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value).trim();
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RUN = /^mongo-[a-f0-9-]{36}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:_-]*@sha256:[a-f0-9]{64}$/;

export type MongoBackupConfig = {
  sourceContainer: string;
  sourceConfigPath: string;
  sshHost: string;
  expectedSshHostname: string;
  expectedSshUser: string;
  remoteRoot: string;
  remoteMount: string;
  stateDir: string;
  ageRecipient: string;
  restoreImage: string;
  minFreeBytes: number;
  timeoutSeconds: number;
};

export type MongoBackupReceipt = {
  schema: 2;
  runId: string;
  state: "preflight" | "streaming" | "transferred" | "verified" | "failed";
  startedAt: string;
  encryptedAtRest: true;
  transferVerified: boolean;
  integrityVerified: boolean;
  restoreVerified: boolean;
  bytes?: number;
  sha256?: string;
  sourceVersion?: string;
  sourceContainerId?: string;
  failure?: string;
  restore?: {
    container: string;
    volume: string;
    state: string;
    checkedCollections?: number;
    checkedDocuments?: number;
  };
};

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) &&
    ![...value].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) &&
    !value.split("/").includes("..");
}

export function parseMongoBackupConfig(value: unknown): MongoBackupConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CONFIG_INVALID");
  }
  const config = {
    minFreeBytes: 1024 ** 3,
    timeoutSeconds: 7200,
    ...value,
  } as MongoBackupConfig;
  const fields = [
    "sourceContainer",
    "sourceConfigPath",
    "sshHost",
    "expectedSshHostname",
    "expectedSshUser",
    "remoteRoot",
    "remoteMount",
    "stateDir",
    "ageRecipient",
    "restoreImage",
    "minFreeBytes",
    "timeoutSeconds",
  ];
  if (Object.keys(config).some((key) => !fields.includes(key))) {
    throw new Error("CONFIG_INVALID");
  }
  for (
    const key of [
      "sourceContainer",
      "sshHost",
      "expectedSshHostname",
      "expectedSshUser",
    ] as const
  ) {
    if (typeof config[key] !== "string" || !TOKEN.test(config[key])) {
      throw new Error("CONFIG_INVALID");
    }
  }
  for (
    const key of [
      "sourceConfigPath",
      "remoteRoot",
      "remoteMount",
      "stateDir",
    ] as const
  ) {
    if (!absolute(config[key])) throw new Error("CONFIG_INVALID");
  }
  if (
    config.remoteMount === "/" ||
    !config.remoteRoot.startsWith(config.remoteMount.replace(/\/$/, "") + "/")
  ) throw new Error("CONFIG_INVALID");
  if (
    !/^age1[0-9a-z]{58}$/.test(config.ageRecipient) ||
    !IMAGE.test(config.restoreImage ?? "")
  ) throw new Error("CONFIG_INVALID");
  if (
    !Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes < 1 ||
    !Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 60 ||
    config.timeoutSeconds > 86400
  ) throw new Error("CONFIG_INVALID");
  return config;
}

function ssh(config: MongoBackupConfig): string[] {
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    config.sshHost,
  ];
}

export function remoteGuard(config: MongoBackupConfig): string {
  return `import os, sys, stat, json, hashlib, shutil, subprocess
base = ${JSON.stringify(config.remoteRoot)}
mount = ${JSON.stringify(config.remoteMount)}
if os.path.realpath(base) != base or os.path.realpath(mount) != mount: raise RuntimeError('destination symlink')
if not os.path.ismount(mount): raise RuntimeError('destination disk not mounted')
if subprocess.check_output(['findmnt','-n','-o','TARGET','-T',base], text=True).strip() != mount: raise RuntimeError('wrong destination mount')
s = os.stat(base)
if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077: raise RuntimeError('destination not private')
os.umask(0o077)
`;
}

export const receiveBody =
  `if shutil.disk_usage(base).free < minimum: raise RuntimeError('insufficient space')
run = os.path.join(base, run_id)
os.mkdir(run, 0o700)
with open(os.path.join(run, 'mongo.archive.gz.age.partial'), 'xb') as f:
    os.fchmod(f.fileno(), 0o600)
    shutil.copyfileobj(sys.stdin.buffer, f, 1024 * 1024)
    f.flush()
    os.fsync(f.fileno())
`;

export const verifyBody = `run = os.path.join(base, run_id)
if os.path.realpath(run) != run or os.stat(run).st_uid != os.getuid(): raise RuntimeError('invalid run directory')
archive = os.path.join(run, filename)
if os.path.islink(archive) or not stat.S_ISREG(os.stat(archive).st_mode): raise RuntimeError('invalid archive file')
digest = hashlib.sha256()
size = 0
with open(archive, 'rb') as f:
    if f.read(22) != b'age-encryption.org/v1\\n': raise RuntimeError('not age ciphertext')
    f.seek(0)
    for block in iter(lambda: f.read(1024 * 1024), b''):
        digest.update(block)
        size += len(block)
if size <= 0 or size != expected_bytes or digest.hexdigest() != expected_sha256: raise RuntimeError('integrity mismatch')
`;

export const finalizeBody = verifyBody +
  `accepted = os.path.join(run, 'mongo.archive.gz.age')
os.link(archive, accepted)
with open(os.path.join(run, 'manifest.json'), 'x') as f:
    os.fchmod(f.fileno(), 0o600)
    json.dump(manifest, f)
    f.flush()
    os.fsync(f.fileno())
for directory in (run, base):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
# Keep the partial hard link as failure/recovery evidence; no retention/deletion.
print(json.dumps({'bytes': size, 'sha256': digest.hexdigest()}))
`;

function remoteCommand(config: MongoBackupConfig, body: string): string[] {
  return [...ssh(config), "python3 -I -c " + quote(remoteGuard(config) + body)];
}

async function command(
  runner: Runner,
  argv: string[],
  timeoutMs = 30_000,
): Promise<string> {
  try {
    const result = await runner.run(argv, {
      timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    validStatus(result);
    return decode(result.stdout);
  } catch {
    throw new Error("COMMAND_FAILED");
  } // Never persist child output/credentials.
}

function validStatus(status: Awaited<RunningCommand["status"]>) {
  if (
    status.code !== 0 || status.timedOut || !status.terminationConfirmed ||
    status.forcedKill
  ) throw new Error("STREAM_FAILED");
}

/** Backpressure across all stages, with bounded diagnostic draining and exits. */
export async function transferEncrypted(
  children: RunningCommand[],
  digestStage = children.length - 2,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const jobs: Promise<unknown>[] = [];
  try {
    for (const child of children) {
      if (!child.stdout || !child.stderr || !child.stdin) {
        throw new Error("STREAM_UNAVAILABLE");
      }
      jobs.push(child.stderr.pipeTo(new WritableStream()));
      jobs.push(child.status.then(validStatus));
    }
    await children[0].stdin!.close();
    for (let index = 0; index < children.length - 1; index++) {
      let stream = children[index].stdout!;
      if (index === digestStage) {
        stream = stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              hash.update(chunk);
              bytes += chunk.length;
              if (!Number.isSafeInteger(bytes)) {
                throw new Error("STREAM_TOO_LARGE");
              }
              controller.enqueue(chunk);
            },
          }),
        );
      }
      jobs.push(stream.pipeTo(children[index + 1].stdin!));
    }
    jobs.push(collectBoundedStream(children.at(-1)!.stdout!, 64 * 1024));
    await Promise.all(jobs);
    if (!bytes) throw new Error("EMPTY_ARCHIVE");
    return { bytes, sha256: hash.digest("hex") };
  } catch {
    for (const child of children) child.kill();
    await Promise.allSettled([
      ...jobs,
      ...children.map((child) => child.status),
    ]);
    throw new Error("STREAM_FAILED");
  }
}

function sourceProbe(config: MongoBackupConfig): string {
  return `try {
 const fs = require('fs'); const p = ${JSON.stringify(config.sourceConfigPath)};
 const st = fs.lstatSync(p); if (!st.isFile() || st.isSymbolicLink() || (st.mode & 63)) quit(1);
 const c = JSON.parse(fs.readFileSync(p, 'utf8'));
 if (Object.keys(c).join() !== 'uri' || typeof c.uri !== 'string') quit(1);
 const m = new Mongo(c.uri); const admin = m.getDB('admin');
 const hello = admin.runCommand({hello:1});
 const oplog = m.getDB('local').getCollection('oplog.rs');
 const first = oplog.find().sort({$natural:1}).limit(1).next();
 const last = oplog.find().sort({$natural:-1}).limit(1).next();
 const databases = admin.runCommand({listDatabases:1});
 if (!hello.isWritablePrimary || !hello.setName || !first || !last || databases.ok !== 1) quit(1);
 // mongosh exposes listDatabases.totalSize as BSON Long, not a JSON number.
 const databaseBytes = Number(databases.totalSize.toString());
 if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 0) quit(1);
 print(JSON.stringify({version:admin.version(), firstOplogSeconds:first.ts.getHighBitsUnsigned(),
 lastOplogSeconds:last.ts.getHighBitsUnsigned(), databaseBytes}));
} catch (_) { quit(1); }`;
}

async function sourceCheck(
  config: MongoBackupConfig,
  runner: Runner,
  container: string,
) {
  const value = JSON.parse(
    await command(runner, [
      "docker",
      "exec",
      container,
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
      sourceProbe(config),
    ]),
  );
  if (
    !/^\d+\.\d+\.\d+/.test(value.version) ||
    !Number.isSafeInteger(value.firstOplogSeconds) ||
    !Number.isSafeInteger(value.lastOplogSeconds) ||
    value.lastOplogSeconds - value.firstOplogSeconds < 3600 ||
    !Number.isSafeInteger(value.databaseBytes) || value.databaseBytes < 0
  ) throw new Error("SOURCE_PREFLIGHT_FAILED");
  return value as {
    version: string;
    firstOplogSeconds: number;
    lastOplogSeconds: number;
    databaseBytes: number;
  };
}

async function checkSsh(config: MongoBackupConfig, runner: Runner) {
  const effective = await command(runner, ["ssh", "-G", config.sshHost]);
  const values = new Map(
    effective.split("\n").map((line) => {
      const [key, ...rest] = line.split(" ");
      return [key, rest.join(" ")];
    }),
  );
  if (
    values.get("hostname") !== config.expectedSshHostname ||
    values.get("user") !== config.expectedSshUser
  ) throw new Error("SSH_DESTINATION_MISMATCH");
}

type SaveReceipt = (receipt: MongoBackupReceipt) => Promise<void>;

export async function createMongoBackup(
  config: MongoBackupConfig,
  runner: Runner,
  save: SaveReceipt,
  runId = "mongo-" + crypto.randomUUID(),
): Promise<MongoBackupReceipt> {
  if (!RUN.test(runId)) throw new Error("RUN_ID_INVALID");
  const receipt: MongoBackupReceipt = {
    schema: 2,
    runId,
    state: "preflight",
    startedAt: new Date().toISOString(),
    encryptedAtRest: true,
    transferVerified: false,
    integrityVerified: false,
    restoreVerified: false,
  };
  const children: RunningCommand[] = [];
  try {
    await save(receipt);
    await checkSsh(config, runner);
    await command(runner, ["age", "--version"]);
    const container = await command(runner, [
      "docker",
      "inspect",
      "--format",
      "{{.Id}}",
      config.sourceContainer,
    ]);
    if (!/^[a-f0-9]{64}$/.test(container)) {
      throw new Error("SOURCE_CONTAINER_INVALID");
    }
    const source = await sourceCheck(config, runner, container);
    receipt.sourceVersion = source.version;
    receipt.sourceContainerId = container;
    const minimum = Math.max(
      config.minFreeBytes,
      Math.ceil(source.databaseBytes * 1.5),
    );
    await command(
      runner,
      remoteCommand(
        config,
        `if shutil.disk_usage(base).free < ${minimum}: raise RuntimeError('insufficient space')\nprint('ready')\n`,
      ),
    );
    receipt.state = "streaming";
    await save(receipt);
    const options = { timeoutMs: config.timeoutSeconds * 1000 };
    // Start downstream first, so no plaintext producer survives a failed sink spawn.
    const receiver = runner.spawn(
      remoteCommand(
        config,
        `run_id = ${JSON.stringify(runId)}\nminimum = ${minimum}\n` +
          receiveBody,
      ),
      options,
    );
    children.push(receiver);
    const encryptor = runner.spawn([
      "age",
      "--encrypt",
      "--recipient",
      config.ageRecipient,
    ], options);
    children.push(encryptor);
    const dump = runner.spawn([
      "docker",
      "exec",
      container,
      "mongodump",
      `--config=${config.sourceConfigPath}`,
      "--archive",
      "--gzip",
      "--oplog",
      "--numParallelCollections=2",
      "--quiet",
    ], options);
    children.push(dump);
    const digest = await transferEncrypted([dump, encryptor, receiver]);
    Object.assign(receipt, digest, {
      state: "transferred",
      transferVerified: true,
    });
    await save(receipt);
    const after = await sourceCheck(config, runner, container);
    if (after.firstOplogSeconds > source.lastOplogSeconds) {
      throw new Error("OPLOG_ROLLED_OVER");
    }
    const manifest = { ...receipt, state: "verified", integrityVerified: true };
    await command(
      runner,
      remoteCommand(
        config,
        verificationVariables(receipt, "mongo.archive.gz.age.partial") +
          `manifest = json.loads(${
            JSON.stringify(JSON.stringify(manifest))
          })\n` + finalizeBody,
      ),
      options.timeoutMs,
    );
    Object.assign(receipt, manifest);
    await save(receipt);
    return receipt;
  } catch {
    for (const child of children) child.kill();
    await Promise.allSettled(children.map((child) => child.status));
    receipt.state = "failed";
    receipt.failure = "BACKUP_FAILED";
    await save(receipt);
    throw new Error("BACKUP_FAILED");
  }
}

function verificationVariables(
  receipt: MongoBackupReceipt,
  filename = "mongo.archive.gz.age",
) {
  if (
    !RUN.test(receipt.runId) || !receipt.transferVerified ||
    !Number.isSafeInteger(receipt.bytes) || receipt.bytes! <= 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
  ) throw new Error("RECEIPT_INVALID");
  return `run_id = ${JSON.stringify(receipt.runId)}\nfilename = ${
    JSON.stringify(filename)
  }\nexpected_bytes = ${receipt.bytes}\nexpected_sha256 = ${
    JSON.stringify(receipt.sha256)
  }\n`;
}

export async function verifyMongoBackup(
  config: MongoBackupConfig,
  receipt: MongoBackupReceipt,
  runner: Runner,
): Promise<void> {
  receipt.integrityVerified = false;
  try {
    await checkSsh(config, runner);
    await command(
      runner,
      remoteCommand(config, verificationVariables(receipt) + verifyBody),
      config.timeoutSeconds * 1000,
    );
    receipt.integrityVerified = true;
    receipt.state = "verified";
    delete receipt.failure;
  } catch {
    receipt.state = "failed";
    receipt.restoreVerified = false;
    receipt.failure = "INTEGRITY_VERIFICATION_FAILED";
    throw new Error("INTEGRITY_VERIFICATION_FAILED");
  }
}

export const RESTORE_VALIDATION = `try {
 const databases=db.getSiblingDB('admin').runCommand({listDatabases:1}); if(databases.ok!==1)quit(1);
 let collections=0, documents=0;
 for(const item of databases.databases){if(item.name==='local')continue; const target=db.getSiblingDB(item.name);
 for(const c of target.getCollectionInfos({type:'collection'})){const result=target.runCommand({validate:c.name,full:true});
 if(result.ok!==1||result.valid!==true)quit(1); collections++; documents+=target.getCollection(c.name).countDocuments({});}}
 if(!collections)quit(1); print(JSON.stringify({collections,documents}));
}catch(_){quit(1);}`;

export async function restoreMongoDrill(
  config: MongoBackupConfig,
  receipt: MongoBackupReceipt,
  identityFile: string,
  runner: Runner,
  save: SaveReceipt,
  disposable: boolean,
): Promise<void> {
  if (!disposable || !absolute(identityFile) || !receipt.integrityVerified) {
    throw new Error("RESTORE_REQUIRES_EXPLICIT_DISPOSABLE_TARGET");
  }
  try {
    await verifyMongoBackup(config, receipt, runner);
  } finally {
    await save(receipt);
  }
  const nonce = crypto.randomUUID();
  const container = "mycelia-restore-" + nonce;
  const volume = container + "-data";
  const label = "tech.mycelia.restore-drill=" + nonce;
  receipt.restoreVerified = false;
  receipt.restore = { container, volume, state: "creating" };
  await save(receipt);
  let created = false;
  const children: RunningCommand[] = [];
  try {
    // Docker volume create is idempotent: check absence, then verify a random
    // ownership label before ever mounting it; never accept an existing target.
    const absent = await runner.run(["docker", "volume", "inspect", volume], {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    if (absent.code === 0 || absent.timedOut) {
      throw new Error("RESTORE_VOLUME_EXISTS");
    }
    await command(runner, [
      "docker",
      "volume",
      "create",
      "--label",
      label,
      volume,
    ]);
    const ownership = await command(runner, [
      "docker",
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "tech.mycelia.restore-drill"}}',
      volume,
    ]);
    if (ownership !== nonce) {
      throw new Error("RESTORE_VOLUME_OWNERSHIP_MISMATCH");
    }
    await command(runner, [
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/data/configdb",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--mount",
      `type=volume,source=${volume},target=/data/db`,
      config.restoreImage,
      "mongod",
      "--bind_ip",
      "127.0.0.1",
      "--noauth",
    ]);
    created = true;
    const restoredVersion = await command(runner, [
      "docker",
      "exec",
      container,
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
      "let ready=false;for(let i=0;i<60;i++){try{const admin=new Mongo('mongodb://127.0.0.1:27017').getDB('admin');if(admin.runCommand({ping:1}).ok===1){print(admin.version());ready=true;break;}}catch(_){}sleep(1000);}if(!ready)quit(1);",
    ], 90_000);
    if (
      !/^\d+\.\d+\.\d+/.test(restoredVersion) ||
      restoredVersion.split(".")[0] !== receipt.sourceVersion?.split(".")[0]
    ) throw new Error("RESTORE_VERSION_MISMATCH");
    receipt.restore.state = "restoring";
    await save(receipt);
    const options = { timeoutMs: config.timeoutSeconds * 1000 };
    const restore = runner.spawn([
      "docker",
      "exec",
      "-i",
      container,
      "mongorestore",
      "--archive",
      "--gzip",
      "--oplogReplay",
      "--stopOnError",
      "--quiet",
    ], options);
    children.push(restore);
    const decrypt = runner.spawn([
      "age",
      "--decrypt",
      "--identity",
      identityFile,
    ], options);
    children.push(decrypt);
    const remote = runner.spawn(
      remoteCommand(
        config,
        verificationVariables(receipt) + verifyBody +
          "with open(archive, 'rb') as f:\n    shutil.copyfileobj(f, sys.stdout.buffer, 1024 * 1024)\n",
      ),
      options,
    );
    children.push(remote);
    const restoredDigest = await transferEncrypted(
      [remote, decrypt, restore],
      0,
    );
    if (
      restoredDigest.bytes !== receipt.bytes ||
      restoredDigest.sha256 !== receipt.sha256
    ) {
      receipt.integrityVerified = false;
      receipt.state = "failed";
      receipt.failure = "RESTORE_STREAM_INTEGRITY_MISMATCH";
      throw new Error("RESTORE_STREAM_INTEGRITY_MISMATCH");
    }
    const validation = JSON.parse(
      await command(runner, [
        "docker",
        "exec",
        container,
        "mongosh",
        "--quiet",
        "--eval",
        RESTORE_VALIDATION,
      ], options.timeoutMs),
    );
    if (
      !Number.isSafeInteger(validation.collections) ||
      validation.collections < 1 ||
      !Number.isSafeInteger(validation.documents) || validation.documents < 0
    ) throw new Error("RESTORE_VALIDATION_FAILED");
    receipt.restore = {
      container,
      volume,
      state: "verified",
      checkedCollections: validation.collections,
      checkedDocuments: validation.documents,
    };
    receipt.restoreVerified = true;
    await save(receipt);
  } catch {
    receipt.restore.state = "failed";
    receipt.restoreVerified = false;
    await save(receipt);
    throw new Error("RESTORE_DRILL_FAILED");
  } finally {
    for (const child of children) child.kill();
    await Promise.allSettled(children.map((child) => child.status));
    if (created) {
      // Keep its volume and stopped container. Cleanup requires a separate,
      // explicit user action; this command never removes data or containers.
      try {
        await command(
          runner,
          ["docker", "stop", "--time", "30", container],
          45_000,
        );
        receipt.restore.state = receipt.restoreVerified
          ? "verified_stopped"
          : "failed_stopped";
        await save(receipt);
      } catch {
        receipt.restore.state = "stop_unverified";
        await save(receipt);
        // Cleanup uncertainty must fail the command even after a valid restore.
        // deno-lint-ignore no-unsafe-finally
        throw new Error("RESTORE_DRILL_STOP_UNVERIFIED");
      }
    }
  }
}

async function privateFile(path: string) {
  const stat = await Deno.lstat(path);
  if (!stat.isFile || stat.isSymlink || ((stat.mode ?? 0) & 0o077)) {
    throw new Error("PRIVATE_FILE_REQUIRED");
  }
}

export async function mongoBackupMain(
  args: string[],
  runner: Runner = new DenoRunner(),
) {
  const [action, ...rest] = args;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (
      !["--config", "--run-id", "--identity-file", "--disposable"].includes(
        key,
      ) || options.has(key)
    ) throw new Error("USAGE_ERROR");
    if (key === "--disposable") options.set(key, "true");
    else {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error("USAGE_ERROR");
      options.set(key, value);
    }
  }
  if (
    !["backup", "verify", "restore-drill"].includes(action) ||
    !options.has("--config")
  ) throw new Error("USAGE_ERROR");
  const config = parseMongoBackupConfig(
    JSON.parse(await Deno.readTextFile(options.get("--config")!)),
  );
  await Deno.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const stat = await Deno.lstat(config.stateDir);
  if (
    !stat.isDirectory || stat.isSymlink || ((stat.mode ?? 0) & 0o077) ||
    await Deno.realPath(config.stateDir) !== config.stateDir
  ) throw new Error("PRIVATE_STATE_DIRECTORY_REQUIRED");
  const lock = await Deno.open(join(config.stateDir, "mongo.lock"), {
    create: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(true);
  try {
    const save: SaveReceipt = async (receipt) => {
      const path = join(config.stateDir, receipt.runId + ".json");
      const temporary = path + ".next-" + crypto.randomUUID();
      const file = await Deno.open(temporary, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      try {
        const bytes = encode(JSON.stringify(receipt, null, 2) + "\n");
        let offset = 0;
        while (offset < bytes.length) {
          offset += await file.write(bytes.subarray(offset));
        }
        await file.sync();
      } finally {
        file.close();
      }
      await Deno.rename(temporary, path);
    };
    let receipt: MongoBackupReceipt;
    if (action === "backup") {
      receipt = await createMongoBackup(config, runner, save);
    } else {
      const runId = options.get("--run-id") ?? "";
      if (!RUN.test(runId)) throw new Error("RUN_ID_INVALID");
      const path = join(config.stateDir, runId + ".json");
      await privateFile(path);
      receipt = JSON.parse(await Deno.readTextFile(path));
      if (
        receipt.runId !== runId || receipt.schema !== 2 ||
        receipt.encryptedAtRest !== true
      ) throw new Error("RECEIPT_INVALID");
      if (action === "verify") {
        try {
          await verifyMongoBackup(config, receipt, runner);
        } finally {
          await save(receipt);
        }
      } else {
        const identity = options.get("--identity-file") ?? "";
        if (!absolute(identity)) throw new Error("IDENTITY_FILE_REQUIRED");
        await privateFile(identity);
        await restoreMongoDrill(
          config,
          receipt,
          identity,
          runner,
          save,
          options.has("--disposable"),
        );
      }
    }
    console.log(JSON.stringify(receipt));
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  try {
    await mongoBackupMain(Deno.args);
  } catch {
    console.error(
      "Mongo backup operation failed; inspect the local receipt. No secrets or child diagnostics are printed.",
    );
    Deno.exitCode = 1;
  }
}
