import type { LocalReadOnlyWorkspaceBinding } from "../desktop/LocalReadOnlyWorkspaceBinding.js";
import { LocalReadOnlyTurnExecutor } from "../desktop/LocalReadOnlyTurnExecutor.js";
import { RegistryToolAuthorization } from "../contracts/RegistryToolAuthorization.js";
import { ThreadSchema, ItemIdSchema, ToolCallIdSchema, WorkerIdSchema, PermissionProfileIdSchema, type LifecycleEvent } from "@repo/platform-protocol";
import type { RuntimeKernelDependencies } from "@repo/runtime-kernel";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalReadOnlyExecutionService } from "../desktop/LocalReadOnlyExecutionService.js";
import { describe, expect, it, vi } from "vitest";
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

    const root = await mkdtemp(join(tmpdir(), "legioncode-read-only-"));
    const workspaceId = WorkspaceIdSchema.parse("wrk_local_readonly");
    let granted = true;
    const binding: LocalReadOnlyWorkspaceBinding = {
      workspace: { workspaceId }, filesystemRoot: root, signal: new AbortController().signal,
      assertCurrent: async () => { if (!granted) throw new Error("Workspace is not granted"); },
    };
    const executor = new LocalReadOnlyExecutionService({ binding });
    const scope = { root, workspaceId, runId: "run_local_readonly", threadId: "thr_local_readonly", turnId: "trn_local_readonly", runAttemptId: "attempt_local_readonly" };
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.txt"), "first\nsecond\nthird\n");
      await symlink(tmpdir(), join(root, "outside"));
      await expect(executor.execute("filesystem", "read_file", { path: "src/a.txt", offset: 1, limit: 1 }, { scope })).resolves.toMatchObject({ output: expect.stringContaining("2: second"), metadata: { truncated: true, nextOffset: 2 } });
      await expect(executor.execute("filesystem", "list_files", { path: "src" }, { scope })).rejects.toThrow("denies");
      await expect(executor.execute("filesystem", "write_file", { path: "src/a.txt", content: "changed" }, { scope })).rejects.toThrow("denies");
      await expect(executor.execute("bash", "execute", { command: "pwd" }, { scope })).rejects.toThrow("denies");
      await expect(executor.execute("filesystem", "read_file", { path: "../secret" }, { scope })).rejects.toThrow("escapes");
      await expect(executor.execute("filesystem", "read_file", { path: "outside" }, { scope })).rejects.toThrow("symbolic");
      await expect(executor.execute("filesystem", "read_file", { path: "src/a.txt" }, { scope: { ...scope, root: tmpdir() } })).rejects.toThrow("does not match");
      await expect(executor.execute("filesystem", "read_file", { path: "src/a.txt" }, { scope, signal: AbortSignal.abort() })).rejects.toThrow();
      await verifyLocalExecutor(root, binding);
      granted = false;
      await expect(executor.execute("filesystem", "read_file", { path: "src/a.txt" }, { scope })).rejects.toThrow("not granted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      options: {
        scope: {
          root: "/runs/one",
          runId: "run_one",
          threadId: "thr_run_one",
          turnId: "trn_run_one",
        },
      },
    });
    expect(secondCalls[0]).toMatchObject({
      payload: { command: "pwd", cwd: "src" },
      options: {
        scope: {
          root: "/runs/two",
          runId: "run_two",
          threadId: "thr_run_two",
          turnId: "trn_run_two",
        },
      },
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
        threadId: "thr_run_one",
        turnId: "trn_run_one",
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
        threadId: "thr_run_one",
        turnId: "trn_run_one",
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
      threadId: `thr_${runId}`,
      turnId: `trn_${runId}`,
      runAttemptId: RunAttemptIdSchema.parse(`attempt_${runId}_000001`),
      workspaceId: WorkspaceIdSchema.parse(`wrk_${runId}_000001`),
      root,
    }),
  });
}


async function verifyLocalExecutor(root: string, binding: LocalReadOnlyWorkspaceBinding): Promise<void> {
  const abort = new AbortController();
  const activeBinding = { ...binding, signal: abort.signal };
  const events: LifecycleEvent[] = [];
  const lifecycleEvents: RuntimeKernelDependencies["lifecycleEvents"] = {
    append: async (event) => { events.push(event); return event; },
    appendBatch: async (batch) => { events.push(...batch); return batch; },
    replay: async (input) => ({ events: events.filter((event) => event.turnId === input.turnId && event.sequence > (input.afterSequence ?? 0)), nextSequence: null }),
  };
  const now = new Date().toISOString();
  const thread = ThreadSchema.parse({
    id: "thr_local_readonly", workspaceId: "wrk_local_readonly", userId: "usr_localdesktop",
    title: "Local runtime", titleSource: "user", status: "active", pinnedAt: null, archivedAt: null,
    activeRunId: null, activeLeafItemId: null, createdAt: now, updatedAt: now, lastEventSequence: 1,
  });
  const input = {
    thread, workspaceId: thread.workspaceId, prompt: "Read src/a.txt", clientRequestId: "local-read-1",
    providerId: "openai", modelId: "gpt-5", workerId: WorkerIdSchema.parse("worker_localdesktop"),
    permissionProfileId: PermissionProfileIdSchema.parse("perm_localdesktop"),
  };
  const allow = { defaultEffect: "allow" as const, defaultRiskLevel: "low" as const, rules: [] };
  const toolAuthorization = new RegistryToolAuthorization({ resolve: async () => ({ commands: allow, paths: allow, network: allow, git: allow, packageManagers: allow, secrets: allow, externalServices: allow, tools: allow }) });
  const provider = vi.fn(async (call: Parameters<RuntimeKernelDependencies["provider"]["generateNext"]>[0]) => {
    if (!call.toolResults.length) return { kind: "tool_call" as const, itemId: ItemIdSchema.parse("itm_local_read_tool"), content: { toolCallId: ToolCallIdSchema.parse("toolcall_local_read"), toolName: "read_file", input: { path: "src/a.txt" } } };
    expect(call.toolResults[0]?.output.content).toContain("1: first");
    return { kind: "complete" as const, itemId: ItemIdSchema.parse("itm_local_final"), output: "Read completed" };
  });
  const executor = new LocalReadOnlyTurnExecutor({
    bindWorkspace: async () => activeBinding, lifecycleEvents, producerId: "local-runtime-test",
    createKernelPorts: async (admission, attemptBinding) => {
      expect(attemptBinding).toBe(activeBinding);
      const workspace = {
        runId: admission.run.id, workspaceId: thread.workspaceId, repoOwner: "local", repoName: "fixture",
        repoUrl: "file:///fixture", baseBranch: "dev", workingBranch: "dev", baseSha: "a".repeat(40), headSha: "a".repeat(40),
        executionLocation: "desktop_local" as const, workerId: admission.run.workerId, filesystemRoot: root,
        artifactNamespace: "local-test", permissionProfileId: admission.run.permissionProfileId, state: "ready" as const,
        lastError: null, createdAt: now, updatedAt: now,
      };
      return {
        workspaceManifests: { create: async () => workspace, update: async () => workspace, getByWorkspaceId: async () => workspace, getLatestByRunId: async () => workspace },
        contextAssembly: { assemble: async () => ({ instructions: String(admission.userMessage.content.text), metadata: {} }) },
        provider: { generateNext: provider }, toolAuthorization,
        approvals: { waitForDecision: async () => { throw new Error("Read-only tools must not require approval in this policy"); } },
      };
    },
  });
  const admission = executor.createAdmission(input);
  expect(admission.run).toMatchObject({ status: "queued", mode: "ask", userId: thread.userId, workspaceId: thread.workspaceId });
  expect(admission.userMessage).toMatchObject({ type: "user_message", status: "completed", role: "user", content: { text: input.prompt }, runId: admission.run.id, turnId: admission.turn.id });
  const execution = executor.execute(admission);
  expect(executor.execute(admission)).toBe(execution);
  await expect(execution).resolves.toMatchObject({ output: "Read completed", toolCallCount: 1 });
  expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  expect(events.some((event) => ["artifact.created", "workspace.snapshot_captured", "turn.diff_updated"].includes(event.type))).toBe(false);
  const identity = { workspaceId: admission.run.workspaceId, threadId: admission.run.threadId, runId: admission.run.id, turnId: admission.turn.id, runAttemptId: admission.runAttemptId };
  await expect(executor.interruptAttempt(identity, "late Stop")).resolves.toBe("already_settled");
  await expect(executor.interruptAttempt({ ...identity, runAttemptId: RunAttemptIdSchema.parse("attempt_wrong_attempt") }, "stale Stop")).rejects.toMatchObject({ code: "turn_not_active" });

  const stoppedAdmission = executor.createAdmission({ ...input, clientRequestId: "local-stop-1" });
  const callsBeforeStop = provider.mock.calls.length;
  const stopped = executor.execute(stoppedAdmission);
  const stoppedResult = expect(stopped).rejects.toThrow();
  await executor.interrupt(stoppedAdmission.turn.id, "Stop before start");
  await stoppedResult;
  expect(provider.mock.calls.length).toBe(callsBeforeStop);
  expect(events.filter((event) => event.turnId === stoppedAdmission.turn.id && event.type === "turn.interrupted")).toHaveLength(1);

  const runningAdmission = executor.createAdmission({ ...input, clientRequestId: "local-abort-1" });
  let providerObservedAbort = false;
  provider.mockImplementationOnce(async (call) => await new Promise<never>((_, reject) => {
    call.signal?.addEventListener("abort", () => { providerObservedAbort = true; reject(call.signal?.reason); }, { once: true });
  }));
  const running = executor.execute(runningAdmission);
  const interrupted = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(provider.mock.calls.length).toBe(callsBeforeStop + 1));
  abort.abort(new DOMException("Workspace grant revoked", "AbortError"));
  await interrupted;
  expect(providerObservedAbort).toBe(true);
  expect(events.filter((event) => event.turnId === runningAdmission.turn.id && event.type === "turn.interrupted")).toHaveLength(1);

  const failedExecutor = new LocalReadOnlyTurnExecutor({
    bindWorkspace: async () => binding, lifecycleEvents, producerId: "local-runtime-test",
    createKernelPorts: async () => { throw new Error("Protected provider preflight failed"); },
  });
  const failedAdmission = failedExecutor.createAdmission({ ...input, clientRequestId: "local-preflight-1" });
  await expect(failedExecutor.execute(failedAdmission)).rejects.toThrow("Protected provider preflight failed");
  expect(events.filter((event) => event.turnId === failedAdmission.turn.id && event.type === "turn.failed")).toHaveLength(1);
}
