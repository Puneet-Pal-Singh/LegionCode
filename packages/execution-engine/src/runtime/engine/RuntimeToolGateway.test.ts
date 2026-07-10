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

    const escaped = await first.execute({
      taskId: "task_escape",
      toolName: "read_file",
      toolInput: { description: "read", path: "../two/secret.ts" },
    });
    const firstResult = await first.execute({
      taskId: "task_first",
      toolName: "read_file",
      toolInput: { description: "read", path: "/runs/one/src/a.ts" },
    });
    const secondResult = await second.execute({
      taskId: "task_second",
      toolName: "bash",
      toolInput: { description: "pwd", command: "pwd", cwd: "src" },
    });

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
