import { checkRepository, runResticJsonBackup } from "./restic-io.ts";
import { buildResticEnvironment } from "./restic.ts";
import type { Runner } from "./types.ts";
import { commandTerminationError } from "./runner.ts";

const env = buildResticEnvironment({
  homeDir: "/fixture",
  composeRoot: "/fixture/repo",
  repository: "rclone:pk-backup:mycelia/restic-v1",
  rcloneConfigPath: "/fixture/rclone.conf",
  passwordCommandPath: "/fixture/password",
  inheritedEnvironment: {},
});
const summary = {
  message_type: "summary",
  snapshot_id: "a".repeat(64),
  total_files_processed: 2,
  total_bytes_processed: 10,
  backup_start: "2026-10-02T12:00:00+04:00",
  backup_end: "2026-10-02T08:00:01Z",
};
const argv = ["restic", "--json", "--quiet", "backup"];

Deno.test("check accepts real restic null packs and rejects errors or repair suggestions", async () => {
  for (const broken_packs of [undefined, null, []]) {
    await checkRepository(
      fixture(
        JSON.stringify({
          message_type: "summary",
          num_errors: 0,
          broken_packs,
          suggest_repair_index: false,
        }),
      ),
      env,
      1,
    );
  }
  for (
    const patch of [{ num_errors: 1 }, { broken_packs: ["bad"] }, {
      suggest_future_repair: true,
    }, { suggest_future_repair: "false" }]
  ) {
    let refused = false;
    try {
      await checkRepository(
        fixture(
          JSON.stringify({ message_type: "summary", num_errors: 0, ...patch }),
        ),
        env,
        1,
      );
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("repair/corruption recommendation ignored");
  }
});
function fixture(text: string, code = 0, force = false): Runner {
  return {
    run() {
      throw new Error("unexpected buffered command");
    },
    spawn(_argv, options) {
      if (options.env !== env || options.clearEnv !== true) {
        throw new Error("environment changed");
      }
      let resolve!: (
        value: {
          code: number;
          timedOut: false;
          terminationConfirmed: true;
          forcedKill: false;
        },
      ) => void;
      let reject!: (e: unknown) => void;
      const status = force
        ? new Promise<
          {
            code: number;
            timedOut: false;
            terminationConfirmed: true;
            forcedKill: false;
          }
        >((a, b) => {
          resolve = a;
          reject = b;
        })
        : Promise.resolve({
          code,
          timedOut: false as const,
          terminationConfirmed: true as const,
          forcedKill: false as const,
        });
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      return {
        stdin: new WritableStream(),
        stdout: new ReadableStream({
          pull(c) {
            if (offset >= bytes.length) c.close();
            else c.enqueue(bytes.subarray(offset, offset += 3));
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("secret-uri:/private"));
            c.close();
          },
        }),
        status,
        kill() {
          if (force) reject(commandTerminationError(false, true, true));
          else {resolve?.({
              code,
              timedOut: false,
              terminationConfirmed: true,
              forcedKill: false,
            });}
        },
      };
    },
  };
}

Deno.test("JSONL accepts split UTF-8 and exact summary, nonzero candidates never become success", async () => {
  for (const code of [0, 1, 2, 3, 10, 11, 12, 130, 42]) {
    const result = await runResticJsonBackup(
      fixture(
        JSON.stringify({ message_type: "status", current_files: ["секрет"] }) +
          "\n" + JSON.stringify(summary),
        code,
      ),
      argv,
      { env, timeoutMs: 1000 },
    );
    if (
      result.exitCode !== code ||
      Boolean(result.summary) !== [0, 3].includes(code) ||
      JSON.stringify(result).includes("секрет")
    ) throw new Error("summary classification/redaction failed");
  }
});
Deno.test("JSONL rejects malformed duplicate missing summaries and prioritizes forced termination", async () => {
  for (
    const text of [
      "",
      "\n",
      "oops",
      JSON.stringify({ ...summary, snapshot_id: "a" }),
      JSON.stringify({ ...summary, dry_run: true }),
      JSON.stringify({ ...summary, total_bytes_processed: -1 }),
      JSON.stringify(summary) + "\n" + JSON.stringify(summary),
      JSON.stringify(summary) + "\n{}\n",
      "x".repeat(65537),
    ]
  ) {
    for (const force of (text === "" ? [false] : [false, true])) {
      let error: unknown;
      try {
        await runResticJsonBackup(fixture(text, 0, force), argv, {
          env,
          timeoutMs: 1000,
        });
      } catch (e) {
        error = e;
      }
      if (!(error instanceof Error)) throw new Error("invalid output accepted");
      if (
        force && text !== "" &&
        (error as { code?: string }).code !== "COMMAND_TERMINATION_UNCONFIRMED"
      ) throw new Error("termination priority lost");
      if (JSON.stringify(error).includes("secret-uri")) {
        throw new Error("diagnostic leaked");
      }
    }
  }
});
