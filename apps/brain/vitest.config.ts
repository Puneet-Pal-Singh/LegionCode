import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@repo/hook-protocol": path.resolve(
        __dirname,
        "../../packages/hook-protocol/src/index.ts",
      ),
      "@repo/shared-types": path.resolve(
        __dirname,
        "../../packages/shared-types/src/index.ts",
      ),
      "@shadowbox/execution-engine/runtime": path.resolve(
        __dirname,
        "../../packages/execution-engine/src/runtime/index.ts",
      ),
      "@shadowbox/execution-engine/runtime/": path.resolve(
        __dirname,
        "../../packages/execution-engine/src/runtime/",
      ),
      "@shadowbox/execution-engine/runtime/agents": path.resolve(
        __dirname,
        "../../packages/execution-engine/src/runtime/agents/index.ts",
      ),
      "@shadowbox/execution-engine/runtime/engine": path.resolve(
        __dirname,
        "../../packages/execution-engine/src/runtime/engine/index.ts",
      ),
      "@shadowbox/execution-engine/runtime/run": path.resolve(
        __dirname,
        "../../packages/execution-engine/src/runtime/run/index.ts",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
