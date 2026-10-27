import { join } from "node:path";

// Names are deliberate: never copy credential-bearing prefixes such as AWS_*,
// GOOGLE_*, OPENAI_*, MYCELIA_*, or arbitrary service/storage configuration.
const runtimeNames = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "DENO_DIR",
  "XDG_CACHE_HOME",
  "UV_CACHE_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "UV_TOOL_DIR",
  "UV_TOOL_BIN_DIR",
  "UV_PYTHON_PREFERENCE",
  "UV_LINK_MODE",
  "UV_OFFLINE",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "COREPACK_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_CHANNEL",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
] as const;
const dockerNames = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
] as const;

export function testProcessEnvironment(
  parent: Record<string, string>,
  options: { root: string; temporaryDirectory: string; docker?: boolean },
): { clearEnv: true; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const allowed = options.docker
    ? [...runtimeNames, ...dockerNames]
    : runtimeNames;
  for (const name of allowed) {
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  const emptyConfig = join(
    options.root,
    "python/tests/fixtures/verification.env",
  );
  Object.assign(env, {
    DENO_JOBS: "1",
    DENO_ENV: "test",
    PYTHONDONTWRITEBYTECODE: "1",
    UV_PYTHON: "3.12",
    MYCELIA_ENV_FILE: emptyConfig,
    RAG_ENV_FILE: emptyConfig,
    MYCELIA_LOG_DIR: join(options.temporaryDirectory, "logs"),
    MYCELIA_URL: "http://127.0.0.1:1",
    MYCELIA_BACKEND_INTERNAL_URL: "http://127.0.0.1:1",
    MONGO_URL: "mongodb://127.0.0.1:1",
    DATABASE_NAME: "mycelia_verification",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "1",
    REDIS_PASSWORD: "",
    MYCELIA_TOKEN: "",
    MYCELIA_CLIENT_ID: "",
    MYCELIA_JWT: "",
    SECRET_KEY: "synthetic-verification-key-not-for-deployment",
    PYTHON_WORKER_URL: "http://127.0.0.1:1",
    RAG_MONGO_URL: "mongodb://127.0.0.1:1",
    RAG_MONGO_DATABASE: "mycelia_verification",
    RAG_QDRANT_URL: "http://127.0.0.1:1",
    RAG_STATE_PATH: join(options.temporaryDirectory, "rag-state.sqlite3"),
    RAG_MODEL_CACHE: join(options.temporaryDirectory, "rag-models"),
    OTEL_ENABLED: "false",
    // A missing explicit ADC file fails before the SDK checks HOME credentials
    // or metadata services. Do not use an empty string, which enables fallback.
    GOOGLE_APPLICATION_CREDENTIALS: join(
      options.temporaryDirectory,
      "absent-adc.json",
    ),
    AWS_EC2_METADATA_DISABLED: "true",
  });
  return { clearEnv: true, env };
}
