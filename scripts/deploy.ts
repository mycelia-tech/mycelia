import { fileURLToPath } from "node:url";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { doctor, summarizeRuntime } from "./doctor.ts";

type Runtime = ReturnType<typeof summarizeRuntime>;
const applicationServices = ["backend", "frontend", "python-worker"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inspect only source-related fields; resolved Compose contains credentials. */
export function candidateDeploymentBlockers(
  candidate: unknown,
  expectedRoot: string,
  services: string[],
): string[] {
  if (!record(candidate) || !record(candidate.services)) {
    return ["Compose configuration has no services"];
  }
  const root = resolve(expectedRoot);
  const blockers: string[] = [];
  for (const name of services) {
    if (!applicationServices.includes(name)) {
      blockers.push("Only application services may be deployed");
      continue;
    }
    const service = candidate.services[name];
    if (!record(service)) {
      blockers.push(`${name}: absent from candidate configuration`);
      continue;
    }
    const component = name === "python-worker" ? "python" : name;
    const roots = [{ target: "/app", source: resolve(root, component) }];
    if (name !== "python-worker") {
      roots.unshift({
        target: name === "frontend" ? "/app/myceliasdk" : "/myceliasdk",
        source: resolve(root, "myceliasdk"),
      });
    }
    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const required of roots) {
      const matching = volumes.filter((volume) =>
        record(volume) && typeof volume.target === "string" &&
        posix.normalize(volume.target) === required.target
      );
      if (matching.length !== 1) {
        blockers.push(`${name}: expected one ${required.target} source bind`);
      }
    }
    for (const volume of volumes) {
      if (!record(volume) || typeof volume.target !== "string") {
        blockers.push(`${name}: candidate mounts are not normalized`);
        continue;
      }
      const target = posix.normalize(volume.target);
      const protectedRoot = roots.find((item) =>
        target === item.target || target.startsWith(item.target + "/")
      );
      if (!protectedRoot) continue;
      const expected = resolve(
        protectedRoot.source,
        "." + target.slice(protectedRoot.target.length),
      );
      if (
        volume.type !== "bind" || typeof volume.source !== "string" ||
        resolve(root, volume.source) !== expected
      ) {
        blockers.push(
          `${name}: candidate source bind differs from the requested checkout`,
        );
      }
    }
    const build = service.build;
    const context = typeof build === "string"
      ? build
      : record(build)
      ? build.context
      : null;
    if (typeof context !== "string" || resolve(root, context) !== root) {
      blockers.push(
        `${name}: candidate build context differs from the requested checkout`,
      );
    }
    if (record(build) && typeof build.dockerfile === "string") {
      const path = relative(root, resolve(root, build.dockerfile));
      if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
        blockers.push(
          `${name}: candidate Dockerfile is outside the requested checkout`,
        );
      }
    }
    if (
      record(build) && build.additional_contexts &&
      Object.keys(build.additional_contexts).length
    ) {
      blockers.push(
        `${name}: additional build contexts are unsupported by this source guard`,
      );
    }
  }
  return [...new Set(blockers)];
}

/** Recovery may start unhealthy apps, but may never silently switch checkouts. */
export function deploymentBlockers(
  runtime: Runtime,
  services: string[],
): string[] {
  const blockers: string[] = [];
  if (
    !services.length ||
    services.some((name) => !applicationServices.includes(name))
  ) {
    blockers.push(
      "Choose only backend, frontend or python-worker; database changes require a separate runbook.",
    );
  }
  for (
    const service of runtime.services.filter((entry) =>
      applicationServices.includes(entry.service)
    )
  ) {
    if (!service.sourceMatches) {
      blockers.push(
        `${service.service}: running checkout differs from the requested checkout`,
      );
    }
  }
  for (const name of services) {
    if (!runtime.services.some((entry) => entry.service === name)) {
      blockers.push(`${name}: no existing deployment; use first-run setup`);
    }
  }
  return blockers;
}

export function deploymentCommands(
  project: string,
  files: string[],
  services: string[],
): string[][] {
  const compose = [
    "docker",
    "compose",
    "--project-name",
    project,
    ...files.flatMap((file) => ["--file", file]),
  ];
  return [
    [...compose, "config", "--format", "json"],
    [
      ...compose,
      "up",
      "--detach",
      "--no-deps",
      "--build",
      "--force-recreate",
      ...services,
    ],
    [...compose, "restart", "nginx"],
  ];
}

type ReadConfiguration = (command: string[], cwd: string) => Promise<string>;

async function readConfiguration(
  command: string[],
  cwd: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await new Deno.Command(command[0], {
      args: command.slice(1),
      cwd,
      signal: controller.signal,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) throw new Error();
    return new TextDecoder().decode(result.stdout);
  } finally {
    clearTimeout(timer);
  }
}

/** Dry-run and apply share this preflight; its return contains mutations only. */
export async function prepareDeployment(
  runtime: Runtime,
  root: string,
  project: string,
  files: string[],
  services: string[],
  read: ReadConfiguration = readConfiguration,
  checkBindSource: (path: string) => Promise<unknown> = Deno.stat,
): Promise<string[][]> {
  const blockers = deploymentBlockers(runtime, services);
  if (blockers.length) throw new Error(blockers.join("\n"));
  const [configuration, ...mutations] = deploymentCommands(
    project,
    files,
    services,
  );
  let candidate: unknown;
  try {
    candidate = JSON.parse(await read(configuration, root));
  } catch {
    // Neither JSON parser errors nor Compose stderr may expose environment values.
    throw new Error("Cannot inspect the candidate Compose configuration");
  }
  const candidateBlockers = candidateDeploymentBlockers(
    candidate,
    root,
    services,
  );
  if (candidateBlockers.length) throw new Error(candidateBlockers.join("\n"));
  // Check required bind paths before Compose can partially recreate the stack.
  // Only the explicitly optional local media folder may be created empty.
  if (record(candidate) && record(candidate.services)) {
    for (const name of services) {
      const service = candidate.services[name];
      if (!record(service) || !Array.isArray(service.volumes)) continue;
      for (const volume of service.volumes) {
        if (
          !record(volume) || volume.type !== "bind" ||
          typeof volume.source !== "string"
        ) continue;
        const optionalMedia = record(service.environment) &&
          service.environment.MEDIA_SOURCE_ROOT === volume.target &&
          record(volume.bind) && volume.bind.create_host_path === true;
        if (optionalMedia) continue;
        try {
          await checkBindSource(resolve(root, volume.source));
        } catch {
          throw new Error(
            `${name}: required bind source for ${volume.target} is missing or inaccessible`,
          );
        }
      }
    }
  }
  return mutations;
}

export function deploymentReadinessIssues(
  runtime: Runtime,
  services: string[],
): string[] {
  const issues: string[] = [];
  for (const name of services) {
    const instances = runtime.services.filter((service) =>
      service.service === name
    );
    if (!instances.length) issues.push(`${name}: missing`);
    for (const service of instances) {
      if (!service.sourceMatches) issues.push(`${name}: checkout mismatch`);
      if (!service.running) issues.push(`${name}: not running`);
      if (
        service.health !== "healthy" &&
        (service.health !== "not-configured" || name === "frontend")
      ) {
        issues.push(`${name}: health ${service.health}`);
      }
      if (name !== "frontend" && service.readiness !== "ready") {
        issues.push(`${name}: readiness not confirmed`);
      }
    }
  }
  return [...new Set(issues)];
}

export async function waitForDeployment(
  services: string[],
  inspect: (signal: AbortSignal) => Promise<Runtime>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Runtime> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 2_000;
  if (
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isFinite(pollMs) || pollMs <= 0 || !services.length ||
    services.some((name) => !applicationServices.includes(name))
  ) {
    throw new Error("Invalid deployment wait configuration");
  }
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let pending = ["runtime inspection unavailable"];
  while (now() < deadline) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const runtime = await Promise.race([
        inspect(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Deployment readiness deadline reached"));
          }, Math.max(1, deadline - now()));
        }),
      ]);
      pending = deploymentReadinessIssues(runtime, services);
      if (!pending.length) return runtime;
    } catch {
      if (controller.signal.aborted) break;
      pending = ["runtime inspection unavailable"];
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  throw new Error(`Deployment readiness timed out: ${pending.join("; ")}`);
}

async function main(args: string[]) {
  let root = fileURLToPath(new URL("../", import.meta.url));
  let project = "mycelia";
  let apply = false;
  const files: string[] = [];
  const services: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (["--expected-root", "--project", "--file"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--expected-root") root = resolve(value);
      else if (arg === "--project") project = value;
      else files.push(value);
    } else if (applicationServices.includes(arg)) services.push(arg);
    else throw new Error(`Unsupported deployment argument: ${arg}`);
  }
  if (!services.length) services.push("backend", "frontend");
  if (!files.length) files.push("docker-compose.yml");
  const runtime = await doctor(["--expected-root", root, "--project", project]);
  const selected = [...new Set(services)];
  const commands = await prepareDeployment(
    runtime,
    root,
    project,
    files,
    selected,
  );
  if (!apply) {
    console.log(
      "Deployment source guard passed. No runtime changes made. Add --apply to update the selected application services.",
    );
    return;
  }
  for (const command of commands) {
    const status = await new Deno.Command(command[0], {
      args: command.slice(1),
      cwd: root,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!status.success) {
      throw new Error(
        "Application deployment command failed; inspect service state before retrying.",
      );
    }
  }
  const after = await waitForDeployment(selected, (signal) =>
    doctor([
      "--expected-root",
      root,
      "--project",
      project,
      "--probe-readiness",
    ], { signal, probeServices: selected }));
  console.log(JSON.stringify(after, null, 2));
  console.log(
    "Application services were recreated. Check [READY] logs; startup and readiness are separate states.",
  );
  if (!after.ok) Deno.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Deployment guard failed",
    );
    Deno.exitCode = 1;
  }
}
