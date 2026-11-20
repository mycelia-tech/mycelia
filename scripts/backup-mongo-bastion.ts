/** One-shot logical Mongo backup. Separate from the restic/PITR workflow. */
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MONGO_PREFLIGHT_SCRIPT } from "./backup/preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "/mnt/datadrive/db-backups";
const SSH = [
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
  "faeon",
];
const DOCKER = "/usr/local/bin/docker";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

// Check the real mounted volume, not a fallback directory on the root disk.
export const remoteGuard = `
import os, sys, stat, json, hashlib, shutil, subprocess
base = ${JSON.stringify(TARGET)}
assert os.path.realpath(base) == base, "symlink destination"
assert os.path.ismount('/mnt/datadrive'), "data disk not mounted"
assert subprocess.check_output(['findmnt','-n','-o','TARGET','-T',base], text=True).strip() == '/mnt/datadrive', "wrong mount"
s = os.stat(base)
assert stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid(), "wrong owner"
assert s.st_mode & 0o077 == 0, "backup directory is not private"
os.umask(0o077)
`;

export const receiveBody = `
assert shutil.disk_usage(base).free >= minimum, "insufficient free space"
run = os.path.join(base, run_id)
os.mkdir(run, 0o700)
os.chmod(run, 0o700)
with open(os.path.join(run, 'mongo.archive.gz.partial'), 'xb') as f:
    os.fchmod(f.fileno(), 0o600)  # Default disk ACLs can override umask.
    shutil.copyfileobj(sys.stdin.buffer, f, 1024 * 1024)
    f.flush()
    os.fsync(f.fileno())
`;

// Called only after mongodump AND the SSH receiver exit successfully.
export const finalizeBody = `
run = os.path.join(base, run_id)
assert os.path.realpath(run) == run and os.stat(run).st_uid == os.getuid()
partial = os.path.join(run, 'mongo.archive.gz.partial')
assert not os.path.islink(partial)
digest = hashlib.sha256()
size = 0
with open(partial, 'rb') as f:
    for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
        digest.update(block)
        size += len(block)
assert size > 0 and size == expected_bytes, "size mismatch"
assert digest.hexdigest() == expected_sha256, "checksum mismatch"
archive = os.path.join(run, 'mongo.archive.gz')
# Exclusive hard link: never overwrite an existing accepted archive.
os.link(partial, archive)
os.unlink(partial)
with open(os.path.join(run, 'SHA256SUMS'), 'x') as f:
    os.fchmod(f.fileno(), 0o600)
    f.write(expected_sha256 + '  mongo.archive.gz\\n')
    f.flush()
    os.fsync(f.fileno())
with open(os.path.join(run, 'manifest.json.partial'), 'x') as f:
    os.fchmod(f.fileno(), 0o600)
    json.dump(manifest, f, indent=2)
    f.write('\\n')
    f.flush()
    os.fsync(f.fileno())
os.link(os.path.join(run, 'manifest.json.partial'), os.path.join(run, 'manifest.json'))
os.unlink(os.path.join(run, 'manifest.json.partial'))
fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(fd)
os.close(fd)
fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(fd)
os.close(fd)
print(json.dumps({'sha256': digest.hexdigest(), 'bytes': size}))
`;

function remote(script: string, input = false) {
  return new Deno.Command("/usr/bin/ssh", {
    args: [...SSH, "python3 -c " + quote(script)],
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "inherit",
  });
}

async function output(command: Deno.Command): Promise<string> {
  const result = await command.output();
  if (!result.success) throw new Error(`Command exited ${result.code}`);
  return new TextDecoder().decode(result.stdout).trim();
}

export async function transfer(
  producer: Deno.ChildProcess,
  receiver: Deno.ChildProcess,
  progress: (bytes: number) => void = () => {},
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  let lastReport = Date.now();
  try {
    const pipe = producer.stdout.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          hash.update(chunk);
          bytes += chunk.length;
          if (Date.now() - lastReport >= 30_000) {
            progress(bytes);
            lastReport = Date.now();
          }
          controller.enqueue(chunk);
        },
      }),
    ).pipeTo(receiver.stdin);
    // Receiver never emits archive data; drain its small diagnostic output.
    const drain = receiver.stdout.pipeTo(new WritableStream());
    const [, , source, destination] = await Promise.all([
      pipe,
      drain,
      producer.status,
      receiver.status,
    ]);
    if (!source.success || !destination.success || bytes === 0) {
      throw new Error(
        `Transfer failed: dump=${source.code}, ssh=${destination.code}`,
      );
    }
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    for (const child of [producer, receiver]) {
      try {
        child.kill("SIGTERM");
      } catch { /* Already exited. */ }
    }
    await Promise.allSettled([producer.status, receiver.status]);
    throw error;
  }
}

async function main() {
  if (Deno.args.length) {
    throw new Error("Usage: deno run -A scripts/backup-mongo-bastion.ts");
  }
  const dir = resolve(ROOT, ".local/backup/bastion-mongo");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(dir);
  if (!info.isDirectory || info.isSymlink || (info.mode! & 0o077)) {
    throw new Error("Local state directory must be private");
  }
  const lock = await Deno.open(`${dir}/run.lock`, {
    create: true,
    write: true,
    mode: 0o600,
  });
  if (!lock.tryLock(true)) {
    throw new Error("A bastion Mongo backup is already running");
  }
  const runId = "mycelia-" + new Date().toISOString().replace(/[-:.]/g, "") +
    "-" + crypto.randomUUID();
  const statePath = `${dir}/${runId}.json`;
  const state: Record<string, unknown> = {
    schema: 1,
    runId,
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    state: "preflight",
    destination: `faeon:${TARGET}/${runId}`,
    encryptedAtRest: false,
    restoreVerified: false,
    scope:
      "full MongoDB logical archive including oplog; no external files or app secrets",
  };
  async function save() {
    await Deno.writeTextFile(
      statePath + ".tmp",
      JSON.stringify(state, null, 2) + "\n",
      { mode: 0o600 },
    );
    await Deno.rename(statePath + ".tmp", statePath);
    console.log(JSON.stringify(state));
  }
  try {
    await save();
    const effective = await output(
      new Deno.Command("/usr/bin/ssh", { args: ["-G", "faeon"] }),
    );
    if (
      !/^hostname 100\.119\.163\.116$/m.test(effective) ||
      !/^user Skywinder$/m.test(effective)
    ) {
      throw new Error("Unexpected SSH destination");
    }
    const container = await output(
      new Deno.Command(DOCKER, {
        args: ["compose", "ps", "-q", "mongo"],
        cwd: ROOT,
      }),
    );
    if (!/^[0-9a-f]{12,64}$/.test(container)) {
      throw new Error("Expected one running Mongo container");
    }
    const source = JSON.parse(
      await output(
        new Deno.Command(DOCKER, {
          args: [
            "exec",
            container,
            "mongosh",
            "--quiet",
            "mycelia",
            "--eval",
            MONGO_PREFLIGHT_SCRIPT,
          ],
        }),
      ),
    );
    if (
      !source.ping || !source.writablePrimary ||
      source.oplogWindowSeconds < 3600
    ) {
      throw new Error("Mongo primary/oplog preflight failed");
    }
    // Do not put credentials in process arguments. Authenticated sources need
    // a separate reviewed credential transport before using this one-shot tool.
    if (source.authorization !== "disabled") {
      throw new Error("Authenticated source is not supported by this command");
    }
    const minimum = Math.max(200 * 1024 ** 3, source.databaseBytes * 2);
    await output(
      remote(
        remoteGuard +
          `\nassert shutil.disk_usage(base).free >= ${minimum}\nprint('ready')\n`,
      ),
    );
    state.sourceContainer = container;
    state.source = source;
    state.state = "streaming";
    await save();
    const receiver = remote(
      remoteGuard +
        `\nrun_id = ${JSON.stringify(runId)}\nminimum = ${minimum}\n` +
        receiveBody,
      true,
    ).spawn();
    let producer: Deno.ChildProcess;
    try {
      producer = new Deno.Command(DOCKER, {
        args: [
          "exec",
          container,
          "mongodump",
          "--host=127.0.0.1",
          "--port=27017",
          "--archive",
          "--gzip",
          "--oplog",
          "--numParallelCollections=2",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
    } catch (error) {
      receiver.kill("SIGTERM");
      await receiver.status;
      throw error;
    }
    const result = await transfer(producer, receiver, (bytes) => {
      console.log(
        JSON.stringify({
          runId,
          state: "streaming",
          bytes,
          at: new Date().toISOString(),
        }),
      );
    });
    Object.assign(state, result, {
      state: "verifying",
      dumpFinishedAt: new Date().toISOString(),
    });
    await save();
    const manifest = {
      ...state,
      state: "transfer_verified",
      completedAt: new Date().toISOString(),
    };
    await output(
      remote(
        remoteGuard +
          `\nrun_id = ${
            JSON.stringify(runId)
          }\nexpected_bytes = ${result.bytes}\nexpected_sha256 = ${
            JSON.stringify(result.sha256)
          }\nmanifest = json.loads(${
            JSON.stringify(JSON.stringify(manifest))
          })\n` + finalizeBody,
      ),
    );
    Object.assign(state, manifest);
    await save();
  } catch (error) {
    state.state = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    await save();
    throw error;
  } finally {
    lock.close();
  }
}

if (import.meta.main) await main();
