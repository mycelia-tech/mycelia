import { equal, notEqual } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

Deno.test("Compose isolates Mongo by project and host access requires a loopback overlay", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await Deno.makeTempDir({
    prefix: "mycelia-compose-contract-",
  });
  try {
    for (
      const file of [
        "docker-compose.yml",
        "docker-compose.mongo-local.yml",
        "docker-compose.media-dev.yml",
      ]
    ) {
      await Deno.copyFile(join(root, file), join(directory, file));
    }
    // These are public example values in a new temporary directory, never an
    // operator's dotenv. Compose only renders configuration; nothing is started.
    await Deno.copyFile(join(root, ".env.example"), join(directory, ".env"));
    await Deno.copyFile(
      join(root, ".env.media.example"),
      join(directory, ".env.media.local"),
    );
    const config = async (
      project: string,
      overlay?: string,
      envFile = ".env",
    ) => {
      const output = await new Deno.Command("docker", {
        args: [
          "compose",
          "--project-directory",
          directory,
          "--env-file",
          join(directory, envFile),
          "--project-name",
          project,
          "--file",
          join(directory, "docker-compose.yml"),
          ...(overlay ? ["--file", join(directory, overlay)] : []),
          "config",
          "--format",
          "json",
        ],
        env: { MYCELIA_MONGO_NETWORK: "", MONGO_LOCAL_PORT: "27017" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(30_000),
      }).output();
      equal(output.code, 0, "Compose example rendering failed");
      return JSON.parse(new TextDecoder().decode(output.stdout));
    };
    const main = await config("mycelia-fixture-a");
    const other = await config("mycelia-fixture-b");
    equal(main.services.mongo.ports?.length ?? 0, 0);
    equal(main.networks.mongo_clients.name, "mycelia-fixture-a-mongo-clients");
    notEqual(
      main.networks.mongo_clients.name,
      other.networks.mongo_clients.name,
    );
    const local = await config(
      "mycelia-fixture-a",
      "docker-compose.mongo-local.yml",
    );
    equal(local.services.mongo.ports.length, 1);
    equal(local.services.mongo.ports[0].host_ip, "127.0.0.1");
    const media = await config(
      "mycelia-media-fixture",
      "docker-compose.media-dev.yml",
      ".env.media.local",
    );
    equal(media.services.mongo.ports?.length ?? 0, 0);
    notEqual(
      media.networks.mongo_clients.name,
      main.networks.mongo_clients.name,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
