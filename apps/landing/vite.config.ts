// apps/landing/vite.config.ts
//
// Dev port contract:
//   - Landing dev server: 5173 (this file)
//   - Web dev server: 5174 (see apps/web/package.json `dev` script
//     and apps/web/vite.config.ts `server.port`)
//
// The landing app serves the public marketing surface at / and
// proxies /agents/* to the web app's dev server on 5174 so a single
// origin (`localhost:5173`) serves both surfaces in dev. This
// mirrors the production dispatch in
// apps/landing/functions/agents/[[path]].ts which forwards /agents/*
// to agents.legioncode.dev.
//
// If you change WEB_DEV_PORT here, update apps/web/package.json
// `dev` and apps/web/vite.config.ts `server.port` to match.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const WEB_DEV_PORT = 5174;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/agents": {
        target: `http://localhost:${WEB_DEV_PORT}`,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/agents/, "") || "/",
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
