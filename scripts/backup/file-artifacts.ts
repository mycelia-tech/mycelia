import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { failureError, isBackupId } from "./redact.ts";
import { readEffectiveUid } from "./state.ts";
import {
  MAX_FILES_MANIFEST_BYTES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_PATH_BYTES,
} from "./limits.ts";
import type { SourceManifest } from "./sources.ts";
import type { VerifiedResticContext } from "./restic.ts";
import type { Runner, StreamDigest } from "./types.ts";

export type Fingerprint = {
  dev: string;
  ino: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};
export type FileEvidence = { path: string; fingerprint: Fingerprint };
function fail(): never {
  throw failureError("SOURCE_COVERAGE_INCOMPLETE");
}
function invalid(): never {
  throw failureError("STATE_INVALID");
}
const encoder = new TextEncoder();
export const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
export async function fingerprint(path: string): Promise<Fingerprint> {
  try {
    const s = await lstat(path, { bigint: true });
    if (
      !s.isFile() || s.isSymbolicLink() || s.size < 0 ||
      s.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) fail();
    return {
      dev: String(s.dev),
      ino: String(s.ino),
      mode: String(s.mode),
      size: String(s.size),
      mtimeNs: String(s.mtimeNs),
      ctimeNs: String(s.ctimeNs),
    };
  } catch {
    fail();
  }
}
export async function assertFingerprint(evidence: FileEvidence): Promise<void> {
  if (
    JSON.stringify(await fingerprint(evidence.path)) !==
      JSON.stringify(evidence.fingerprint)
  ) fail();
}
export async function localDigest(path: string): Promise<StreamDigest> {
  const before = await fingerprint(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let byteCount = 0;
  const bytes = new Uint8Array(64 * 1024);
  try {
    const s = await handle.stat({ bigint: true });
    if (String(s.dev) !== before.dev || String(s.ino) !== before.ino) fail();
    while (true) {
      const { bytesRead } = await handle.read(bytes);
      if (!bytesRead) break;
      hash.update(bytes.subarray(0, bytesRead));
      byteCount += bytesRead;
      if (!Number.isSafeInteger(byteCount)) fail();
    }
    await assertFingerprint({ path, fingerprint: before });
    return { byteCount, sha256Hex: hash.digest("hex") };
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}
async function syncDirectory(path: string) {
  const file = await Deno.open(path);
  try {
    await file.sync();
  } finally {
    file.close();
  }
}

export function manifestPath(stateDir: string, backupId: string): string {
  if (!isBackupId(backupId)) invalid();
  return join(stateDir, `files-manifest-v1-${backupId}.json`);
}
export async function cleanupArtifact(
  e: FileEvidence,
  stateDir: string,
): Promise<void> {
  const [s, uid] = await Promise.all([Deno.lstat(e.path), readEffectiveUid()]);
  if (
    !s.isFile || s.isSymlink || s.uid !== uid || s.mode === null ||
    (s.mode & 0o7777) !== 0o600 || String(s.dev) !== e.fingerprint.dev ||
    String(s.ino) !== e.fingerprint.ino
  ) invalid();
  await Deno.remove(e.path);
  await syncDirectory(stateDir);
}
export async function cleanupStaleArtifacts(stateDir: string): Promise<void> {
  const artifacts: FileEvidence[] = [];
  const ids = new Set<string>();
  for await (const entry of Deno.readDir(stateDir)) {
    const m = entry.name.match(
      /^(files-manifest-v1|files-input)-(\d{8}T\d{6}(?:\d{3})?Z(?:-[a-f0-9]{8})?)(?:-([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}))?\.(json|nul)$/,
    );
    if (
      !m || !isBackupId(m[2]) ||
      (m[1] === "files-input"
        ? (!m[3] || m[4] !== "nul")
        : (m[3] || m[4] !== "json"))
    ) continue;
    const key = m[1] + m[2];
    if (ids.has(key) || artifacts.length === 128) invalid();
    ids.add(key);
    artifacts.push({
      path: join(stateDir, entry.name),
      fingerprint: await fingerprint(join(stateDir, entry.name)),
    });
  }
  // Validate every candidate before unlinking any of them.
  const uid = await readEffectiveUid();
  for (const e of artifacts) {
    const s = await Deno.lstat(e.path);
    if (s.uid !== uid || s.mode === null || (s.mode & 0o7777) !== 0o600) {
      invalid();
    }
  }
  for (const e of artifacts) await cleanupArtifact(e, stateDir);
}

export async function prepareFileArtifacts(options: {
  composeRoot: string;
  stateDir: string;
  manifest: SourceManifest;
  context: VerifiedResticContext;
  startedAtUtc: string;
  runner: Runner;
  uuid: string;
  assertLease: () => Promise<void>;
}): Promise<{
  files: FileEvidence[];
  inventory: FileEvidence;
  input: FileEvidence;
  inventoryDigest: StreamDigest;
  representativeDigest: StreamDigest;
  sourceBytes: number;
}> {
  const { manifest, stateDir, context, runner, composeRoot } = options;
  if (
    !manifest.coverage.complete ||
    manifest.coverage.total !== manifest.coverage.covered ||
    [
      manifest.coverage.missing,
      manifest.coverage.unreadable,
      manifest.coverage.outsideRoots,
      manifest.coverage.invalid,
    ].some((n) => n !== 0) || manifest.files.length === 0 ||
    manifest.files.length > MAX_SOURCE_FILES ||
    new Set(manifest.files).size !== manifest.files.length
  ) fail();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      .test(options.uuid)
  ) invalid();
  const files: FileEvidence[] = [];
  let sourceBytes = 0, pathBytes = 0;
  for (const path of [...manifest.files].sort(byteOrder)) {
    if (
      !path.startsWith("/") || path.includes("\0") || path === stateDir ||
      path.startsWith(stateDir + "/") ||
      new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(path)) !==
        path
    ) fail();
    pathBytes += encoder.encode(path).length + 1;
    if (pathBytes > MAX_SOURCE_PATH_BYTES) fail();
    const fp = await fingerprint(path);
    sourceBytes += Number(fp.size);
    if (!Number.isSafeInteger(sourceBytes)) fail();
    files.push({ path, fingerprint: fp });
  }
  const representativePath = join(composeRoot, "docker-compose.yml");
  if (!files.some((f) => f.path === representativePath)) fail();
  const representativeDigest = await localDigest(representativePath);
  const metadata = async (args: string[], maxOutputBytes: number) => {
    await options.assertLease();
    const result = await runner.run(["git", "-C", composeRoot, ...args], {
      timeoutMs: 60_000,
      maxOutputBytes,
      clearEnv: true,
      env: { HOME: context.env.HOME, PATH: context.env.PATH },
    });
    result.stderr.fill(0);
    if (result.code !== 0 || result.timedOut) {
      result.stdout.fill(0);
      throw failureError("COMMAND_FAILED");
    }
    return result.stdout;
  };
  const revisionBytes = await metadata(["rev-parse", "--verify", "HEAD"], 128);
  let revision: string;
  try {
    const raw = new TextDecoder().decode(revisionBytes);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(raw)) invalid();
    revision = raw.trim();
  } finally {
    revisionBytes.fill(0);
  }
  const status = await metadata([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ], 1024 * 1024);
  const dirty = status.length > 0;
  status.fill(0);
  const inventoryPath = manifestPath(stateDir, manifest.backupId);
  const inputPath = join(
    stateDir,
    `files-input-${manifest.backupId}-${options.uuid}.nul`,
  );
  const created: FileEvidence[] = [];
  const write = async (
    path: string,
    parts: Iterable<string>,
    maximum: number,
  ): Promise<{ evidence: FileEvidence; digest: StreamDigest }> => {
    await options.assertLease();
    const file = await Deno.open(path, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    let evidence: FileEvidence;
    try {
      const s = await file.stat();
      evidence = { path, fingerprint: await fingerprint(path) };
      if (
        String(s.dev) !== evidence.fingerprint.dev ||
        String(s.ino) !== evidence.fingerprint.ino ||
        s.uid !== await readEffectiveUid() || s.mode === null ||
        (s.mode & 0o7777) !== 0o600
      ) invalid();
      created.push(evidence);
      const hash = createHash("sha256");
      let byteCount = 0;
      for (const part of parts) {
        const bytes = encoder.encode(part);
        if (bytes.length > maximum - byteCount) fail();
        hash.update(bytes);
        byteCount += bytes.length;
        try {
          for (let offset = 0; offset < bytes.length;) {
            const n = await file.write(bytes.subarray(offset));
            if (n <= 0) throw failureError("COMMAND_FAILED");
            offset += n;
          }
        } finally {
          bytes.fill(0);
        }
      }
      await file.sync();
      await syncDirectory(stateDir);
      const fp = await fingerprint(path);
      if (
        fp.dev !== evidence.fingerprint.dev ||
        fp.ino !== evidence.fingerprint.ino
      ) invalid();
      evidence.fingerprint = fp;
      return { evidence, digest: { byteCount, sha256Hex: hash.digest("hex") } };
    } finally {
      file.close();
    }
  };
  try {
    const inventoryParts = function* () {
      const header = {
        schema: 1,
        kind: "files",
        backupId: manifest.backupId,
        startedAtUtc: options.startedAtUtc,
        installationId: context.installationId,
        repositoryId: context.repositoryId,
        labels: manifest.labels,
        coverage: manifest.coverage,
        git: { revision, dirty },
        tools: context.preflight.versions,
        sourceCounts: { files: files.length, bytes: sourceBytes },
        representativeDigest,
      };
      yield JSON.stringify(header).slice(0, -1) + ',"files":[';
      for (let i = 0; i < files.length; i++) {
        yield (i ? "," : "") + JSON.stringify(files[i]);
      }
      yield "]}\n";
    };
    const inventory = await write(
      inventoryPath,
      inventoryParts(),
      MAX_FILES_MANIFEST_BYTES,
    );
    const paths = [...manifest.files, inventoryPath].sort(byteOrder);
    const input = await write(
      inputPath,
      paths.map((p) => p + "\0"),
      MAX_SOURCE_PATH_BYTES + 8192,
    );
    return {
      files,
      inventory: inventory.evidence,
      input: input.evidence,
      inventoryDigest: inventory.digest,
      representativeDigest,
      sourceBytes,
    };
  } catch (error) {
    for (const e of created.reverse()) {
      await options.assertLease();
      await cleanupArtifact(e, stateDir);
    }
    throw error;
  }
}
