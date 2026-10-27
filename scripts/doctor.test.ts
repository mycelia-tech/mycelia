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
