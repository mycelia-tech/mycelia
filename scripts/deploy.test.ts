import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  candidateDeploymentBlockers,
  deploymentBlockers,
  deploymentCommands,
  deploymentReadinessIssues,
  prepareDeployment,
  waitForDeployment,
} from "./deploy.ts";
import { summarizeRuntime } from "./doctor.ts";

const runtime = () =>
  summarizeRuntime(
    ["backend", "frontend", "mongo", "redis"].map((service) => ({
      Config: { Labels: { "com.docker.compose.service": service } },
      Mounts: [{ Source: `/repo/${service}`, Destination: "/app" }],
      State: { Running: true },
    })),
    "/repo",
  );

Deno.test("deployment blocks a different checkout even when changing another app", () => {
  const state = runtime();
  state.services[1].sourceMatches = false;
  equal(deploymentBlockers(state, ["backend"]).length, 1);
});
Deno.test("deployment allows unhealthy same-checkout app recovery but never databases", () => {
  const state = runtime();
  state.services[0].running = false;
  equal(deploymentBlockers(state, ["backend"]).length, 0);
  equal(deploymentBlockers(state, ["mongo"]).length, 1);
  equal(deploymentBlockers(state, ["python-worker"]).length, 1);
});
Deno.test("deployment preserves explicit overlays and only recreates selected apps", () => {
  const commands = deploymentCommands("example", [
    "docker-compose.yml",
    "local.yml",
  ], ["backend"]);
  deepStrictEqual(commands[1], [
    "docker",
    "compose",
    "--project-name",
    "example",
    "--file",
    "docker-compose.yml",
    "--file",
    "local.yml",
    "up",
    "--detach",
    "--no-deps",
    "--build",
    "--force-recreate",
    "backend",
  ]);
  deepStrictEqual(commands[2].slice(-2), ["restart", "nginx"]);
  deepStrictEqual(commands[0].slice(-3), ["config", "--format", "json"]);
});

function candidate() {
  return {
    services: Object.fromEntries(
      ["backend", "frontend", "python-worker"].map((name) => {
        const component = name === "python-worker" ? "python" : name;
        return [name, {
          build: { context: "/repo", dockerfile: `${component}/Dockerfile` },
          environment: { SECRET_KEY: "PRIVATE_CONFIGURATION_CANARY" },
          volumes: [
            { type: "bind", source: `/repo/${component}`, target: "/app" },
            ...(name === "python-worker" ? [] : [{
              type: "bind",
              source: "/repo/myceliasdk",
              target: name === "frontend" ? "/app/myceliasdk" : "/myceliasdk",
            }]),
          ],
        }];
      }),
    ),
  };
}

Deno.test("candidate rejects overlays replacing app, SDK, nested code or build source", () => {
  equal(
    candidateDeploymentBlockers(candidate(), "/repo", [
      "backend",
      "frontend",
      "python-worker",
    ]).length,
    0,
  );
  for (
    const mutate of [
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.volumes[0].source = "/other/backend";
      },
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.volumes[1].source = "/other/myceliasdk";
      },
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.build.context = "/other";
      },
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.build.dockerfile = "../other/Dockerfile";
      },
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.volumes.push({
          type: "bind",
          source: "/other/server.ts",
          target: "/app/server.ts",
        });
      },
      (input: ReturnType<typeof candidate>) => {
        input.services.backend.volumes[0].type = "volume";
      },
    ]
  ) {
    const input = candidate();
    mutate(input);
    const issues = candidateDeploymentBlockers(input, "/repo", ["backend"]);
    equal(issues.length > 0, true);
    equal(issues.join().includes("PRIVATE_CONFIGURATION_CANARY"), false);
  }
  const input = candidate();
  input.services.frontend.volumes[1].source = "/other/myceliasdk";
  equal(
    candidateDeploymentBlockers(input, "/repo", ["frontend"]).length > 0,
    true,
  );
});

Deno.test("dry-run preflight reads resolved Compose and never returns a config-printing command", async () => {
  const seen: string[][] = [];
  const commands = await prepareDeployment(
    runtime(),
    "/repo",
    "example",
    ["base.yml", "override.yml"],
    ["backend"],
    (command, cwd) => {
      equal(cwd, "/repo");
      seen.push(command);
      return Promise.resolve(JSON.stringify(candidate()));
    },
  );
  equal(seen.length, 1);
  deepStrictEqual(seen[0].slice(-3), ["config", "--format", "json"]);
  equal(commands.length, 2);
  equal(commands.some((command) => command.includes("config")), false);
  equal(
    JSON.stringify(commands).includes("PRIVATE_CONFIGURATION_CANARY"),
    false,
  );
});

Deno.test("candidate mismatch or malformed private configuration fails before dry-run success", async () => {
  const input = candidate();
  input.services.backend.volumes[0].source = "/other/backend";
  await rejects(
    () =>
      prepareDeployment(runtime(), "/repo", "example", ["override.yml"], [
        "backend",
      ], () => Promise.resolve(JSON.stringify(input))),
    /candidate source bind differs/,
  );
  await rejects(
    () =>
      prepareDeployment(runtime(), "/repo", "example", ["override.yml"], [
        "backend",
      ], () => Promise.resolve('{"secret":"PRIVATE_CONFIGURATION_CANARY"')),
    (error) => {
      equal(
        (error as Error).message,
        "Cannot inspect the candidate Compose configuration",
      );
      return true;
    },
  );
  await rejects(
    () =>
      prepareDeployment(runtime(), "/repo", "example", ["missing.yml"], [
        "backend",
      ], () => {
        return Promise.reject(new Error("PRIVATE_COMPOSE_STDERR_CANARY"));
      }),
    /Cannot inspect the candidate Compose configuration/,
  );
});

function readyRuntime() {
  const state = runtime();
  for (const service of state.services) service.health = "healthy";
  state.services[0].readiness = "ready";
  return state;
}

Deno.test("deployment waits through starting state and probes only selected applications", async () => {
  let clock = 0;
  let calls = 0;
  const state = await waitForDeployment(["backend", "frontend"], () => {
    calls++;
    const current = readyRuntime();
    if (calls === 1) {
      current.services[0].readiness = "http-503";
      current.services[1].health = "starting";
    }
    // The caller still receives global diagnostics, but unrelated services do
    // not extend a targeted application readiness wait.
    current.services[2].health = "unhealthy";
    current.ok = false;
    return Promise.resolve(current);
  }, {
    timeoutMs: 30,
    pollMs: 10,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  equal(calls, 2);
  equal(clock, 10);
  equal(state.ok, false);
  deepStrictEqual(
    deploymentReadinessIssues(state, ["backend", "frontend"]),
    [],
  );
});

Deno.test("unhealthy or unprobed selected applications time out within one shared budget", async () => {
  for (const kind of ["unhealthy", "no-probe"]) {
    let clock = 0;
    let calls = 0;
    await rejects(
      () =>
        waitForDeployment(["backend", "frontend"], () => {
          calls++;
          const state = readyRuntime();
          if (kind === "unhealthy") state.services[1].health = "unhealthy";
          else state.services[0].readiness = "not-probed";
          return Promise.resolve(state);
        }, {
          timeoutMs: 30,
          pollMs: 10,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
            return Promise.resolve();
          },
        }),
      kind === "unhealthy"
        ? /timed out: frontend: health unhealthy/
        : /timed out: backend: readiness not confirmed/,
    );
    equal(clock, 30);
    equal(calls, 3);
  }
});

Deno.test("a stalled inspection is cancelled at the readiness deadline", async () => {
  let signal: AbortSignal | undefined;
  await rejects(() =>
    waitForDeployment(["backend"], (value) => {
      signal = value;
      return new Promise(() => {});
    }, { timeoutMs: 10 }), /Deployment readiness timed out/);
  equal(signal?.aborted, true);
});
