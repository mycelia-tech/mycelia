import { checkRemote, OWNER_MARKER } from "./remote.ts";
import type { BufferedCommandOptions, CommandResult, Runner } from "./types.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const enc = new TextEncoder();
const result = (stdout: string, code = 0, stderr = ""): CommandResult => ({
  stdout: enc.encode(stdout),
  stderr: enc.encode(stderr),
  code,
  timedOut: false,
  terminationConfirmed: true,
  forcedKill: false,
});
const identity = "e3e70b0a-ee4d-40ce-b0bd-e74a951efb35";
const marker = {
  schema: 1,
  installationId: identity,
  createdAtUtc: "2026-09-30T12:00:00.000Z",
  children: ["restic-v1/", "bootstrap-manifests/", "logs/"],
};
function fake(responses: CommandResult[]) {
  const calls: string[][] = [];
  const runner: Runner = {
    run(argv: readonly string[], options: BufferedCommandOptions) {
      calls.push([...argv]);
      assert(
        argv[0] === "rclone" && ["lsf", "about", "cat"].includes(argv[1]),
        "mutating command",
      );
      assert(
        options.timeoutMs > 0 && options.maxOutputBytes > 0,
        "unbounded command",
      );
      const next = responses.shift();
      assert(next, "unexpected command");
      return Promise.resolve(next);
    },
    spawn() {
      throw new Error("unexpected spawn");
    },
  };
  return { runner, calls };
}
const options = {
  rcloneRemote: "pk-backup:",
  remoteRoot: "pk-backup:mycelia",
  remoteMinFreeBytes: 100,
  fileBytes: 100,
  databaseBytes: 100,
};

Deno.test("remote rejects inherited rclone filtering listing format and config overrides before contacting remote", async () => {
  for (
    const [name, value] of [
      ["RCLONE_EXCLUDE", "/mycelia/**"],
      ["RCLONE_INCLUDE", "/unrelated/**"],
      ["RCLONE_FILTER", "- /mycelia/**"],
      ["RCLONE_FILES_FROM", "/private-secret/file-list"],
      ["RCLONE_MAX_DEPTH", "0"],
      ["RCLONE_LSF_FORMAT", "s"],
      ["RCLONE_CONFIG", "/private-secret/alternate.conf"],
      ["RCLONE_CONFIG_PK_BACKUP_TYPE", "local"],
      ["RCLONE_FUTURE_OVERRIDE", "private-secret"],
    ]
  ) {
    const previous = Deno.env.get(name);
    Deno.env.set(name, value);
    try {
      // An inherited exclude can make an occupied namespace produce exactly
      // this empty listing. The gate must refuse before consulting that output.
      const f = fake([result(""), result('{"free":1000}')]);
      let caught: unknown;
      try {
        await checkRemote(options, f.runner);
      } catch (error) {
        caught = error;
      }
      assert(
        (caught as { code?: string })?.code === "CONFIG_INVALID",
        "rclone environment override accepted",
      );
      assert(
        f.calls.length === 0,
        "remote contacted with an untrusted environment",
      );
      assert(!String(caught).includes(value), "environment value disclosed");
    } finally {
      if (previous === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous);
    }
  }
});

Deno.test("remote capacity uses floor plus rounded 125 percent and never writes absent or empty namespace", async () => {
  for (const listing of ["", "mycelia/\n"]) {
    const f = fake([
      result(listing),
      result('{"free":350}'),
      ...(listing ? [result("")] : []),
    ]);
    const actual = await checkRemote(options, f.runner);
    assert(
      actual.namespace === "reservable" && actual.requiredBytes === 350 &&
        actual.freeBytes === 350,
    );
    assert(f.calls.length === (listing ? 3 : 2));
  }
  const f = fake([result(""), result('{"free":102}')]);
  assert(
    (await checkRemote(
      { ...options, fileBytes: 1, databaseBytes: 0 },
      f.runner,
    )).requiredBytes === 102,
  );
});

Deno.test("remote distinguishes authentication and host-key failures without reflecting stderr", async () => {
  for (
    const [stderr, code] of [
      ["secret Permission denied", "SSH_NONINTERACTIVE_REQUIRED"],
      ["secret REMOTE HOST IDENTIFICATION HAS CHANGED", "HOST_KEY_MISMATCH"],
      ["secret Host key verification failed", "HOST_KEY_MISMATCH"],
    ]
  ) {
    const f = fake([result("", 1, stderr)]);
    let caught: unknown;
    try {
      await checkRemote(options, f.runner);
    } catch (e) {
      caught = e;
    }
    assert((caught as { code?: string })?.code === code);
    assert(!String(caught).includes("secret") && f.calls.length === 1);
  }
});

Deno.test("remote capacity rejects unsupported malformed missing negative fractional and overflowing free bytes", async () => {
  for (
    const response of [
      result("", 1),
      result("invalid"),
      result("{}"),
      result('{"free":-1}'),
      result('{"free":1.5}'),
      result('{"free":9007199254740992}'),
    ]
  ) {
    const f = fake([result(""), response]);
    let caught: unknown;
    try {
      await checkRemote(options, f.runner);
    } catch (e) {
      caught = e;
    }
    assert((caught as { code?: string })?.code === "REMOTE_CAPACITY_UNKNOWN");
    assert(f.calls.length === 2);
  }
  for (
    const values of [{ fileBytes: Number.MAX_SAFE_INTEGER }, {
      databaseBytes: -1,
    }]
  ) {
    const f = fake([]);
    let caught: unknown;
    try {
      await checkRemote({ ...options, ...values }, f.runner);
    } catch (e) {
      caught = e;
    }
    assert((caught as { code?: string })?.code === "REMOTE_CAPACITY_UNKNOWN");
    assert(f.calls.length === 0);
  }
  const f = fake([result(""), result('{"free":349}')]);
  let caught: unknown;
  try {
    await checkRemote(options, f.runner);
  } catch (e) {
    caught = e;
  }
  assert((caught as { code?: string })?.code === "REMOTE_CAPACITY_LOW");
});

Deno.test("remote accepts only exact owned marker and known children", async () => {
  const f = fake([
    result("mycelia/\n"),
    result('{"free":1000}'),
    result(`${OWNER_MARKER}\nrestic-v1/\nlogs/\n`),
    result(JSON.stringify(marker)),
  ]);
  assert(
    (await checkRemote(
      { ...options, expectedInstallationId: identity },
      f.runner,
    )).namespace === "owned",
  );
  assert(
    f.calls[3].join(" ") === `rclone cat pk-backup:mycelia/${OWNER_MARKER}`,
  );
});

Deno.test("remote cannot adopt an existing marker without a matching local installation identity", async () => {
  const f = fake([
    result("mycelia/\n"),
    result('{"free":1000}'),
    result(`${OWNER_MARKER}\n`),
    result(JSON.stringify(marker)),
  ]);
  let caught: unknown;
  try {
    await checkRemote(options, f.runner);
  } catch (error) {
    caught = error;
  }
  assert((caught as { code?: string })?.code === "REMOTE_NAMESPACE_UNKNOWN");
});

Deno.test("remote rejects unknown namespace entries missing ownership and malformed or foreign markers", async () => {
  for (
    const entries of [
      "restic-v1/\n",
      "other\n",
      `${OWNER_MARKER}\n${OWNER_MARKER}\n`,
      `${OWNER_MARKER}\nunknown/\n`,
    ]
  ) {
    const f = fake([
      result("mycelia/\n"),
      result('{"free":1000}'),
      result(entries),
    ]);
    let caught: unknown;
    try {
      await checkRemote(options, f.runner);
    } catch (e) {
      caught = e;
    }
    assert((caught as { code?: string })?.code === "REMOTE_NAMESPACE_UNKNOWN");
  }
  for (
    const value of [
      null,
      {},
      { ...marker, schema: 2 },
      { ...marker, installationId: "secret" },
      { ...marker, createdAtUtc: "yesterday" },
      { ...marker, children: ["restic-v1/"] },
      { ...marker, secret: "value" },
      { ...marker, installationId: "aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa" },
    ]
  ) {
    const f = fake([
      result("mycelia/\n"),
      result('{"free":1000}'),
      result(`${OWNER_MARKER}\n`),
      result(JSON.stringify(value)),
    ]);
    let caught: unknown;
    try {
      await checkRemote(
        { ...options, expectedInstallationId: identity },
        f.runner,
      );
    } catch (e) {
      caught = e;
    }
    assert((caught as { code?: string })?.code === "REMOTE_NAMESPACE_UNKNOWN");
    assert(!String(caught).includes("secret"));
  }
});
