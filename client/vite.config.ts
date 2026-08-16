import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The Go server's default port. Both are off the obvious numbers because this
// machine already has a native Postgres on 5432 and something on 8080.
const API = "http://localhost:8081";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
