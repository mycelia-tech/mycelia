import { expandGlob } from "@std/fs";
import { toFileUrl } from "@std/path";
import { z } from "zod";
import { readDiscoveryProcess } from "./discovery-process.ts";

export const zTriggerSource = z.object({
  channel: z.string(),
  name: z.string(),
  filter: z.record(z.string(), z.any()).optional(),
});

export type TriggerSource = z.infer<typeof zTriggerSource>;

export const zTriggers = z.object({
  sources: z.array(zTriggerSource),
  debounceMs: z.number().optional(),
  interval: z.number().optional(),
});

export type Triggers = z.infer<typeof zTriggers>;

export const zCapabilityManifest = z.object({
  name: z.string(),
  inputSchema: z.any(),
  outputSchema: z.any(),
  policies: z.array(z.any()).optional(),
  maxConcurrency: z.number().optional(),
  triggers: zTriggers.optional(),
  /** Extra `host:port` entries appended to the job subprocess --allow-net. */
  allowedHosts: z.array(z.string()).optional(),
});

export type CapabilityManifest = z.infer<typeof zCapabilityManifest>;

export type RegistryEntry = {
  manifest: CapabilityManifest;
  path: URL;
};

export class Registry<T extends RegistryEntry = RegistryEntry> {
  private readonly entries = new Map<string, T>();

  list(): T[] {
    return [...this.entries.values()];
  }

  get(name: string): T | undefined {
    return this.entries.get(name);
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  register(capability: T): void {
    if (this.entries.has(capability.manifest.name)) {
      throw new Error(`Duplicate capability: ${capability.manifest.name}`);
    }
    this.entries.set(capability.manifest.name, capability);
  }
}

export async function discoverCapabilities<Input, Output>(
  options: {
    globPattern: string;
    root: string;
    exclude?: string[];
    timeoutMs?: number;
  },
): Promise<
  RegistryEntry[]
> {
  const discovered: RegistryEntry[] = [];

  for await (
    const file of expandGlob(options.globPattern, {
      root: options.root,
      includeDirs: false,
      exclude: options.exclude,
    })
  ) {
    const capabilityModule = toFileUrl(file.path);
    const started = performance.now();
    console.log(`[worker-discovery] Inspecting ${file.name}`);

    const sdkPath = Deno.cwd();
    const launcherPath = `${sdkPath}/app/utils/capabilityLauncher.ts`;

    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-E",
        "--config",
        `${sdkPath}/deno.json`,
        `--allow-read=${sdkPath}`,
        `--allow-read=${sdkPath}/../myceliasdk`,
        launcherPath,
      ],
      env: {
        MYCELIA_CAPABILITY_PATH: capabilityModule.toString(),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

    let stdoutContent: string;
    try {
      stdoutContent = await readDiscoveryProcess(cmd, {
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      throw new Error(
        `Could not discover ${file.name}: ${
          error instanceof Error ? error.message : "child process failed"
        }`,
      );
    }

    // Find the last line of output which should be the JSON result
    const lines = stdoutContent.trim().split("\n");
    const lastLine = lines[lines.length - 1];

    try {
      const resp = JSON.parse(lastLine);
      const manifest = zCapabilityManifest.parse(resp);

      // Ensure we have schemas before attempting to use them
      if (manifest.inputSchema) {
        z.fromJSONSchema(manifest.inputSchema);
      }
      if (manifest.outputSchema) {
        z.fromJSONSchema(manifest.outputSchema);
      }

      if (discovered.some((entry) => entry.manifest.name === manifest.name)) {
        throw new Error("Duplicate manifest name");
      }
      discovered.push({ manifest, path: capabilityModule });
      console.log(
        `[worker-discovery] Inspected ${file.name} in ${
          Math.round(performance.now() - started)
        } ms`,
      );
    } catch {
      throw new Error(
        `Invalid or duplicate capability manifest from ${file.name}`,
      );
    }
  }

  return discovered;
}
