import { expect } from "@std/expect";
import { readDiscoveryProcess } from "./discovery-process.ts";
import { discoverCapabilities, Registry } from "./registries.ts";
import { join } from "@std/path";

function command(source: string) {
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-config", source],
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
}

Deno.test("discovery preserves UTF-8 stdout and drains stderr", async () => {
  const output = await readDiscoveryProcess(command(`
    const bytes = new TextEncoder().encode('готово');
    for (const byte of bytes) await Deno.stdout.write(new Uint8Array([byte]));
    console.error('internal module diagnostic');
  `));
  expect(output).toBe("готово");
});

Deno.test("discovery kills and reaps a child that ignores SIGTERM", async () => {
  await expect(readDiscoveryProcess(
    command(`
    Deno.addSignalListener('SIGTERM', () => {});
    setInterval(() => {}, 100);
  `),
    { timeoutMs: 500 },
  )).rejects.toThrow("timed out after 500 ms");
});

for (const stream of ["stdout", "stderr"]) {
  Deno.test(`discovery bounds ${stream} and reaps a noisy child`, async () => {
    await expect(readDiscoveryProcess(
      command(`
      while (true) await Deno.${stream}.write(new Uint8Array(4096));
    `),
      { maxOutputBytes: 1024 },
    )).rejects.toThrow("exceeded 1024 output bytes");
  });
}

Deno.test("discovery reports an exit code without reflecting module output", async () => {
  await expect(readDiscoveryProcess(command(`
    console.error('fixture-secret'); Deno.exit(7);
  `))).rejects.toThrow(/^Manifest discovery process exited with code 7$/);
});

async function withWorkers(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  // Within the backend tree so the production launcher's read permissions apply.
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".discovery-test-",
  });
  try {
    for (const [name, source] of Object.entries(files)) {
      await Deno.writeTextFile(join(root, name), source);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const validWorker =
  `export default {name: 'fixture', inputSchema: {type: 'object'}, outputSchema: {type: 'object'}};`;

Deno.test("production discovery reads a real manifest", async () => {
  await withWorkers({ "fixture.ts": validWorker }, async (root) => {
    const entries = await discoverCapabilities({ root, globPattern: "*.ts" });
    expect(entries.map((entry) => entry.manifest.name)).toEqual(["fixture"]);
  });
});

for (
  const [name, source, message] of [
    ["broken.ts", "throw new Error('fixture-secret')", "exited with code 1"],
    ["invalid.ts", "export default {name: 123}", "Invalid or duplicate"],
    [
      "stalled.ts",
      "await new Promise(() => setInterval(() => {}, 100));",
      "timed out",
    ],
  ] as const
) {
  Deno.test(`production discovery rejects ${name} instead of returning a partial registry`, async () => {
    await withWorkers(
      { "a-valid.ts": validWorker, [name]: source },
      async (root) => {
        await expect(
          discoverCapabilities({ root, globPattern: "*.ts", timeoutMs: 2000 }),
        )
          .rejects.toThrow(message);
      },
    );
  });
}

Deno.test("discovery rejects duplicate names; registry rejects ordinary names but permits Map method names", async () => {
  await withWorkers(
    { "first.ts": validWorker, "second.ts": validWorker },
    async (root) => {
      await expect(discoverCapabilities({ root, globPattern: "*.ts" })).rejects
        .toThrow("duplicate");
    },
  );
  const registry = new Registry();
  const entry = {
    manifest: { name: "fixture", inputSchema: {}, outputSchema: {} },
    path: new URL("file:///fixture.ts"),
  };
  registry.register(entry);
  expect(() => registry.register(entry)).toThrow("Duplicate capability");
  registry.register({ ...entry, manifest: { ...entry.manifest, name: "get" } });
  expect(registry.list().length).toBe(2);
});
