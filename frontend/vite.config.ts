import deno from "@deno/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// In Docker build, myceliasdk is copied to ./myceliasdk
// In local dev, myceliasdk is at ../myceliasdk
const interfacesPath = existsSync("../myceliasdk")
  ? "../myceliasdk/"
  : "./myceliasdk/";

// In local dev myceliasdk sits outside this package, so its bare `zod` imports
// walk up to the repo-root node_modules (zod 3) while src/ gets our zod 4.
// Two zods in one bundle break the v4-only `_zod` internals the SDK writes to,
// so pin every zod import to this package's copy.
const zodPath = fileURLToPath(new URL("./node_modules/zod", import.meta.url));
// Deno resolves npm imports with Node conditions. Explicitly select BSON's
// browser entry so the production bundle uses Web Crypto rather than node:crypto.
const bsonPath = fileURLToPath(new URL("./node_modules/bson/lib/bson.mjs", import.meta.url));
const frontendLifecycleAt = new Date().toISOString();

export default defineConfig({
  define: {
    "import.meta.env.VITE_FRONTEND_LIFECYCLE_AT": JSON.stringify(
      frontendLifecycleAt,
    ),
  },
  plugins: [
    deno(),
    react(),
    {
      name: "mycelia-readiness-log",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const host = typeof address === "object" && address
            ? address.address
            : "0.0.0.0";
          const port = typeof address === "object" && address
            ? address.port
            : server.config.server.port;
          console.info(
            `[READY] frontend ready mode=development hmr=enabled source=bind-mount url=http://${host}:${port} readyAt=${
              new Date().toISOString()
            }`,
          );
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": "./src",
      "@myceliasdk/": interfacesPath,
      "zod": zodPath,
      "bson": bsonPath,
    },
    dedupe: ["zod", "bson"],
  },
  server: {
    watch: {
      // Use polling for Docker volumes (native fs events don't work reliably)
      usePolling: true,
      interval: 1000,
    },
    hmr: {
      // Ensure HMR works through Docker port mapping
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "esnext",
  },
});
