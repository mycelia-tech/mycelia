import { FAILURE_CODES } from "./types.ts";
import type {
  FailureCode,
  PersistedCounters,
  PersistedFailure,
  Stage,
  ToolLabel,
} from "./types.ts";

// Exhaustive maps are checked against the unions in types.ts; they cannot add
// values independently of those registries.
const tools: Record<ToolLabel, true> = {
  backupctl: true,
  filesystem: true,
  git: true,
  swiftc: true,
  "keychain-helper": true,
  security: true,
  ssh: true,
  rclone: true,
  restic: true,
  docker: true,
  mongosh: true,
  mongodump: true,
  mongorestore: true,
};
const sources: Record<NonNullable<PersistedFailure["sourceLabel"]>, true> = {
  "tracked-config": true,
  "operational-config": true,
  media: true,
  "voice-memos-archive": true,
  "mongo-bootstrap": true,
};
const stages: Record<Stage, true> = {
  preflight: true,
  bootstrap: true,
  files: true,
  "mongo-bootstrap": true,
};
const counters: Record<keyof PersistedCounters, true> = {
  files: true,
  bytes: true,
  total: true,
  covered: true,
  missing: true,
  unreadable: true,
  outsideRoots: true,
  invalid: true,
};
export const MAX_RECORD_BYTES = 8192;
export function failureError(code: FailureCode): Error & { code: FailureCode } {
  return Object.assign(new Error(code), { code });
}
export function invalidState(): never {
  throw failureError("STATE_INVALID");
}
export function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
export function closedObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalidState();
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" || !allowed.includes(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !("value" in Object.getOwnPropertyDescriptor(value, key)!)
    ) invalidState();
  }
  return value as Record<string, unknown>;
}
function registered(value: unknown, registry: object): boolean {
  return typeof value === "string" && Object.hasOwn(registry, value);
}
export function isStage(value: unknown): value is Stage {
  return registered(value, stages);
}
export function isBackupId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{8}T\d{6}(?:\d{3})?Z(?:-[a-f0-9]{8})?$/.test(value)
  ) return false;
  const base = value.slice(0, 15);
  return isUtc(
    `${base.slice(0, 4)}-${base.slice(4, 6)}-${base.slice(6, 8)}T${
      base.slice(9, 11)
    }:${base.slice(11, 13)}:${base.slice(13, 15)}.000Z`,
  );
}
export function isUtc(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
export function validateCounters(
  value: unknown,
): asserts value is PersistedCounters {
  const record = closedObject(value, Object.keys(counters));
  for (const number of Object.values(record)) {
    if (!Number.isSafeInteger(number) || (number as number) < 0) invalidState();
  }
}
export function validateFailure(
  value: unknown,
): asserts value is PersistedFailure {
  const record = closedObject(value, [
    "schema",
    "code",
    "stage",
    "backupId",
    "timestampUtc",
    "tool",
    "exitCode",
    "timedOut",
    "sourceLabel",
    "counters",
  ]);
  if (
    record.schema !== 1 ||
    !FAILURE_CODES.includes(record.code as FailureCode) ||
    !isStage(record.stage) || !isBackupId(record.backupId) ||
    !isUtc(record.timestampUtc) || !registered(record.tool, tools) ||
    typeof record.timedOut !== "boolean"
  ) invalidState();
  if (
    Object.hasOwn(record, "exitCode") &&
    (!Number.isInteger(record.exitCode) || (record.exitCode as number) < -1 ||
      (record.exitCode as number) > 255)
  ) invalidState();
  if (
    Object.hasOwn(record, "sourceLabel") &&
    !registered(record.sourceLabel, sources)
  ) invalidState();
  if (Object.hasOwn(record, "counters")) validateCounters(record.counters);
  boundedJson(record);
}
export function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_RECORD_BYTES) {
    invalidState();
  }
  return json;
}

// Neither error text nor raw subprocess bytes are inspected or copied. Only
// own data properties can supply the explicitly registered metadata below.
export function redactError(
  error: unknown,
  context: unknown,
): PersistedFailure {
  const timedOut = ownData(error, "timedOut") === true;
  const candidate = ownData(error, "code");
  const code: FailureCode = FAILURE_CODES.includes(candidate as FailureCode)
    ? candidate as FailureCode
    : timedOut
    ? "COMMAND_TIMEOUT"
    : "COMMAND_FAILED";
  const failure: Record<string, unknown> = {
    schema: 1,
    code,
    stage: ownData(context, "stage"),
    backupId: ownData(context, "backupId"),
    timestampUtc: ownData(context, "timestampUtc") ?? new Date().toISOString(),
    tool: ownData(context, "tool"),
    timedOut,
  };
  const exitCode = ownData(error, "exitCode");
  if (
    Number.isInteger(exitCode) && (exitCode as number) >= -1 &&
    (exitCode as number) <= 255
  ) failure.exitCode = exitCode;
  const source = ownData(context, "sourceLabel");
  if (source !== undefined) failure.sourceLabel = source;
  const counts = ownData(context, "counters");
  if (counts !== undefined) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      invalidState();
    }
    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(counters)) {
      const number = ownData(counts, key);
      if (number !== undefined) safe[key] = number;
    }
    failure.counters = safe;
  }
  validateFailure(failure);
  return failure;
}
export function renderFailure(
  failure: unknown,
  format: "json" | "human",
): string {
  validateFailure(failure);
  if (format === "json") return boundedJson(failure);
  return `${failure.timestampUtc} ${failure.backupId} ${failure.stage}: ${failure.code} (${failure.tool}; timedOut=${failure.timedOut}${
    failure.exitCode === undefined ? "" : `; exitCode=${failure.exitCode}`
  })`;
}
