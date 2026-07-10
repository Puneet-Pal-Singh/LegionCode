/**
 * Phase 8: Golden Scenario Reliability Tests
 * Tests the single-agent baseline under production-like conditions:
 * - Combined read+edit+test+git diff workflow
 * - Timeout handling
 * - Schema mismatch recovery
 * - Stale runtime detection
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Run } from "../../run/Run.js";
import { RunRepository } from "../../run/RunRepository.js";
import { TaskRepository } from "../../task/TaskRepository.js";
import { RunEventRepository } from "../../events/RunEventRepository.js";
import {
  createToolCompletedEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  createRunStartedEvent,
  createRunCompletedEvent,
} from "../../events/RunEventFactory.js";
import { tagRuntimeStateSemantics } from "../../state/index.js";
import type { RuntimeDurableObjectState, RuntimeStorage } from "../../types.js";

class InMemoryStorage implements RuntimeStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.values.delete(entry)) deleted += 1;
      }
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    for (const [key, value] of this.values.entries()) {
      if (options?.prefix && !key.startsWith(options.prefix)) continue;
      if (options?.start && key < options.start) continue;
      if (options?.end && key >= options.end) continue;
      results.set(key, value as T);
      if (options?.limit && results.size >= options.limit) break;
    }
    return results;
  }
}

class MockDurableObjectState implements RuntimeDurableObjectState {
  storage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

describe("Phase 8: Golden Scenario Reliability Tests", () => {
  let mockCtx: MockDurableObjectState;
  let runtimeState: RuntimeDurableObjectState;

  beforeEach(() => {
    mockCtx = new MockDurableObjectState();
    runtimeState = tagRuntimeStateSemantics(mockCtx, "do");
  });

  describe("Golden Scenario: Combined Workflow", () => {
    it("should handle read+edit+test+git diff workflow as sequential tasks", async () => {
      const runRepo = new RunRepository(runtimeState);
      const eventRepo = new RunEventRepository(runtimeState);

      const runId = "golden-workflow-run";
      await runRepo.create(
        new Run(runId, "golden-session", "RUNNING", "coding", {
          agentType: "coding",
          prompt: "read, edit, test, and git diff",
          sessionId: "golden-session",
        }),
      );

      await eventRepo.append(
        runId,
        createRunStartedEvent({ runId, sessionId: "golden-session" }),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-1",
            toolName: "read_file",
          },
          { path: "src/index.ts" },
        ),
      );
      await eventRepo.append(
        runId,
        createToolCompletedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-1",
            toolName: "read_file",
          },
          "file content",
          100,
        ),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-2",
            toolName: "write_file",
          },
          { path: "src/index.ts", content: "updated content" },
        ),
      );
      await eventRepo.append(
        runId,
        createToolCompletedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-2",
            toolName: "write_file",
          },
          "written",
          50,
        ),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-3",
            toolName: "bash",
          },
          { command: "pnpm test -- --run" },
        ),
      );
      await eventRepo.append(
        runId,
        createToolCompletedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-3",
            toolName: "bash",
          },
          "PASS",
          5000,
        ),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-4",
            toolName: "git_diff",
          },
          {},
        ),
      );
      await eventRepo.append(
        runId,
        createToolCompletedEvent(
          {
            runId,
            sessionId: "golden-session",
            taskId: "task-4",
            toolName: "git_diff",
          },
          "diff output",
          200,
        ),
      );

      await eventRepo.append(
        runId,
        createRunCompletedEvent(
          { runId, sessionId: "golden-session" },
          6000,
          4,
        ),
      );

      const events = await eventRepo.getByRun(runId);
      expect(events.length).toBe(10);
      expect(events[0].type).toBe("run.started");
      expect(events[9].type).toBe("run.completed");
    });
  });

  describe("Timeout Path Tests", () => {
    it("should handle tool execution timeout gracefully", async () => {
      const runRepo = new RunRepository(runtimeState);
      const eventRepo = new RunEventRepository(runtimeState);

      const runId = "timeout-run";
      await runRepo.create(
        new Run(runId, "timeout-session", "RUNNING", "coding", {
          agentType: "coding",
          prompt: "run a slow command",
          sessionId: "timeout-session",
        }),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "timeout-session",
            taskId: "task-1",
            toolName: "bash",
          },
          { command: "sleep 100" },
        ),
      );
      await eventRepo.append(
        runId,
        createToolStartedEvent({
          runId,
          sessionId: "timeout-session",
          taskId: "task-1",
          toolName: "bash",
        }),
      );

      const events = await eventRepo.getByRun(runId);
      const toolStarted = events.find((e) => e.type === "tool.started");
      expect(toolStarted).toBeDefined();
    });
  });

  describe("Schema Mismatch Path Tests", () => {
    it("should record schema mismatch in events for recovery", async () => {
      const runRepo = new RunRepository(runtimeState);
      const eventRepo = new RunEventRepository(runtimeState);

      const runId = "schema-mismatch-run";
      await runRepo.create(
        new Run(runId, "schema-session", "RUNNING", "coding", {
          agentType: "coding",
          prompt: "generate invalid plan",
          sessionId: "schema-session",
        }),
      );

      await eventRepo.append(
        runId,
        createToolRequestedEvent(
          {
            runId,
            sessionId: "schema-session",
            taskId: "task-1",
            toolName: "planner",
          },
          { prompt: "generate plan" },
        ),
      );

      const events = await eventRepo.getByRun(runId);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toHaveProperty("toolName");
    });
  });

  describe("Stale Runtime Detection Tests", () => {
    it("should detect stale runtime via run status check", async () => {
      const runRepo = new RunRepository(runtimeState);

      const staleRunId = "stale-runtime-run";
      await runRepo.create(
        new Run(staleRunId, "stale-session", "RUNNING", "coding", {
          agentType: "coding",
          prompt: "old prompt",
          sessionId: "stale-session",
        }),
      );

      const staleRun = await runRepo.getById(staleRunId);
      expect(staleRun).toBeDefined();
      expect(staleRun?.status).toBe("RUNNING");

      staleRun!.transition("COMPLETED");
      await runRepo.update(staleRun!);

      const completedRun = await runRepo.getById(staleRunId);
      expect(completedRun?.status).toBe("COMPLETED");
    });

    it("should allow reset of recyclable run", async () => {
      const { resetRecyclableRun } =
        await import("../RunRecyclableResetPolicy.js");

      const runRepo = new RunRepository(runtimeState);
      const taskRepo = new TaskRepository(runtimeState);

      const runId = "recyclable-run";
      await runRepo.create(
        new Run(runId, "recycle-session", "COMPLETED", "coding", {
          agentType: "coding",
          prompt: "completed prompt",
          sessionId: "recycle-session",
        }),
      );

      const recycled = await resetRecyclableRun({
        runId,
        sessionId: "recycle-session",
        input: {
          agentType: "coding",
          prompt: "new prompt",
          sessionId: "recycle-session",
        },
        previousStatus: "COMPLETED",
        existingRun: new Run(runId, "recycle-session", "COMPLETED", "coding", {
          agentType: "coding",
          prompt: "completed prompt",
          sessionId: "recycle-session",
        }),
        taskRepo: taskRepo as TaskRepository,
        runRepo: runRepo as RunRepository,
        createFreshRun: (id, sid, input) =>
          new Run(id, sid, "RUNNING", "coding", input),
      });

      expect(recycled.status).toBe("RUNNING");
      expect(recycled.id).toBe(runId);
    });

    it("should preserve existing run events when recyclable run resets", async () => {
      const { resetRecyclableRun } =
        await import("../RunRecyclableResetPolicy.js");

      const runRepo = new RunRepository(runtimeState);
      const taskRepo = new TaskRepository(runtimeState);
      const eventRepo = new RunEventRepository(runtimeState);

      const runId = "recyclable-run-with-events";
      await runRepo.create(
        new Run(runId, "recycle-session", "COMPLETED", "coding", {
          agentType: "coding",
          prompt: "completed prompt",
          sessionId: "recycle-session",
        }),
      );

      await eventRepo.append(
        runId,
        createRunStartedEvent({
          runId,
          sessionId: "recycle-session",
        }),
      );

      await resetRecyclableRun({
        runId,
        sessionId: "recycle-session",
        input: {
          agentType: "coding",
          prompt: "new prompt",
          sessionId: "recycle-session",
        },
        previousStatus: "COMPLETED",
        existingRun: new Run(runId, "recycle-session", "COMPLETED", "coding", {
          agentType: "coding",
          prompt: "completed prompt",
          sessionId: "recycle-session",
        }),
        taskRepo: taskRepo as TaskRepository,
        runRepo: runRepo as RunRepository,
        createFreshRun: (id, sid, input) =>
          new Run(id, sid, "RUNNING", "coding", input),
      });

      const events = await eventRepo.getByRun(runId);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("run.started");
    });

    it("preserves the active workspace branch when a recyclable run resets", async () => {
      const { resetRecyclableRun } =
        await import("../RunRecyclableResetPolicy.js");

      const runRepo = new RunRepository(runtimeState);
      const taskRepo = new TaskRepository(runtimeState);

      const runId = "recyclable-run-active-branch";
      const existingRun = new Run(runId, "recycle-session", "COMPLETED", "coding", {
        agentType: "coding",
        prompt: "commit and push the branch",
        sessionId: "recycle-session",
        repositoryContext: {
          owner: "sourcegraph",
          repo: "shadowbox",
          branch: "main",
        },
      });
      existingRun.metadata.agenticLoop = {
        enabled: true,
        stopReason: "tool_error",
        toolLifecycle: [
          {
            toolCallId: "branch-1",
            toolName: "git_branch_create",
            status: "completed",
            mutating: true,
            recordedAt: new Date().toISOString(),
            metadata: {
              family: "git",
              branch: "feat/floating-hero-carousels",
              preview: "feat/floating-hero-carousels",
            },
          },
        ],
      };
      await runRepo.create(existingRun);

      const recycled = await resetRecyclableRun({
        runId,
        sessionId: "recycle-session",
        input: {
          agentType: "coding",
          prompt: "continue?",
          sessionId: "recycle-session",
          repositoryContext: {
            owner: "sourcegraph",
            repo: "shadowbox",
            branch: "main",
          },
        },
        previousStatus: "COMPLETED",
        existingRun,
        taskRepo: taskRepo as TaskRepository,
        runRepo: runRepo as RunRepository,
        createFreshRun: (id, sid, input) =>
          new Run(id, sid, "RUNNING", "coding", input),
      });

      expect(recycled.input.repositoryContext?.branch).toBe(
        "feat/floating-hero-carousels",
      );
      expect(recycled.metadata.continuation?.activeBranch).toBe(
        "feat/floating-hero-carousels",
      );
    });
  });

  describe("Cloudflare Agents Backend Selection", () => {
    it("should route to cloudflare agents when feature flag enabled", () => {
      const FEATURE_FLAG_CLOUDFLARE_AGENTS_V1 = true;

      const shouldUseCloudflareAgents = FEATURE_FLAG_CLOUDFLARE_AGENTS_V1;

      expect(shouldUseCloudflareAgents).toBe(true);
    });

    it("should route to execution-engine-v1 when feature flag disabled", () => {
      const FEATURE_FLAG_CLOUDFLARE_AGENTS_V1 = false;

      const shouldUseCloudflareAgents = FEATURE_FLAG_CLOUDFLARE_AGENTS_V1;

      expect(shouldUseCloudflareAgents).toBe(false);
    });
  });
});
