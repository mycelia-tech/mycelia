import { createHash } from "node:crypto";
import type {
  BufferedCommandOptions,
  CommandResult,
  CommandRunError,
  CommandTerminationError,
  Runner,
  RunningCommand,
  StreamDigest,
  StreamingCommandOptions,
} from "./types.ts";

function requirePositive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Expected a positive integer limit");
  }
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function outputLimitError(
  exitCode: number,
  timedOut: boolean,
): CommandRunError {
  return Object.assign(new Error("Command output limit exceeded"), {
    code: "OUTPUT_LIMIT_EXCEEDED" as const,
    exitCode,
    timedOut,
    terminationConfirmed: true as const,
    forcedKill: false as const,
  });
}

const TERM_GRACE_MS = 250;
const TERMINATION_CONFIRM_MS = 1_000;

export function commandTerminationError(
  timedOut: boolean,
  terminationConfirmed: boolean,
  forcedKill: boolean,
): CommandTerminationError {
  return Object.assign(new Error("Command termination could not be trusted"), {
    code: "COMMAND_TERMINATION_UNCONFIRMED" as const,
    timedOut,
    terminationConfirmed,
    forcedKill,
  }) as CommandTerminationError;
}

export function isCommandTerminationError(
  error: unknown,
): error is CommandTerminationError {
  if (!(error instanceof Error)) return false;
  const value = error as Error & Record<string, unknown>;
  return value.code === "COMMAND_TERMINATION_UNCONFIRMED" &&
    typeof value.timedOut === "boolean" &&
    typeof value.terminationConfirmed === "boolean" &&
    typeof value.forcedKill === "boolean" &&
    (value.terminationConfirmed === false || value.forcedKill === true) &&
    Object.keys(value).sort().join(",") ===
      "code,forcedKill,terminationConfirmed,timedOut";
}

function managedOutput(
  source: ReadableStream<Uint8Array>,
  stopChild: () => void,
): {
  stream: ReadableStream<Uint8Array>;
  done: Promise<void>;
  forceClose: () => void;
} {
  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (finished) return false;
    finished = true;
    resolveDone();
    return true;
  };
  const cancelSource = () => {
    void reader.cancel().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finish();
          value.close();
          return;
        }
        value.enqueue(next.value);
      } catch {
        if (finish()) {
          stopChild();
          value.error(new Error("Command output unavailable"));
        }
      }
    },
    cancel() {
      if (finish()) stopChild();
      cancelSource();
    },
  }, { highWaterMark: 0 });
  return {
    stream,
    done,
    forceClose: () => {
      if (!finish()) return;
      controller.close();
      cancelSource();
    },
  };
}

function managedWriter(source: WritableStream<Uint8Array>): {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => void;
} {
  const writer = source.getWriter();
  const aborted = Symbol("managed input aborted");
  let didAbort = false;
  let resolveAbort!: (value: typeof aborted) => void;
  const abortSignal = new Promise<typeof aborted>((resolve) => {
    resolveAbort = resolve;
  });
  const settle = async <T>(operation: Promise<T>): Promise<T> => {
    const observed = operation.then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const outcome = await Promise.race([observed, abortSignal]);
    if (outcome === aborted) throw new Error("Command input unavailable");
    if (outcome.kind === "rejected") throw outcome.error;
    return outcome.value;
  };
  const abort = () => {
    if (didAbort) return;
    didAbort = true;
    resolveAbort(aborted);
    // The underlying writer is owned here rather than by the caller-facing
    // stream, so cancellation remains possible while that facade is locked by
    // a pending write. Its promise is always observed even if a platform pipe
    // never completes the in-flight write.
    void writer.abort().catch(() => undefined);
  };
  return {
    write: (chunk) => settle(Promise.resolve().then(() => writer.write(chunk))),
    close: () => settle(Promise.resolve().then(() => writer.close())),
    abort,
  };
}

function managedInput(source: WritableStream<Uint8Array>): {
  stream: WritableStream<Uint8Array>;
  abort: () => void;
} {
  const writer = managedWriter(source);
  return {
    stream: new WritableStream<Uint8Array>({
      write: writer.write,
      close: writer.close,
      abort() {
        writer.abort();
      },
    }),
    abort: writer.abort,
  };
}

export type ManagedStdinOperation = Readonly<{
  operation: Promise<void>;
  settled: Promise<void>;
  abort: () => void;
}>;

export function startManagedStdin(
  stream: WritableStream<Uint8Array> | null,
  bytes?: Uint8Array,
): ManagedStdinOperation {
  if (!stream) {
    const operation = bytes === undefined
      ? Promise.resolve()
      : Promise.reject(new Error("Command input unavailable"));
    return {
      operation,
      settled: operation.then(() => undefined, () => undefined),
      abort() {},
    };
  }
  const writer = managedWriter(stream);
  const operation = (async () => {
    if (bytes !== undefined) await writer.write(bytes);
    await writer.close();
  })();
  return {
    operation,
    settled: operation.then(() => undefined, () => undefined),
    abort: writer.abort,
  };
}

export type RunnerChildProcess = Readonly<{
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<{ code: number }>;
  kill: (signal: Deno.Signal) => void;
}>;

export type RunnerChildSpawner = (
  argv: readonly string[],
  options: StreamingCommandOptions,
) => RunnerChildProcess;

function spawnDenoChild(
  argv: readonly string[],
  options: StreamingCommandOptions,
): RunnerChildProcess {
  return new Deno.Command(argv[0], {
    args: argv.slice(1),
    ...(options.clearEnv === undefined ? {} : { clearEnv: options.clearEnv }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

export async function hashAndCountStream(
  stream: ReadableStream<Uint8Array>,
): Promise<StreamDigest> {
  const hash = createHash("sha256");
  let byteCount = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > Number.MAX_SAFE_INTEGER - byteCount) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Stream byte count exceeds safe integer range");
      }
      hash.update(next.value);
      byteCount += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { byteCount, sha256Hex: hash.digest("hex") };
}

export async function collectBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Expected a non-negative integer limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    if (chunk.byteLength > maxBytes - length) {
      throw new Error("Stream output limit exceeded");
    }
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  return joinChunks(chunks, length);
}

export class DenoRunner implements Runner {
  constructor(
    private readonly spawnChild: RunnerChildSpawner = spawnDenoChild,
  ) {}

  spawn(
    argv: readonly string[],
    options: StreamingCommandOptions,
  ): RunningCommand {
    if (argv.length === 0 || !argv[0]) {
      throw new TypeError("Expected a non-empty argv");
    }
    requirePositive(options.timeoutMs);
    const terminationGraceMs = options.terminationGraceMs ?? TERM_GRACE_MS;
    requirePositive(terminationGraceMs);
    const terminationConfirmMs = options.terminationConfirmMs ??
      TERMINATION_CONFIRM_MS;
    requirePositive(terminationConfirmMs);

    let child: RunnerChildProcess;
    try {
      child = this.spawnChild(argv, options);
    } catch {
      throw new Error("Command could not start");
    }
    const stdin = managedInput(child.stdin);
    let stopForOutput = () => {};
    const stdout = managedOutput(child.stdout, () => stopForOutput());
    const stderr = managedOutput(child.stderr, () => stopForOutput());
    let timedOut = false;
    let completed = false;
    let stopping = false;
    let forcedKill = false;
    let rawSettled = false;
    let rawCode: number | null = null;
    let stdoutSettled = false;
    let stderrSettled = false;
    let terminationUnconfirmed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveStatus!: (value: {
      code: number;
      timedOut: boolean;
      terminationConfirmed: true;
      forcedKill: false;
    }) => void;
    let rejectStatus!: (reason: CommandTerminationError) => void;
    const status = new Promise<{
      code: number;
      timedOut: boolean;
      terminationConfirmed: true;
      forcedKill: false;
    }>((resolve, reject) => {
      resolveStatus = resolve;
      rejectStatus = reject;
    });
    const finish = () => {
      if (completed || !stdoutSettled || !stderrSettled) return;
      if (!rawSettled && !terminationUnconfirmed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      clearTimeout(confirmTimer);
      if (!rawSettled || terminationUnconfirmed) {
        rejectStatus(commandTerminationError(timedOut, false, forcedKill));
      } else if (forcedKill) {
        rejectStatus(commandTerminationError(timedOut, true, true));
      } else {
        resolveStatus({
          code: rawCode!,
          timedOut,
          terminationConfirmed: true,
          forcedKill: false,
        });
      }
    };
    const forceLocalClosure = () => {
      stdout.forceClose();
      stderr.forceClose();
      stdin.abort();
    };
    const sendForcedKill = () => {
      if (completed) return;
      // An attempted SIGKILL is itself a fail-closed boundary: even a reaped
      // direct child cannot prove that it left no producer descendants.
      forcedKill = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may have exited while a descendant holds a pipe.
      }
      confirmTimer = setTimeout(() => {
        if (!rawSettled) terminationUnconfirmed = true;
        forceLocalClosure();
        finish();
      }, terminationConfirmMs);
    };
    const kill = () => {
      stdin.abort();
      if (completed || stopping) return;
      stopping = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The parent may already have exited while a descendant holds a pipe.
      }
      graceTimer = setTimeout(sendForcedKill, terminationGraceMs);
    };
    stopForOutput = kill;
    const timeoutTimer = setTimeout(() => {
      if (completed) return;
      timedOut = true;
      kill();
    }, options.timeoutMs);
    child.status.then(({ code }) => {
      rawSettled = true;
      rawCode = code;
      stdin.abort();
      finish();
    }, () => {
      kill();
      terminationUnconfirmed = true;
      forceLocalClosure();
      finish();
    });
    stdout.done.then(() => {
      stdoutSettled = true;
      finish();
    });
    stderr.done.then(() => {
      stderrSettled = true;
      finish();
    });
    return {
      stdin: stdin.stream,
      stdout: stdout.stream,
      stderr: stderr.stream,
      status,
      kill,
    };
  }

  async run(
    argv: readonly string[],
    options: BufferedCommandOptions,
  ): Promise<CommandResult> {
    requirePositive(options.maxOutputBytes);
    const child = this.spawn(argv, options);
    if (!child.stdout || !child.stderr) {
      throw new Error("Command output streams unavailable");
    }
    let total = 0;
    let exceeded = false;
    const drain = async (
      stream: ReadableStream<Uint8Array>,
    ): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of stream) {
        if (exceeded) continue;
        if (chunk.byteLength > options.maxOutputBytes - total) {
          exceeded = true;
          child.kill();
          continue;
        }
        total += chunk.byteLength;
        length += chunk.byteLength;
        chunks.push(chunk);
      }
      return joinChunks(chunks, length);
    };
    let stdout: Uint8Array;
    let stderr: Uint8Array;
    let status;
    const stdoutTask = drain(child.stdout);
    const stderrTask = drain(child.stderr);
    const statusTask = child.status;
    const input = startManagedStdin(child.stdin);
    const inputTask = input.operation;
    const tasks = [stdoutTask, stderrTask, statusTask, inputTask] as const;
    try {
      [stdout, stderr, status] = await Promise.all(tasks);
    } catch (error) {
      input.abort();
      try {
        child.kill();
      } catch { /* A raced exit must not hide the settled status. */ }
      const outcomes = await Promise.allSettled(tasks);
      for (const outcome of outcomes) {
        if (
          outcome.status === "rejected" &&
          isCommandTerminationError(outcome.reason)
        ) throw outcome.reason;
      }
      const terminal = outcomes[2];
      if (terminal.status === "rejected") throw terminal.reason;
      if (
        !terminal.value.terminationConfirmed || terminal.value.code === null
      ) {
        throw commandTerminationError(
          terminal.value.timedOut,
          false,
          terminal.value.forcedKill,
        );
      }
      if (terminal.value.forcedKill) {
        throw commandTerminationError(terminal.value.timedOut, true, true);
      }
      throw error;
    }
    if (!status.terminationConfirmed || status.code === null) {
      throw commandTerminationError(
        status.timedOut,
        false,
        status.forcedKill,
      );
    }
    if (status.forcedKill) {
      throw commandTerminationError(status.timedOut, true, true);
    }
    if (exceeded) throw outputLimitError(status.code, status.timedOut);
    return {
      code: status.code,
      stdout,
      stderr,
      timedOut: status.timedOut,
      terminationConfirmed: true,
      forcedKill: false,
    };
  }
}
