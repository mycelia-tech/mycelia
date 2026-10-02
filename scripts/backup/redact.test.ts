import { redactError, renderFailure } from "./redact.ts";
import { readState, writeStateAtomic } from "./state.ts";
import type { BackupStatus } from "./types.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const context = {
  stage: "files" as const,
  backupId: "20260930T120000Z",
  timestampUtc: "2026-09-30T12:00:00.000Z",
  tool: "restic" as const,
  sourceLabel: "media" as const,
};

Deno.test("closed failure survives real persistence and both CLI renderers without raw diagnostics", async () => {
  const raw = [
    "password=hunter-demo",
    "mongodb://user:p%40ss%2Fword@host/db",
    "AKIAEXAMPLEFAKEKEY1234",
    "/Users/private-person/library/file.wav",
    "rclone:private-remote:folder/private",
    "first stderr line\nprivate second line",
    "arbitrary exception cause",
    "argv-secret",
    "env-secret",
  ];
  const error = Object.assign(new Error(raw[0], { cause: new Error(raw[6]) }), {
    code: "COMMAND_FAILED",
    exitCode: 17,
    timedOut: false,
    stdout: raw[1],
    stderr: raw[5],
    path: raw[3],
    uri: raw[4],
    accessKey: raw[2],
    argv: [raw[7]],
    env: { TOKEN: raw[8] },
    unexpected: raw[6],
  });
  const failure = redactError(error, {
    ...context,
    counters: { files: 3, bytes: 12, unexpected: raw[0] },
    unexpected: raw[1],
  });
  const expected = {
    schema: 1,
    code: "COMMAND_FAILED",
    ...context,
    exitCode: 17,
    timedOut: false,
    counters: { files: 3, bytes: 12 },
  };
  assert(
    JSON.stringify(Object.keys(failure).sort()) ===
      JSON.stringify(Object.keys(expected).sort()),
  );
  for (const [key, value] of Object.entries(expected)) {
    assert(
      JSON.stringify(failure[key as keyof typeof failure]) ===
        JSON.stringify(value),
    );
  }
  const root = await Deno.makeTempDir();
  try {
    const state: BackupStatus = {
      schema: 1,
      stage: "files",
      state: "running",
      backupId: context.backupId,
      startedAtUtc: context.timestampUtc,
    };
    await writeStateAtomic(`${root}/state.json`, state);
    await writeStateAtomic(`${root}/state.json`, {
      ...state,
      state: "failed",
      failure,
    });
    assert(
      (await readState(`${root}/state.json`))?.failure?.code ===
        "COMMAND_FAILED",
    );
    const outputs = [
      await Deno.readTextFile(`${root}/state.json`),
      renderFailure(failure, "json"),
      renderFailure(failure, "human"),
    ];
    for (const output of outputs) {
      for (
        const input of [
          ...raw,
          "unexpected",
          "stdout",
          "stderr",
          "stack",
          "cause",
          "argv",
          '"env"',
        ]
      ) assert(!output.includes(input), "raw diagnostics leaked");
      assert(output.includes("COMMAND_FAILED"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("redaction rejects unbounded context and maps arbitrary failures to registered codes", () => {
  assert(
    redactError({ code: "secret-code", message: "secret" }, context).code ===
      "COMMAND_FAILED",
  );
  assert(redactError({ timedOut: true }, context).code === "COMMAND_TIMEOUT");
  for (
    const patch of [
      { tool: "/bin/secret" },
      { backupId: "secret-id" },
      { stage: "secret-stage" },
      { timestampUtc: "secret-time" },
      { sourceLabel: "secret-source" },
      { counters: { files: -1 } },
    ]
  ) {
    let rejected = false;
    try {
      redactError(new Error("secret"), { ...context, ...patch });
    } catch {
      rejected = true;
    }
    assert(rejected, "unbounded context accepted");
  }
  let invoked = false;
  const error = {
    get code() {
      invoked = true;
      throw new Error("secret getter");
    },
  };
  assert(redactError(error, context).code === "COMMAND_FAILED");
  assert(!invoked, "untrusted getter executed");
});
