import { deepStrictEqual, equal } from "node:assert/strict";
import { summarizeRuntime } from "./doctor.ts";

function containers() {
  return ["backend", "frontend", "mongo", "redis"].map((service) => ({
    Config: {
      Labels: { "com.docker.compose.service": service },
      Env: ["SECRET_KEY=never-print-me", "APP_MODE=dev"],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    Mounts: [{ Source: `/repo/${service}`, Destination: "/app" }],
    NetworkSettings: { Ports: {} },
  }));
}
Deno.test("doctor distinguishes health/readiness and does not leak inspect credentials", () => {
  const result = summarizeRuntime(containers(), "/repo");
  equal(result.ok, true);
  equal(result.services[0].health, "healthy");
  equal(result.services[0].readiness, "not-probed");
  equal(JSON.stringify(result).includes("never-print-me"), false);
});
Deno.test("doctor rejects a healthy application mounted from another checkout", () => {
  const input = containers();
  input[0].Mounts[0].Source = "/other/backend";
  const result = summarizeRuntime(input, "/repo");
  equal(result.ok, false);
  deepStrictEqual(result.issues, [
    "backend: checkout does not match expected root",
  ]);
});
Deno.test("doctor flags public Mongo bindings and accepts explicit loopback maintenance", () => {
  for (
    const [host, expected] of [["0.0.0.0", false], ["::", false], [
      "127.0.0.1",
      true,
    ]] as const
  ) {
    const input = containers();
    input[2].NetworkSettings.Ports = {
      "27017/tcp": [{ HostIp: host, HostPort: "27017" }],
    };
    equal(summarizeRuntime(input, "/repo").ok, expected);
  }
});

Deno.test("doctor treats unhealthy running services as failures without conflating startup", () => {
  const input = containers();
  input[1].State.Health.Status = "unhealthy";
  const result = summarizeRuntime(input, "/repo");
  equal(result.services[1].running, true);
  equal(result.ok, false);
  deepStrictEqual(result.issues, ["frontend: unhealthy"]);
  input[1].State.Health.Status = "starting";
  equal(summarizeRuntime(input, "/repo").services[1].health, "starting");
});

Deno.test("doctor distinguishes a stopped Mongo from its configured exposure on restart", () => {
  const input = containers();
  const mongo = {
    ...input[2],
    State: {
      Running: false,
      Status: "exited",
      ExitCode: 137,
      OOMKilled: false,
      FinishedAt: "2026-10-27T17:02:14Z",
      Health: { Status: "unhealthy" },
      Error: "private connection details must not appear",
    },
    RestartCount: 1,
    HostConfig: {
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      NanoCpus: 1e9,
      PortBindings: {
        "27017/tcp": [{ HostIp: "0.0.0.0", HostPort: "27017" }],
      },
    },
  };
  const result = summarizeRuntime(
    [input[0], input[1], mongo, input[3]],
    "/repo",
  );
  const summary = result.services[2];
  equal(summary.running, false);
  equal(summary.state, "exited");
  equal(summary.health, "not-running");
  equal(summary.recordedHealth, "unhealthy");
  equal(summary.readiness, "not-running");
  equal(summary.lastExit?.code, 137);
  equal(summary.lastExit?.oomKilled, false);
  equal(summary.restartCount, 1);
  equal(summary.resourceLimits.memoryBytes, 1024 ** 3);
  equal(summary.published.length, 0);
  equal(summary.configuredPublished[0].host, "0.0.0.0");
  equal(
    result.issues.includes(
      "mongo: configured host publication exposes the database on start",
    ),
    true,
  );
  equal(JSON.stringify(result).includes("private connection"), false);
  mongo.HostConfig.PortBindings["27017/tcp"][0].HostIp = "127.0.0.1";
  deepStrictEqual(
    summarizeRuntime([input[0], input[1], mongo, input[3]], "/repo").issues,
    ["mongo: not running"],
  );
});

Deno.test("doctor does not infer a missing OOM status or exit cause", () => {
  const input = containers();
  input[0].State.Running = false;
  const summary = summarizeRuntime(input, "/repo").services[0];
  equal(summary.lastExit?.code, null);
  equal(summary.lastExit?.oomKilled, null);
  equal(summary.resourceLimits.memoryBytes, null);
});
