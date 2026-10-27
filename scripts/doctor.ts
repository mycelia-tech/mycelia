import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Container = {
  Id?: string;
  Name?: string;
  Image?: string;
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
  State?: {
    Running?: boolean;
    Status?: string;
    ExitCode?: number;
    OOMKilled?: boolean;
    FinishedAt?: string;
    Health?: { Status?: string };
  };
  RestartCount?: number;
  HostConfig?: {
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    PortBindings?: Record<
      string,
      { HostIp: string; HostPort: string }[] | null
    >;
  };
  Mounts?: { Source: string; Destination: string; RW?: boolean }[];
  NetworkSettings?: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
};

function hostPath(path: string): string {
  return resolve(path.replace(/^\/host_mnt(?=\/)/, ""));
}

/** Whitelist output fields: docker inspect contains credentials and private mounts. */
export function summarizeRuntime(
  containers: Container[],
  expectedRoot: string,
) {
  const root = hostPath(expectedRoot);
  const issues: string[] = [];
  const services = containers.map((container) => {
    const service = container.Config?.Labels?.["com.docker.compose.service"] ??
      "unknown";
    const environment = Object.fromEntries(
      (container.Config?.Env ?? []).map((entry) => {
        const index = entry.indexOf("=");
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    const codeMount = container.Mounts?.find((mount) =>
      mount.Destination === "/app"
    );
    const component = service === "python-worker" ? "python" : service;
    const needsSource = ["backend", "frontend", "python-worker"].includes(
      service,
    );
    const sourceMatches = !needsSource || Boolean(
      codeMount &&
        hostPath(codeMount.Source) === resolve(root, component),
    );
    if (!sourceMatches) {
      issues.push(`${service}: checkout does not match expected root`);
    }
    if (!container.State?.Running) issues.push(`${service}: not running`);
    if (
      container.State?.Running && container.State.Health?.Status === "unhealthy"
    ) {
      issues.push(`${service}: unhealthy`);
    }
    const portBindings = (
      ports: Record<string, { HostIp: string; HostPort: string }[] | null>,
    ) =>
      Object.entries(ports)
        .flatMap(
          ([port, bindings]) =>
            (bindings ?? []).map((binding) => ({
              port,
              host: binding.HostIp,
              hostPort: binding.HostPort,
            })),
        );
    const published = portBindings(container.NetworkSettings?.Ports ?? {});
    // Stopping a container removes active bindings, but restarting it restores
    // HostConfig.PortBindings. Keep the latent exposure visible to operators.
    const configuredPublished = portBindings(
      container.HostConfig?.PortBindings ?? {},
    );
    const isPublic = (binding: { host: string }) =>
      !["127.0.0.1", "::1"].includes(binding.host);
    if (
      service === "mongo" &&
      published.some(isPublic)
    ) issues.push("mongo: database is published beyond loopback");
    else if (service === "mongo" && configuredPublished.some(isPublic)) {
      issues.push(
        "mongo: configured host publication exposes the database on start",
      );
    }
    return {
      service,
      running: container.State?.Running ?? false,
      state: container.State?.Status ?? "unknown",
      lastExit: container.State?.Running ? null : {
        code: container.State?.ExitCode ?? null,
        oomKilled: container.State?.OOMKilled ?? null,
        finishedAt: container.State?.FinishedAt ?? null,
      },
      restartCount: container.RestartCount ?? null,
      resourceLimits: {
        memoryBytes: container.HostConfig?.Memory ?? null,
        memorySwapBytes: container.HostConfig?.MemorySwap ?? null,
        nanoCpus: container.HostConfig?.NanoCpus ?? null,
      },
      health: container.State?.Running
        ? container.State.Health?.Status ?? "not-configured"
        : "not-running",
      recordedHealth: container.State?.Health?.Status ?? "not-configured",
      readiness: container.State?.Running ? "not-probed" : "not-running",
      mode: service === "backend"
        ? environment.APP_MODE ?? "unknown"
        : service === "frontend"
        ? environment.NODE_ENV ?? "unknown"
        : "not-applicable",
      source: needsSource ? codeMount?.Source ?? null : null,
      sourceMatches,
      image: container.Config?.Image ?? null,
      imageId: container.Image ?? null,
      imageRevision:
        container.Config?.Labels?.["org.opencontainers.image.revision"] ?? null,
      published,
      configuredPublished,
    };
  });
  for (const service of ["backend", "frontend", "mongo", "redis"]) {
    if (!services.some((entry) => entry.service === service)) {
      issues.push(`${service}: missing`);
    }
  }
  return { expectedRoot: root, services, issues, ok: issues.length === 0 };
}

async function command(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const output = await new Deno.Command(args[0], {
      args: args.slice(1),
      cwd,
      signal: abort.signal,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) throw new Error(`${args[0]} check failed`);
    return new TextDecoder().decode(output.stdout).trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function doctor(args: string[], options: {
  signal?: AbortSignal;
  probeServices?: string[];
} = {}) {
  const value = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] ?? fallback;
  };
  const root = resolve(
    value("--expected-root", fileURLToPath(new URL("../", import.meta.url))),
  );
  const project = value("--project", "mycelia");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new Error("Invalid Compose project name");
  }
  const ids = (await command(
    [
      "docker",
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    undefined,
    options.signal,
  ))
    .split(/\s+/).filter(Boolean);
  const containers: Container[] = ids.length
    ? JSON.parse(
      await command(["docker", "inspect", ...ids], undefined, options.signal),
    )
    : [];
  const summary = summarizeRuntime(containers, root);
  let expectedRevision = "unavailable";
  try {
    expectedRevision = await command(
      ["git", "rev-parse", "HEAD"],
      root,
      options.signal,
    );
  } catch { /* report explicitly */ }
  if (args.includes("--probe-readiness")) {
    for (
      const service of summary.services.filter((entry) =>
        (options.probeServices ?? ["backend"]).includes(entry.service) &&
        ["backend", "python-worker"].includes(entry.service)
      )
    ) {
      const container = containers.find((entry) =>
        entry.Config?.Labels?.["com.docker.compose.service"] === service.service
      );
      if (!service.running) {
        service.readiness = "not-running";
        continue;
      }
      try {
        const probe = service.service === "backend"
          ? [
            "deno",
            "eval",
            "const r = await fetch('http://127.0.0.1:5173/readiness', {signal: AbortSignal.timeout(5000)}); console.log(r.status);",
          ]
          : [
            "python",
            "-c",
            "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8000/capabilities',timeout=5)); print(200 if r.get('status')=='ready' and isinstance(r.get('jobs'),list) and r['jobs'] else 503)",
          ];
        const status = await command(
          [
            "docker",
            "exec",
            container!.Id!,
            ...probe,
          ],
          undefined,
          options.signal,
        );
        service.readiness = status === "200" ? "ready" : `http-${status}`;
      } catch {
        service.readiness = "unavailable";
      }
      if (service.readiness !== "ready") {
        summary.issues.push(`${service.service}: readiness not confirmed`);
      }
    }
  }
  summary.ok = summary.issues.length === 0;
  return {
    ...summary,
    expectedRevision,
    note:
      "Source revision and container health do not prove that a production process loaded those sources.",
  };
}

if (import.meta.main) {
  try {
    const result = await doctor(Deno.args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) Deno.exitCode = 1;
  } catch {
    console.error(
      "Runtime inspection unavailable. Check Docker access and the expected checkout; no runtime changes were made.",
    );
    Deno.exitCode = 2;
  }
}
