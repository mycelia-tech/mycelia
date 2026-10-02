export type Stage =
  | "preflight"
  | "bootstrap"
  | "files"
  | "mongo-bootstrap";

export type StageState =
  | "not_started"
  | "running"
  | "complete"
  | "failed"
  | "stale";

export type BackupStatus = {
  schema: 1;
  stage: Stage;
  state: StageState;
  backupId: string;
  startedAtUtc: string;
  endedAtUtc?: string;
  snapshotId?: string;
  failure?: PersistedFailure;
  sourceCounts?: PersistedCounters;
  accepted?: FilesAcceptedReceipt;
};

export type FilesAcceptedReceipt = {
  schema: 1;
  kind: "files";
  repositoryId: string;
  backupId: string;
  snapshotId: string;
  acceptedAtUtc: string;
  verificationOrdinal: number;
  checkSubsetPart: number;
  manifestSha256: string;
  manifestBytes: number;
  representativeSha256: string;
  representativeBytes: number;
  sourceCounts: {
    files: number;
    bytes: number;
    total: number;
    covered: number;
    missing: 0;
    unreadable: 0;
    outsideRoots: 0;
    invalid: 0;
  };
  transportVerified: true;
};

export const FAILURE_CODES = [
  "USAGE_ERROR",
  "OUTPUT_LIMIT_EXCEEDED",
  "COMMAND_TERMINATION_UNCONFIRMED",
  "COMMAND_TIMEOUT",
  "COMMAND_FAILED",
  "CONFIG_INVALID",
  "LOCK_HELD",
  "STALE_LOCK",
  "STATE_INVALID",
  "REPOSITORY_QUARANTINED",
  "SOURCE_COVERAGE_INCOMPLETE",
  "SSH_NONINTERACTIVE_REQUIRED",
  "HOST_KEY_MISMATCH",
  "REMOTE_CAPACITY_UNKNOWN",
  "REMOTE_CAPACITY_LOW",
  "REMOTE_NAMESPACE_UNKNOWN",
  "MONGO_NOT_PRIMARY",
  "OPLOG_WINDOW_SHORT",
  "VISIBLE_TTY_REQUIRED",
  "KEYCHAIN_ITEM_MISSING",
  "KEYCHAIN_DUPLICATE_ITEM",
  "KEYCHAIN_CANCELLED",
  "KEYCHAIN_UNAVAILABLE",
  "KEYCHAIN_RNG_FAILED",
  "KEYCHAIN_CREATE_AMBIGUOUS",
  "KEYCHAIN_CREATE_FAILED",
  "KEYCHAIN_PROVENANCE_MISMATCH",
  "KEYCHAIN_ITEM_AMBIGUOUS",
  "RECOVERY_RECEIPT_MISSING",
  "REPOSITORY_ID_MISMATCH",
  "RESTIC_INIT_FAILED",
  "RESTIC_VERIFY_FAILED",
  "FILES_BACKUP_FAILED",
  "MONGO_BOOTSTRAP_FAILED",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export type ToolLabel =
  | "backupctl"
  | "filesystem"
  | "git"
  | "swiftc"
  | "keychain-helper"
  | "security"
  | "ssh"
  | "rclone"
  | "restic"
  | "docker"
  | "mongosh"
  | "mongodump"
  | "mongorestore";
export type PersistedCounters = {
  files?: number;
  bytes?: number;
  total?: number;
  covered?: number;
  missing?: number;
  unreadable?: number;
  outsideRoots?: number;
  invalid?: number;
};
export type PersistedFailure = {
  schema: 1;
  code: FailureCode;
  stage: Stage;
  backupId: string;
  timestampUtc: string;
  tool: ToolLabel;
  exitCode?: number;
  timedOut: boolean;
  sourceLabel?:
    | "tracked-config"
    | "operational-config"
    | "media"
    | "voice-memos-archive"
    | "mongo-bootstrap";
  counters?: PersistedCounters;
};

export type CommandResult = {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
  terminationConfirmed: true;
  forcedKill: false;
};

export type BaseChildEnvironment = Readonly<{
  HOME: string;
  PATH: string;
}>;

export type ClosedResticEnvironment = Readonly<
  BaseChildEnvironment & {
    MYCELIA_BACKUP_COMPOSE_ROOT: string;
    RCLONE_CONFIG: string;
    RESTIC_PASSWORD_COMMAND: string;
    RESTIC_REPOSITORY: string;
  }
>;

export type BufferedCommandOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  terminationGraceMs?: number;
  terminationConfirmMs?: number;
  clearEnv?: boolean;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
};

export type StreamingCommandOptions = {
  timeoutMs: number;
  terminationGraceMs?: number;
  terminationConfirmMs?: number;
  clearEnv?: boolean;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
};

export type StreamDigest = {
  byteCount: number;
  sha256Hex: string;
};

export type RunningCommandStatus = Readonly<{
  code: number;
  timedOut: boolean;
  terminationConfirmed: true;
  forcedKill: false;
}>;

export type CommandTerminationError =
  & Error
  & (
    | Readonly<{
      code: "COMMAND_TERMINATION_UNCONFIRMED";
      timedOut: boolean;
      terminationConfirmed: false;
      forcedKill: boolean;
    }>
    | Readonly<{
      code: "COMMAND_TERMINATION_UNCONFIRMED";
      timedOut: boolean;
      terminationConfirmed: true;
      forcedKill: true;
    }>
  );

export type CommandRunError =
  & Error
  & Readonly<{
    code: "OUTPUT_LIMIT_EXCEEDED";
    exitCode?: number;
    timedOut: boolean;
    terminationConfirmed: true;
    forcedKill: false;
  }>;

export interface Runner {
  run(
    argv: readonly string[],
    options: BufferedCommandOptions,
  ): Promise<CommandResult>;
  spawn(
    argv: readonly string[],
    options: StreamingCommandOptions,
  ): RunningCommand;
}

export type RunningCommand = {
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  status: Promise<RunningCommandStatus>;
  kill: () => void;
};

export { collectBoundedStream, hashAndCountStream } from "./runner.ts";
