import { fileURLToPath } from "node:url";
import { testProcessEnvironment } from "./test-environment.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups: Record<string, { cwd?: string; command: string[] }[]> = {
  repo: [{
    command: [
      "deno",
      "run",
      "--allow-read",
      "--allow-run=git",
      "scripts/check-repo.ts",
    ],
  }, {
    command: [
      "deno",
      "test",
      "--frozen",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "scripts/doctor.test.ts",
      "scripts/deploy.test.ts",
      "scripts/setup.test.ts",
      "scripts/dependency-inventory.test.ts",
      "scripts/backup-mongo-bastion.test.ts",
      "scripts/test-environment.test.ts",
    ],
  }],
  backend: [
    { cwd: "backend", command: ["deno", "lint"] },
    {
      cwd: "backend",
      command: [
        "deno",
        "run",
        "--frozen",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-run",
        "--allow-sys",
        "--allow-env",
        "--deny-read=.env,../.env",
        "app/tests/run-backend-tests.ts",
      ],
    },
  ],
  frontend: [
    { cwd: "frontend", command: ["deno", "lint"] },
    { cwd: "frontend", command: ["deno", "task", "type-check"] },
    {
      cwd: "frontend",
      command: [
        "deno",
        "run",
        "--frozen",
        "-A",
        "npm:vitest",
        "run",
        "--maxWorkers=2",
        "--minWorkers=1",
      ],
    },
    { cwd: "frontend", command: ["deno", "task", "build"] },
  ],
  sdk: [
    { cwd: "myceliasdk", command: ["deno", "lint"] },
    { cwd: "myceliasdk", command: ["deno", "test", "--frozen"] },
  ],
  e2e: [
    { cwd: "frontend", command: ["deno", "install", "--frozen"] },
    {
      cwd: "frontend",
      command: [
        "node",
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "playwright.config.ts",
      ],
    },
  ],
  infra: [
    {
      command: [
        "deno",
        "test",
        "--frozen",
        "--allow-read",
        "--allow-write",
        "--allow-run=docker,openssl",
        "scripts/nginx.test.ts",
        "scripts/compose.test.ts",
      ],
    },
  ],
  python: [
    {
      cwd: "python",
      command: [
        "uv",
        "run",
        "--frozen",
        "--group",
        "dev",
        "ruff",
        "check",
        ".",
      ],
    },
    {
      cwd: "python",
      command: [
        "uv",
        "run",
        "--frozen",
        "--group",
        "dev",
        "pytest",
        "-q",
        "tests",
      ],
    },
  ],
  rag: [
    {
      cwd: "rag",
      command: [
        "uv",
        "run",
        "--frozen",
        "--group",
        "dev",
        "ruff",
        "check",
        "src",
        "tests",
      ],
    },
    {
      cwd: "rag",
      command: ["uv", "run", "--frozen", "--group", "dev", "pytest"],
    },
  ],
  gpu: [
    {
      command: [
        "uv",
        "run",
        "--no-project",
        "--with-requirements",
        "gpu/whisper_shared/tests/requirements.txt",
        "python",
        "-m",
        "unittest",
        "discover",
        "-s",
        "gpu/whisper_shared/tests",
      ],
    },
    {
      command: [
        "uv",
        "run",
        "--no-project",
        "--with-requirements",
        "gpu/tests/requirements.txt",
        "python",
        "-m",
        "pytest",
        "-q",
        "-p",
        "no:cacheprovider",
        "gpu/proxy/tests/test_live_api.py",
        "gpu/livekit/tests/test_livekit_diagnostics.py",
        "gpu/scripts/tests/test_verifier.py",
        "gpu/ops/faeon-boot/test_mount_guard.py",
        ...[
          "test_remote_settings_fail_closed_and_select_model",
          "test_capability_requires_loaded_sortformer_and_remote_asr",
          "test_only_one_session_and_slot_released",
          "test_cancelled_remote_call_drains_thread_before_release",
          "test_short_sortformer_tail_is_padded_and_clipped_before_silence",
          "test_worker_calls_remain_serial_after_first_caller_cancelled",
        ]
          .map((test) =>
            `gpu/livekit/tests/test_shared_livekit.py::SharedLiveKitTests::${test}`
          ),
        "gpu/omi/tests/test_relay_diagnostics.py::test_untrusted_failure_and_url_context_are_bounded",
      ],
    },
  ],
};

const selected = Deno.args.length ? Deno.args : Object.keys(groups);
if (selected.includes("--list")) {
  console.log(Object.keys(groups).join("\n"));
  Deno.exit();
}
if (selected.some((group) => !(group in groups))) {
  console.error(`Unknown group. Available: ${Object.keys(groups).join(", ")}`);
  Deno.exit(2);
}
for (const group of selected) {
  for (const step of groups[group]) {
    console.log(`[verify:${group}] ${step.command.join(" ")}`);
    const isolated = testProcessEnvironment(Deno.env.toObject(), {
      root,
      temporaryDirectory:
        `/tmp/mycelia-verification-${Deno.pid}-${crypto.randomUUID()}`,
      docker: group === "backend" || group === "infra",
    });
    const result = await new Deno.Command(step.command[0], {
      args: step.command.slice(1),
      cwd: `${root}${step.cwd ?? ""}`,
      clearEnv: isolated.clearEnv,
      env: {
        ...isolated.env,
        PYTHONPATH: group === "gpu"
          ? `${root}gpu/whisper_shared`
          : `${root}python`,
      },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!result.success) Deno.exit(result.code || 1);
  }
}
