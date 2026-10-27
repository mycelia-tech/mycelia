import {
  GenericContainer,
  type InspectResult,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { MongoDBContainer } from "@testcontainers/mongodb";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertLoopbackBindings,
  loopbackPortBindings,
  parseTestArguments,
  within,
  withOwnedTestContainers,
} from "./test-session.ts";
import { testProcessEnvironment } from "../../../scripts/test-environment.ts";

const backendRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function verifyBindings(
  container: StartedTestContainer,
  inspect: InspectResult,
  port: number,
) {
  try {
    assertLoopbackBindings(inspect.ports, port);
    console.info(
      `[TEST] Verified container port ${port} is bound only to 127.0.0.1`,
    );
  } catch (error) {
    await within(
      container.stop({ timeout: 10_000 }),
      15_000,
      "Unsafe test binding cleanup",
    );
    throw error;
  }
}

// Testcontainers 11's public port options omit HostIp. Use its supported
// protected creation hook and HostConfig, then assert the actual inspect result.
class LoopbackRedisContainer extends GenericContainer {
  protected override async beforeContainerCreated() {
    this.hostConfig.PortBindings = loopbackPortBindings(6379);
  }
  protected override async containerStarted(
    container: StartedTestContainer,
    inspect: InspectResult,
  ) {
    await verifyBindings(container, inspect, 6379);
  }
}
class LoopbackMongoContainer extends MongoDBContainer {
  protected override async beforeContainerCreated() {
    this.hostConfig.PortBindings = loopbackPortBindings(27017);
  }
  protected override async containerStarted(
    container: StartedTestContainer,
    inspect: InspectResult,
  ) {
    await verifyBindings(container, inspect, 27017);
  }
}

async function main(args: string[]): Promise<number> {
  const testArguments = parseTestArguments(args);
  // Paths are backend-relative, even when this runner is invoked from the repo root.
  for (let i = 0; i < testArguments.length; i++) {
    if (testArguments[i] === "--filter") {
      i++;
      continue;
    }
    if (testArguments[i].startsWith("--")) continue;
    const path = await Deno.realPath(resolve(backendRoot, testArguments[i]));
    const inside = relative(backendRoot, path);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("Test paths must stay inside the backend checkout");
    }
  }
  const abort = new AbortController();
  const owner = crypto.randomUUID();
  console.info(`[TEST] Container owner: ${owner}`);
  const interrupt = () =>
    abort.abort(new Error("Backend test run interrupted"));
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", interrupt);
  try {
    return await withOwnedTestContainers(
      async () => {
        const container = await new LoopbackRedisContainer(
          "redis@sha256:344e3945a0b431c8ff1eecd58c5573538126bd756f02fc7e218ddf1fc2546366",
        ).withExposedPorts(6379)
          .withLabels({ "mycelia.test-run": owner })
          .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
          .withStartupTimeout(120_000)
          .start();
        return {
          host: container.getHost(),
          port: container.getMappedPort(6379),
          stop: async () => {
            await container.stop({ timeout: 10_000 });
          },
        };
      },
      async () => {
        const container = await new LoopbackMongoContainer("mongo:8.0")
          .withLabels({ "mycelia.test-run": owner })
          .withStartupTimeout(120_000).start();
        return {
          host: container.getHost(),
          port: container.getMappedPort(27017),
          stop: async () => {
            await container.stop({ timeout: 10_000 });
          },
        };
      },
      async (session) => {
        const directory = await Deno.makeTempDir({
          prefix: "mycelia-backend-tests-",
        });
        const manifest = `${directory}/session.json`;
        try {
          await Deno.chmod(directory, 0o700);
          await Deno.writeTextFile(manifest, JSON.stringify(session), {
            mode: 0o600,
            createNew: true,
          });
          const isolated = testProcessEnvironment(Deno.env.toObject(), {
            root: repoRoot,
            temporaryDirectory: directory,
          });
          const child = new Deno.Command(Deno.execPath(), {
            cwd: backendRoot,
            args: [
              "test",
              "--frozen",
              "--allow-read",
              "--allow-write",
              "--allow-net",
              "--allow-run",
              "--allow-sys",
              "--allow-env",
              "--deny-read=.env,../.env",
              ...testArguments,
            ],
            clearEnv: isolated.clearEnv,
            env: {
              ...isolated.env,
              MYCELIA_TEST_SESSION_FILE: manifest,
              MYCELIA_TEST_SESSION_ID: session.session,
            },
            stdin: "null",
            stdout: "inherit",
            stderr: "inherit",
          }).spawn();
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const stopChild = () => {
            try {
              child.kill("SIGTERM");
            } catch { /* Already exited. */ }
            killTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch { /* Already exited. */ }
            }, 5_000);
          };
          abort.signal.addEventListener("abort", stopChild, { once: true });
          if (abort.signal.aborted) stopChild();
          // A broken test cannot keep the owned pair alive indefinitely.
          const deadline = setTimeout(interrupt, 60 * 60 * 1000);
          try {
            const status = await child.status;
            return abort.signal.aborted ? 130 : status.code;
          } finally {
            clearTimeout(deadline);
            clearTimeout(killTimer);
            abort.signal.removeEventListener("abort", stopChild);
          }
        } finally {
          await within(
            Deno.remove(directory, { recursive: true }),
            5_000,
            "Test manifest cleanup",
          );
        }
      },
      { signal: abort.signal },
    );
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main(Deno.args);
  } catch (error) {
    console.error(error);
  }
  // Testcontainers' reaper connection is process-scoped; exit only after finally.
  Deno.exit(code);
}
