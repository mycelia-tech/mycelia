import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { testProcessEnvironment } from "../../../scripts/test-environment.ts";
import { createBodyParsers } from "./body-parsers.ts";

Deno.test("body parser error handler preserves unrelated application errors", () => {
  const handler = createBodyParsers()[2];
  for (
    const error of [
      new Error("unrelated application failure"),
      { status: 401, message: "Unauthorized" },
      { type: "entity.parse.failed", status: 500 },
      { code: "Z_DATA_ERROR", status: 500 },
    ]
  ) {
    let forwarded: unknown;
    handler(error, {} as Request, {
      headersSent: false,
      status() {
        throw new Error("unexpected response for unrelated error");
      },
    } as unknown as Response, (nextError: unknown) => {
      forwarded = nextError;
    });
    assert.equal(forwarded, error);
  }
});

Deno.test("body parser error handler forwards errors after headers are sent", () => {
  const handler = createBodyParsers()[2];
  const error = { type: "entity.parse.failed", status: 400 };
  let forwarded: unknown;
  handler(error, {} as Request, {
    headersSent: true,
    status() {
      throw new Error("must not send a second response");
    },
  } as unknown as Response, (nextError: unknown) => {
    forwarded = nextError;
  });
  assert.equal(forwarded, error);
});

// Disposable processes exercise ordinary HTTP middleware without application
// startup or databases; stderr must remain empty for rejected request bodies.
for (
  const scenario of [
    "compatible",
    "malformed-json",
    "body-size",
    "form-parameters",
    "unsupported-encoding",
    "unsupported-charset",
  ]
) {
  Deno.test(`body parsers: ${scenario} before authentication`, async () => {
    const backendRoot = fileURLToPath(new URL("../..", import.meta.url));
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=manual",
        "--allow-read",
        "--deny-read=.env,../.env",
        "--allow-env",
        "--allow-net=127.0.0.1",
        fileURLToPath(new URL("body-parsers.fixture.ts", import.meta.url)),
        scenario,
      ],
      cwd: backendRoot,
      ...testProcessEnvironment(Deno.env.toObject(), {
        root: fileURLToPath(new URL("../../..", import.meta.url)),
        temporaryDirectory: "/tmp",
      }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // It may have exited just before the deadline.
      }
    }, 15_000);
    try {
      const result = await child.output();
      assert.equal(timedOut, false, "parser child exceeded 15 seconds");
      assert.equal(
        result.code,
        0,
        new TextDecoder().decode(result.stderr) ||
          `parser child exited ${result.code}`,
      );
      assert.equal(new TextDecoder().decode(result.stdout).trim(), "PASS");
      assert.equal(new TextDecoder().decode(result.stderr), "");
    } finally {
      clearTimeout(deadline);
    }
  });
}
