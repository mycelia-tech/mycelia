import { fileURLToPath } from "node:url";
import deno from "@deno/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [deno(), react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": "./src",
      // The deno plugin can resolve `zod` inside ../myceliasdk to a stale
      // zod@3 copy from the .deno store; production uses zod@4 (`_zod`
      // internals). Pin tests to the same copy.
      zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
    },
  },
});
