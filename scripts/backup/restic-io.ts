import type {
  ClosedResticEnvironment,
  FailureCode,
  Runner,
  RunningCommand,
  StreamDigest,
} from "./types.ts";
import {
  hashAndCountStream,
  isCommandTerminationError,
  startManagedStdin,
} from "./runner.ts";
import { assertClosedResticEnvironment } from "./restic.ts";
import { failureError } from "./redact.ts";
import {
  MAX_RESTIC_JSON_LINE_BYTES,
  MAX_RESTIC_JSON_TOTAL_BYTES,
  MAX_RESTIC_STDERR_BYTES,
  MAX_SNAPSHOT_JSON_BYTES,
  RESTIC_CHECK_TIMEOUT_MS,
  RESTIC_DUMP_TIMEOUT_MS,
  RESTIC_METADATA_TIMEOUT_MS,
} from "./limits.ts";

const hash = /^[a-f0-9]{64}$/;
function fail(code: FailureCode): never {
  throw failureError(code);
}
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      if (chunk.length > limit - length) fail("OUTPUT_LIMIT_EXCEEDED");
      chunks.push(chunk);
      length += chunk.length;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
export type ResticBackupExecution = {
  exitCode: number;
  timedOut: false;
  terminationConfirmed: true;
  summary?: {
    snapshotId: string;
    dryRun: false;
    totalFilesProcessed: number;
    totalBytesProcessed: number;
    backupStart: string;
    backupEnd: string;
  };
};

// Every consumer is attached before awaiting any of them. On failure the
// managed stdin is aborted before kill/drain/reap, preserving typed termination.
async function consume<T>(
  child: RunningCommand,
  reader: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  code: FailureCode,
): Promise<{ value: T; code: number }> {
  const input = startManagedStdin(child.stdin);
  const output = child.stdout
    ? reader(child.stdout)
    : Promise.reject(failureError(code));
  const diagnostics = child.stderr
    ? (async () => {
      const bytes = await boundedBytes(
        child.stderr!,
        MAX_RESTIC_STDERR_BYTES,
      );
      bytes.fill(0);
    })()
    : Promise.reject(failureError(code));
  const tasks = [output, diagnostics, child.status, input.operation] as const;
  try {
    const [value, , status] = await Promise.all(tasks);
    if (status.timedOut) fail("COMMAND_TIMEOUT");
    return { value, code: status.code };
  } catch (error) {
    input.abort();
    try {
      child.kill();
    } catch { /* raced exit */ }
    const outcomes = await Promise.allSettled(tasks);
    for (const result of outcomes) {
      if (
        result.status === "rejected" && isCommandTerminationError(result.reason)
      ) throw result.reason;
    }
    if (isCommandTerminationError(error)) throw error;
    if (
      ["COMMAND_TIMEOUT", "OUTPUT_LIMIT_EXCEEDED"].includes(
        (error as { code?: string })?.code ?? "",
      )
    ) throw error;
    fail(code);
  }
}

function spawn(
  runner: Runner,
  argv: readonly string[],
  env: ClosedResticEnvironment,
  timeoutMs: number,
) {
  assertClosedResticEnvironment(env);
  return runner.spawn(argv, { env, clearEnv: true, timeoutMs });
}

async function jsonLines(
  stream: ReadableStream<Uint8Array>,
  onRecord: (record: Record<string, unknown>) => void,
  code: FailureCode,
) {
  const line = new Uint8Array(MAX_RESTIC_JSON_LINE_BYTES);
  let length = 0, total = 0;
  const decode = () => {
    if (!length) fail(code);
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          line.subarray(0, length),
        ),
      );
    } catch {
      fail(code);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    onRecord(value);
    line.fill(0, 0, length);
    length = 0;
  };
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_RESTIC_JSON_TOTAL_BYTES) fail("OUTPUT_LIMIT_EXCEEDED");
      for (const byte of chunk) {
        if (byte === 10) {
          decode();
          continue;
        }
        if (length === line.length) fail("OUTPUT_LIMIT_EXCEEDED");
        line[length++] = byte;
      }
    }
    if (length) decode();
  } finally {
    line.fill(0);
  }
}

export async function runResticJsonBackup(
  runner: Runner,
  argv: readonly string[],
  options: { env: ClosedResticEnvironment; timeoutMs: number },
): Promise<ResticBackupExecution> {
  if (
    !argv.includes("--quiet") || !argv.includes("--json") ||
    !argv.includes("backup")
  ) fail("CONFIG_INVALID");
  let summary: ResticBackupExecution["summary"];
  const result = await consume(
    spawn(runner, argv, options.env, options.timeoutMs),
    async (stream) => {
      await jsonLines(stream, (record) => {
        if (summary) fail("FILES_BACKUP_FAILED");
        if (record.message_type !== "summary") return;
        const start = record.backup_start, end = record.backup_end;
        const date = (v: unknown): v is string =>
          typeof v === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
            v,
          ) && Number.isFinite(Date.parse(v));
        const files = record.total_files_processed ?? 0,
          bytes = record.total_bytes_processed ?? 0;
        if (
          typeof record.snapshot_id !== "string" ||
          !hash.test(record.snapshot_id) ||
          (record.dry_run !== undefined && record.dry_run !== false) ||
          !integer(files) || !integer(bytes) || !date(start) || !date(end) ||
          Date.parse(start) > Date.parse(end)
        ) fail("FILES_BACKUP_FAILED");
        summary = {
          snapshotId: record.snapshot_id,
          dryRun: false,
          totalFilesProcessed: files,
          totalBytesProcessed: bytes,
          backupStart: new Date(start).toISOString(),
          backupEnd: new Date(end).toISOString(),
        };
      }, "FILES_BACKUP_FAILED");
    },
    "FILES_BACKUP_FAILED",
  );
  if (result.code === 0 && !summary) fail("FILES_BACKUP_FAILED");
  return {
    exitCode: result.code,
    timedOut: false,
    terminationConfirmed: true,
    ...((result.code === 0 || result.code === 3) && summary ? { summary } : {}),
  };
}

export async function readSnapshot(
  runner: Runner,
  env: ClosedResticEnvironment,
  expected: {
    snapshotId: string;
    host: string;
    backupId: string;
    paths?: readonly string[];
    startedAtUtc?: string;
    endedAtUtc?: string;
  },
): Promise<void> {
  if (!hash.test(expected.snapshotId)) fail("RESTIC_VERIFY_FAILED");
  const result = await consume(
    spawn(
      runner,
      [
        "restic",
        "--json",
        "--quiet",
        "--no-cache",
        "snapshots",
        "--host",
        expected.host,
        "--tag",
        `mycelia-files,backup-id=${expected.backupId}`,
        expected.snapshotId,
      ],
      env,
      RESTIC_METADATA_TIMEOUT_MS,
    ),
    async (stream) => {
      const bytes = await boundedBytes(stream, MAX_SNAPSHOT_JSON_BYTES);
      try {
        const all = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (!Array.isArray(all) || all.length !== 1) {
          fail("RESTIC_VERIFY_FAILED");
        }
        const s = all[0];
        if (
          s.id !== expected.snapshotId || s.hostname !== expected.host ||
          !Array.isArray(s.tags) || s.tags.length !== 2 ||
          !s.tags.includes("mycelia-files") ||
          !s.tags.includes(`backup-id=${expected.backupId}`) ||
          !Array.isArray(s.paths) || s.paths.some((p: unknown) =>
            typeof p !== "string"
          ) || new Set(s.paths).size !== s.paths.length ||
          typeof s.time !== "string" || !Number.isFinite(Date.parse(s.time))
        ) fail("RESTIC_VERIFY_FAILED");
        const snapshotPaths = new Set<string>(s.paths);
        if (
          expected.paths &&
          (s.paths.length !== expected.paths.length ||
            !expected.paths.every((p) => snapshotPaths.has(p)))
        ) fail("RESTIC_VERIFY_FAILED");
        if (
          expected.startedAtUtc &&
          Date.parse(s.time) < Date.parse(expected.startedAtUtc)
        ) fail("RESTIC_VERIFY_FAILED");
        if (
          expected.endedAtUtc &&
          Date.parse(s.time) > Date.parse(expected.endedAtUtc)
        ) fail("RESTIC_VERIFY_FAILED");
      } finally {
        bytes.fill(0);
      }
    },
    "RESTIC_VERIFY_FAILED",
  );
  if (result.code !== 0) fail("RESTIC_VERIFY_FAILED");
}

export async function checkRepository(
  runner: Runner,
  env: ClosedResticEnvironment,
  part: number,
): Promise<void> {
  if (!Number.isInteger(part) || part < 1 || part > 100) {
    fail("RESTIC_VERIFY_FAILED");
  }
  let summary = false;
  const result = await consume(
    spawn(
      runner,
      [
        "restic",
        "--json",
        "--quiet",
        "--no-cache",
        "check",
        `--read-data-subset=${part}/100`,
      ],
      env,
      RESTIC_CHECK_TIMEOUT_MS,
    ),
    async (stream) => {
      await jsonLines(stream, (record) => {
        if (summary) fail("RESTIC_VERIFY_FAILED");
        if (record.message_type !== "summary") return;
        if (
          (record.num_errors !== undefined && record.num_errors !== 0) ||
          (record.broken_packs != null &&
            (!Array.isArray(record.broken_packs) ||
              record.broken_packs.length !== 0)) ||
          Object.keys(record).some((k) =>
            k.startsWith("suggest_") && record[k] !== false
          )
        ) fail("RESTIC_VERIFY_FAILED");
        summary = true;
      }, "RESTIC_VERIFY_FAILED");
    },
    "RESTIC_VERIFY_FAILED",
  );
  if (result.code !== 0 || !summary) fail("RESTIC_VERIFY_FAILED");
}

export async function dumpDigest(
  runner: Runner,
  env: ClosedResticEnvironment,
  snapshotId: string,
  path: string,
): Promise<StreamDigest> {
  if (!hash.test(snapshotId) || !path.startsWith("/") || path.includes("\0")) {
    fail("RESTIC_VERIFY_FAILED");
  }
  const result = await consume(
    spawn(
      runner,
      ["restic", "--quiet", "--no-cache", "dump", snapshotId, path],
      env,
      RESTIC_DUMP_TIMEOUT_MS,
    ),
    hashAndCountStream,
    "RESTIC_VERIFY_FAILED",
  );
  if (result.code !== 0) fail("RESTIC_VERIFY_FAILED");
  return result.value;
}
