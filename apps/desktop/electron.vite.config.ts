import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@legioncode/app-server",
          "@repo/platform-client-sdk",
          "@repo/platform-protocol",
          "zod",
        ],
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
        exclude: ["@repo/platform-protocol", "zod"],
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
    plugins: [react()],
  },
});
