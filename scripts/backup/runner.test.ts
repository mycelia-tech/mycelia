import {
  collectBoundedStream,
  DenoRunner,
  hashAndCountStream,
  type RunnerChildProcess,
  startManagedStdin,
} from "./runner.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const decoder = new TextDecoder();
const runner = new DenoRunner();

async function withFixture(
  source: string,
  test: (path: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/fixture.ts`;
  try {
    await Deno.writeTextFile(path, source);
    await test(path, directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function fixtureArgv(path: string, ...args: string[]): string[] {
  return [Deno.execPath(), "run", "--allow-all", path, ...args];
}

async function settlesWithin<T>(
  operation: Promise<T>,
  maxMs: number,
): Promise<T> {
  const expired = Symbol("test deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: T | typeof expired;
  try {
    result = await Promise.race([
      operation,
      new Promise<typeof expired>((resolve) => {
        timer = setTimeout(() => resolve(expired), maxMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (result === expired) {
    await operation.catch(() => {}); // The fixture self-exits, so RED leaves no child.
    throw new Error("command did not settle within the test deadline");
  }
  return result;
}

Deno.test("run preserves argv and forwards explicit cwd and environment", async () => {
  await withFixture(
    'await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({args:Deno.args,cwd:Deno.cwd(),env:Deno.env.get("BACKUP_FIXTURE_VALUE")})));',
    async (path, directory) => {
      const result = await runner.run(
        fixtureArgv(
          path,
          "space value",
          "semi;colon",
          "$(do-not-run)",
          "quote'arg",
        ),
        {
          timeoutMs: 15_000,
          maxOutputBytes: 4_096,
          cwd: directory,
          env: { BACKUP_FIXTURE_VALUE: "fixture value" },
        },
      );
      assert(result.code === 0 && !result.timedOut, "fixture did not complete");
      const output = JSON.parse(decoder.decode(result.stdout));
      assert(
        JSON.stringify(output.args) ===
          JSON.stringify([
            "space value",
            "semi;colon",
            "$(do-not-run)",
            "quote'arg",
          ]),
        "argv was changed or interpreted",
      );
      assert(
        output.cwd === await Deno.realPath(directory),
        "cwd was not forwarded",
      );
      assert(output.env === "fixture value", "environment was not forwarded");
      assert(result.code === 0 && !result.timedOut, "unexpected child status");
      assert(
        result.terminationConfirmed === true && result.forcedKill === false,
        "natural exit did not carry confirmed termination metadata",
      );
    },
  );
});

Deno.test("run can clear every inherited variable while preserving only explicit environment", async () => {
  const names = [
    "MYCELIA_RUNNER_PARENT_ONLY",
    "DYLD_LIBRARY_PATH",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ] as const;
  const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
  for (const name of names) Deno.env.set(name, "must-not-reach-child");
  try {
    await withFixture(
      `await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({parent:Deno.env.get("MYCELIA_RUNNER_PARENT_ONLY"),explicit:Deno.env.get("MYCELIA_RUNNER_EXPLICIT"),names:Object.keys(Deno.env.toObject()).filter((name)=>["DYLD_LIBRARY_PATH","SSH_AUTH_SOCK","HTTP_PROXY","HTTPS_PROXY"].includes(name))})));`,
      async (path) => {
        const result = await runner.run(fixtureArgv(path), {
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
          clearEnv: true,
          env: { MYCELIA_RUNNER_EXPLICIT: "safe" },
        });
        assert(result.code === 0 && !result.timedOut, "fixture failed");
        const output = JSON.parse(decoder.decode(result.stdout));
        assert(output.parent === undefined, "parent environment leaked");
        assert(output.explicit === "safe", "explicit environment was lost");
        assert(
          JSON.stringify(output.names) === "[]",
          "dangerous inherited environment reached the child",
        );
      },
    );
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("run keeps documented ambient inheritance when clearEnv is omitted or false", async () => {
  const name = "MYCELIA_RUNNER_AMBIENT_COMPATIBILITY";
  const previous = Deno.env.get(name);
  Deno.env.set(name, "inherited");
  try {
    await withFixture(
      `console.log(Deno.env.get(${JSON.stringify(name)}) ?? "missing");`,
      async (path) => {
        for (
          const options of [
            {
              timeoutMs: 5_000,
              maxOutputBytes: 100,
            },
            {
              timeoutMs: 5_000,
              maxOutputBytes: 100,
              clearEnv: false,
            },
          ]
        ) {
          const result = await runner.run(fixtureArgv(path), options);
          assert(result.code === 0 && !result.timedOut, "fixture failed");
          assert(
            decoder.decode(result.stdout) === "inherited\n",
            "generic runner compatibility unexpectedly cleared ambient env",
          );
        }
      },
    );
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("run captures stdout and stderr separately and returns non-zero exit", async () => {
  await withFixture(
    'await Deno.stdout.write(new TextEncoder().encode("out")); await Deno.stderr.write(new TextEncoder().encode("err")); Deno.exit(7);',
    async (path) => {
      const result = await runner.run(fixtureArgv(path), {
        timeoutMs: 5_000,
        maxOutputBytes: 100,
      });
      assert(decoder.decode(result.stdout) === "out", "stdout mismatch");
      assert(decoder.decode(result.stderr) === "err", "stderr mismatch");
      assert(result.code === 7 && !result.timedOut, "exit status mismatch");
    },
  );
});

Deno.test("run times out a child and closes both pipes", async () => {
  await withFixture(
    'await Deno.stdout.write(new TextEncoder().encode("started")); setInterval(() => {}, 1000);',
    async (path) => {
      const result = await runner.run(fixtureArgv(path), {
        timeoutMs: 1_000,
        maxOutputBytes: 100,
      });
      assert(result.timedOut, "timeout was not reported");
      assert(
        decoder.decode(result.stdout) === "started",
        "stdout was not drained",
      );
    },
  );
});

Deno.test("run kills and drains on aggregate output limit without exposing output", async () => {
  await withFixture(
    'await Deno.stdout.write(new TextEncoder().encode("123456")); await Deno.stderr.write(new TextEncoder().encode("abcdef")); setInterval(() => {}, 1000);',
    async (path) => {
      let caught: unknown;
      try {
        await runner.run(fixtureArgv(path), {
          timeoutMs: 5_000,
          maxOutputBytes: 10,
        });
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof Error, "expected output-limit error");
      const error = caught as Error & {
        code: string;
        exitCode?: number;
        timedOut: boolean;
      };
      assert(error.code === "OUTPUT_LIMIT_EXCEEDED", "wrong stable code");
      assert(error.timedOut === false, "overflow should not be a timeout");
      assert(typeof error.exitCode === "number", "missing exit metadata");
      assert(
        JSON.stringify(Object.keys(error).sort()) ===
          JSON.stringify([
            "code",
            "exitCode",
            "forcedKill",
            "terminationConfirmed",
            "timedOut",
          ]),
        "error has unexpected enumerable fields",
      );
      assert(
        !JSON.stringify(error).includes("abcdef"),
        "captured bytes leaked",
      );
      assert(!error.message.includes(path), "fixture path leaked");
    },
  );
});

Deno.test("run rejects a forced kill even after the direct child is reaped", async () => {
  await withFixture(
    'Deno.addSignalListener("SIGTERM", () => {}); await Deno.stdout.write(new TextEncoder().encode("ready")); setTimeout(() => Deno.exit(99), 4500); setInterval(() => {}, 1000);',
    async (path) => {
      let caught: unknown;
      try {
        await settlesWithin(
          runner.run(
            fixtureArgv(path),
            {
              timeoutMs: 300,
              terminationGraceMs: 100,
              terminationConfirmMs: 500,
              maxOutputBytes: 100,
            } as Parameters<DenoRunner["run"]>[1],
          ),
          1_500,
        );
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof Error, "forced kill unexpectedly returned");
      const error = caught as Error & Record<string, unknown>;
      assert(
        error.code === "COMMAND_TERMINATION_UNCONFIRMED" &&
          error.timedOut === true && error.terminationConfirmed === true &&
          error.forcedKill === true,
        "forced kill did not return the closed termination error",
      );
      assert(
        JSON.stringify(Object.keys(error).sort()) ===
          JSON.stringify([
            "code",
            "forcedKill",
            "terminationConfirmed",
            "timedOut",
          ]),
        "termination error exposed unexpected metadata",
      );
    },
  );
});

Deno.test("run output overflow reports forced termination before its original limit error", async () => {
  await withFixture(
    'Deno.addSignalListener("SIGTERM", () => {}); await Deno.stdout.write(new TextEncoder().encode("123456789012")); setTimeout(() => Deno.exit(99), 4500); setInterval(() => {}, 1000);',
    async (path) => {
      let caught: unknown;
      try {
        await settlesWithin(
          runner.run(fixtureArgv(path), {
            timeoutMs: 10_000,
            maxOutputBytes: 10,
          }),
          1_600,
        );
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof Error, "expected output-limit error");
      assert(
        (caught as Error & { code?: string }).code ===
          "COMMAND_TERMINATION_UNCONFIRMED",
        "forced termination was hidden behind the output-limit error",
      );
    },
  );
});

Deno.test("run manages stdin close failure through kill and settled status", async () => {
  for (const forced of [false, true] as const) {
    let killed = false;
    let statusObserved = false;
    let resolveStatus!: (value: { code: number }) => void;
    const rawStatus = new Promise<{ code: number }>((resolve) => {
      resolveStatus = resolve;
    }).then((value) => {
      statusObserved = true;
      return value;
    });
    const empty = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    const closeFailure = new Error("synthetic stdin close failure");
    const closeFailingRunner = new DenoRunner(() => ({
      stdin: new WritableStream<Uint8Array>({
        close() {
          throw closeFailure;
        },
      }),
      stdout: empty(),
      stderr: empty(),
      status: rawStatus,
      kill(signal) {
        killed = true;
        if (!forced || signal === "SIGKILL") {
          resolveStatus({ code: signal === "SIGKILL" ? 137 : 143 });
        }
      },
    }));

    let caught: unknown;
    try {
      await settlesWithin(
        closeFailingRunner.run(["/not-executed"], {
          timeoutMs: 1_000,
          maxOutputBytes: 100,
          terminationGraceMs: 10,
          terminationConfirmMs: 100,
        }),
        500,
      );
    } catch (error) {
      caught = error;
    }

    assert(
      caught instanceof Error,
      "stdin close failure unexpectedly returned",
    );
    assert(killed, "stdin close failure did not terminate the child");
    assert(statusObserved, "stdin close failure returned before child status");
    if (forced) {
      assert(
        (caught as Error & { code?: string }).code ===
          "COMMAND_TERMINATION_UNCONFIRMED",
        "forced termination was hidden by stdin close failure",
      );
    } else {
      assert(
        Object.is(caught, closeFailure),
        "natural termination did not preserve stdin close failure",
      );
    }
  }
});

Deno.test("managed stdin abort settles locally when raw write and abort never do", async () => {
  const never = new Promise<void>(() => {});
  const input = startManagedStdin(
    new WritableStream<Uint8Array>({
      write() {
        return never;
      },
      abort() {
        return never;
      },
    }),
    new Uint8Array([1]),
  );
  input.abort();
  const outcomes = await settlesWithin(
    Promise.allSettled([input.operation, input.settled]),
    100,
  );
  assert(outcomes[0].status === "rejected", "aborted write returned success");
  assert(outcomes[1].status === "fulfilled", "settlement observer rejected");
});

Deno.test("synthetic 64 MiB stream hashes with bounded producer pull-ahead", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x5a);
  let pulled = 0;
  let consumed = 0;
  let maxAhead = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 1024) {
        controller.close();
        return;
      }
      pulled++;
      maxAhead = Math.max(maxAhead, pulled - consumed);
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 1 });
  const delayed = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(
      {
        async transform(value, controller) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          consumed++;
          controller.enqueue(value);
        },
      },
      { highWaterMark: 1 },
      { highWaterMark: 1 },
    ),
  );
  const digest = await hashAndCountStream(delayed);
  assert(digest.byteCount === 64 * 1024 * 1024, "byte count mismatch");
  assert(
    digest.sha256Hex ===
      "103f23a15401a701b73587902f16e3b5b3bf38a039d5c94b675a9a8e84dbd5b5",
    "digest mismatch",
  );
  const queueCapacity = 2; // Source and transform each admit one queued chunk.
  assert(
    maxAhead <= queueCapacity + 1,
    `producer pulled ${maxAhead} chunks ahead`,
  );
});

Deno.test("hashAndCountStream cancels before a safe-integer byte-count overflow", async () => {
  const huge = new Uint8Array(0);
  Object.defineProperty(huge, "byteLength", {
    value: Number.MAX_SAFE_INTEGER,
  });
  let cancelled = false;
  let step = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(step++ === 0 ? huge : new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  let caught: unknown;
  try {
    await hashAndCountStream(source);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, "unsafe byte count was returned");
  assert(cancelled, "overflow did not cancel the producer stream");
  assert(
    !Object.hasOwn(caught, "byteCount"),
    "imprecise byte count escaped on the error",
  );
});

Deno.test("spawn streams 64 MiB stdout while stderr is consumed concurrently", async () => {
  await withFixture(
    'const chunk=new Uint8Array(65536).fill(0x5a); await Deno.stderr.write(new TextEncoder().encode("small stderr")); for(let i=0;i<1024;i++) await Deno.stdout.write(chunk);',
    async (path) => {
      const child = runner.spawn(fixtureArgv(path), { timeoutMs: 10_000 });
      assert(child.stdout && child.stderr, "missing output streams");
      const [digest, stderr] = await Promise.all([
        hashAndCountStream(child.stdout),
        collectBoundedStream(child.stderr, 100),
      ]);
      const status = await child.status;
      assert(digest.byteCount === 64 * 1024 * 1024, "byte count mismatch");
      assert(
        digest.sha256Hex ===
          "103f23a15401a701b73587902f16e3b5b3bf38a039d5c94b675a9a8e84dbd5b5",
        "digest mismatch",
      );
      assert(decoder.decode(stderr) === "small stderr", "stderr mismatch");
      assert(status.code === 0 && !status.timedOut, "unexpected child status");
    },
  );
});

Deno.test("spawn timeout closes both empty output consumers", async () => {
  await withFixture(
    "setTimeout(() => Deno.exit(0), 3000); setInterval(() => {}, 1000);",
    async (path) => {
      const child = runner.spawn(fixtureArgv(path), { timeoutMs: 250 });
      assert(child.stdout && child.stderr, "missing output streams");
      const [stdout, stderr, status] = await settlesWithin(
        Promise.all([
          hashAndCountStream(child.stdout),
          hashAndCountStream(child.stderr),
          child.status,
        ]),
        1_500,
      );
      assert(status.timedOut, "timeout not reported");
      assert(
        stdout.byteCount === 0 && stderr.byteCount === 0,
        "empty output streams did not close",
      );
    },
  );
});

Deno.test("spawn timeout closes pipes retained by a descendant", async () => {
  await withFixture(
    'new Deno.Command(Deno.execPath(), {args:["eval","setTimeout(() => Deno.exit(0), 4500)"], clearEnv:true, env:{}, stdin:"null", stdout:"inherit", stderr:"inherit"}).spawn(); await Deno.stdout.write(new TextEncoder().encode("ready")); setInterval(() => {}, 1000);',
    async (path) => {
      const child = runner.spawn(fixtureArgv(path), {
        timeoutMs: 1_500,
        terminationConfirmMs: 300,
      });
      assert(child.stdout && child.stderr, "missing output streams");
      const outcomes = await settlesWithin(
        Promise.allSettled([
          hashAndCountStream(child.stdout),
          hashAndCountStream(child.stderr),
          child.status,
        ]),
        2_600,
      );
      const [stdout, stderr, status] = outcomes;
      assert(stdout.status === "fulfilled", "stdout did not settle");
      assert(stderr.status === "fulfilled", "stderr did not settle");
      assert(status.status === "rejected", "forced kill unexpectedly returned");
      const error = status.reason as Error & Record<string, unknown>;
      assert(
        error.timedOut === true && error.terminationConfirmed === true &&
          error.forcedKill === true,
        "descendant-held pipes did not produce the forced termination error",
      );
      assert(stdout.value.byteCount === 5, "parent output was not drained");
      assert(stderr.value.byteCount === 0, "unexpected stderr output");
    },
  );
});

Deno.test("spawn never synthesizes an exit status before raw child reap", async () => {
  const source = await Deno.readTextFile(
    new URL("./runner.ts", import.meta.url),
  );
  assert(
    !source.includes("resolveFallback"),
    "synthetic status resolver remains",
  );
  assert(
    !source.includes("Promise.race([rawStatus, fallback])"),
    "raw child status still races a synthetic fallback",
  );
});

Deno.test("spawn honors a longer termination grace before forced kill", async () => {
  await withFixture(
    'Deno.addSignalListener("SIGTERM",()=>setTimeout(()=>Deno.exit(0),400)); await Deno.stdout.write(new TextEncoder().encode("ready")); setInterval(()=>{},1000);',
    async (path) => {
      const child = runner.spawn(
        fixtureArgv(path),
        {
          timeoutMs: 5_000,
          terminationGraceMs: 800,
        } as Parameters<DenoRunner["spawn"]>[1],
      );
      assert(child.stdout && child.stderr, "missing output streams");
      let ready!: () => void;
      const isReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const stdoutPromise = (async () => {
        let byteCount = 0;
        for await (const chunk of child.stdout!) {
          byteCount += chunk.byteLength;
          if (byteCount >= 5) ready();
        }
        return byteCount;
      })();
      await settlesWithin(isReady, 1_500);
      child.kill();
      const [stdout, stderr, status] = await settlesWithin(
        Promise.all([
          stdoutPromise,
          hashAndCountStream(child.stderr),
          child.status,
        ]),
        1_500,
      );
      assert(!status.timedOut, "manual termination was reported as timeout");
      assert(
        status.code === 0,
        "configured grace did not permit graceful exit",
      );
      assert(
        stdout === 5 && stderr.byteCount === 0,
        "graceful child output was not drained",
      );
    },
  );
});

Deno.test("spawn bounds post-KILL waiting when raw child status never settles", async () => {
  const signals: string[] = [];
  const never = new Promise<{ code: number }>(() => {});
  const empty = () => new ReadableStream<Uint8Array>();
  const fake: RunnerChildProcess = {
    stdin: new WritableStream<Uint8Array>(),
    stdout: empty(),
    stderr: empty(),
    status: never,
    kill(signal) {
      signals.push(signal);
    },
  };
  const injected = new DenoRunner(() => fake);
  const child = injected.spawn(["/not-executed"], {
    timeoutMs: 10,
    terminationGraceMs: 10,
    terminationConfirmMs: 20,
  });
  assert(child.stdout && child.stderr, "missing managed pipes");
  const outcomes = await settlesWithin(
    Promise.allSettled([
      hashAndCountStream(child.stdout),
      hashAndCountStream(child.stderr),
      child.status,
    ]),
    500,
  );
  assert(
    outcomes[0].status === "fulfilled" &&
      outcomes[1].status === "fulfilled",
    "local pipes were not settled before the termination result",
  );
  assert(outcomes[2].status === "rejected", "unreaped child returned status");
  const error = outcomes[2].reason as Error & Record<string, unknown>;
  assert(
    error.terminationConfirmed === false && error.forcedKill === true &&
      error.timedOut === true,
    "unreaped status did not use the unconfirmed union member",
  );
  assert(
    JSON.stringify(signals) === JSON.stringify(["SIGTERM", "SIGKILL"]),
    "bounded termination signal order changed",
  );
});

Deno.test("managed stream cancellation terminates and reaps the caller child", async () => {
  const huge = new Uint8Array(0);
  Object.defineProperty(huge, "byteLength", {
    value: Number.MAX_SAFE_INTEGER,
  });
  let outputStep = 0;
  let resolveStatus!: (status: { code: number }) => void;
  const rawStatus = new Promise<{ code: number }>((resolve) => {
    resolveStatus = resolve;
  });
  const signals: string[] = [];
  const fake: RunnerChildProcess = {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          outputStep++ === 0 ? huge : new Uint8Array([1]),
        );
      },
    }, { highWaterMark: 0 }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    status: rawStatus,
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGTERM") resolveStatus({ code: 143 });
    },
  };
  const injected = new DenoRunner(() => fake);
  const child = injected.spawn(["/not-executed"], { timeoutMs: 5_000 });
  assert(child.stdout && child.stderr, "missing managed pipes");
  const [digest, stderr, status] = await Promise.allSettled([
    hashAndCountStream(child.stdout),
    hashAndCountStream(child.stderr),
    child.status,
  ]);
  assert(digest.status === "rejected", "overflow did not reject hashing");
  assert(stderr.status === "fulfilled", "peer pipe was not drained");
  assert(status.status === "fulfilled", "graceful child reap was lost");
  assert(
    status.value.terminationConfirmed === true &&
      status.value.forcedKill === false,
    "stream cancellation did not await confirmed termination",
  );
  assert(JSON.stringify(signals) === '["SIGTERM"]', "child was not stopped");
});
