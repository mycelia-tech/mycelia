import { type BackupConfig, loadBackupConfig } from "./config.ts";
import {
  buildSourceManifest,
  type ManifestOptions,
  type ProtectedConfig,
  reconcileSourcePaths,
  type RuntimeLocation,
  type SourceManifest,
} from "./sources.ts";
import {
  type BaseChildEnvironment,
  FAILURE_CODES,
  type FailureCode,
  type Runner,
} from "./types.ts";
import { collectBoundedStream, DenoRunner } from "./runner.ts";
import { failureError, isBackupId } from "./redact.ts";
import { readMongoSourcePaths } from "./mongo.ts";
import { assertRcloneEnvironment, checkRemote } from "./remote.ts";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseEnvText } from "../check-env.ts";
import {
  assertOwnedLockLease,
  type OwnedLockLease,
  readEffectiveUid,
} from "./state.ts";
import {
  assertRcloneConfigIdentity,
  defaultRcloneConfigPath,
  pinDefaultRcloneConfig,
  type RcloneConfigIdentity,
  readAttestedRcloneConfigText,
} from "./rclone-config.ts";
export type Mount = { Type: string; Source: string; Destination: string };
export type DeploymentContext = {
  mongo: Mount[];
  redis: Mount[];
  rag: { active: false } | { active: true; qdrant: Mount[]; service: Mount[] };
  protectedConfig: ProtectedConfig;
  archiveRoot: string;
  picturesImportRoot?: string;
  voiceMemos?: ManifestOptions["voiceMemos"];
  excludedRoots?: string[];
};
export type PreflightOptions = {
  backupId?: string;
  composeRoot: string;
  remoteMode: "full" | "skip";
  expectedInstallationId?: string;
  lockLease?: OwnedLockLease;
};
export type PreflightDependencies = {
  runner?: Runner;
  homeDir?: string;
  tempFreeBytes?: () => Promise<number>;
  localFloorBytes?: number;
  context?: (config: BackupConfig) => Promise<DeploymentContext>;
};
export type PreflightReport = {
  schema: 1;
  ok: boolean;
  remoteVerified: boolean;
  backupId: string;
  failure?: FailureCode;
  localVerified: boolean;
  versions?: { restic: string; rclone: string; mongodump?: string };
  localFreeBytes?: number;
  fileBytes?: number;
  databaseBytes?: number;
  oplogWindowSeconds?: number;
  sourceCoverage?: { complete: boolean; total: number; covered: number };
  namespace?: "reservable" | "owned";
  requiredBytes?: number;
  freeBytes?: number;
};
// Streaming workspace only: no database-size local staging. This is a capacity
// floor, not a measured dump duration or an RPO claim.
export const LOCAL_WORKSPACE_FLOOR_BYTES = 1024 ** 3;
// Preliminary first-run gate; Task 7 MUST repeat with measured duration +25%.
export const PRELIMINARY_OPLOG_SECONDS = 3600;
function fail(code: FailureCode): never {
  throw failureError(code);
}
function controlCharacters(value: string): boolean {
  return [...value].some((char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
  );
}
function path(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !isAbsolute(value) ||
    controlCharacters(value) || value.split("/").includes("..")
  ) fail("SOURCE_COVERAGE_INCOMPLETE");
}
function baseChildEnvironment(homeDir: string): BaseChildEnvironment {
  path(homeDir);
  if (homeDir.includes(":")) fail("CONFIG_INVALID");
  return Object.freeze({
    HOME: homeDir,
    PATH: `${homeDir}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  });
}
function exactEnvironmentRunner(
  runner: Runner,
  environment: Readonly<Record<string, string>>,
): Runner {
  const env = Object.freeze({ ...environment });
  return {
    run: (argv, options) =>
      runner.run(argv, { ...options, clearEnv: true, env }),
    spawn: (argv, options) =>
      runner.spawn(argv, { ...options, clearEnv: true, env }),
  };
}

function attestedRcloneRunner(
  runner: Runner,
  identity: RcloneConfigIdentity,
): Runner {
  const protectedTool = (argv: readonly string[]) =>
    argv[0] === "rclone" || argv[0] === "restic";
  return {
    run: async (argv, options) => {
      if (protectedTool(argv)) {
        await assertRcloneConfigIdentity(identity);
      }
      return await runner.run(argv, options);
    },
    spawn: (argv, options) => {
      if (protectedTool(argv)) {
        // Identity attestation is asynchronous. Never introduce an unattested
        // streaming rclone/restic launch through this synchronous interface.
        fail("CONFIG_INVALID");
      }
      return runner.spawn(argv, options);
    },
  };
}
function location(mounts: Mount[], target: string): RuntimeLocation {
  if (!Array.isArray(mounts)) fail("SOURCE_COVERAGE_INCOMPLETE");
  for (const mount of mounts) path(mount?.Destination);
  // One RuntimeLocation cannot represent an overlaid subtree. Refuse both
  // subordinate and ancestor mounts rather than dropping host runtime bytes
  // from the exclusion contract. Adjacent path components are unrelated.
  if (
    mounts.some((mount) =>
      mount.Destination !== target && (
        mount.Destination === "/" ||
        mount.Destination.startsWith(target + "/") ||
        target.startsWith(mount.Destination + "/")
      )
    )
  ) fail("SOURCE_COVERAGE_INCOMPLETE");
  const found = mounts.filter((m) => m?.Destination === target);
  if (found.length !== 1) fail("SOURCE_COVERAGE_INCOMPLETE");
  const mount = found[0];
  if (mount.Type === "volume") return { kind: "named-volume" };
  if (mount.Type !== "bind") fail("SOURCE_COVERAGE_INCOMPLETE");
  path(mount.Source);
  return { kind: "host-path", path: mount.Source };
}
export function resolveManifestOptions(
  context: DeploymentContext,
): ManifestOptions {
  try {
    const protectedConfig = context.protectedConfig;
    for (
      const slot of [
        "media",
        "rag",
        "tls",
        "rclone",
        "provider",
        "mongoKeyfile",
        "pbm",
        "icloudArchive",
      ] as const
    ) {
      const value = protectedConfig?.[slot];
      if (!value || typeof value.active !== "boolean") {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      const keys = slot === "tls"
        ? ["certificate", "privateKey"]
        : slot === "rclone"
        ? ["config", "knownHosts"]
        : slot === "pbm"
        ? ["env", "ca"]
        : ["path"];
      if (Object.keys(value).some((k) => k !== "active" && !keys.includes(k))) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      if (value.active) {
        for (const key of keys) path((value as Record<string, unknown>)[key]);
      }
    }
    if (
      !protectedConfig.rclone?.active || !protectedConfig.icloudArchive?.active
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    if (
      !context.rag || typeof context.rag.active !== "boolean" ||
      context.rag.active !== protectedConfig.rag?.active
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    path(context.archiveRoot);
    return {
      runtimeRoots: {
        mongo: location(context.mongo, "/data/db"),
        redis: location(context.redis, "/data"),
        rag: context.rag.active
          ? {
            active: true,
            qdrant: location(context.rag.qdrant, "/qdrant/storage"),
            state: location(context.rag.service, "/data"),
            modelCache: location(context.rag.service, "/models"),
          }
          : { active: false },
      },
      protectedConfig,
      archiveRoot: context.archiveRoot,
      picturesImportRoot: context.picturesImportRoot,
      voiceMemos: context.voiceMemos,
      excludedRoots: context.excludedRoots,
    };
  } catch {
    return fail("SOURCE_COVERAGE_INCOMPLETE");
  }
}
async function command(
  runner: Runner,
  argv: string[],
  code: FailureCode = "COMMAND_FAILED",
): Promise<string> {
  try {
    const result = await runner.run(argv, {
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    try {
      if (result.code !== 0 || result.timedOut) fail(code);
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  } catch {
    return fail(code);
  }
}
function version(
  text: string,
  tool: "restic" | "rclone" | "mongodump",
  min: number[],
): string {
  const prefix = tool === "rclone"
    ? "rclone v"
    : tool === "mongodump"
    ? "mongodump version: "
    : "restic ";
  const match = text.match(
    new RegExp(`^${prefix}(\\d+)\\.(\\d+)\\.(\\d+)(?:\\s|$)`),
  );
  if (!match) fail("COMMAND_FAILED");
  const parts = match.slice(1).map(Number);
  if (parts.some((x) => !Number.isSafeInteger(x))) fail("COMMAND_FAILED");
  const different = parts.findIndex((v, i) => v !== min[i]);
  if (different >= 0 && parts[different] < min[different]) {
    fail("COMMAND_FAILED");
  }
  return parts.join(".");
}
type Service = { ID: string; Service: string; State: string; Health: string };
function services(text: string): Service[] {
  try {
    const parsed: unknown = text.trim().startsWith("[")
      ? JSON.parse(text)
      : text.trim().split("\n").map((l) => JSON.parse(l));
    if (
      !Array.isArray(parsed) ||
      parsed.some((v) =>
        !v || !(/^[a-f0-9]{12,64}$/).test(v.ID) ||
        typeof v.Service !== "string" || typeof v.State !== "string" ||
        typeof v.Health !== "string"
      )
    ) throw 0;
    return parsed;
  } catch {
    return fail("COMMAND_FAILED");
  }
}
function oneService(items: Service[], name: string): Service {
  const found = items.filter((v) => v.Service === name);
  if (
    found.length !== 1 || found[0].State !== "running" ||
    found[0].Health !== "healthy"
  ) fail("COMMAND_FAILED");
  return found[0];
}
export const MONGO_PREFLIGHT_SCRIPT = `
try {
 const admin = db.getSiblingDB("admin");
 const user = process.env.MONGO_INITDB_ROOT_USERNAME;
 const password = process.env.MONGO_INITDB_ROOT_PASSWORD;
 let authenticated = false;
 const authenticate = () => {
  if (!user || !password) quit(1);
  const result = admin.auth(user, password);
  if (!(result === 1 || result === true || (result && result.ok === 1))) quit(1);
  authenticated = true;
 };
 let options;
 try { options = admin.runCommand({getCmdLineOpts:1}); }
 catch (error) { if (error.code !== 13) quit(1); options = {ok:0,code:13}; }
 if (options.ok !== 1) {
  if (options.code !== 13) quit(1);
  authenticate();
  options = admin.runCommand({getCmdLineOpts:1});
 }
 if (options.ok !== 1 || !options.parsed) quit(1);
 const security = options.parsed.security || {};
 if (security.authorization !== undefined && !["enabled","disabled"].includes(security.authorization)) quit(1);
 const authorization = security.authorization === "enabled" || security.keyFile || security.clusterAuthMode ? "enabled" : "disabled";
 if (authorization === "enabled" && !authenticated) authenticate();
 const ping = admin.runCommand({ping:1});
 const hello = admin.runCommand({hello:1});
 const oplog = db.getSiblingDB("local").getCollection("oplog.rs");
 const first = oplog.find().sort({$natural:1}).limit(1).next();
 const last = oplog.find().sort({$natural:-1}).limit(1).next();
 const stats = db.runCommand({dbStats:1,scale:1});
 if (!first || !last || stats.ok !== 1 || hello.ok !== 1) quit(1);
 const firstOplogSeconds = first.ts.getHighBitsUnsigned();
 const lastOplogSeconds = last.ts.getHighBitsUnsigned();
 print(JSON.stringify({authorization,ping:ping.ok===1,writablePrimary:hello.isWritablePrimary===true && typeof hello.setName==="string",firstOplogSeconds,lastOplogSeconds,oplogWindowSeconds:lastOplogSeconds-firstOplogSeconds,databaseBytes:stats.totalSize}));
} catch (_) { quit(1); }
`;
type MongoProbe = {
  authorization: "enabled" | "disabled";
  ping: boolean;
  writablePrimary: boolean;
  firstOplogSeconds: number;
  lastOplogSeconds: number;
  oplogWindowSeconds: number;
  databaseBytes: number;
};
async function probeMongo(
  root: string,
  databaseName: string,
  runner: Runner,
): Promise<MongoProbe> {
  const child = runner.spawn([
    "docker",
    "compose",
    "--project-directory",
    root,
    "exec",
    "-T",
    "mongo",
    "mongosh",
    "--quiet",
    "--norc",
    databaseName,
    "--file",
    "/dev/stdin",
  ], { timeoutMs: 30_000 });
  try {
    if (!child.stdin || !child.stdout || !child.stderr) fail("COMMAND_FAILED");
    const write = async () => {
      const writer = child.stdin!.getWriter();
      try {
        await writer.write(new TextEncoder().encode(MONGO_PREFLIGHT_SCRIPT));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    };
    const [out, err, status] = await Promise.all([
      collectBoundedStream(child.stdout, 16 * 1024),
      collectBoundedStream(child.stderr, 16 * 1024),
      child.status,
      write(),
    ]);
    try {
      if (status.code !== 0 || status.timedOut) fail("COMMAND_FAILED");
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(out),
      );
      if (
        !value ||
        Object.keys(value).sort().join(",") !==
          "authorization,databaseBytes,firstOplogSeconds,lastOplogSeconds,oplogWindowSeconds,ping,writablePrimary" ||
        !["enabled", "disabled"].includes(value.authorization) ||
        value.ping !== true || typeof value.writablePrimary !== "boolean"
      ) fail("COMMAND_FAILED");
      for (
        const key of [
          "databaseBytes",
          "firstOplogSeconds",
          "lastOplogSeconds",
          "oplogWindowSeconds",
        ]
      ) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
          fail("COMMAND_FAILED");
        }
      }
      if (
        value.firstOplogSeconds === 0 ||
        value.lastOplogSeconds - value.firstOplogSeconds !==
          value.oplogWindowSeconds
      ) fail("COMMAND_FAILED");
      return value;
    } finally {
      out.fill(0);
      err.fill(0);
    }
  } catch {
    child.kill();
    await child.status.catch(() => {});
    return fail("COMMAND_FAILED");
  }
}
async function freeTempBytes(): Promise<number> {
  const fs = await statfs(tmpdir(), { bigint: true });
  const free = fs.bavail * fs.bsize;
  return free <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(free) : NaN;
}
async function readLimitedText(file: string): Promise<string> {
  path(file);
  const info = await Deno.lstat(file);
  if (!info.isFile || info.size > 1024 * 1024) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  return await Deno.readTextFile(file);
}

async function requireOwnedMode0600(file: string): Promise<void> {
  try {
    path(file);
    const [info, uid] = await Promise.all([
      Deno.lstat(file),
      readEffectiveUid(),
    ]);
    if (
      !info.isFile || info.isSymlink || info.uid !== uid ||
      info.mode === null || (info.mode & 0o7777) !== 0o600 ||
      info.size > 1024 * 1024
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
  } catch {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
}
type MountInspection = {
  mounts: Mount[];
  files: string;
  workingDir: string;
  envFile: string | null;
  command: unknown;
};
function hostFile(mounts: Mount[], target: string): string {
  const found = mounts.filter((m) =>
    m.Destination === target || target.startsWith(m.Destination + "/")
  ).sort((a, b) => b.Destination.length - a.Destination.length);
  if (
    !found.length ||
    (found.length > 1 && found[0].Destination === found[1].Destination) ||
    found[0].Type !== "bind"
  ) fail("SOURCE_COVERAGE_INCOMPLETE");
  path(found[0].Source);
  return join(found[0].Source, target.slice(found[0].Destination.length));
}
export type PkBackupSshTransport = Readonly<{
  sshArgv: readonly string[];
  rcloneConfigPath: string;
  sshConfigPath: string;
  knownHostsPath: string;
  identityFilePath: string;
}>;

function parsePkBackupSshConfig(text: string, homeDir: string): string {
  const expected = new Map<string, string>([
    ["hostname", "77.51.198.164"],
    ["port", "22126"],
    ["user", "pk"],
    ["identityfile", "~/.ssh/id_rsa"],
    ["identitiesonly", "yes"],
    ["identityagent", "none"],
    ["usekeychain", "yes"],
    ["stricthostkeychecking", "yes"],
  ]);
  const exact = new Map<string, string>();
  let context: "global" | "exact" | "wildcard" | "other" = "global";
  let exactSeen = false;
  let addKeysSeen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const directive = line.match(/^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/);
    if (!directive || directive[2].length > 1024) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    const keyword = directive[1].toLowerCase();
    const value = directive[2].trim();
    if (keyword === "include" || keyword === "match") {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    if (keyword === "host") {
      const patterns = value.split(/\s+/);
      if (
        !patterns.length ||
        patterns.some((item) => !/^[A-Za-z0-9_.?*!-]+$/.test(item))
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      if (patterns.some((item) => /[?*!]/.test(item))) {
        if (
          patterns.length !== 1 || patterns[0] !== "*" || !exactSeen
        ) fail("SOURCE_COVERAGE_INCOMPLETE");
        context = "wildcard";
      } else if (patterns.some((item) => item.toLowerCase() === "pk_backup")) {
        if (
          exactSeen || patterns.length !== 1 || patterns[0] !== "pk_backup"
        ) fail("SOURCE_COVERAGE_INCOMPLETE");
        exactSeen = true;
        context = "exact";
      } else context = "other";
      continue;
    }
    if (context === "other") continue;
    if (context === "global") {
      if (keyword !== "addkeystoagent" || value !== "yes" || addKeysSeen) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      addKeysSeen = true;
      continue;
    }
    if (context === "exact") {
      if (!expected.has(keyword) || exact.has(keyword)) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      if (value !== expected.get(keyword)) fail("SOURCE_COVERAGE_INCOMPLETE");
      exact.set(keyword, value);
      continue;
    }
    // Values in a later Host * block cannot override the exact alias because
    // OpenSSH uses the first obtained scalar value. Additive identities and
    // every unreviewed matching directive remain forbidden.
    if (keyword === "addkeystoagent") {
      if (value !== "yes") fail("SOURCE_COVERAGE_INCOMPLETE");
    } else if (keyword === "identityfile" || !expected.has(keyword)) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
  }
  if (!exactSeen || exact.size !== expected.size) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const identity = join(homeDir, ".ssh", "id_rsa");
  path(identity);
  return identity;
}

export async function resolvePkBackupSshTransport(
  runner: Runner,
  homeDir: string,
  providedIdentity?: RcloneConfigIdentity,
): Promise<PkBackupSshTransport> {
  assertRcloneEnvironment();
  const identity = providedIdentity ??
    await pinDefaultRcloneConfig(homeDir);
  if (identity.path !== defaultRcloneConfigPath(homeDir)) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const closedRunner = exactEnvironmentRunner(
    attestedRcloneRunner(runner, identity),
    baseChildEnvironment(homeDir),
  );
  const output = await command(
    closedRunner,
    ["rclone", "config", "file"],
    "SOURCE_COVERAGE_INCOMPLETE",
  );
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2 || lines[0] !== "Configuration file is stored at:") {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const rcloneConfigPath = lines[1];
  path(rcloneConfigPath);
  if (rcloneConfigPath !== identity.path) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const allowedKeys = new Set([
    "type",
    "ssh",
    "known_hosts_file",
    "shell_type",
    "md5sum_command",
    "sha1sum_command",
  ]);
  const values = new Map<string, string>();
  let active = false;
  let sections = 0;
  for (
    const raw of (await readAttestedRcloneConfigText(identity)).split(/\r?\n/)
  ) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      active = section[1] === "pk-backup";
      if (active) sections++;
      continue;
    }
    if (!active) continue;
    const pair = line.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.*)$/);
    if (
      !pair || !allowedKeys.has(pair[1]) || values.has(pair[1])
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    values.set(pair[1], pair[2]);
  }
  if (
    sections !== 1 || values.size !== allowedKeys.size ||
    values.get("type") !== "sftp" || values.get("shell_type") !== "unix" ||
    values.get("md5sum_command") !== "md5sum" ||
    values.get("sha1sum_command") !== "sha1sum"
  ) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const ssh = values.get("ssh");
  if (!ssh || controlCharacters(ssh) || /['"`$;|&<>\\]/.test(ssh)) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const args = ssh.split(/ +/);
  if (args[0] !== "/usr/bin/ssh" || args[1] !== "-F") {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  const sshConfigPath = args[2];
  path(sshConfigPath);
  const opts = new Map<string, string>();
  for (let i = 3; i < args.length - 1; i++) {
    if (args[i] === "-o") {
      const pair = args[++i]?.match(
        /^(BatchMode|StrictHostKeyChecking|UserKnownHostsFile|ConnectTimeout|ServerAliveInterval|ServerAliveCountMax)=([^=]+)$/,
      );
      if (!pair || opts.has(pair[1])) fail("SOURCE_COVERAGE_INCOMPLETE");
      opts.set(pair[1], pair[2]);
    } else fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  if (
    args.at(-1) !== "pk_backup" || opts.size !== 6 ||
    opts.get("BatchMode") !== "yes" ||
    opts.get("StrictHostKeyChecking") !== "yes" ||
    opts.get("ConnectTimeout") !== "12" ||
    opts.get("ServerAliveInterval") !== "20" ||
    opts.get("ServerAliveCountMax") !== "3"
  ) fail("SOURCE_COVERAGE_INCOMPLETE");
  const knownHostsPath = opts.get("UserKnownHostsFile");
  path(knownHostsPath);
  if (values.get("known_hosts_file") !== knownHostsPath) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  await requireOwnedMode0600(sshConfigPath);
  const identityFilePath = parsePkBackupSshConfig(
    await readLimitedText(sshConfigPath),
    homeDir,
  );
  await requireOwnedMode0600(identityFilePath);
  await requireOwnedMode0600(knownHostsPath);
  await assertRcloneConfigIdentity(identity);
  // No ssh -G: Match exec and Include can execute or expand unreviewed input.
  return Object.freeze({
    sshArgv: Object.freeze([...args]),
    rcloneConfigPath,
    sshConfigPath,
    knownHostsPath,
    identityFilePath,
  });
}

async function rclonePaths(
  runner: Runner,
  homeDir: string,
  identity?: RcloneConfigIdentity,
): Promise<{ active: true; config: string; knownHosts: string }> {
  const transport = await resolvePkBackupSshTransport(
    runner,
    homeDir,
    identity,
  );
  return {
    active: true,
    config: transport.rcloneConfigPath,
    knownHosts: transport.knownHostsPath,
  };
}
export async function discoverDeployment(
  config: BackupConfig,
  items: Service[],
  runner: Runner,
  rcloneConfigIdentity?: RcloneConfigIdentity,
): Promise<DeploymentContext> {
  try {
    if (
      config.rcloneRemote !== "pk-backup:" ||
      config.remoteRoot !== "pk-backup:mycelia"
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    const base = join(config.repoRoot, "docker-compose.yml");
    const mediaUat = join(config.repoRoot, "docker-compose.media-uat.yml");
    const mediaDisks = join(
      config.repoRoot,
      "docker-compose.media-disks.yml",
    );
    const ragFile = join(config.repoRoot, "docker-compose.rag.yml");
    const ragEnvFile = join(config.repoRoot, ".env.rag.local");
    const reviewedMainFiles = [base, mediaUat, mediaDisks] as const;
    const trackedRelative = new Map<string, string>([
      [base, "docker-compose.yml"],
      [mediaUat, "docker-compose.media-uat.yml"],
      [mediaDisks, "docker-compose.media-disks.yml"],
      [ragFile, "docker-compose.rag.yml"],
    ]);
    const verifiedTracked = new Set<string>();
    let verifiedRagProjectName: string | undefined;
    const verifyRagEnvFile = async (): Promise<string> => {
      if (verifiedRagProjectName !== undefined) {
        return verifiedRagProjectName;
      }
      path(ragEnvFile);
      const [info, uid] = await Promise.all([
        Deno.lstat(ragEnvFile),
        readEffectiveUid(),
      ]);
      if (
        !info.isFile || info.isSymlink || info.uid !== uid ||
        info.mode === null || (info.mode & 0o7777) !== 0o600 ||
        info.size > 1024 * 1024 ||
        await Deno.realPath(ragEnvFile) !== ragEnvFile
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const parsed = parseEnvText(
        ragEnvFile,
        await Deno.readTextFile(ragEnvFile),
      );
      if (parsed.malformed.length) fail("SOURCE_COVERAGE_INCOMPLETE");
      const assignedLines = new Set(parsed.active.map(({ line }) => line));
      if (
        parsed.lines.some((line, index) =>
          line.trim() && !line.trimStart().startsWith("#") &&
          !assignedLines.has(index + 1)
        )
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const keys = new Set<string>();
      for (const assignment of parsed.active) {
        if (keys.has(assignment.key)) fail("SOURCE_COVERAGE_INCOMPLETE");
        keys.add(assignment.key);
      }
      const projectNames = parsed.active.filter((assignment) =>
        assignment.key === "RAG_COMPOSE_PROJECT_NAME"
      );
      if (
        projectNames.length !== 1 ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectNames[0].value)
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      verifiedRagProjectName = projectNames[0].value;
      return verifiedRagProjectName;
    };
    const verifyTrackedComposeFile = async (file: string): Promise<void> => {
      if (verifiedTracked.has(file)) return;
      const relative = trackedRelative.get(file);
      if (!relative) fail("SOURCE_COVERAGE_INCOMPLETE");
      path(file);
      const info = await Deno.lstat(file);
      if (
        !info.isFile || info.isSymlink || info.size > 1024 * 1024 ||
        await Deno.realPath(file) !== file
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const output = await command(runner, [
        "git",
        "-C",
        config.repoRoot,
        "ls-files",
        "--error-unmatch",
        "-z",
        "--",
        relative,
      ], "SOURCE_COVERAGE_INCOMPLETE");
      if (output !== `${relative}\0`) fail("SOURCE_COVERAGE_INCOMPLETE");
      verifiedTracked.add(file);
    };
    const verifyComposeProvenance = async (
      value: string,
      scope: "main" | "rag",
    ): Promise<void> => {
      if (
        !value || value.length > 4096 || controlCharacters(value)
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const listed = value.split(",");
      const reviewed = scope === "main" ? reviewedMainFiles : [ragFile];
      if (
        listed.length < 1 || listed.length > reviewed.length ||
        listed.some((file, index) => file !== reviewed[index])
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      for (const file of listed) await verifyTrackedComposeFile(file);
    };
    const inspect = async (
      item: Service,
      composeScope: "main" | "rag",
    ): Promise<MountInspection> => {
      const format =
        '{"mounts":{{json .Mounts}},"files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"envFile":{{json (index .Config.Labels "com.docker.compose.project.environment_file")}},"command":null}';
      // Only Mongo argv can be inspected: Redis/PBM argv may contain credentials.
      const filtered = item.Service === "mongo"
        ? format.replace('"command":null', '"command":{{json .Config.Cmd}}')
        : format;
      const value = JSON.parse(
        await command(runner, [
          "docker",
          "inspect",
          "--format",
          filtered,
          item.ID,
        ], "SOURCE_COVERAGE_INCOMPLETE"),
      );
      if (
        !value || !Array.isArray(value.mounts) ||
        value.workingDir !== config.repoRoot ||
        typeof value.files !== "string"
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      if (composeScope === "rag") {
        // RAG consumes the dedicated env file. Qdrant does not consume its
        // values, so an older missing label remains valid: this permits a
        // targeted RAG recreate without restarting durable Qdrant solely to
        // add provenance metadata. Any present Qdrant label must still match.
        const validRagEnvLabel = item.Service === "rag"
          ? value.envFile === ragEnvFile
          : item.Service === "qdrant" &&
            (value.envFile === null || value.envFile === "" ||
              value.envFile === ragEnvFile);
        if (!validRagEnvLabel) fail("SOURCE_COVERAGE_INCOMPLETE");
      } else if (
        value.envFile !== "" && value.envFile !== null &&
        value.envFile !== join(config.repoRoot, ".env")
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      await verifyComposeProvenance(value.files, composeScope);
      for (const m of value.mounts) {
        if (
          !m || typeof m.Type !== "string" || typeof m.Source !== "string" ||
          typeof m.Destination !== "string"
        ) fail("SOURCE_COVERAGE_INCOMPLETE");
        path(m.Destination);
      }
      return value;
    };
    const mongo = await inspect(oneService(items, "mongo"), "main");
    const redis = await inspect(oneService(items, "redis"), "main");
    if (
      JSON.stringify(mongo.command) !==
        JSON.stringify(["mongod", "--config", "/etc/mongod.conf"])
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    const mongoConfig = await readLimitedText(
      hostFile(mongo.mounts, "/etc/mongod.conf"),
    );
    const keyfiles = [...mongoConfig.matchAll(/^\s*keyFile:\s*(\S+)\s*$/gm)];
    if (
      keyfiles.length > 1 ||
      (/keyFile/.test(mongoConfig) && keyfiles.length !== 1)
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    // Unsupported encryption or config expansion cannot silently omit key material.
    if (/encryption|__exec|__rest|configExpand/i.test(mongoConfig)) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    const backend = items.filter((s) => s.Service === "backend");
    const frontend = items.filter((s) => s.Service === "frontend");
    const nginx = items.filter((s) => s.Service === "nginx");
    if (
      backend.length !== 1 || backend[0].State !== "running" ||
      frontend.length !== 1 || frontend[0].State !== "running" ||
      nginx.length !== 1 || nginx[0].State !== "running" || items.some((s) =>
        s.Service === "pbm-agent"
      )
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    await inspect(backend[0], "main");
    await inspect(frontend[0], "main");
    const web = await inspect(nginx[0], "main");
    const composeText = await readLimitedText(base);
    if (
      (composeText.match(/\benv_file:/g) ?? []).length !== 1 ||
      !/^\s+env_file:\s*\n\s+- \.env\s*$/m.test(composeText)
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    const template = await readLimitedText(
      hostFile(web.mounts, "/etc/nginx/templates/site.conf.template"),
    );
    const cert = [...template.matchAll(/^\s*ssl_certificate\s+(\S+);\s*$/gm)];
    const key = [
      ...template.matchAll(/^\s*ssl_certificate_key\s+(\S+);\s*$/gm),
    ];
    if (
      cert.length !== 1 || key.length !== 1 ||
      /[${}]/.test(cert[0][1] + key[0][1])
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    const rclone = await rclonePaths(
      runner,
      config.homeDir,
      rcloneConfigIdentity,
    );
    const projects = JSON.parse(
      await command(runner, [
        "docker",
        "compose",
        "ls",
        "--all",
        "--format",
        "json",
      ], "SOURCE_COVERAGE_INCOMPLETE"),
    );
    if (
      !Array.isArray(projects) || projects.some((p) =>
        !p || typeof p.Name !== "string" || typeof p.ConfigFiles !== "string" ||
        typeof p.Status !== "string"
      )
    ) fail("SOURCE_COVERAGE_INCOMPLETE");
    const ragProjects = projects.filter((p) =>
      p.ConfigFiles.split(",").includes(ragFile) || p.Name === "mycelia-rag"
    );
    let rag: DeploymentContext["rag"] = { active: false };
    if (ragProjects.length) {
      if (
        ragProjects.length !== 1 || ragProjects[0].ConfigFiles !== ragFile ||
        !/^running\(2\)$/.test(ragProjects[0].Status)
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const ragProjectName = await verifyRagEnvFile();
      if (ragProjects[0].Name !== ragProjectName) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      const ragItems = services(
        await command(
          exactEnvironmentRunner(
            runner,
            baseChildEnvironment(config.homeDir),
          ),
          [
            "docker",
            "compose",
            "--project-directory",
            config.repoRoot,
            "--project-name",
            ragProjectName,
            "--env-file",
            ragEnvFile,
            "-f",
            ragFile,
            "ps",
            "--all",
            "--format",
            "json",
          ],
          "SOURCE_COVERAGE_INCOMPLETE",
        ),
      );
      const service = oneService(ragItems, "rag");
      const qdrants = ragItems.filter((s) => s.Service === "qdrant");
      if (qdrants.length !== 1 || qdrants[0].State !== "running") {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      rag = {
        active: true,
        qdrant: (await inspect(qdrants[0], "rag")).mounts,
        service: (await inspect(service, "rag")).mounts,
      };
      if (/\benv_file:/.test(await readLimitedText(ragFile))) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
    }
    const excludedRoots: string[] = [];
    for (
      const item of items.filter((s) =>
        ["python-worker", "diarizator"].includes(s.Service)
      )
    ) {
      const mounts = (await inspect(item, "main")).mounts;
      for (
        const m of mounts.filter((m) =>
          ["/root/.cache", "/models", "/app/debug"].includes(m.Destination)
        )
      ) {
        if (m.Type === "bind") {
          path(m.Source);
          excludedRoots.push(m.Source);
        } else if (m.Type !== "volume") fail("SOURCE_COVERAGE_INCOMPLETE");
      }
    }
    const archiveRoot = Deno.env.get("MYCELIA_VOICE_MEMOS_ARCHIVE_ROOT") ??
      "/Volumes/TM_data/iCloudArchive";
    const archiveTool = Deno.env.get("ICLOUD_ARCHIVE_TOOL_ROOT") ??
      join(config.homeDir, "claude-cowork/icloud-archive-tool");
    const archiveConfig = Deno.env.get("ICLOUD_ARCHIVE_CONFIG") ??
      join(archiveTool, "config.env");
    let voiceMemos: ManifestOptions["voiceMemos"];
    const publishedAudioRoot = config.voiceMemosRoot ??
      join(
        config.homeDir,
        "Library/mycelia/voice-memos-staging/audio-original",
      );
    try {
      const receiptPath = join(
        dirname(publishedAudioRoot),
        "sync-status.json",
      );
      const info = await Deno.lstat(receiptPath);
      if (
        !info.isFile || info.mode === null || (info.mode & 0o7777) !== 0o600
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      const receipt = JSON.parse(await readLimitedText(receiptPath));
      if (
        receipt.schema !== 1 ||
        receipt.published_audio_root !==
          await Deno.realPath(publishedAudioRoot) ||
        receipt.archive_audio_root !==
          await Deno.realPath(
            join(archiveRoot, "data/voice-memos/audio-original"),
          )
      ) fail("SOURCE_COVERAGE_INCOMPLETE");
      voiceMemos = {
        publishedAudioRoot,
        archiveAudioRoot: receipt.archive_audio_root,
        receiptPath,
      };
    } catch (error) {
      // A missing default receipt cannot authorize any staged claim: Task 3
      // reconciliation will fail those paths outside the archive allowlist.
      if (config.voiceMemosRoot || !(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    const env = join(config.repoRoot, ".env");
    return {
      mongo: mongo.mounts,
      redis: redis.mounts,
      rag,
      archiveRoot,
      voiceMemos,
      excludedRoots,
      protectedConfig: {
        media: { active: true, path: env },
        provider: { active: true, path: env },
        rag: rag.active
          ? { active: true, path: ragEnvFile }
          : { active: false },
        rclone,
        tls: {
          active: true,
          certificate: hostFile(web.mounts, cert[0][1]),
          privateKey: hostFile(web.mounts, key[0][1]),
        },
        mongoKeyfile: keyfiles.length
          ? { active: true, path: hostFile(mongo.mounts, keyfiles[0][1]) }
          : { active: false },
        pbm: { active: false },
        icloudArchive: { active: true, path: archiveConfig },
      },
    };
  } catch {
    return fail("SOURCE_COVERAGE_INCOMPLETE");
  }
}
async function readDatabaseName(root: string): Promise<string> {
  // Drop the parser's other values before any external command is invoked.
  const env = parseEnvText(
    join(root, ".env"),
    await Deno.readTextFile(join(root, ".env")),
  );
  const setting = env.active.find((entry) => entry.key === "DATABASE_NAME")
    ?.value.trim();
  const name = setting === undefined
    ? "mycelia"
    : setting.replace(/^(['"])(.*)\1$/, "$2");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name)) fail("CONFIG_INVALID");
  return name;
}

export async function runPreflight(
  options: PreflightOptions,
  deps: PreflightDependencies = {},
): Promise<PreflightReport> {
  const report: PreflightReport = {
    schema: 1,
    ok: false,
    remoteVerified: false,
    localVerified: false,
    backupId: options.backupId ??
      new Date().toISOString().replace(/[-:.]/g, ""),
  };
  const baseRunner = deps.runner ?? new DenoRunner();
  try {
    if (!isBackupId(report.backupId)) fail("CONFIG_INVALID");
    assertRcloneEnvironment();
    if (
      !isAbsolute(options.composeRoot) ||
      !["skip", "full"].includes(options.remoteMode)
    ) fail("CONFIG_INVALID");
    try {
      const info = await Deno.lstat(join(options.composeRoot, ".env"));
      if (
        !info.isFile || info.isSymlink || info.mode === null ||
        (info.mode & 0o7777) !== 0o600 || info.size > 1024 * 1024
      ) fail("CONFIG_INVALID");
    } catch {
      fail("CONFIG_INVALID");
    }
    const config = await loadBackupConfig(
      options.composeRoot,
      deps.homeDir ?? Deno.env.get("HOME") ?? options.composeRoot,
    );
    const rcloneConfigIdentity = await pinDefaultRcloneConfig(config.homeDir);
    const runner = attestedRcloneRunner(baseRunner, rcloneConfigIdentity);
    const restic = version(
      await command(runner, ["restic", "version"]),
      "restic",
      [0, 19, 0],
    );
    const rclone = version(
      await command(runner, ["rclone", "version"]),
      "rclone",
      [1, 75, 0],
    );
    report.versions = { restic, rclone };
    const databaseName = await readDatabaseName(options.composeRoot);
    const free = await (deps.tempFreeBytes ?? freeTempBytes)();
    const floor = deps.localFloorBytes ?? LOCAL_WORKSPACE_FLOOR_BYTES;
    if (
      !Number.isSafeInteger(free) || !Number.isSafeInteger(floor) ||
      floor <= 0 || free <= floor
    ) fail("CONFIG_INVALID");
    report.localFreeBytes = free;
    try {
      await Deno.lstat(config.lockPath);
      if (!options.lockLease) fail("LOCK_HELD");
      await assertOwnedLockLease(config.lockPath, options.lockLease);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && !options.lockLease) {
        // Normal read-only preflight without a participating owner.
      } else fail("LOCK_HELD");
    }
    await command(runner, [
      "docker",
      "info",
      "--format",
      "{{json .ServerVersion}}",
    ]);
    const items = services(
      await command(runner, [
        "docker",
        "compose",
        "--project-directory",
        options.composeRoot,
        "ps",
        "--all",
        "--format",
        "json",
      ]),
    );
    oneService(items, "mongo");
    oneService(items, "redis");
    report.versions.mongodump = version(
      await command(runner, [
        "docker",
        "compose",
        "--project-directory",
        options.composeRoot,
        "exec",
        "-T",
        "mongo",
        "mongodump",
        "--version",
      ]),
      "mongodump",
      [100, 17, 0],
    );
    const mongo = await probeMongo(options.composeRoot, databaseName, runner);
    if (!mongo.writablePrimary) fail("MONGO_NOT_PRIMARY");
    if (mongo.oplogWindowSeconds < PRELIMINARY_OPLOG_SECONDS) {
      fail("OPLOG_WINDOW_SHORT");
    }
    report.databaseBytes = mongo.databaseBytes;
    report.oplogWindowSeconds = mongo.oplogWindowSeconds;
    const context = await (deps.context
      ? deps.context(config)
      : discoverDeployment(config, items, runner, rcloneConfigIdentity));
    const manifestOptions = resolveManifestOptions(context);
    if (
      manifestOptions.protectedConfig?.rclone?.config !==
        rcloneConfigIdentity.path
    ) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    const manifest = await collectResolvedManifest(
      config,
      report.backupId,
      manifestOptions,
      databaseName,
      mongo.authorization,
      runner,
    );
    report.sourceCoverage = {
      complete: manifest.coverage.complete,
      total: manifest.coverage.total,
      covered: manifest.coverage.covered,
    };
    if (!manifest.coverage.complete) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    let size = 0n;
    for (const file of manifest.files) {
      const info = await Deno.stat(file);
      if (
        !info.isFile || !Number.isSafeInteger(info.size) || info.size < 0
      ) {
        fail("SOURCE_COVERAGE_INCOMPLETE");
      }
      size += BigInt(info.size);
    }
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    report.fileBytes = Number(size);
    report.localVerified = true;
    if (options.remoteMode === "skip") {
      return report;
    }
    const rcloneConfig = manifestOptions.protectedConfig?.rclone?.config;
    if (typeof rcloneConfig !== "string") {
      fail("SOURCE_COVERAGE_INCOMPLETE");
    }
    const remoteRunner = exactEnvironmentRunner(runner, {
      ...baseChildEnvironment(config.homeDir),
      RCLONE_CONFIG: rcloneConfig,
    });
    const remote = await checkRemote({
      ...config,
      fileBytes: report.fileBytes,
      databaseBytes: mongo.databaseBytes,
      expectedInstallationId: options.expectedInstallationId,
    }, remoteRunner);
    Object.assign(report, remote);
    report.remoteVerified = true;
    report.ok = true;
  } catch (error) {
    const candidate = (error as { code?: FailureCode })?.code;
    report.failure = candidate && FAILURE_CODES.includes(candidate)
      ? candidate
      : "COMMAND_FAILED";
  }
  return report;
}

async function collectResolvedManifest(
  config: BackupConfig,
  backupId: string,
  options: ManifestOptions,
  databaseName: string,
  authorization: "enabled" | "disabled",
  runner: Runner,
): Promise<SourceManifest> {
  const sources = await readMongoSourcePaths({
    composeRoot: config.repoRoot,
    databaseName,
    authorization,
  }, runner);
  return await reconcileSourcePaths(
    await buildSourceManifest(config, backupId, options, runner),
    sources,
    options.voiceMemos,
  );
}

export async function collectCurrentSourceManifest(
  options: { composeRoot: string; backupId: string },
  deps: Pick<PreflightDependencies, "runner" | "homeDir" | "context"> = {},
): Promise<SourceManifest> {
  if (!isBackupId(options.backupId)) fail("CONFIG_INVALID");
  assertRcloneEnvironment();
  const config = await loadBackupConfig(
    options.composeRoot,
    deps.homeDir ?? Deno.env.get("HOME") ?? options.composeRoot,
  );
  const identity = await pinDefaultRcloneConfig(config.homeDir);
  const runner = attestedRcloneRunner(
    deps.runner ?? new DenoRunner(),
    identity,
  );
  const items = services(
    await command(runner, [
      "docker",
      "compose",
      "--project-directory",
      options.composeRoot,
      "ps",
      "--all",
      "--format",
      "json",
    ]),
  );
  oneService(items, "mongo");
  oneService(items, "redis");
  const databaseName = await readDatabaseName(options.composeRoot);
  const mongo = await probeMongo(options.composeRoot, databaseName, runner);
  const context = deps.context
    ? await deps.context(config)
    : await discoverDeployment(config, items, runner, identity);
  const manifestOptions = resolveManifestOptions(context);
  if (manifestOptions.protectedConfig?.rclone?.config !== identity.path) {
    fail("SOURCE_COVERAGE_INCOMPLETE");
  }
  return await collectResolvedManifest(
    config,
    options.backupId,
    manifestOptions,
    databaseName,
    mongo.authorization,
    runner,
  );
}
