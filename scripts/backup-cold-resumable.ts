/** Fixed APFS cold snapshot + resumable rsync + isolated remote restore. */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteGuard } from "./backup-mongo-bastion.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, ".local/backup/cold-resumable");
const SOURCE = "/Users/pk/.mycelia/data/mongo";
const REMOTE = "/mnt/datadrive/db-backups";
const DOCKER = "/usr/local/bin/docker";
const RSYNC = "/opt/homebrew/bin/rsync";
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
  "ServerAliveCountMax=3",
  "faeon",
];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runPattern = /^mycelia-cold-[0-9TZ]+-[a-f0-9-]{36}$/;

async function command(bin: string, args: string[], inherit = false) {
  const p = new Deno.Command(bin, {
    args,
    cwd: ROOT,
    stdin: "null",
    stdout: inherit ? "inherit" : "piped",
    stderr: "inherit",
  }).spawn();
  if (inherit) {
    const status = await p.status;
    if (!status.success) throw Error(`${bin} exit ${status.code}`);
    return "";
  }
  const out = await p.output();
  if (!out.success) throw Error(`${bin} exit ${out.code}`);
  return text(out.stdout);
}
const ssh = (cmd: string) => command("/usr/bin/ssh", [...SSH, cmd]);

export async function inventory(
  root: string,
): Promise<{ path: string; size: number; mtime: number; ino: number }[]> {
  const found: { path: string; size: number; mtime: number; ino: number }[] =
    [];
  async function walk(dir: string, rel = "") {
    for await (const e of Deno.readDir(dir)) {
      const name = rel ? rel + "/" + e.name : e.name;
      const path = join(dir, e.name);
      const s = await Deno.lstat(path);
      if (s.isSymlink || (!s.isFile && !s.isDirectory)) {
        throw Error("Unsupported source entry: " + name);
      }
      if (s.isDirectory) await walk(path, name);
      else {found.push({
          path: name,
          size: s.size,
          mtime: s.mtime?.getTime() ?? 0,
          ino: s.ino ?? 0,
        });}
    }
  }
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export async function cloneTree(source: string, dest: string) {
  // clonefile is mandatory: unlike cp -c, it cannot fall back to a full copy.
  const lib = Deno.dlopen("/usr/lib/libSystem.B.dylib", {
    clonefile: { parameters: ["buffer", "buffer", "i32"], result: "i32" },
  });
  try {
    await Deno.mkdir(dest, { mode: 0o700 });
    const files = await inventory(source);
    for (const f of files) {
      const to = join(dest, f.path);
      await Deno.mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const encode = (s: string) => new TextEncoder().encode(s + "\0");
      if (
        lib.symbols.clonefile(encode(join(source, f.path)), encode(to), 1) !== 0
      ) throw Error("APFS clone failed: " + f.path);
      await Deno.chmod(to, 0o400);
    }
    return files;
  } finally {
    lib.close();
  }
}

async function checkStopped() {
  const all = (await command(DOCKER, ["ps", "-q"])).split(/\s+/).filter(
    Boolean,
  );
  if (!all.length) return;
  const containers = JSON.parse(await command(DOCKER, ["inspect", ...all]));
  for (const c of containers) {
    if (
      c.Mounts.some((m: { Source: string }) =>
        m.Source === SOURCE || SOURCE.startsWith(m.Source + "/")
      )
    ) throw Error("Source is mounted by a running container: " + c.Name);
  }
}

async function save(path: string, data: unknown) {
  const file = await Deno.open(path + ".tmp", {
    create: true,
    truncate: true,
    write: true,
    mode: 0o600,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n");
  try {
    let n = 0;
    while (n < bytes.length) n += await file.write(bytes.subarray(n));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(path + ".tmp", path);
}

async function prepare() {
  await checkStopped();
  const sourceStat = await Deno.lstat(SOURCE);
  if (!sourceStat.isDirectory || sourceStat.isSymlink) {
    throw Error("Unsafe source path");
  }
  const id = "mycelia-cold-" + new Date().toISOString().replace(/[-:.]/g, "") +
    "-" + crypto.randomUUID();
  const dir = join(STATE, id);
  await Deno.mkdir(dir, { mode: 0o700 });
  const snapshot = join(dir, "snapshot");
  await Deno.mkdir(snapshot, { mode: 0o700 });
  console.log(JSON.stringify({ id, state: "cloning" }));
  const before = await cloneTree(SOURCE, join(snapshot, "db"));
  await checkStopped();
  if (JSON.stringify(before) !== JSON.stringify(await inventory(SOURCE))) {
    throw Error("Source changed during cloning; snapshot NOT accepted");
  }
  const info =
    JSON.parse(await command(DOCKER, ["inspect", "mycelia-mongo-1"]))[0];
  const digests = JSON.parse(
    await command(DOCKER, [
      "image",
      "inspect",
      info.Image,
      "--format",
      "{{json .RepoDigests}}",
    ]),
  );
  const mongoImage = digests.find((s: string) =>
    /^mongo@sha256:[a-f0-9]{64}$/.test(s)
  );
  if (!mongoImage) throw Error("Missing pinned Mongo image digest");
  const config = join(snapshot, "config");
  await Deno.mkdir(config, { mode: 0o700 });
  for (
    const name of [
      ".env",
      ".env.backup",
      "docker-compose.yml",
      "docker-compose.media-uat.yml",
      "docker-compose.media-disks.yml",
      "misc/mongo/mongod.conf",
      "misc/mongo/mongo-entrypoint.sh",
    ]
  ) {
    try {
      const s = await Deno.lstat(join(ROOT, name));
      if (!s.isFile || s.isSymlink) throw Error("Unsafe config path");
      const target = join(config, name);
      await Deno.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await Deno.copyFile(join(ROOT, name), target);
      await Deno.chmod(target, 0o400);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  await save(join(dir, "source.json"), {
    id,
    source: SOURCE,
    mongoImage,
    sourceContainer: info.Id,
    createdAt: new Date().toISOString(),
    state: "cloned",
    sourceCleanShutdown: info.State.ExitCode === 0,
    encryptedAtRest: false,
  });
  console.log(
    JSON.stringify({
      id,
      state: "cloned",
      files: before.length,
      bytes: before.reduce((n, f) => n + f.size, 0),
    }),
  );
  return id;
}

async function hashSnapshot(dir: string) {
  const snapshot = join(dir, "snapshot");
  const source = JSON.parse(await Deno.readTextFile(join(dir, "source.json")));
  const entries = (await inventory(snapshot)).filter((f) =>
    !["manifest.json", "manifest.json.tmp"].includes(f.path)
  );
  const files = [];
  let bytes = 0;
  let last = Date.now();
  for (const e of entries) {
    const hash = createHash("sha256");
    const f = await Deno.open(join(snapshot, e.path));
    for await (const block of f.readable) hash.update(block);
    files.push({ path: e.path, size: e.size, sha256: hash.digest("hex") });
    bytes += e.size;
    if (Date.now() - last > 30_000) {
      console.log(
        JSON.stringify({ state: "hashing", files: files.length, bytes }),
      );
      last = Date.now();
    }
  }
  await save(join(snapshot, "manifest.json"), {
    ...source,
    files,
    scope: "cold Mongo data and app configuration; external media excluded",
  });
}

async function run(id: string) {
  if (!runPattern.test(id)) throw Error("Invalid run id");
  const dir = join(STATE, id);
  const lock = await Deno.open(join(dir, "run.lock"), {
    create: true,
    write: true,
    mode: 0o600,
  });
  if (!lock.tryLock(true)) throw Error("This backup is already running");
  try {
    await Deno.stat(join(dir, "source.json")); // Only a completed cold clone may be sent.
    const effective = await command("/usr/bin/ssh", ["-G", "faeon"]);
    if (
      !/^hostname 100\.119\.163\.116$/m.test(effective) ||
      !/^user Skywinder$/m.test(effective)
    ) throw Error("SSH destination changed");
    try {
      await Deno.stat(join(dir, "snapshot/manifest.json"));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      await hashSnapshot(dir);
    }
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "snapshot/manifest.json")),
    );
    const expected = manifest.files.reduce(
      (n: number, f: { size: number }) => n + f.size,
      0,
    );
    const remote = REMOTE + "/" + id;
    const setup = remoteGuard +
      `\nassert subprocess.check_output(['findmnt','-n','-o','UUID','-T',base],text=True).strip() == '816b292e-4e7e-4965-85b8-24abbb3e000d'\nrun = ${
        JSON.stringify(remote)
      }\nif not os.path.exists(run): os.mkdir(run,0o700)\nassert os.path.realpath(run)==run and os.stat(run).st_uid==os.getuid()\nos.chmod(run,0o700)\nassert shutil.disk_usage(run).free > ${
        expected * 2 + 10 * 1024 ** 3
      }\nprint('ready')\n`;
    let attempt = 0;
    while (true) {
      attempt++;
      await save(join(dir, "status.json"), {
        id,
        state: "transferring",
        attempt,
        pid: Deno.pid,
        updatedAt: new Date().toISOString(),
      });
      try {
        await ssh("python3 -c " + quote(setup));
        await command(RSYNC, [
          "-rltz",
          "--compress-choice=zstd",
          "--partial-dir=.rsync-partial",
          "--timeout=90",
          "--fsync",
          "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
          "--info=progress2,stats2",
          "-e",
          "/usr/bin/ssh " + SSH.slice(0, -1).join(" "),
          join(dir, "snapshot"),
          "faeon:" + remote + "/",
        ], true);
        break;
      } catch (error) {
        const failed = {
          id,
          state: "retry_wait",
          attempt,
          error: String(error),
          at: new Date().toISOString(),
        };
        console.log(JSON.stringify(failed));
        await save(join(dir, "status.json"), failed);
        await pause(Math.min(attempt * 10, 60) * 1000);
      }
    }
    while (true) {
      try {
        await command(RSYNC, [
          "-rt",
          "--chmod=Fu=rw,Fgo=",
          "-e",
          "/usr/bin/ssh " + SSH.slice(0, -1).join(" "),
          join(ROOT, "scripts/backup/cold-worker.py"),
          "faeon:" + remote + "/worker.py",
        ]);
        await ssh(
          "umask 077; nohup python3 " + quote(remote + "/worker.py") + " " +
            quote(remote) + " >> " + quote(remote + "/worker.log") +
            " 2>&1 < /dev/null &",
        );
        break;
      } catch (e) {
        console.log("Retrying verification worker startup: " + String(e));
        await pause(30_000);
      }
    }
    while (true) {
      try {
        const status = JSON.parse(
          await ssh("cat " + quote(remote + "/restore-status.json")),
        );
        await save(join(dir, "status.json"), { id, ...status });
        console.log(JSON.stringify({ id, ...status }));
        if (status.state === "complete") return;
        if (status.state === "failed") {
          throw new Error("REMOTE_RESTORE_FAILED: " + status.failure);
        }
      } catch (e) {
        if (String(e).includes("REMOTE_RESTORE_FAILED")) throw e;
        console.log("Verification status temporarily unavailable; retrying");
      }
      await pause(45_000);
    }
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  await Deno.mkdir(STATE, { recursive: true, mode: 0o700 });
  const [mode, id] = Deno.args;
  if (mode === "start" && !id) await run(await prepare());
  else if (mode === "resume" && id) await run(id);
  else {throw Error(
      "Usage: deno run -A scripts/backup-cold-resumable.ts start | resume <run-id>",
    );}
}
