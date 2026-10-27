import { dirname, resolve } from "node:path";

const errors: string[] = [];
const decoder = new TextDecoder();
const git = await new Deno.Command("git", {
  args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  stdout: "piped",
}).output();
if (!git.success) throw new Error("Cannot list tracked files");
const files = decoder.decode(git.stdout).split("\0").filter(Boolean);
for (const directory of ["backend", "frontend"]) {
  const pkg = JSON.parse(await Deno.readTextFile(`${directory}/package.json`));
  const deno = JSON.parse(await Deno.readTextFile(`${directory}/deno.json`));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, value] of Object.entries(deno.imports ?? {})) {
    if (
      typeof value === "string" && value.startsWith("npm:") &&
      name in dependencies && value !== `npm:${name}@${dependencies[name]}`
    ) {
      errors.push(
        `${directory}: dependency ${name} differs between package.json and deno.json`,
      );
    }
  }
}
for (const file of files) {
  if (!file.endsWith(".md") || file.startsWith("docs/archive/")) continue;
  let source: string;
  try {
    source = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  if (source.includes("<!-- historical-plan -->")) continue;
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0].split(' "')[0].replace(/^<|>$/g, "");
    if (!target || /^[a-z]+:|^[/$\{]/i.test(target)) continue;
    try {
      await Deno.stat(resolve(dirname(file), decodeURIComponent(target)));
    } catch {
      errors.push(`${file}: broken relative link ${target}`);
    }
  }
}
// Scan non-ignored source text, including new work before staging. Never print
// matched values, including in CI logs; operator dotenv/key files stay ignored.
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
for (const file of files) {
  if (
    /\.(?:lock|wav|aiff|png|jpg|webp|svg|pdf)$/.test(file) ||
    /(?:test|fixtures?)[/.]/.test(file)
  ) continue;
  let source: string;
  try {
    source = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    errors.push(`${file}: possible secret; inspect locally (value redacted)`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  Deno.exitCode = 1;
} else {console.log(
    "Repository dependency declarations, documentation links and tracked-secret checks passed.",
  );}
