import { FAILURE_CODES, type FailureCode, type Stage } from "./backup/types.ts";
import { ownData } from "./backup/redact.ts";
import { loadBackupConfig } from "./backup/config.ts";
import {
  backupStatusPath,
  clearStaleLock,
  readState,
  withLock,
} from "./backup/state.ts";
import { runFilesBackup, verifyAcceptedFiles } from "./backup/files.ts";
import { readBootstrapState } from "./backup/bootstrap-state.ts";
import { runPreflight } from "./backup/preflight.ts";
import {
  attestRecovery,
  checkBootstrap,
  initializeKeychain,
  initializeRepository,
} from "./backup/restic.ts";
import {
  bootstrapStatePaths,
  ensureBootstrapDirectories,
} from "./backup/bootstrap-state.ts";
import {
  assertRepositoryWritable,
  readRepositorySafetyInterlock,
} from "./backup/repository-safety.ts";
import { isAbsolute, join } from "node:path";

export type BackupCommand = Stage | "status" | "verify";
export type BootstrapMode =
  | "check"
  | "initialize-keychain"
  | "attest-recovery"
  | "initialize-repository";
export type ParsedCli = {
  command: BackupCommand;
  composeRoot: string;
  clearStaleLockPid?: number;
  remoteMode?: "skip" | "full";
  json?: boolean;
  bootstrapMode?: BootstrapMode;
  receiptId?: string;
};
export type CommandHandlers = Record<
  BackupCommand,
  (options: ParsedCli) => Promise<number>
>;

const commands: readonly BackupCommand[] = [
  "preflight",
  "bootstrap",
  "files",
  "mongo-bootstrap",
  "status",
  "verify",
];
const usage =
  "Usage: backupctl <command> --compose-root <absolute-path> [options]";

function stalePid(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid <= 2147483647 ? pid : undefined;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  if (
    argv[0] === "preflight" && argv[1] === "--compose-root" &&
    argv[2]?.startsWith("/") &&
    ((argv.length === 4 && argv[3] === "--json") ||
      (argv.length === 6 && argv[3] === "--remote-mode" &&
        ["skip", "full"].includes(argv[4]) && argv[5] === "--json"))
  ) {
    return {
      command: "preflight",
      composeRoot: argv[2],
      remoteMode: argv.length === 4 ? "full" : argv[4] as "skip" | "full",
      json: true,
    };
  }
  if (
    argv[0] === "bootstrap" && argv[1] === "--compose-root" &&
    argv[2] !== undefined && isAbsolute(argv[2])
  ) {
    let tail = argv.slice(3);
    let clearStaleLockPid: number | undefined;
    if (tail.length >= 2 && tail.at(-2) === "--clear-stale-lock") {
      clearStaleLockPid = stalePid(tail.at(-1));
      if (clearStaleLockPid === undefined) throw new Error(usage);
      tail = tail.slice(0, -2);
    }
    let bootstrapMode: BootstrapMode;
    let receiptId: string | undefined;
    if (tail.length === 1 && tail[0] === "--check") {
      bootstrapMode = "check";
    } else if (tail.length === 1 && tail[0] === "--initialize-keychain") {
      bootstrapMode = "initialize-keychain";
    } else if (tail.length === 1 && tail[0] === "--initialize-repository") {
      bootstrapMode = "initialize-repository";
    } else if (
      tail.length === 3 && tail[0] === "--attest-recovery" &&
      tail[1] === "--receipt-id" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(tail[2])
    ) {
      bootstrapMode = "attest-recovery";
      receiptId = tail[2];
    } else {
      throw new Error(usage);
    }
    return {
      command: "bootstrap",
      composeRoot: argv[2],
      bootstrapMode,
      ...(receiptId === undefined ? {} : { receiptId }),
      ...(clearStaleLockPid === undefined ? {} : { clearStaleLockPid }),
    };
  }
  if (
    (argv.length !== 3 && argv.length !== 5) ||
    !commands.includes(argv[0] as BackupCommand) || argv[0] === "bootstrap" ||
    argv[1] !== "--compose-root" ||
    !argv[2] || !isAbsolute(argv[2])
  ) {
    throw new Error(usage);
  }
  if (argv.length === 5) {
    const pid = stalePid(argv[4]);
    if (argv[3] !== "--clear-stale-lock" || pid === undefined) {
      throw new Error(usage);
    }
    return {
      command: argv[0] as BackupCommand,
      composeRoot: argv[2],
      clearStaleLockPid: pid,
    };
  }
  return { command: argv[0] as BackupCommand, composeRoot: argv[2] };
}

const unavailable = () => Promise.resolve(69);
async function runBootstrap(options: ParsedCli): Promise<number> {
  if (options.bootstrapMode === "check") {
    await checkBootstrap(options.composeRoot);
    return 0;
  }
  if (!options.bootstrapMode) throw new Error("invalid bootstrap mode");
  await assertRepositoryWritable(
    bootstrapStatePaths(options.composeRoot).stateDir,
  );
  await ensureBootstrapDirectories(options.composeRoot);
  const config = await loadBackupConfig(
    options.composeRoot,
    Deno.env.get("HOME") ?? options.composeRoot,
  );
  const backupId = new Date().toISOString().replace(/[-:.]/g, "");
  return await withLock(
    config.lockPath,
    { command: "bootstrap", backupId },
    async (lease) => {
      if (options.bootstrapMode === "initialize-keychain") {
        await initializeKeychain(options.composeRoot, lease);
      } else if (options.bootstrapMode === "attest-recovery") {
        if (!options.receiptId) throw new Error("missing receipt");
        await attestRecovery(
          options.composeRoot,
          lease,
          options.receiptId,
        );
      } else if (options.bootstrapMode === "initialize-repository") {
        await initializeRepository(options.composeRoot, lease);
      } else {
        throw new Error("invalid bootstrap mode");
      }
      return 0;
    },
  );
}
const unavailableHandlers: CommandHandlers = {
  preflight: async (options) => {
    const report = await runPreflight({
      composeRoot: options.composeRoot,
      remoteMode: options.remoteMode ?? "full",
    });
    console.log(
      options.json
        ? JSON.stringify(report)
        : `preflight: ${
          report.failure ?? (report.ok ? "complete" : "not_started")
        }`,
    );
    return report.ok ? 0 : 1;
  },
  bootstrap: runBootstrap,
  files: async (options) => {
    const state = await runFilesBackup(options);
    console.log(JSON.stringify(state));
    return state.state === "complete" ? 0 : 1;
  },
  "mongo-bootstrap": unavailable,
  status: async (options) => {
    const stateDir = bootstrapStatePaths(options.composeRoot).stateDir;
    let initialized = true;
    try {
      await Deno.lstat(stateDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) initialized = false;
      else throw error;
    }
    const [bootstrap, files, mongo, interlock] = await Promise.all([
      initialized
        ? readBootstrapState(options.composeRoot)
        : Promise.resolve(null),
      readState(backupStatusPath(stateDir, "files")),
      readState(backupStatusPath(stateDir, "mongo-bootstrap")),
      readRepositorySafetyInterlock(stateDir),
    ]);
    console.log(JSON.stringify({
      schema: 1,
      bootstrap: bootstrap?.phase ?? "not_started",
      files,
      mongo,
      quarantine: interlock
        ? {
          phase: interlock.phase,
          quarantineId: interlock.record.quarantineId,
          reason: interlock.record.reason,
        }
        : null,
    }));
    return interlock ? 1 : 0;
  },
  verify: async (options) => {
    const paths = bootstrapStatePaths(options.composeRoot);
    await assertRepositoryWritable(paths.stateDir);
    const backupId = new Date().toISOString().replace(/[-:.]/g, "");
    await withLock(join(paths.stateDir, "backup.lock"), {
      command: "verify",
      backupId,
    }, async (lockLease) => {
      const state = await readState(backupStatusPath(paths.stateDir, "files"));
      if (!state?.accepted) throw new Error("RESTIC_VERIFY_FAILED");
      await verifyAcceptedFiles({ ...options, lockLease }, state.accepted);
      console.log(
        JSON.stringify({
          schema: 1,
          scope: "files",
          verified: true,
          snapshotId: state.accepted.snapshotId,
        }),
      );
    });
    return 0;
  },
};

export async function main(
  argv: readonly string[],
  handlers: CommandHandlers = unavailableHandlers,
  writeError: (message: string) => void = console.error,
): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch {
    writeError(usage);
    return 64;
  }
  try {
    if (parsed.clearStaleLockPid !== undefined) {
      const config = await loadBackupConfig(
        parsed.composeRoot,
        Deno.env.get("HOME") ?? parsed.composeRoot,
      );
      await clearStaleLock(config.lockPath, parsed.clearStaleLockPid);
    }
    return await handlers[parsed.command](parsed);
  } catch (error) {
    const code = ownData(error, "code");
    writeError(
      `Backup command failed: ${
        FAILURE_CODES.includes(code as FailureCode) ? code : "COMMAND_FAILED"
      }`,
    );
    return 70;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
