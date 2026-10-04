import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@legioncode/app-server",
          "@legioncode/sdk",
          "@repo/event-store/local",
          "@repo/platform-protocol",
          "@repo/shared-types",
          "zod",
        ],
        include: ["better-sqlite3"],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          "local-app-server": "src/main/local-app-server.ts",
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@legioncode/app-server", "@repo/platform-protocol", "@repo/shared-types", "zod"],
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
  },
});
