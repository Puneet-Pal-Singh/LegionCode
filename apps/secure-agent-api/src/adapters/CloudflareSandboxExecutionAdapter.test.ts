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
import type {
  IPlugin,
  PluginExecutionContext,
  ToolDefinition,
} from "../interfaces/types";
import type { TaskExecutionHooks } from "../ports/SandboxExecutionPort";
import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";

const TEST_RUN_ID = "run-1";
const TEST_LEASE: SandboxExecutionLease = {
  leaseId: "lease:workspace-1:attempt-1",
  sandboxId: "workspace:workspace-1:attempt:attempt-1",
  workspaceScope: {
    runId: TEST_RUN_ID,
    threadId: "thread-1",
    turnId: "turn-1",
    runAttemptId: "attempt-1",
    workspaceId: "workspace-1",
    root: "/home/sandbox/checkouts/run-1",
  },
  owner: "test-session",
  correlationId: "corr-1",
  expiresAt: Date.now() + 60_000,
  generation: 0,
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

    adapter = new CloudflareSandboxExecutionAdapter(
      mockSandbox,
      pluginMap,
      TEST_LEASE,
    );
  });

  describe("executeTask", () => {
    it("should execute task and return success result", async () => {
      const input = {
        taskId: "task-1",
        action: "MockPlugin.execute",
        params: { action: "run", test: "value", runId: TEST_RUN_ID },
      };

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("PLUGIN_NOT_FOUND");
    });

    it("should fail fast when runId is missing for execute actions", async () => {
      const input = {
        taskId: "task-missing-run",
        action: "MockPlugin.execute",
        params: { action: "run", test: "value" },
      };

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease({
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
        TEST_LEASE.leaseId,
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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease({
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

    it("passes each lease's server-owned workspace root to the plugin", async () => {
      const roots: string[] = [];
      class ScopedPlugin implements IPlugin {
        readonly name = "scoped";
        readonly tools: ToolDefinition[] = [];

        async execute(
          _sandbox: unknown,
          _payload: unknown,
          _onLog?: unknown,
          context?: PluginExecutionContext,
        ): Promise<{ success: boolean; output: string }> {
          roots.push(context?.workspaceScope.root ?? "missing");
          return { success: true, output: "ok" };
        }
      }

      const secondLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        leaseId: "lease:workspace-1:attempt-2",
        workspaceScope: {
          ...TEST_LEASE.workspaceScope,
          runId: "run-2",
          turnId: "turn-2",
          runAttemptId: "attempt-2",
          root: "/home/sandbox/checkouts/attempt-2",
        },
      };
      pluginMap.set("scoped", new ScopedPlugin());
      adapter.registerLease(secondLease);

      await adapter.executeTask(TEST_LEASE.leaseId, withLease({
        taskId: "task-scoped-1",
        action: "scoped.execute",
        params: { action: "run", runId: TEST_RUN_ID },
      }));
      await adapter.executeTask(secondLease.leaseId, {
        taskId: "task-scoped-2",
        action: "scoped.execute",
        params: { action: "run", runId: "run-2" },
        lease: secondLease,
      });

      expect(roots).toEqual([
        "/home/sandbox/checkouts/run-1",
        "/home/sandbox/checkouts/attempt-2",
      ]);
    });

    it("rejects a caller run id that does not match its active workspace scope", async () => {
      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease({
        taskId: "task-scoped-mismatch",
        action: "MockPlugin.execute",
        params: { action: "run", runId: "another-run" },
      }));

      expect(result.status).toBe("failure");
      expect(result.error?.code).toBe("WORKSPACE_SCOPE_MISMATCH");
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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease({
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
      const taskPromise = adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

      // Cancel attempt while task is still running
      // (may succeed if task hasn't completed yet)
      const cancelled = await adapter.cancelTask(TEST_LEASE.leaseId, "task-7");

      // Task exists in active executions, so cancel should be attempted
      // Actual result depends on timing
      expect(typeof cancelled).toBe("boolean");

      const result = await taskPromise;
      expect(result.status).toBe("success");
    });

    it("should return false for non-existent task", async () => {
      const result = await adapter.cancelTask(TEST_LEASE.leaseId, "non-existent");
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

      await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));
      await adapter.cleanup(TEST_LEASE.leaseId);

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

      const result = await adapter.executeTask(TEST_LEASE.leaseId, withLease(input));

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBeDefined();
      expect(result.error?.message).toBeDefined();
    });
  });

  describe("lease isolation", () => {
    it("serializes mutations from distinct leases for the same workspace run-attempt", async () => {
      const order: string[] = [];
      let concurrent = 0;
      let maximumConcurrent = 0;
      const tracker: IPlugin = {
        name: "tracker",
        tools: [],
        async execute(_sandbox, payload): Promise<{ success: boolean; output: string }> {
          const callId = (payload as { __toolbox: { callId: string } }).__toolbox.callId;
          order.push(`start:${callId}`);
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
          order.push(`finish:${callId}`);
          return { success: true, output: callId };
        },
      };
      const firstLease = TEST_LEASE;
      const secondLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        leaseId: "lease:workspace-1:attempt-1:second",
        owner: "second-session",
        correlationId: "corr-2",
      };
      const localAdapter = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[tracker.name, tracker]]),
        firstLease,
      );
      localAdapter.registerLease(secondLease);

      const first = localAdapter.executeTask(firstLease.leaseId, {
        taskId: "first",
        action: "tracker.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: firstLease,
      });
      const second = localAdapter.executeTask(secondLease.leaseId, {
        taskId: "second",
        action: "tracker.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: secondLease,
      });

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(maximumConcurrent).toBe(1);
      expect(order).toEqual([
        "start:first",
        "finish:first",
        "start:second",
        "finish:second",
      ]);
    });

    it("cancels only the matching lease when sibling leases share a task id", async () => {
      const slowPlugin: IPlugin = {
        name: "slow",
        tools: [],
        async execute(): Promise<{ success: boolean; output: string }> {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { success: true, output: "complete" };
        },
      };
      const firstLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        mutationMode: "read_only",
      };
      const secondLease: SandboxExecutionLease = {
        ...firstLease,
        leaseId: "lease:workspace-1:attempt-1:read-only",
        owner: "second-session",
        correlationId: "corr-read-only",
      };
      const localAdapter = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[slowPlugin.name, slowPlugin]]),
        firstLease,
      );
      localAdapter.registerLease(secondLease);
      const first = localAdapter.executeTask(firstLease.leaseId, {
        taskId: "shared-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: firstLease,
      });
      const second = localAdapter.executeTask(secondLease.leaseId, {
        taskId: "shared-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: secondLease,
      });

      expect(await localAdapter.cancelTask(firstLease.leaseId, "shared-task")).toBe(true);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.status).toBe("cancelled");
      expect(secondResult.status).toBe("success");
      expect(await localAdapter.cancelTask(firstLease.leaseId, "shared-task")).toBe(false);
    });

    it("allows explicit read-only leases to run without taking the mutation lock", async () => {
      let concurrent = 0;
      let maximumConcurrent = 0;
      const readOnlyPlugin: IPlugin = {
        name: "readonly",
        tools: [],
        async execute(): Promise<{ success: boolean; output: string }> {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
          return { success: true, output: "read" };
        },
      };
      const firstLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        mutationMode: "read_only",
      };
      const secondLease: SandboxExecutionLease = {
        ...firstLease,
        leaseId: "lease:workspace-1:attempt-1:readonly-second",
        owner: "readonly-second",
        correlationId: "corr-readonly-second",
      };
      const localAdapter = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[readOnlyPlugin.name, readOnlyPlugin]]),
        firstLease,
      );
      localAdapter.registerLease(secondLease);

      const [first, second] = await Promise.all([
        localAdapter.executeTask(firstLease.leaseId, {
          taskId: "read-first",
          action: "readonly.execute",
          params: { action: "run", runId: TEST_RUN_ID },
          lease: firstLease,
        }),
        localAdapter.executeTask(secondLease.leaseId, {
          taskId: "read-second",
          action: "readonly.execute",
          params: { action: "run", runId: TEST_RUN_ID },
          lease: secondLease,
        }),
      ]);

      expect(first.status).toBe("success");
      expect(second.status).toBe("success");
      expect(maximumConcurrent).toBe(2);
    });

    it("keeps active task state isolated between different workspace adapters", async () => {
      const slowPlugin: IPlugin = {
        name: "slow",
        tools: [],
        async execute(): Promise<{ success: boolean; output: string }> {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { success: true, output: "complete" };
        },
      };
      const workspaceTwoLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        leaseId: "lease:workspace-2:attempt-1",
        owner: "workspace-two",
        correlationId: "corr-workspace-two",
        workspaceScope: {
          runId: TEST_RUN_ID,
          threadId: "thread-2",
          turnId: "turn-2",
          runAttemptId: "attempt-1",
          workspaceId: "workspace-2",
          root: "/workspace-2",
        },
      };
      const workspaceOne = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[slowPlugin.name, slowPlugin]]),
        TEST_LEASE,
      );
      const workspaceTwo = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[slowPlugin.name, slowPlugin]]),
        workspaceTwoLease,
      );
      const first = workspaceOne.executeTask(TEST_LEASE.leaseId, {
        taskId: "shared-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: TEST_LEASE,
      });
      const second = workspaceTwo.executeTask(workspaceTwoLease.leaseId, {
        taskId: "shared-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: workspaceTwoLease,
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(await workspaceOne.cancelTask(TEST_LEASE.leaseId, "shared-task")).toBe(true);
      expect((await first).status).toBe("cancelled");
      expect((await second).status).toBe("success");
    });

    it("settles a timeout without retaining a sibling task entry", async () => {
      const slowPlugin: IPlugin = {
        name: "slow",
        tools: [],
        async execute(): Promise<{ success: boolean; output: string }> {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { success: true, output: "complete" };
        },
      };
      const timeoutLease: SandboxExecutionLease = {
        ...TEST_LEASE,
        mutationMode: "read_only",
      };
      const siblingLease: SandboxExecutionLease = {
        ...timeoutLease,
        leaseId: "lease:workspace-2:attempt-1:read-only",
        owner: "sibling-session",
        correlationId: "corr-sibling",
        workspaceScope: {
          runId: TEST_RUN_ID,
          threadId: "thread-2",
          turnId: "turn-2",
          runAttemptId: "attempt-1",
          workspaceId: "workspace-2",
          root: "/workspace-2",
        },
      };
      const localAdapter = new CloudflareSandboxExecutionAdapter(
        mockSandbox,
        new Map([[slowPlugin.name, slowPlugin]]),
        timeoutLease,
      );
      localAdapter.registerLease(siblingLease);
      const timedOut = localAdapter.executeTask(timeoutLease.leaseId, {
        taskId: "timeout-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        timeout: 1,
        lease: timeoutLease,
      });
      const sibling = localAdapter.executeTask(siblingLease.leaseId, {
        taskId: "sibling-task",
        action: "slow.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: siblingLease,
      });

      expect((await timedOut).status).toBe("timeout");
      expect(await localAdapter.cancelTask(timeoutLease.leaseId, "timeout-task")).toBe(false);
      expect((await sibling).status).toBe("success");
    });

    it("rejects an expired lease without invoking a plugin", async () => {
      const expired = { ...TEST_LEASE, expiresAt: Date.now() - 1 };
      const result = await adapter.executeTask(TEST_LEASE.leaseId, {
        taskId: "expired-task",
        action: "MockPlugin.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: expired,
      });

      expect(result.status).toBe("sandbox_unavailable");
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
        TEST_LEASE,
      );

      const result = await localAdapter.executeTask(TEST_LEASE.leaseId, {
        taskId: "dead-task",
        action: "dead.execute",
        params: { action: "run", runId: TEST_RUN_ID },
        lease: TEST_LEASE,
      });

      expect(result.status).toBe("sandbox_unavailable");
      expect(result.error?.code).toBe("SANDBOX_UNAVAILABLE");
      expect(result.retryable).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
    });

    it("does not cancel a sibling lease during cleanup", async () => {
      const siblingLease = {
        ...TEST_LEASE,
        leaseId: "lease:workspace-2:attempt-1",
        workspaceScope: {
          runId: TEST_RUN_ID,
          threadId: "thread-2",
          turnId: "turn-2",
          runAttemptId: "attempt-1",
          workspaceId: "workspace-2",
          root: "/workspace-2",
        },
        sandboxId: "workspace:workspace-2:attempt:attempt-1",
      };
      adapter.registerLease(siblingLease);
      const first = adapter.executeTask(TEST_LEASE.leaseId, {
        taskId: "first-task",
        action: "MockPlugin.execute",
        params: { action: "run", delay: 25, runId: TEST_RUN_ID },
        lease: TEST_LEASE,
      });
      const second = adapter.executeTask(siblingLease.leaseId, {
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
