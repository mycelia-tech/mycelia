import { equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const initializing of [false, true]) {
  Deno.test(`Mongo entrypoint waits for child shutdown during ${initializing ? "initialization" : "normal operation"}`, async () => {
    const directory = await Deno.makeTempDir({
      prefix: "mycelia-mongo-signal-",
    });
    const entrypoint = fileURLToPath(
      new URL("../misc/mongo/mongo-entrypoint.sh", import.meta.url),
    );
    let child: Deno.ChildProcess | undefined;
    let output: Promise<string> | undefined;
    let childPid: number | undefined;
    try {
      await Deno.writeTextFile(
        join(directory, "mongosh"),
        `#!/bin/bash\n${
          initializing
            ? 'touch "$FIXTURE_DIR/probing"; sleep 0.2; exit 1'
            : "exit 0"
        }\n`,
        { mode: 0o700 },
      );
      await Deno.writeTextFile(
        join(directory, "fake-mongod"),
        `#!/bin/bash
exec >/dev/null 2>&1
trap 'sleep 0.1; touch "$FIXTURE_DIR/flushed"; exit 0' TERM
echo $$ > "$FIXTURE_DIR/child-pid"
deadline=$((SECONDS + 15))
while [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
`,
        { mode: 0o700 },
      );
      child = new Deno.Command("/bin/bash", {
        args: [entrypoint, join(directory, "fake-mongod")],
        clearEnv: true,
        env: { PATH: `${directory}:/usr/bin:/bin`, FIXTURE_DIR: directory },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let log = "";
      output = (async () => {
        for await (const chunk of child!.stdout) {
          log += new TextDecoder().decode(chunk);
        }
        return log;
      })();
      const errors = new Response(child.stderr).text();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const ready = initializing
          ? await Deno.stat(join(directory, "probing")).then(
            () => true,
            () => false,
          )
          : log.includes("MongoDB initialization complete.");
        const pid = await Deno.readTextFile(join(directory, "child-pid")).catch(
          () => "",
        );
        if (/^[0-9]+\s*$/.test(pid)) childPid = Number(pid);
        if (ready && childPid) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ok(childPid, "Synthetic child did not start");
      ok(
        initializing || log.includes("MongoDB initialization complete."),
        "Startup deadline exceeded",
      );
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await Promise.race([
          child.status,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Shutdown deadline exceeded")),
              3000,
            );
          }),
        ]);
        equal(status.code, 0);
        ok(
          (await Deno.stat(join(directory, "flushed"))).isFile,
          "Child must finish before the wrapper exits",
        );
      } finally {
        clearTimeout(timer);
      }
      await errors;
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch { /* already exited */ }
      // Also clean up the synthetic child when testing a broken wrapper.
      if (childPid) {
        await new Deno.Command("/bin/bash", {
          args: [
            "-c",
            'kill -TERM "$1" 2>/dev/null || true',
            "cleanup",
            String(childPid),
          ],
          stdout: "null",
          stderr: "null",
        }).output();
      }
      await child?.status;
      await output;
      await Deno.remove(directory, { recursive: true });
    }
  });
}
