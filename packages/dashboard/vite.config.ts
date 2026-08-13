import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * The dashboard is served by the Hono control plane at /dashboard, not from the web root, so
 * `base` must match or every asset URL 404s once it is built. In dev, the proxy sends API and
 * auth calls to the real control plane so `bun run dev` works against live oris.
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/desktop": "http://localhost:8787",
    },
  },
});
