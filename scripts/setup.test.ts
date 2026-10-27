import { equal, match } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

Deno.test("first-run setup creates private distinct secrets without printing them", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mycelia-setup-test-" });
  try {
    await Deno.mkdir(join(directory, "scripts"));
    await Deno.copyFile(
      fileURLToPath(new URL("./setup.sh", import.meta.url)),
      join(directory, "scripts/setup.sh"),
    );
    await Deno.copyFile(
      fileURLToPath(new URL("../.env.example", import.meta.url)),
      join(directory, ".env.example"),
    );
    const result = await new Deno.Command("bash", {
      args: [join(directory, "scripts/setup.sh")],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    equal(result.code, 0);
    const env = await Deno.readTextFile(join(directory, ".env"));
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    const secrets = [
      "SECRET_KEY",
      "MYCELIA_BOOTSTRAP_TOKEN",
      "REDIS_PASSWORD",
      "MONGO_INITDB_ROOT_PASSWORD",
    ].map((key) => {
      const value = env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1] ?? "";
      match(value, /^[a-f0-9]{64}$/);
      equal(output.includes(value), false);
      return value;
    });
    equal(new Set(secrets).size, secrets.length);
    if (Deno.build.os !== "windows") {
      equal((await Deno.stat(join(directory, ".env"))).mode! & 0o777, 0o600);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
