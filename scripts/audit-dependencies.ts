/** Online inventory audit: sends only package names/versions, never source or secrets. */
import {
  type AuditedPackage as Package,
  denoNpmPackage,
} from "./dependency-inventory.ts";
const packages = new Map<string, Package>();
function add(pkg: Package) {
  packages.set(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`, pkg);
}
for (
  const file of [
    "backend/deno.lock",
    "frontend/deno.lock",
    "myceliasdk/deno.lock",
  ]
) {
  const lock = JSON.parse(await Deno.readTextFile(file));
  for (const specifier of Object.keys(lock.npm ?? {})) {
    add(denoNpmPackage(specifier));
  }
}
for (const file of ["python/uv.lock", "rag/uv.lock", "diarizator/uv.lock"]) {
  const lock = await Deno.readTextFile(file);
  for (const block of lock.split("[[package]]").slice(1)) {
    if (!/source\s*=\s*\{\s*registry\s*=/.test(block)) continue;
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (name && version) add({ name, version, ecosystem: "PyPI" });
  }
}
const inventory = [...packages.values()];
const findings: { package: Package; advisories: string[] }[] = [];
try {
  for (let start = 0; start < inventory.length; start += 250) {
    const batch = inventory.slice(start, start + 250);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: batch.map(({ name, version, ecosystem }) => ({
          package: { name, ecosystem },
          version,
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Advisory service unavailable");
    const data = await response.json();
    if (!Array.isArray(data.results) || data.results.length !== batch.length) {
      throw new Error("Invalid advisory response");
    }
    data.results.forEach(
      (result: { vulns?: { id: string }[] }, index: number) => {
        if (result.vulns?.length) {
          findings.push({
            package: batch[index],
            advisories: result.vulns.map((v) => v.id),
          });
        }
      },
    );
  }
  console.log(
    JSON.stringify({ checkedPackages: inventory.length, findings }, null, 2),
  );
  if (findings.length) Deno.exitCode = 1;
} catch {
  console.error(
    "Dependency audit incomplete: the advisory service could not be queried. No clean result is asserted.",
  );
  Deno.exitCode = 2;
}
