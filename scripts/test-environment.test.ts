import { deepStrictEqual, equal } from "node:assert/strict";
import { testProcessEnvironment } from "./test-environment.ts";

Deno.test("verification clears inherited credentials, endpoints and operator storage paths", () => {
  const parent = {
    PATH: "/tools/bin",
    HOME: "/operator",
    UV_CACHE_DIR: "/cache/uv",
    UV_PYTHON: "3.14",
    PLAYWRIGHT_BROWSERS_PATH: "/cache/playwright",
    SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "synthetic-provider-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/operator.json",
    AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
    STT_SERVER_URL: "https://operator.invalid",
    MEDIA_SOURCE_ROOT: "/private/media",
    MYCELIA_LOG_DIR: "/private/logs",
    RAG_STATE_PATH: "/private/state.sqlite3",
    RAG_ENV_FILE: "/private/rag.env",
    MONGO_URL: "mongodb://operator.invalid",
    PYTHONPATH: "/private/extensions",
    NODE_OPTIONS: "--require /private/injection.js",
    HTTPS_PROXY: "http://user:secret@proxy.invalid",
    DOCKER_HOST: "unix:///docker.sock",
  };
  const result = testProcessEnvironment(parent, {
    root: "/repo",
    temporaryDirectory: "/tmp/test-unique",
  });
  equal(result.clearEnv, true);
  for (
    const name of [
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "STT_SERVER_URL",
      "MEDIA_SOURCE_ROOT",
      "PYTHONPATH",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "DOCKER_HOST",
    ]
  ) {
    equal(result.env[name], undefined, name);
  }
  for (
    const name of [
      "PATH",
      "HOME",
      "UV_CACHE_DIR",
      "PLAYWRIGHT_BROWSERS_PATH",
      "SystemRoot",
    ] as const
  ) {
    equal(result.env[name], parent[name]);
  }
  equal(result.env.MONGO_URL, "mongodb://127.0.0.1:1");
  equal(result.env.UV_PYTHON, "3.12");
  equal(result.env.MYCELIA_LOG_DIR, "/tmp/test-unique/logs");
  equal(result.env.RAG_STATE_PATH, "/tmp/test-unique/rag-state.sqlite3");
  equal(
    result.env.RAG_ENV_FILE,
    "/repo/python/tests/fixtures/verification.env",
  );
  equal(
    result.env.GOOGLE_APPLICATION_CREDENTIALS,
    "/tmp/test-unique/absent-adc.json",
  );
});

Deno.test("only the container-owning verification process retains explicit Docker transport", () => {
  const input = {
    DOCKER_HOST: "unix:///docker.sock",
    DOCKER_CONFIG: "/tools/docker",
    TESTCONTAINERS_RYUK_DISABLED: "true",
    TESTCONTAINERS_HOST_OVERRIDE: "operator.invalid",
  };
  const result = testProcessEnvironment(input, {
    root: "/repo",
    temporaryDirectory: "/tmp/test-unique",
    docker: true,
  });
  deepStrictEqual([result.env.DOCKER_HOST, result.env.DOCKER_CONFIG], [
    input.DOCKER_HOST,
    input.DOCKER_CONFIG,
  ]);
  equal(result.env.TESTCONTAINERS_RYUK_DISABLED, undefined);
  equal(result.env.TESTCONTAINERS_HOST_OVERRIDE, undefined);
});
