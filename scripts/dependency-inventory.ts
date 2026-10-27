export type AuditedPackage = {
  name: string;
  version: string;
  ecosystem: "npm" | "PyPI";
};

/** Deno peer suffixes contain further @ signs; they are not package names. */
export function denoNpmPackage(key: string): AuditedPackage {
  const match = /^((?:@[^/]+\/)?[^@]+)@([^_]+)(?:_|$)/.exec(key);
  if (!match || !/^\d+\.\d+\.\d+/.test(match[2])) {
    throw new Error("Invalid npm lock entry");
  }
  return { name: match[1], version: match[2], ecosystem: "npm" };
}
