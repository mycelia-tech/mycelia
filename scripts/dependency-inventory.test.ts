import { deepStrictEqual, throws } from "node:assert/strict";
import { denoNpmPackage } from "./dependency-inventory.ts";

Deno.test("advisory inventory removes nested Deno peers without losing scoped names", () => {
  deepStrictEqual(
    denoNpmPackage("@deno/vite-plugin@2.0.3_vite@6.4.5__yaml@2.8.2"),
    {
      name: "@deno/vite-plugin",
      version: "2.0.3",
      ecosystem: "npm",
    },
  );
  deepStrictEqual(denoNpmPackage("vite@6.4.5_jiti@2.6.1_yaml@2.8.2"), {
    name: "vite",
    version: "6.4.5",
    ecosystem: "npm",
  });
  deepStrictEqual(denoNpmPackage("@types/node@22.18.0"), {
    name: "@types/node",
    version: "22.18.0",
    ecosystem: "npm",
  });
  throws(() => denoNpmPackage("not-a-package"));
});
