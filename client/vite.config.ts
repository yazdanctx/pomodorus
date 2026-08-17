import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

import { manifestJSON } from "./src/manifest";

// The Go server's default port. Both are off the obvious numbers because this
// machine already has a native Postgres on 5432 and something on 8080.
const API = "http://localhost:8081";

const MANIFEST = "/manifest.webmanifest";

const WORKER = "/sw.js";

/**
 * Serves the manifest in dev and writes it into the build.
 *
 * It is generated rather than kept in `public/` because it is made of copy —
 * the app's name and description — and copy lives in copy.json. A static file
 * would be a second place for those two strings to drift.
 */
function webManifest(): Plugin {
  return {
    name: "pomodorus:web-manifest",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== MANIFEST) return next();
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(manifestJSON);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST.slice(1),
        source: manifestJSON,
      });
    },
  };
}

/**
 * Bundles the service worker to `/sw.js`, in dev and in the build.
 *
 * Its own bundle rather than a second Rollup entry, for two reasons. A worker
 * is registered from the root so that its scope is the whole origin, which
 * means one file at one unhashed path — not something Vite's asset pipeline
 * wants to produce. And it has to be a classic script: module workers are
 * still not everywhere, and the one thing this worker exists for is reaching
 * the browsers that are hardest to reach.
 *
 * esbuild rather than a hand-written copy in `public/`, because the worker
 * imports copy.json. The words in a notification are the same words the in-tab
 * one uses, and a second copy of them in a static file is a second place for
 * them to drift.
 */
function serviceWorker(): Plugin {
  const bundle = async () => {
    const built = await build({
      entryPoints: ["src/sw.ts"],
      bundle: true,
      // A classic script, so `navigator.serviceWorker.register` needs no
      // `{ type: "module" }` and every browser can run it.
      format: "iife",
      target: "es2022",
      minify: true,
      write: false,
    });
    return built.outputFiles[0]?.text ?? "";
  };

  return {
    name: "pomodorus:service-worker",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== WORKER) return next();
        // Rebuilt per request rather than watched: it is one small file, and
        // a worker that is stale in dev is an afternoon nobody gets back.
        bundle().then(
          (source) => {
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(source);
          },
          (error: unknown) => next(error),
        );
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: WORKER.slice(1),
        source: await bundle(),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), webManifest(), serviceWorker()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 5173 is taken on this machine.
    port: 5174,
    strictPort: true,
    // Proxying rather than pointing the client at another origin: the session
    // is an httpOnly cookie, and keeping the browser on one origin in dev
    // means cookies and the WebSocket upgrade behave exactly as they will in
    // production, where the Go binary serves the client itself.
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/ws": { target: API, ws: true, changeOrigin: true },
    },
  },
  test: {
    // Component tests render a route and read what is on screen; the seam is
    // at `fetch` and the WebSocket, never at a component's internals.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
  build: {
    // Straight into the Go binary's embed directory, so `make build` produces
    // one deployable artifact with no copy step to forget.
    outDir: "../server/internal/web/dist",
    emptyOutDir: true,
  },
});
