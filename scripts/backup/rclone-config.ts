import { isAbsolute, join, normalize } from "node:path";
import { failureError } from "./redact.ts";
import { readEffectiveUid } from "./state.ts";

const MAX_RCLONE_CONFIG_BYTES = 1024 * 1024;

export type RcloneConfigIdentity = Readonly<{
  path: string;
  canonicalPath: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
  uid: number;
}>;

function safeAbsolute(path: string): boolean {
  return path.length > 1 && path.length <= 4096 && isAbsolute(path) &&
    normalize(path) === path &&
    ![...path].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const value = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  try {
    return hex(value);
  } finally {
    copy.fill(0);
    value.fill(0);
  }
}

async function captureRcloneConfig(
  path: string,
  expected?: RcloneConfigIdentity,
): Promise<{ identity: RcloneConfigIdentity; bytes: Uint8Array }> {
  let bytes: Uint8Array | undefined;
  try {
    if (!safeAbsolute(path)) throw 0;
    // Dotfile managers may symlink an ancestor (for example ~/.config).
    // Keep the selected alias AND its resolved target pinned for this run;
    // the config file itself must still be a regular, non-symlink 0600 file.
    const canonicalPath = await Deno.realPath(path);
    if (!safeAbsolute(canonicalPath)) throw 0;
    const uid = expected?.uid ?? await readEffectiveUid();
    const before = await Deno.lstat(path);
    if (
      !before.isFile || before.isSymlink || before.uid !== uid ||
      before.mode === null || (before.mode & 0o7777) !== 0o600 ||
      before.dev === null || before.ino === null ||
      !Number.isSafeInteger(before.size) || before.size < 1 ||
      before.size > MAX_RCLONE_CONFIG_BYTES
    ) throw 0;
    const file = await Deno.open(path, { read: true });
    try {
      const opened = await file.stat();
      if (
        !opened.isFile || opened.isSymlink || opened.uid !== uid ||
        opened.mode === null || (opened.mode & 0o7777) !== 0o600 ||
        opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size
      ) throw 0;
      bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = await file.read(bytes.subarray(offset));
        if (count === null || count <= 0) break;
        offset += count;
      }
      if (offset !== bytes.length) throw 0;
      const trailing = new Uint8Array(1);
      try {
        if (await file.read(trailing) !== null) throw 0;
      } finally {
        trailing.fill(0);
      }
      const identity = Object.freeze({
        path,
        canonicalPath,
        sha256: await digest(bytes),
        dev: opened.dev!,
        ino: opened.ino!,
        size: opened.size,
        uid,
      });
      const named = await Deno.lstat(path);
      if (
        await Deno.realPath(path) !== canonicalPath ||
        !named.isFile || named.isSymlink || named.uid !== uid ||
        named.mode === null || (named.mode & 0o7777) !== 0o600 ||
        named.dev !== opened.dev || named.ino !== opened.ino ||
        named.size !== opened.size ||
        (expected !== undefined && (
          identity.path !== expected.path ||
          identity.canonicalPath !== expected.canonicalPath ||
          identity.sha256 !== expected.sha256 ||
          identity.dev !== expected.dev || identity.ino !== expected.ino ||
          identity.size !== expected.size || identity.uid !== expected.uid
        ))
      ) throw 0;
      return { identity, bytes };
    } finally {
      file.close();
    }
  } catch {
    bytes?.fill(0);
    throw failureError("CONFIG_INVALID");
  }
}

export function defaultRcloneConfigPath(homeDir: string): string {
  if (!safeAbsolute(homeDir)) throw failureError("CONFIG_INVALID");
  return join(homeDir, ".config", "rclone", "rclone.conf");
}

export async function pinRcloneConfig(
  path: string,
): Promise<RcloneConfigIdentity> {
  const captured = await captureRcloneConfig(path);
  try {
    return captured.identity;
  } finally {
    captured.bytes.fill(0);
  }
}

export async function pinDefaultRcloneConfig(
  homeDir: string,
): Promise<RcloneConfigIdentity> {
  return await pinRcloneConfig(defaultRcloneConfigPath(homeDir));
}

export async function assertRcloneConfigIdentity(
  expected: RcloneConfigIdentity,
): Promise<void> {
  const captured = await captureRcloneConfig(expected.path, expected);
  captured.bytes.fill(0);
}

export async function readAttestedRcloneConfigText(
  expected: RcloneConfigIdentity,
): Promise<string> {
  const captured = await captureRcloneConfig(expected.path, expected);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes);
  } catch {
    throw failureError("CONFIG_INVALID");
  } finally {
    captured.bytes.fill(0);
  }
}
