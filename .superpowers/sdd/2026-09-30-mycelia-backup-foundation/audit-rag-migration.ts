#!/usr/bin/env -S deno run --allow-run

const baseEnv = {
  HOME: "/Users/pk",
  PATH: "/Users/pk/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
};
const root = "/Users/pk/repo/mycelia";

async function jsonCommand(argv: string[]): Promise<unknown> {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    clearEnv: true,
    env: baseEnv,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  try {
    if (result.code !== 0 || result.stdout.byteLength > 4 * 1024 * 1024) {
      throw new Error("command");
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

try {
  const [inspectedRaw, renderedRaw] = await Promise.all([
    jsonCommand(["/usr/local/bin/docker", "inspect", "mycelia-rag-full-rag-1"]),
    jsonCommand([
      "/usr/local/bin/docker",
      "compose",
      "--project-directory",
      root,
      "--env-file",
      `${root}/.env.rag.local`,
      "-f",
      `${root}/docker-compose.rag.yml`,
      "config",
      "--format",
      "json",
    ]),
  ]);
  if (!Array.isArray(inspectedRaw) || inspectedRaw.length !== 1) throw 0;
  const inspected = inspectedRaw[0] as Record<string, unknown>;
  const currentConfig = inspected.Config as Record<string, unknown>;
  const currentHost = inspected.HostConfig as Record<string, unknown>;
  const rendered = renderedRaw as Record<string, unknown>;
  const services = rendered.services as Record<string, Record<string, unknown>>;
  const candidate = services?.rag;
  if (!candidate) throw 0;

  const current = new Map<string, string>();
  for (const entry of currentConfig.Env as string[]) {
    const index = entry.indexOf("=");
    if (index < 1) throw 0;
    const key = entry.slice(0, index);
    if (current.has(key)) throw 0;
    current.set(key, entry.slice(index + 1));
  }
  const candidateEnv = candidate.environment as Record<string, unknown>;
  const comparedKeys = [...current.keys()].filter((key) =>
    key.startsWith("RAG_")
  );
  const mismatchedEnvironmentKeys = comparedKeys.filter((key) =>
    candidateEnv[key] !== current.get(key)
  ).sort();
  const missingCandidateKeys = Object.keys(candidateEnv).filter((key) =>
    key.startsWith("RAG_") && !current.has(key)
  ).sort();
  const deploy = candidate.deploy as Record<string, unknown>;
  const resources = deploy.resources as Record<string, unknown>;
  const limits = resources.limits as Record<string, unknown>;
  console.log(JSON.stringify({
    imageUnchanged: candidate.image === currentConfig.Image,
    mismatchedEnvironmentKeys,
    missingCandidateKeys,
    currentNanoCpus: currentHost.NanoCpus,
    candidateNanoCpus: limits.cpus,
    currentMemoryBytes: currentHost.Memory,
    candidateMemoryBytes: limits.memory,
  }));
} catch {
  console.error("RAG_MIGRATION_AUDIT_FAILED");
  Deno.exit(1);
}
