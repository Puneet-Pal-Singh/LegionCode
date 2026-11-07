import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { evaluatePermission, parsePermissionPolicy, type PermissionPolicy } from "@repo/permission-policy";
import type { RunAttemptId, RunId, TurnId, WorkspaceId } from "@repo/platform-protocol";
import type { WorkerProtocolPort } from "@repo/runtime-kernel/ports";
import { RuntimeKernelError, toProtocolError } from "@repo/runtime-kernel/errors";
import type { WorkerToolResult } from "@repo/runtime-kernel";
import { BASH_TOOL_INPUT_SCHEMA } from "../tools/CodingToolRegistry.js";
import { BoundedLocalProcess } from "./BoundedLocalProcess.js";

export type LocalBashWorkerOptions = {
  attempt: { workspaceId: WorkspaceId; runId: RunId; turnId: TurnId; runAttemptId: RunAttemptId };
  grant: {
    filesystemRoot: string;
    generation: number;
    signal: AbortSignal;
    assertCurrent(): void | Promise<void>;
  };
  permissionPolicy: PermissionPolicy;
  /** Composition must supply real baseline/final capture before enabling bash. */
  artifactCapture: "required";
};

type Operation = { controller: AbortController; process?: BoundedLocalProcess; finished: boolean };

/** Runtime-only worker. The kernel owns approvals, tool events and terminal settlement. */
export class LocalBashWorker implements WorkerProtocolPort {
  private readonly operations = new Set<Operation>();
  private readonly policy: PermissionPolicy;
  private readonly attempt: LocalBashWorkerOptions["attempt"];
  private readonly grant: LocalBashWorkerOptions["grant"];
  private stopped = false;

  constructor(options: LocalBashWorkerOptions) {
    if (options.artifactCapture !== "required") throw new Error("Bash requires real artifact capture");
    if (!isAbsolute(options.grant.filesystemRoot)) throw new Error("Bash requires an absolute granted root");
    this.policy = parsePermissionPolicy(options.permissionPolicy);
    this.attempt = { ...options.attempt };
    this.grant = { ...options.grant };
  }

  async executeTool(input: Parameters<WorkerProtocolPort["executeTool"]>[0]): Promise<WorkerToolResult> {
    const operation: Operation = { controller: new AbortController(), finished: false };
    this.operations.add(operation);
    const abort = () => operation.controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    this.grant.signal.addEventListener("abort", abort, { once: true });
    try {
      this.assertIdentity(input);
      if (this.stopped || input.signal?.aborted || this.grant.signal.aborted) abort();
      operation.controller.signal.throwIfAborted();
      if (input.toolCall.toolName !== "bash") throw new RuntimeKernelError("tool_not_registered", "Local bash worker only accepts bash");
      const command = BASH_TOOL_INPUT_SCHEMA.parse(input.toolCall.input);
      if (input.approval?.decision !== "approved" || input.approval.timedOut) {
        throw new RuntimeKernelError("approval_denied", "Local bash requires a current explicit approval");
      }
      if (evaluatePermission(this.policy, { domain: "command", command: command.command }).effect === "deny") {
        throw new RuntimeKernelError("tool_policy_denied", "Command is denied by the canonical permission policy");
      }
      await this.grant.assertCurrent();
      const root = await realpath(this.grant.filesystemRoot);
      const cwd = await realpath(resolve(root, command.cwd ?? "."));
      const path = relative(root, cwd);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !(await stat(cwd)).isDirectory()) {
        throw new RuntimeKernelError("tool_policy_denied", "Bash cwd must be inside the granted workspace");
      }
      // Revalidate after all asynchronous preparation, immediately before spawn.
      await this.grant.assertCurrent();
      operation.controller.signal.throwIfAborted();
      this.requireDescendantContainment();
      operation.process = new BoundedLocalProcess({ command: command.command, cwd, signal: operation.controller.signal });
      const output = await operation.process.result;
      if (!(await this.waitForProcess(operation.process, 2_000))) {
        throw new RuntimeKernelError("worker_failed", "Command process-group exit could not be confirmed");
      }
      if (operation.controller.signal.aborted) return { kind: "cancelled", reason: "Local command interrupted" };
      return { kind: "completed", output: { ...output } };
    } catch (error) {
      if (operation.controller.signal.aborted) return { kind: "cancelled", reason: "Local command interrupted" };
      return { kind: "failed", disposition: "recoverable", failure: toProtocolError(error) };
    } finally {
      operation.finished = true;
      input.signal?.removeEventListener("abort", abort);
      this.grant.signal.removeEventListener("abort", abort);
      if (!operation.process || operation.process.quiescent) this.operations.delete(operation);
    }
  }

  /** Permanently closes this exact-attempt worker to new commands. */
  async stop(): Promise<boolean> {
    this.stopped = true;
    for (const operation of this.operations) operation.controller.abort();
    return this.awaitQuiescence({ turnId: this.attempt.turnId, timeoutMs: 2_000 });
  }

  async awaitQuiescence(input: { turnId: TurnId; timeoutMs: number }): Promise<boolean> {
    if (input.turnId !== this.attempt.turnId || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) return false;
    const deadline = Date.now() + Math.min(input.timeoutMs, 5_000);
    do {
      for (const operation of this.operations) {
        if (operation.finished && (!operation.process || operation.process.quiescent)) this.operations.delete(operation);
      }
      if (this.operations.size === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
  }

  private requireDescendantContainment(): void {
    // Process groups cannot contain setsid descendants. No supported full-tree
    // owner is composed; accidental wiring must not enable this worker.
    throw new RuntimeKernelError("tool_policy_denied", "Native bash is unavailable until descendant containment is implemented");
  }

  private assertIdentity(input: Parameters<WorkerProtocolPort["executeTool"]>[0]): void {
    if (input.runId !== this.attempt.runId || input.turnId !== this.attempt.turnId || input.runAttemptId !== this.attempt.runAttemptId
      || input.workspace.runId !== this.attempt.runId || input.workspace.workspaceId !== this.attempt.workspaceId
      || resolve(input.workspace.filesystemRoot) !== resolve(this.grant.filesystemRoot)) {
      throw new RuntimeKernelError("invalid_turn_identity", "Bash command does not match the granted exact attempt");
    }
  }

  private async waitForProcess(child: BoundedLocalProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!child.quiescent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return child.quiescent;
  }
}
