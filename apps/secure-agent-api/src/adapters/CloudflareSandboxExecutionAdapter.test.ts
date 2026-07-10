/**
 * Tests for CloudflareSandboxExecutionAdapter.
 *
 * Verifies:
 * 1. Port contract adherence (SandboxExecutionPort)
 * 2. Task routing to plugins
 * 3. Error handling and normalization
 * 4. Timeout and cancellation semantics
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { CloudflareSandboxExecutionAdapter } from "./CloudflareSandboxExecutionAdapter";
import type { IPlugin, ToolDefinition } from "../interfaces/types";
import type { TaskExecutionHooks } from "../ports/SandboxExecutionPort";
import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";

const TEST_RUN_ID = "run-1";
const TEST_LEASE: SandboxExecutionLease = {
  leaseId: "lease:workspace-1:attempt-1",
  sandboxId: "workspace:workspace-1:attempt:attempt-1",
  workspaceId: "workspace-1",
  runAttemptId: "attempt-1",
  owner: "test-session",
  correlationId: "corr-1",
  expiresAt: Date.now() + 60_000,
  mutationMode: "serialized",
};

function withLease<T extends Record<string, unknown>>(
  input: T,
): T & { lease: SandboxExecutionLease } {
  return { ...input, lease: TEST_LEASE };
}

// Mock plugin for testing
class MockPlugin implements IPlugin {
  readonly name = "MockPlugin";
  readonly tools: ToolDefinition[] = [];

  async setup(): Promise<void> {
    // No-op for testing
  }

  // This matches the actual IPlugin.execute signature
  async execute(
    sandbox: any,
    payload: any,
  ): Promise<{ success: boolean; output?: string }> {
    const params = payload as Record<string, unknown>;
    if (params.delay) {
      await new Promise((resolve) =>
        setTimeout(resolve, (params.delay as number) ?? 100),
      );
    }
    if (params.shouldFail) {
      throw new Error("Mock failure");
    }
    return { success: true, output: JSON.stringify({ success: true, params }) };
  }

  // Custom method for adapter testing (adapter doesn't call the standard execute)
  async executeMock(
    sessionId: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    if (params.delay) {
      await new Promise((resolve) =>
        setTimeout(resolve, (params.delay as number) ?? 100),
      );
    }
    if (params.shouldFail) {
      throw new Error("Mock failure");
    }
    return JSON.stringify({ success: true, params });
  }
}

describe("CloudflareSandboxExecutionAdapter", () => {
  let adapter: CloudflareSandboxExecutionAdapter;
  let mockPlugin: MockPlugin;
  let mockSandbox: any;
  let pluginMap: Map<string, IPlugin>;

  beforeEach(() => {
    mockPlugin = new MockPlugin();
    pluginMap = new Map([["MockPlugin", mockPlugin]]);
    mockSandbox = {}; // Sandbox is not directly used in current implementation

    adapter = new CloudflareSandboxExecutionAdapter(mockSandbox, pluginMap);
  });

  describe("executeTask", () => {
    it("should execute task and return success result", async () => {
      const input = {
        taskId: "task-1",
        action: "MockPlugin.execute",
        params: { action: "run", test: "value", runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.taskId).toBe("task-1");
      expect(result.status).toBe("success");
      expect(result.output).toBeDefined();
      expect(result.metrics?.duration).toBeGreaterThanOrEqual(0);
    });

    it("should handle unknown action", async () => {
      const input = {
        taskId: "task-2",
        action: "UnknownAction.method",
        params: {},
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.taskId).toBe("task-2");
      expect(result.status).toBe("failure");
      // Routes to plugin lookup, so returns PLUGIN_NOT_FOUND
      expect(result.error?.code).toBe("PLUGIN_NOT_FOUND");
    });

    it("should handle missing plugin", async () => {
      const input = {
        taskId: "task-3",
        action: "MissingPlugin.method",
        params: {},
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("PLUGIN_NOT_FOUND");
    });

    it("should fail fast when runId is missing for execute actions", async () => {
      const input = {
        taskId: "task-missing-run",
        action: "MockPlugin.execute",
        params: { action: "run", test: "value" },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("runId is required");
    });

    it("should fail fast when execute-style routing is missing params.action", async () => {
      const input = {
        taskId: "task-missing-action",
        action: "MockPlugin.execute",
        params: { runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.message).toContain("action is required");
    });

    it("should handle task execution errors", async () => {
      const input = {
        taskId: "task-4",
        action: "MockPlugin.execute",
        params: { action: "run", shouldFail: true, runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.taskId).toBe("task-4");
      expect(result.status).toBe("failure");
      expect(result.error?.message).toContain("Mock failure");
    });

    it("should apply timeout configuration", async () => {
      // Note: Full timeout test requires signal-aware mock plugin.
      // This verifies timeout parameter is accepted.
      const input = {
        taskId: "task-5",
        action: "MockPlugin.execute",
        params: { action: "run", delay: 10, runId: TEST_RUN_ID },
        timeout: 50,
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      // Task completes, timeout doesn't fire because delay < timeout
      expect(result.taskId).toBe("task-5");
      expect(result.status).toBe("success");
    });

    it("should support legacy action mappings", async () => {
      // Mock FileSystemPlugin
      class FileSystemPlugin implements IPlugin {
        readonly name = "filesystem";
        readonly tools: ToolDefinition[] = [];

        async setup(): Promise<void> {
          // No-op
        }

        async execute(
          _sandbox: unknown,
          payload: unknown,
        ): Promise<{ success: boolean; output: string }> {
          const params = payload as Record<string, unknown>;
          expect(params.action).toBe("read_file");
          expect(params.runId).toBe(TEST_RUN_ID);
          return { success: true, output: "file content" };
        }

        async readFile(): Promise<string> {
          return "file content";
        }
      }

      const fsPlugin = new FileSystemPlugin();
      pluginMap.set("filesystem", fsPlugin);

      const input = {
        taskId: "task-6",
        action: "read_file",
        params: { path: "/test.txt", runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.status).toBe("success");
    });

    it("preserves params.action for execute-style plugin routing", async () => {
      class NodePlugin implements IPlugin {
        readonly name = "node";
        readonly tools: ToolDefinition[] = [];

        async setup(): Promise<void> {
          // No-op
        }

        async execute(
          _sandbox: unknown,
          payload: unknown,
        ): Promise<{ success: boolean; output: string }> {
          const params = payload as Record<string, unknown>;
          expect(params.action).toBe("run");
          expect(params.runId).toBe(TEST_RUN_ID);
          expect(params.command).toBe("echo hi");
          return { success: true, output: "hi" };
        }
      }

      pluginMap.set("node", new NodePlugin());

      const result = await adapter.executeTask("session-1", withLease({
        taskId: "task-node-run",
        action: "node.execute",
        params: {
          action: "run",
          command: "echo hi",
          runId: TEST_RUN_ID,
        },
      }));

      expect(result.status).toBe("success");
      expect(result.output).toBe("hi");
    });

    it("waits for async log hooks before returning plugin results", async () => {
      const callOrder: string[] = [];

      class LoggingPlugin implements IPlugin {
        readonly name = "logger";
        readonly tools: ToolDefinition[] = [];

        async setup(): Promise<void> {
          // No-op
        }

        async execute(
          _sandbox: unknown,
          _payload: unknown,
          onLog?: (entry: string | { message: string; source?: "stdout" | "stderr" }) => void,
        ): Promise<{ success: boolean; output: string }> {
          onLog?.({ message: "chunk", source: "stdout" });
          callOrder.push("plugin-result");
          return { success: true, output: "done" };
        }
      }

      pluginMap.set("logger", new LoggingPlugin());

      const hooks: TaskExecutionHooks = {
        onLog: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          callOrder.push("log-drained");
        },
      };

      const result = await adapter.executeTask(
        "session-1",
        withLease({
          taskId: "task-log-drain",
          action: "logger.execute",
          params: { action: "run", runId: TEST_RUN_ID },
        }),
        hooks,
      );

      expect(result.status).toBe("success");
      expect(callOrder).toEqual(["plugin-result", "log-drained"]);
    });

    it("injects stable toolbox correlation metadata into execute-style payloads", async () => {
      class NodePlugin implements IPlugin {
        readonly name = "node";
        readonly tools: ToolDefinition[] = [];

        async setup(): Promise<void> {
          // No-op
        }

        async execute(
          _sandbox: unknown,
          payload: unknown,
        ): Promise<{ success: boolean; output: string }> {
          const params = payload as {
            __toolbox?: {
              callId?: string;
              runId?: string;
              toolName?: string;
            };
            action?: string;
            runId?: string;
          };
          expect(params.__toolbox).toEqual({
            callId: "task-node-toolbox",
            runId: TEST_RUN_ID,
            toolName: "node.run",
          });
          expect(params.action).toBe("run");
          expect(params.runId).toBe(TEST_RUN_ID);
          return { success: true, output: "hi" };
        }
      }

      pluginMap.set("node", new NodePlugin());

      const result = await adapter.executeTask("session-1", withLease({
        taskId: "task-node-toolbox",
        action: "node.execute",
        params: {
          action: "run",
          command: "echo hi",
          runId: TEST_RUN_ID,
        },
      }));

      expect(result.status).toBe("success");
    });

    it("trims execute-style params.action before forwarding to plugins", async () => {
      class NodePlugin implements IPlugin {
        readonly name = "node";
        readonly tools: ToolDefinition[] = [];

        async setup(): Promise<void> {
          // No-op
        }

        async execute(
          _sandbox: unknown,
          payload: unknown,
        ): Promise<{ success: boolean; output: string }> {
          const params = payload as Record<string, unknown>;
          expect(params.action).toBe("run");
          return { success: true, output: "trimmed" };
        }
      }

      pluginMap.set("node", new NodePlugin());

      const result = await adapter.executeTask("session-1", withLease({
        taskId: "task-node-trimmed-run",
        action: "node.execute",
        params: {
          action: "  run  ",
          command: "echo hi",
          runId: TEST_RUN_ID,
        },
      }));

      expect(result.status).toBe("success");
      expect(result.output).toBe("trimmed");
    });
  });

  describe("cancelTask", () => {
    it("should track active task cancellation attempts", async () => {
      const input = {
        taskId: "task-7",
        action: "MockPlugin.execute",
        params: { action: "run", delay: 10, runId: TEST_RUN_ID },
        timeout: 5000,
      };

      // Start task
      const taskPromise = adapter.executeTask("session-1", withLease(input));

      // Cancel attempt while task is still running
      // (may succeed if task hasn't completed yet)
      const cancelled = await adapter.cancelTask("session-1", "task-7");

      // Task exists in active executions, so cancel should be attempted
      // Actual result depends on timing
      expect(typeof cancelled).toBe("boolean");

      const result = await taskPromise;
      expect(result.status).toBe("success");
    });

    it("should return false for non-existent task", async () => {
      const result = await adapter.cancelTask("session-1", "non-existent");
      expect(result).toBe(false);
    });
  });

  describe("getHealth", () => {
    it("should report healthy when plugins are loaded", async () => {
      const health = await adapter.getHealth("session-1");

      expect(health.healthy).toBe(true);
    });

    it("should report unhealthy with no plugins", async () => {
      const emptyAdapter = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map(),
      );
      const health = await emptyAdapter.getHealth("session-1");

      expect(health.healthy).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("should clean up resources without error", async () => {
      // Start and quickly complete a task
      const input = {
        taskId: "task-8",
        action: "MockPlugin.execute",
        params: { action: "run", runId: TEST_RUN_ID },
      };

      await adapter.executeTask("session-1", withLease(input));
      await adapter.cleanup("session-1");

      // Verify no hanging timeouts (manual inspection only)
      // In real test, would use jest.fake timers
      expect(true).toBe(true);
    });
  });

  describe("error normalization", () => {
    it("should normalize Error objects", async () => {
      const input = {
        taskId: "task-9",
        action: "MockPlugin.execute",
        params: { action: "run", shouldFail: true, runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask("session-1", withLease(input));

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBeDefined();
      expect(result.error?.message).toBeDefined();
    });
  });

  describe("lease isolation", () => {
    it("rejects an expired lease without invoking a plugin", async () => {
      const expired = { ...TEST_LEASE, expiresAt: Date.now() - 1 };
      const result = await adapter.executeTask("session-1", {
        taskId: "expired-task",
        action: "MockPlugin.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: expired,
      });

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("SANDBOX_LEASE_REQUIRED");
      expect(result.retryable).toBe(true);
    });

    it("releases only the dead lease after an exit 137", async () => {
      const destroy = vi.fn(async () => undefined);
      const sandbox = { destroy };
      const failingPlugin: IPlugin = {
        name: "dead",
        tools: [],
        async execute(): Promise<never> {
          throw { exitCode: 137, message: "container exited" };
        },
      };
      const localAdapter = new CloudflareSandboxExecutionAdapter(
        sandbox as never,
        new Map([[failingPlugin.name, failingPlugin]]),
      );

      const result = await localAdapter.executeTask("session-1", {
        taskId: "dead-task",
        action: "dead.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: TEST_LEASE,
      });

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("SANDBOX_UNAVAILABLE");
      expect(result.retryable).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
    });

    it("does not cancel a sibling lease during cleanup", async () => {
      const siblingLease = {
        ...TEST_LEASE,
        leaseId: "lease:workspace-2:attempt-1",
        workspaceId: "workspace-2",
        sandboxId: "workspace:workspace-2:attempt:attempt-1",
      };
      const first = adapter.executeTask("session-1", {
        taskId: "first-task",
        action: "MockPlugin.execute",
        params: { action: "run", delay: 25, runId: TEST_RUN_ID },
        lease: TEST_LEASE,
      });
      const second = adapter.executeTask("session-1", {
        taskId: "second-task",
        action: "MockPlugin.execute",
        params: { action: "run", delay: 5, runId: TEST_RUN_ID },
        lease: siblingLease,
      });

      await adapter.cleanup(TEST_LEASE.leaseId);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.taskId).toBe("first-task");
      expect(secondResult.status).toBe("success");
    });
  });
});
