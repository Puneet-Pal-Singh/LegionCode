// packages/execution-engine/src/runtime/planner/PlanSchema.test.ts
// Phase 2: Test structured task input preservation

import { describe, it, expect } from "vitest";
import { PlannedTaskSchema, PlanSchema, validatePlan } from "./PlanSchema.js";

describe("PlanSchema - Phase 2: Structured Input Persistence", () => {
  describe("PlannedTaskSchema", () => {
    it("should accept analyze task with structured path input", () => {
      const task = {
        id: "1",
        type: "analyze" as const,
        description: "Read README file",
        dependsOn: [],
        input: { path: "README.md" },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({ path: "README.md" });
    });

    it("should accept edit task with path and content input", () => {
      const task = {
        id: "2",
        type: "edit" as const,
        description: "Create config file",
        dependsOn: [],
        input: { path: "config.ts", content: "export const config = {};" },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({
        path: "config.ts",
        content: "export const config = {};",
      });
    });

    it("should accept test task with command input", () => {
      const task = {
        id: "3",
        type: "test" as const,
        description: "Run unit tests",
        dependsOn: [],
        input: { command: "npm test -- src/service.test.ts" },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({
        command: "npm test -- src/service.test.ts",
      });
    });

    it("should accept shell task with command input", () => {
      const task = {
        id: "4",
        type: "shell" as const,
        description: "List files",
        dependsOn: [],
        input: { command: "ls -la /workspace" },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({ command: "ls -la /workspace" });
    });

    it("should accept git task with action input", () => {
      const task = {
        id: "5",
        type: "git" as const,
        description: "Commit changes",
        dependsOn: [],
        input: { action: "git_commit", message: "feat: add feature" },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({
        action: "git_commit",
        message: "feat: add feature",
      });
    });

    it("should make input field optional for backward compatibility", () => {
      const task = {
        id: "6",
        type: "review" as const,
        description: "Review code",
        dependsOn: [],
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toBeUndefined();
    });

    it("should support arbitrary additional fields in input", () => {
      const task = {
        id: "7",
        type: "analyze" as const,
        description: "Analyze with metadata",
        dependsOn: [],
        input: {
          path: "src/index.ts",
          format: "json",
          recursive: true,
          maxDepth: 5,
        },
      };
      const result = PlannedTaskSchema.parse(task);
      expect(result.input).toEqual({
        path: "src/index.ts",
        format: "json",
        recursive: true,
        maxDepth: 5,
      });
    });

    it("should reject invalid input field type", () => {
      const task = {
        id: "8",
        type: "analyze" as const,
        description: "Invalid input",
        dependsOn: [],
        input: "not an object",
      };
      expect(() => PlannedTaskSchema.parse(task)).toThrow();
    });
  });

  describe("PlanSchema - Full Plan Validation", () => {
    it("should validate plan with structured inputs on all tasks", () => {
      const plan = {
        tasks: [
          {
            id: "1",
            type: "analyze" as const,
            description: "Analyze README",
            dependsOn: [],
            input: { path: "README.md" },
          },
          {
            id: "2",
            type: "edit" as const,
            description: "Update README",
            dependsOn: ["1"],
            input: { path: "README.md", content: "# Updated" },
          },
          {
            id: "3",
            type: "test" as const,
            description: "Run tests",
            dependsOn: ["2"],
            input: { command: "npm test" },
          },
        ],
        metadata: { estimatedSteps: 3, reasoning: "Test plan" },
      };
      const result = validatePlan(plan);
      expect(result.tasks).toHaveLength(3);
      expect(result.tasks[0].input).toEqual({ path: "README.md" });
      expect(result.tasks[1].input).toEqual({
        path: "README.md",
        content: "# Updated",
      });
      expect(result.tasks[2].input).toEqual({ command: "npm test" });
    });

    it("should validate mixed plans with and without input", () => {
      const plan = {
        tasks: [
          {
            id: "1",
            type: "analyze" as const,
            description: "With input",
            dependsOn: [],
            input: { path: "file.ts" },
          },
          {
            id: "2",
            type: "review" as const,
            description: "Without input",
            dependsOn: ["1"],
          },
        ],
        metadata: { estimatedSteps: 2 },
      };
      const result = validatePlan(plan);
      expect(result.tasks[0].input).toBeDefined();
      expect(result.tasks[1].input).toBeUndefined();
    });

    it("should preserve input through full plan lifecycle", () => {
      const originalPlan = {
        tasks: [
          {
            id: "task-1",
            type: "analyze" as const,
            description: "Check file",
            dependsOn: [],
            expectedOutput: "File contents",
            input: { path: "src/main.ts" },
          },
        ],
        metadata: { estimatedSteps: 1 },
      };
      const validated = validatePlan(originalPlan);
      expect(validated.tasks[0]).toEqual(originalPlan.tasks[0]);
      expect(validated.tasks[0].input).toEqual({ path: "src/main.ts" });
    });
  });
});
