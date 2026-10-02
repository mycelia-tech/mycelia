import type { BackupConfig } from "./config.ts";
import type { MongoSourcePaths } from "./mongo.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DenoRunner, hashAndCountStream } from "./runner.ts";
import type { Runner } from "./types.ts";
import { failureError } from "./redact.ts";
import { MAX_SOURCE_FILES, MAX_SOURCE_PATH_BYTES } from "./limits.ts";
export type Coverage = {
  total: number;
  covered: number;
  missing: number;
  unreadable: number;
  outsideRoots: number;
  invalid: number;
  complete: boolean;
};
export type SourceManifest = {
  backupId: string;
  labels: Array<{ label: string; canonicalRoot: string }>;
  files: string[];
  coverage: Coverage;
};
type ActivePath = { active: boolean; path?: string };
export type ProtectedConfig = {
  media?: ActivePath;
  rag?: ActivePath;
  tls?: { active: boolean; certificate?: string; privateKey?: string };
  rclone?: { active: boolean; config?: string; knownHosts?: string };
  provider?: ActivePath;
  mongoKeyfile?: ActivePath;
  pbm?: { active: boolean; env?: string; ca?: string };
  icloudArchive?: ActivePath;
};
export type VoiceMemosMapping = {
  publishedAudioRoot: string;
  archiveAudioRoot: string;
  receiptPath: string;
  notBefore?: string;
};
export type RuntimeLocation =
  | { kind: "host-path"; path: string }
  | { kind: "named-volume" };
export type RuntimeRoots = {
  mongo: RuntimeLocation;
  redis: RuntimeLocation;
  rag:
    | { active: false }
    | {
      active: true;
      qdrant: RuntimeLocation;
      state: RuntimeLocation;
      modelCache: RuntimeLocation;
    };
};
export type ManifestOptions = {
  // Must come from effective mount inspection; never infer inactive services.
  runtimeRoots: RuntimeRoots;
  archiveRoot?: string;
  picturesImportRoot?: string;
  voiceMemos?: VoiceMemosMapping;
  protectedConfig?: ProtectedConfig;
  excludedRoots?: string[];
};
const DEFAULT_ARCHIVE_ROOT = "/Volumes/TM_data/iCloudArchive";
const DEFAULT_IMPORT_ROOT = "/Users/pk/Pictures/Mycelia-Import";
const deniedComponents = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  "dist",
  "build",
  "coverage",
  "qdrant",
  "qdrant_storage",
  "qdrant_data",
  "rag_qdrant_data",
  "rag_state",
  "rag_model_cache",
  "redis_data",
  "mongo_data",
  "model-cache",
  "model_cache",
  ".models",
  "test-data",
  "test_data",
  "test-media",
  "voice-memos-staging",
]);
type Problem = "missing" | "unreadable" | "outsideRoots" | "invalid";
class SourceProblem extends Error {
  constructor(readonly kind: Problem) {
    super(kind);
  }
}
const freshCoverage = (): Coverage => ({
  total: 0,
  covered: 0,
  missing: 0,
  unreadable: 0,
  outsideRoots: 0,
  invalid: 0,
  complete: true,
});
function problem(coverage: Coverage, error: unknown) {
  const kind = error instanceof SourceProblem
    ? error.kind
    : error instanceof Deno.errors.NotFound
    ? "missing"
    : "unreadable";
  coverage[kind]++;
  coverage.complete = false;
}
function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}
function hasControlCharacters(path: string): boolean {
  return [...path].some((char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
  );
}
function safeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes("\\") &&
    !hasControlCharacters(path) &&
    path.split("/").every((part) =>
      part !== ".." && part !== "." && part !== ""
    );
}
function excluded(path: string, explicitlyReviewed = false): boolean {
  const parts = path.split(sep);
  return parts.some((part) =>
    deniedComponents.has(part) ||
    (part === ".env.backup" && !explicitlyReviewed) ||
    part.startsWith(".env.backup-")
  ) ||
    parts.some((part, index) =>
      part === ".local" && parts[index + 1] === "backup"
    ) ||
    parts.some((part, index) =>
      part === "tests" && parts[index + 1] === "fixtures"
    ) ||
    // Model weights are not canonical source; retain ordinary source modules.
    (parts.includes("models") &&
      !/\.(?:ts|tsx|js|py|md|json|yaml|yml)$/.test(path));
}
function absolute(path: string | undefined): asserts path is string {
  if (
    !path || !isAbsolute(path) || hasControlCharacters(path) ||
    path.split(sep).includes("..")
  ) throw new SourceProblem("invalid");
}
async function readableFile(path: string): Promise<Deno.FileInfo> {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new SourceProblem("invalid");
  if (info.mode !== null && (info.mode & 0o444) === 0) {
    throw new SourceProblem("unreadable");
  }
  const file = await Deno.open(path, { read: true });
  file.close();
  return info;
}
function protectedPaths(
  config: ProtectedConfig = {},
): Array<string | undefined> {
  const paths: Array<string | undefined> = [];
  for (
    const slot of [
      config.media,
      config.rag,
      config.provider,
      config.mongoKeyfile,
      config.icloudArchive,
    ]
  ) {
    if (slot?.active) paths.push(slot.path);
  }
  if (config.tls?.active) {
    paths.push(config.tls.certificate, config.tls.privateKey);
  }
  if (config.rclone?.active) {
    paths.push(config.rclone.config, config.rclone.knownHosts);
  }
  if (config.pbm?.active) paths.push(config.pbm.env, config.pbm.ca);
  return paths;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function runtimeHostPaths(value: unknown): string[] {
  if (!exactKeys(value, ["mongo", "redis", "rag"])) {
    throw new SourceProblem("invalid");
  }
  const paths: string[] = [];
  const location = (input: unknown) => {
    if (exactKeys(input, ["kind"]) && input.kind === "named-volume") return;
    if (
      !exactKeys(input, ["kind", "path"]) || input.kind !== "host-path" ||
      typeof input.path !== "string"
    ) {
      throw new SourceProblem("invalid");
    }
    absolute(input.path);
    paths.push(input.path);
  };
  location(value.mongo);
  location(value.redis);
  if (exactKeys(value.rag, ["active"]) && value.rag.active === false) {
    return paths;
  }
  if (
    !exactKeys(value.rag, ["active", "qdrant", "state", "modelCache"]) ||
    value.rag.active !== true
  ) {
    throw new SourceProblem("invalid");
  }
  location(value.rag.qdrant);
  location(value.rag.state);
  location(value.rag.modelCache);
  return paths;
}

/** Full paths are sensitive: persist this manifest only inside encrypted restic. */
export async function buildSourceManifest(
  config: BackupConfig,
  backupId: string,
  options: ManifestOptions,
  runner: Runner = new DenoRunner(),
): Promise<SourceManifest> {
  const manifest: SourceManifest = {
    backupId,
    labels: [],
    files: [],
    coverage: freshCoverage(),
  };
  const files = new Set<string>();
  let pathBytes = 0;
  const limitFailure = failureError("SOURCE_COVERAGE_INCOMPLETE");
  const deniedRoots: string[] = [];
  const record = (error: unknown) => {
    if (error === limitFailure) throw error;
    problem(manifest.coverage, error);
  };
  let runtimePaths: string[];
  try {
    runtimePaths = runtimeHostPaths(options?.runtimeRoots);
  } catch (error) {
    record(error);
    return manifest;
  }
  const stage = options.voiceMemos?.publishedAudioRoot ??
    config.voiceMemosRoot ??
    join(config.homeDir, "Library/mycelia/voice-memos-staging/audio-original");
  for (
    const path of [
      config.stateDir,
      dirname(stage),
      ...(config.voiceMemosRoot ? [dirname(config.voiceMemosRoot)] : []),
      join(config.homeDir, "Library/mycelia/voice-memos-staging"),
      // .env.example documents these Mongo/Redis bind-mount defaults.
      join(config.homeDir, ".mycelia/data/mongo"),
      join(config.homeDir, ".mycelia/data/redis"),
      ...runtimePaths,
      ...(options.excludedRoots ?? []),
    ]
  ) {
    try {
      absolute(path);
      deniedRoots.push(resolve(path));
      deniedRoots.push(await Deno.realPath(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) record(error);
    }
  }
  const denied = (path: string, explicitlyReviewed = false) =>
    excluded(path, explicitlyReviewed) ||
    deniedRoots.some((root) => contains(root, path));
  if (options.voiceMemos && config.voiceMemosRoot) {
    try {
      absolute(config.voiceMemosRoot);
      absolute(options.voiceMemos.publishedAudioRoot);
      if (
        await Deno.realPath(config.voiceMemosRoot) !==
          await Deno.realPath(options.voiceMemos.publishedAudioRoot)
      ) {
        throw new SourceProblem("invalid");
      }
    } catch (error) {
      record(error);
    }
  }
  const add = async (
    candidate: string,
    root: string,
    required = false,
    explicitlyReviewed = false,
  ) => {
    try {
      absolute(candidate);
      if (denied(candidate, explicitlyReviewed)) {
        if (required) throw new SourceProblem("invalid");
        return;
      }
      const canonical = await Deno.realPath(candidate);
      if (!contains(root, canonical)) throw new SourceProblem("outsideRoots");
      if (denied(canonical, explicitlyReviewed)) {
        if (required) throw new SourceProblem("invalid");
        return;
      }
      await readableFile(canonical);
      if (!files.has(canonical)) {
        const bytes = new TextEncoder().encode(canonical).length + 1;
        if (
          files.size >= MAX_SOURCE_FILES ||
          bytes > MAX_SOURCE_PATH_BYTES - pathBytes
        ) {
          throw limitFailure;
        }
        pathBytes += bytes;
      }
      files.add(canonical);
    } catch (error) {
      record(error);
    }
  };
  let repoRoot: string | undefined;
  try {
    absolute(config.repoRoot);
    repoRoot = await Deno.realPath(config.repoRoot);
    manifest.labels.push({ label: "tracked-config", canonicalRoot: repoRoot });
    const result = await runner.run(["git", "-C", repoRoot, "ls-files", "-z"], {
      timeoutMs: 30_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    if (result.code !== 0 || result.timedOut) {
      throw new SourceProblem("invalid");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      result.stdout,
    );
    if (text && !text.endsWith("\0")) throw new SourceProblem("invalid");
    for (
      const path of [
        ...text.split("\0").filter(Boolean),
        ...config.operationalUntracked,
      ]
    ) {
      if (!safeRelative(path)) {
        record(new SourceProblem("invalid"));
        continue;
      }
      await add(
        join(repoRoot, path),
        repoRoot,
        false,
        config.operationalUntracked.includes(path),
      );
    }
    await add(join(repoRoot, ".env"), repoRoot, true);
  } catch (error) {
    record(error);
  }

  for (const path of protectedPaths(options.protectedConfig)) {
    try {
      absolute(path);
      const root = await Deno.realPath(dirname(path));
      await add(path, root, true);
      manifest.labels.push({
        label: "operational-config",
        canonicalRoot: root,
      });
    } catch (error) {
      record(error);
    }
  }
  const archiveRoot = options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const roots = [
    { path: archiveRoot, label: "voice-memos-archive", optional: false },
    { path: config.mediaSourceHostPath, label: "media", optional: false },
    { path: config.mediaSourceExtraHostPath, label: "media", optional: false },
    {
      path: options.picturesImportRoot ?? DEFAULT_IMPORT_ROOT,
      label: "media",
      optional: true,
    },
  ];
  for (const item of roots) {
    if (item.path === undefined) continue;
    try {
      absolute(item.path);
      const root = await Deno.realPath(item.path);
      if (
        !(await Deno.stat(root)).isDirectory ||
        (repoRoot && contains(root, repoRoot))
      ) throw new SourceProblem("invalid");
      if (item.label === "voice-memos-archive" && options.voiceMemos) {
        const expected = await Deno.realPath(
          join(root, "data/voice-memos/audio-original"),
        );
        if (
          await Deno.realPath(options.voiceMemos.archiveAudioRoot) !== expected
        ) throw new SourceProblem("invalid");
      }
      if (
        item.label === "voice-memos-archive" &&
        (denied(root) || denied(join(root, "data/voice-memos/audio-original")))
      ) {
        throw new SourceProblem("invalid");
      }
      manifest.labels.push({ label: item.label, canonicalRoot: root });
      const visited = new Set<string>();
      const walk = async (path: string): Promise<void> => {
        try {
          if (denied(path)) return;
          const canonical = await Deno.realPath(path);
          if (!contains(root, canonical)) {
            throw new SourceProblem("outsideRoots");
          }
          if (denied(canonical)) return;
          const info = await Deno.stat(canonical);
          if (info.isDirectory) {
            if (visited.has(canonical)) return;
            visited.add(canonical);
            if (info.mode !== null && (info.mode & 0o444) === 0) {
              throw new SourceProblem("unreadable");
            }
            for await (const entry of Deno.readDir(canonical)) {
              await walk(join(canonical, entry.name));
            }
          } else await add(canonical, root);
        } catch (error) {
          record(error);
        }
      };
      await walk(root);
    } catch (error) {
      if (!(item.optional && error instanceof Deno.errors.NotFound)) {
        record(error);
      }
    }
  }
  manifest.files = [...files].sort();
  return manifest;
}

async function resolveStaged(
  path: string,
  voice: VoiceMemosMapping,
): Promise<string> {
  absolute(voice.publishedAudioRoot);
  absolute(voice.archiveAudioRoot);
  absolute(voice.receiptPath);
  const lexicalRoot = resolve(voice.publishedAudioRoot);
  const canonicalRoot = await Deno.realPath(voice.publishedAudioRoot);
  if (!contains(lexicalRoot, path) && !contains(canonicalRoot, path)) {
    throw new SourceProblem("invalid");
  }
  const selectedRoot = contains(lexicalRoot, path)
    ? lexicalRoot
    : canonicalRoot;
  // Do not normalize away unsafe catalog components before validating them.
  const rawTail = path.slice(
    selectedRoot.length + (selectedRoot.endsWith(sep) ? 0 : 1),
  );
  if (!safeRelative(rawTail)) throw new SourceProblem("invalid");
  const staged = await Deno.realPath(path);
  if (!contains(canonicalRoot, staged)) throw new SourceProblem("outsideRoots");
  const tail = relative(canonicalRoot, staged);
  if (!safeRelative(tail)) throw new SourceProblem("invalid");
  const receiptPath = await Deno.realPath(voice.receiptPath);
  if (!contains(await Deno.realPath(dirname(voice.receiptPath)), receiptPath)) {
    throw new SourceProblem("outsideRoots");
  }
  const info = await readableFile(receiptPath);
  if (
    info.mode === null || (info.mode & 0o777) !== 0o600 ||
    info.size > 1024 * 1024
  ) throw new SourceProblem("invalid");
  const receipt = JSON.parse(await Deno.readTextFile(receiptPath));
  const archiveRoot = await Deno.realPath(voice.archiveAudioRoot);
  const published = Date.parse(receipt.published_at_utc);
  if (
    receipt.schema !== 1 || !Number.isFinite(published) ||
    published > Date.now() + 1000 ||
    receipt.published_audio_root !== canonicalRoot ||
    receipt.archive_audio_root !== archiveRoot ||
    (voice.notBefore !== undefined && receipt.not_before !== voice.notBefore)
  ) throw new SourceProblem("invalid");
  const archive = await Deno.realPath(join(archiveRoot, tail));
  if (!contains(archiveRoot, archive)) throw new SourceProblem("outsideRoots");
  const [stagedInfo, archiveInfo] = await Promise.all([
    readableFile(staged),
    readableFile(archive),
  ]);
  if (
    stagedInfo.size !== archiveInfo.size ||
    (stagedInfo.mtime && stagedInfo.mtime.getTime() > published)
  ) throw new SourceProblem("invalid");
  const digest = async (file: string) => {
    const handle = await Deno.open(file, { read: true });
    return await hashAndCountStream(handle.readable);
  };
  const [a, b] = await Promise.all([digest(staged), digest(archive)]);
  if (
    a.byteCount !== stagedInfo.size || b.byteCount !== archiveInfo.size ||
    a.sha256Hex !== b.sha256Hex
  ) throw new SourceProblem("invalid");
  return archive;
}

export async function reconcileSourcePaths(
  manifest: SourceManifest,
  sources: MongoSourcePaths,
  voiceMemos?: VoiceMemosMapping,
): Promise<SourceManifest> {
  const coverage = {
    ...manifest.coverage,
    total: sources.filteredCount,
    covered: 0,
  };
  const files = new Set(manifest.files);
  if (
    !Number.isSafeInteger(sources.filteredCount) || sources.filteredCount < 0 ||
    sources.records.length !== sources.filteredCount
  ) {
    coverage.total = sources.records.length;
    problem(coverage, new SourceProblem("invalid"));
  }
  let stageRoot: string | undefined;
  if (voiceMemos) {
    try {
      stageRoot = await Deno.realPath(voiceMemos.publishedAudioRoot);
    } catch { /* Each referenced staging claim will fail closed below. */ }
  }
  for (const entry of sources.records) {
    try {
      absolute(entry.path);
      let canonical: string;
      if (
        voiceMemos &&
        (contains(resolve(voiceMemos.publishedAudioRoot), entry.path) ||
          (stageRoot && contains(stageRoot, entry.path)))
      ) {
        canonical = await resolveStaged(entry.path, voiceMemos);
      } else {
        canonical = await Deno.realPath(entry.path);
        if (stageRoot && contains(stageRoot, canonical)) {
          canonical = await resolveStaged(entry.path, voiceMemos!);
        }
      }
      if (!files.has(canonical)) throw new SourceProblem("outsideRoots");
      await readableFile(canonical);
      coverage.covered++;
    } catch (error) {
      problem(coverage, error);
    }
  }
  coverage.complete = coverage.complete && coverage.covered === coverage.total;
  return { ...manifest, files: [...files].sort(), coverage };
}
