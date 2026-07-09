import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    pool: "forks",
    poolMatchGlobs: [
      ["src/runtime/planner/PlanSchema.test.ts", "forks"],
      ["src/runtime/orchestration/RunRecovery.test.ts", "forks"],
      ["src/runtime/lib/ToolPresentation.test.ts", "forks"],
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "**/*.test.ts"],
    },
  },
});
