import { describe, expect, it } from "vitest";
import { RunAttemptIdSchema, WorkspaceIdSchema } from "@repo/platform-protocol";
import { createCloudSandboxRunCapabilityManifest } from "../capabilities/RuntimeCapabilityManifest.js";
import type { RuntimeExecutionService } from "../types.js";
import { RuntimeToolGateway } from "./RuntimeToolGateway.js";
import { RuntimeWorkspaceScope } from "./RuntimeWorkspaceScope.js";

describe("RuntimeToolGateway", () => {
  it("rejects unavailable and malformed tools before dispatch", async () => {
    const calls: unknown[] = [];
    const gateway = createGateway("/runs/one", calls, ["read_file"]);

    const unavailable = await gateway.execute({
      taskId: "task_one",
      toolName: "bash",
      toolInput: { description: "run", command: "pwd" },
    });
    const malformed = await gateway.execute({
      taskId: "task_two",
      toolName: "read_file",
      toolInput: { description: "read" },
    });

    expect(unavailable).toMatchObject({
      kind: "failed",
      code: "tool_unavailable",
    });
    expect(malformed).toMatchObject({
      kind: "failed",
      code: "invalid_tool_input",
    });
    expect(calls).toEqual([]);
  });

  it("binds every dispatch to its run workspace and denies traversal", async () => {
    const firstCalls: Array<Record<string, unknown>> = [];
    const secondCalls: Array<Record<string, unknown>> = [];
    const first = createGateway("/runs/one", firstCalls, ["read_file", "bash"]);
    const second = createGateway("/runs/two", secondCalls, [
      "read_file",
      "bash",
    ]);

    const [escaped, firstResult, secondResult] = await Promise.all([
      first.execute({
        taskId: "task_escape",
        toolName: "read_file",
        toolInput: { description: "read", path: "../two/secret.ts" },
      }),
      first.execute({
        taskId: "task_first",
        toolName: "read_file",
        toolInput: { description: "read", path: "/runs/one/src/a.ts" },
      }),
      second.execute({
        taskId: "task_second",
        toolName: "bash",
        toolInput: { description: "pwd", command: "pwd", cwd: "src" },
      }),
    ]);

    expect(escaped).toMatchObject({
      kind: "failed",
      code: "workspace_escape_denied",
    });
    expect(firstResult.kind).toBe("completed");
    expect(secondResult.kind).toBe("completed");
    expect(firstCalls[0]).toMatchObject({
      payload: { path: "src/a.ts" },
      options: { scope: { root: "/runs/one", runId: "run_one" } },
    });
    expect(secondCalls[0]).toMatchObject({
      payload: { command: "pwd", cwd: "src" },
      options: { scope: { root: "/runs/two", runId: "run_two" } },
    });
  });

  it("denies traversal for search, edit, and shell inputs", async () => {
    const calls: unknown[] = [];
    const gateway = createGateway(
      "/runs/one",
      calls as Array<Record<string, unknown>>,
      ["grep", "edit_file", "bash"],
    );

    const [search, edit, shell] = await Promise.all([
      gateway.execute({
        taskId: "task_search_escape",
        toolName: "grep",
        toolInput: { description: "search", pattern: "secret", path: "../two" },
      }),
      gateway.execute({
        taskId: "task_edit_escape",
        toolName: "edit_file",
        toolInput: {
          description: "edit",
          path: "../two/secret.ts",
          oldText: "old",
          newText: "new",
        },
      }),
      gateway.execute({
        taskId: "task_shell_escape",
        toolName: "bash",
        toolInput: { description: "shell", command: "pwd", cwd: "../two" },
      }),
    ]);

    expect(search).toMatchObject({
      kind: "failed",
      code: "workspace_escape_denied",
    });
    expect(edit).toMatchObject({
      kind: "failed",
      code: "workspace_escape_denied",
    });
    expect(shell).toMatchObject({
      kind: "failed",
      code: "workspace_escape_denied",
    });
    expect(calls).toEqual([]);
  });

  it("returns typed executor failure and cancellation results", async () => {
    let cancelled = false;
    const executor: RuntimeExecutionService = {
      execute: async () => ({ success: false, output: "executor rejected" }),
    };
    const gateway = new RuntimeToolGateway({
      executor,
      manifest: createCloudSandboxRunCapabilityManifest({
        runId: "run_one",
        workspaceRoot: "/runs/one",
        availableToolIds: ["read_file"],
      }),
      scope: new RuntimeWorkspaceScope({
        runId: "run_one",
        runAttemptId: RunAttemptIdSchema.parse("attempt_run_one_000001"),
        workspaceId: WorkspaceIdSchema.parse("wrk_run_one_000001"),
        root: "/runs/one",
      }),
    });

    const failed = await gateway.execute({
      taskId: "task_failed",
      toolName: "read_file",
      toolInput: { description: "read", path: "src/a.ts" },
    });
    cancelled = true;
    const cancelledResult = await gateway.execute({
      taskId: "task_cancelled",
      toolName: "read_file",
      toolInput: { description: "read", path: "src/a.ts" },
      isCancelled: () => cancelled,
    });

    expect(failed).toMatchObject({ kind: "failed", code: "executor_failed" });
    expect(cancelledResult).toMatchObject({ kind: "cancelled" });
  });

  it("preserves a typed runtime failure from the execution backend", async () => {
    const executor: RuntimeExecutionService = {
      execute: async () => ({
        success: false,
        title: "Secure execution",
        output: "Sandbox container became unavailable during execution",
        metadata: {
          success: false,
          runtimeFailure: {
            code: "worker_unavailable",
            message: "Sandbox container became unavailable during execution",
            retryable: true,
            correlationId: "secure-correlation-1",
            details: {
              secureStatus: "sandbox_unavailable",
              secureCode: "SANDBOX_UNAVAILABLE",
              taskId: "secure-task-1",
              leaseId: "lease-1",
            },
          },
        },
        truncated: false,
      }),
    };
    const gateway = new RuntimeToolGateway({
      executor,
      manifest: createCloudSandboxRunCapabilityManifest({
        runId: "run_one",
        workspaceRoot: "/runs/one",
        availableToolIds: ["read_file"],
      }),
      scope: new RuntimeWorkspaceScope({
        runId: "run_one",
        runAttemptId: RunAttemptIdSchema.parse("attempt_run_one_000001"),
        workspaceId: WorkspaceIdSchema.parse("wrk_run_one_000001"),
        root: "/runs/one",
      }),
    });

    const result = await gateway.execute({
      taskId: "tool-call-1",
      toolName: "read_file",
      toolInput: { description: "read", path: "src/a.ts" },
    });

    expect(result).toMatchObject({
      kind: "failed",
      code: "executor_failed",
      retryable: true,
      failure: {
        code: "worker_unavailable",
        correlationId: "secure-correlation-1",
        details: {
          secureStatus: "sandbox_unavailable",
          secureCode: "SANDBOX_UNAVAILABLE",
        },
      },
    });
  });
});

function createGateway(
  root: string,
  calls: Array<Record<string, unknown>>,
  availableToolIds: readonly string[],
): RuntimeToolGateway {
  const runId = root.endsWith("one") ? "run_one" : "run_two";
  const executor: RuntimeExecutionService = {
    execute: async (plugin, action, payload, options) => {
      calls.push({ plugin, action, payload, options });
      return { success: true, output: "ok" };
    },
  };
  return new RuntimeToolGateway({
    executor,
    manifest: createCloudSandboxRunCapabilityManifest({
      runId,
      workspaceRoot: root,
      availableToolIds,
    }),
    scope: new RuntimeWorkspaceScope({
      runId,
      runAttemptId: RunAttemptIdSchema.parse(`attempt_${runId}_000001`),
      workspaceId: WorkspaceIdSchema.parse(`wrk_${runId}_000001`),
      root,
    }),
  });
}
