#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

import { dirname, isAbsolute, join } from "node:path";

const [rootArg] = Deno.args;

function stop(message: string): never {
  console.error(`RAG_ENV_MATERIALIZE_FAILED:${message}`);
  Deno.exit(1);
}

function safeValue(value: string): string {
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 0 || code === 10 || code === 13 || code === 127;
    })
  ) stop("unsafe-runtime-value");
  return JSON.stringify(value);
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const count = await file.write(bytes.subarray(offset));
    if (count <= 0) stop("short-write");
    offset += count;
  }
}

try {
  if (
    !rootArg || !isAbsolute(rootArg) || await Deno.realPath(rootArg) !== rootArg
  ) {
    stop("root");
  }
  const rootInfo = await Deno.lstat(rootArg);
  if (!rootInfo.isDirectory || rootInfo.isSymlink) stop("root");

  const examplePath = join(rootArg, ".env.rag.example");
  const targetPath = join(rootArg, ".env.rag.local");
  try {
    await Deno.lstat(targetPath);
    stop("target-exists");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const command = new Deno.Command("/usr/local/bin/docker", {
    args: ["inspect", "mycelia-rag-full-rag-1"],
    clearEnv: true,
    env: {
      HOME: "/Users/pk",
      PATH: "/Users/pk/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (result.code !== 0 || result.stdout.byteLength > 4 * 1024 * 1024) {
    result.stdout.fill(0);
    result.stderr.fill(0);
    stop("docker-inspect");
  }
  let inspected: unknown;
  try {
    inspected = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    stop("inspect-shape");
  }
  const container = inspected[0] as Record<string, unknown>;
  const config = container.Config as Record<string, unknown> | undefined;
  const labels = config?.Labels as Record<string, unknown> | undefined;
  if (
    container.Name !== "/mycelia-rag-full-rag-1" ||
    config?.Image !== "mycelia-rag:full-e55fc315" ||
    labels?.["com.docker.compose.project"] !== "mycelia-rag-full" ||
    labels?.["com.docker.compose.project.working_dir"] !== rootArg
  ) stop("runtime-provenance");
  const runtimeEntries = config?.Env;
  if (
    !Array.isArray(runtimeEntries) ||
    runtimeEntries.some((value) => typeof value !== "string")
  ) {
    stop("runtime-env-shape");
  }
  const runtime = new Map<string, string>();
  for (const entry of runtimeEntries as string[]) {
    const index = entry.indexOf("=");
    if (index < 1) stop("runtime-env-entry");
    const key = entry.slice(0, index);
    if (runtime.has(key)) stop("runtime-env-duplicate");
    runtime.set(key, entry.slice(index + 1));
  }

  const source = await Deno.readTextFile(examplePath);
  if (new TextEncoder().encode(source).byteLength > 1024 * 1024) {
    stop("example-size");
  }
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const template = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (template.has(match[1])) stop("template-duplicate");
    template.set(match[1], match[2]);
  }

  const synthetic = new Set([
    "RAG_COMPOSE_PROJECT_NAME",
    "RAG_IMAGE_TAG",
    "RAG_API_BIND",
    "RAG_API_PORT",
    "RAG_QDRANT_BIND",
    "RAG_QDRANT_HTTP_PORT",
    "RAG_QDRANT_GRPC_PORT",
  ]);
  const captured = new Set(["RAG_MONGO_URL", "RAG_BATCH_SIZE"]);
  for (const [key, expected] of template) {
    if (synthetic.has(key) || captured.has(key)) continue;
    if (!runtime.has(key) || runtime.get(key) !== expected) {
      stop(`unexpected-runtime-key:${key}`);
    }
  }
  for (const key of captured) {
    if (!runtime.has(key)) stop(`missing-runtime-key:${key}`);
  }

  const replacements = new Map<string, string>([
    ["RAG_COMPOSE_PROJECT_NAME", "mycelia-rag-full"],
    ["RAG_IMAGE_TAG", "full-e55fc315"],
    ["RAG_MONGO_URL", safeValue(runtime.get("RAG_MONGO_URL")!)],
    ["RAG_BATCH_SIZE", runtime.get("RAG_BATCH_SIZE")!],
  ]);
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !replacements.has(match[1])) return line;
    if (seen.has(match[1])) stop("replacement-duplicate");
    seen.add(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  }).join("\n");
  if (seen.size !== replacements.size || !output.endsWith("\n")) {
    stop("output-shape");
  }

  const temporaryPath = join(
    dirname(targetPath),
    `.env.rag.local.tmp-${crypto.randomUUID()}`,
  );
  const file = await Deno.open(temporaryPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    await writeAll(file, new TextEncoder().encode(output));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(temporaryPath, targetPath);
  await Deno.chmod(targetPath, 0o600);
  const directory = await Deno.open(dirname(targetPath), { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
  console.log("RAG_ENV_MATERIALIZED");
} catch {
  stop("closed");
}
