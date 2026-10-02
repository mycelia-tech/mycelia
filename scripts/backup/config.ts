import { isAbsolute, join, resolve } from "node:path";
import { parseEnvText } from "../check-env.ts";
import { failureError } from "./redact.ts";

export type BackupConfig = {
  repoRoot: string;
  homeDir: string;
  rcloneRemote: string;
  remoteRoot: string;
  resticRepository: string;
  resticKeychainService: string;
  resticKeychainAccount: string;
  remoteMinFreeBytes: number;
  operationalUntracked: string[];
  mediaSourceHostPath?: string;
  mediaSourceExtraHostPath?: string;
  voiceMemosRoot?: string;
  voiceMemosDb?: string;
  stateDir: string;
  lockPath: string;
};
const defaults = {
  BACKUP_RCLONE_REMOTE: "pk-backup:",
  BACKUP_REMOTE_ROOT: "pk-backup:mycelia",
  BACKUP_RESTIC_REPOSITORY: "rclone:pk-backup:mycelia/restic-v1",
  BACKUP_RESTIC_KEYCHAIN_SERVICE: "tech.mycelia.backup.restic",
  BACKUP_RESTIC_KEYCHAIN_ACCOUNT: "mycelia",
  BACKUP_REMOTE_MIN_FREE_BYTES: "10737418240",
  BACKUP_OPERATIONAL_UNTRACKED_JSON: "[]",
};
function invalid(): never {
  throw failureError("CONFIG_INVALID");
}
function unsafePath(value: string): boolean {
  return [...value].some((char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "$" ||
    char === "`"
  );
}
function valueText(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith(value[0])) invalid();
    return value.slice(1, -1);
  }
  return value;
}
async function readEnv(path: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Map();
    invalid();
  }
  const parsed = parseEnvText(path, text);
  if (parsed.malformed.length) invalid();
  const assigned = new Set(parsed.active.map(({ line }) => line));
  parsed.lines.forEach((line, index) => {
    if (
      line.trim() && !line.trimStart().startsWith("#") &&
      !assigned.has(index + 1)
    ) invalid();
  });
  const values = new Map<string, string>();
  for (const item of parsed.active) {
    const value = valueText(item.value);
    if (values.has(item.key) && values.get(item.key) !== value) invalid();
    values.set(item.key, value);
  }
  return values;
}
export async function loadBackupConfig(
  repoRoot: string,
  homeDir: string,
): Promise<BackupConfig> {
  try {
    if (!isAbsolute(repoRoot) || !isAbsolute(homeDir)) invalid();
    const app = await readEnv(join(repoRoot, ".env"));
    const backup = await readEnv(join(repoRoot, ".env.backup"));
    for (const [key, value] of backup) {
      if (
        !Object.hasOwn(defaults, key) ||
        (app.has(key) && app.get(key) !== value)
      ) invalid();
    }
    const config = { ...defaults, ...Object.fromEntries(backup) };
    if (!/^[a-zA-Z0-9_-]+:$/.test(config.BACKUP_RCLONE_REMOTE)) invalid();
    const root = config.BACKUP_REMOTE_ROOT;
    if (
      !root.startsWith(config.BACKUP_RCLONE_REMOTE) ||
      !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(root)
    ) invalid();
    if (config.BACKUP_RESTIC_REPOSITORY !== `rclone:${root}/restic-v1`) {
      invalid();
    }
    for (
      const value of [
        config.BACKUP_RESTIC_KEYCHAIN_SERVICE,
        config.BACKUP_RESTIC_KEYCHAIN_ACCOUNT,
      ]
    ) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) invalid();
    }
    const floor = Number(config.BACKUP_REMOTE_MIN_FREE_BYTES);
    if (
      !/^\d+$/.test(config.BACKUP_REMOTE_MIN_FREE_BYTES) ||
      !Number.isSafeInteger(floor) || floor <= 0
    ) invalid();
    const operational: unknown = JSON.parse(
      config.BACKUP_OPERATIONAL_UNTRACKED_JSON,
    );
    if (
      !Array.isArray(operational) ||
      operational.some((path) =>
        typeof path !== "string" || !path || isAbsolute(path) ||
        path.split(/[\\/]/).includes("..") || unsafePath(path)
      )
    ) invalid();
    const pathValue = (key: string): string | undefined => {
      const value = app.get(key);
      if (!value) return undefined;
      if (
        unsafePath(value) ||
        (value.startsWith("~") && !value.startsWith("~/"))
      ) invalid();
      return value.startsWith("~/")
        ? resolve(homeDir, value.slice(2))
        : resolve(repoRoot, value);
    };
    const stateDir = join(repoRoot, ".local", "backup");
    return {
      repoRoot,
      homeDir,
      rcloneRemote: config.BACKUP_RCLONE_REMOTE,
      remoteRoot: root,
      resticRepository: config.BACKUP_RESTIC_REPOSITORY,
      resticKeychainService: config.BACKUP_RESTIC_KEYCHAIN_SERVICE,
      resticKeychainAccount: config.BACKUP_RESTIC_KEYCHAIN_ACCOUNT,
      remoteMinFreeBytes: floor,
      operationalUntracked: operational as string[],
      mediaSourceHostPath: pathValue("MEDIA_SOURCE_HOST_PATH"),
      mediaSourceExtraHostPath: pathValue("MEDIA_SOURCE_EXTRA_HOST_PATH"),
      voiceMemosRoot: pathValue("MYCELIA_APPLE_VOICEMEMOS_ROOT"),
      voiceMemosDb: pathValue("MYCELIA_APPLE_VOICEMEMOS_DB"),
      stateDir,
      lockPath: join(stateDir, "backup.lock"),
    };
  } catch {
    invalid();
  }
}
