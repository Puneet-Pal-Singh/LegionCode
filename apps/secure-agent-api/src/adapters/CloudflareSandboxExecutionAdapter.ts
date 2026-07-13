import type { Sandbox } from "@cloudflare/sandbox";
import type { IPlugin } from "../interfaces/types";
import type {
  LeaseReleaseResult,
  SandboxExecutionPort,
  TaskExecutionHooks,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import {
  createSandboxLease,
  isLeaseExpired,
  workspaceLeaseKey,
  type SandboxExecutionLease,
  type SandboxExecutionLeaseRequest,
} from "../ports/SandboxExecutionLease";

interface TaskActionMapping {
  pluginName: string;
  method: string;
}

type TerminationReason = "cancelled" | "timeout";

interface ActiveTaskExecution {
  leaseId: string;
  taskId: string;
  abortController: AbortController;
  terminationReason?: TerminationReason;
}

interface ToolboxPayloadContext {
  __toolbox: { callId: string; runId?: string; toolName: string };
}

class TaskInterruptedError extends Error {
  constructor(readonly reason: TerminationReason) {
    super(reason === "timeout" ? "Sandbox task timed out" : "Sandbox task cancelled");
    this.name = "TaskInterruptedError";
  }
}

export class SandboxLeaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly correlationId: string,
  ) {
    super(message);
    this.name = "SandboxLeaseError";
  }
}

export class CloudflareSandboxExecutionAdapter implements SandboxExecutionPort {
  private readonly activeExecutions = new Map<string, ActiveTaskExecution>();
  private readonly taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly leases = new Map<string, SandboxExecutionLease>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly sandbox: Sandbox,
    private readonly plugins: Map<string, IPlugin>,
    initialLease?: SandboxExecutionLease,
  ) {
    if (initialLease) this.registerLease(initialLease);
  }

  registerLease(lease: SandboxExecutionLease): void {
    const existing = this.leases.get(lease.leaseId);
    if (existing && workspaceLeaseKey(existing) !== workspaceLeaseKey(lease)) {
      throw new SandboxLeaseError(
        "SANDBOX_LEASE_COLLISION",
        "A lease id cannot be rebound to a different workspace run-attempt",
        false,
        lease.correlationId,
      );
    }
    this.leases.set(lease.leaseId, lease);
  }

  async acquireLease(
    request: SandboxExecutionLeaseRequest,
  ): Promise<SandboxExecutionLease> {
    const lease = createSandboxLease(request);
    this.registerLease(lease);
    return lease;
  }

  async executeTask(
    leaseId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    if (leaseId !== input.lease.leaseId || !this.isActiveLease(input.lease)) {
      return this.leaseFailure(input);
    }
    const execute = () => this.executeTaskWithLease(input, hooks);
    return input.lease.mutationMode === "serialized"
      ? this.withWorkspaceMutationLock(input.lease, execute)
      : execute();
  }

  async cancelTask(leaseId: string, taskId: string): Promise<boolean> {
    const active = this.activeExecutions.get(this.executionKey(leaseId, taskId));
    if (!active) return false;
    active.terminationReason = "cancelled";
    active.abortController.abort();
    return true;
  }

  async getHealth(_leaseId: string): Promise<{ healthy: boolean }> {
    return { healthy: this.plugins.size > 0 && this.leases.size > 0 };
  }

  async cleanup(leaseId: string): Promise<void> {
    for (const [key, active] of this.activeExecutions) {
      if (active.leaseId !== leaseId) continue;
      active.terminationReason = "cancelled";
      active.abortController.abort();
      const timeout = this.taskTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.taskTimeouts.delete(key);
    }
  }

  async releaseLease(leaseId: string): Promise<LeaseReleaseResult> {
    const lease = this.leases.get(leaseId);
    if (!lease) return { released: false, sandboxReleased: false };
    await this.cleanup(leaseId);
    this.leases.delete(leaseId);
    const sandboxReleased = this.leases.size === 0;
    if (sandboxReleased) await destroySandbox(this.sandbox);
    return { released: true, sandboxReleased };
  }

  private async executeTaskWithLease(
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    const { lease } = input;
    const startedAt = Date.now();
    const active: ActiveTaskExecution = {
      leaseId: lease.leaseId,
      taskId: input.taskId,
      abortController: new AbortController(),
    };
    const key = this.executionKey(lease.leaseId, input.taskId);
    this.activeExecutions.set(key, active);
    const timeoutMs = input.timeout ?? 30_000;
    this.taskTimeouts.set(
      key,
      setTimeout(() => {
        active.terminationReason = "timeout";
        active.abortController.abort();
      }, timeoutMs),
    );

    try {
      const mapping = getTaskActionMapping(input.action);
      if (!mapping) return this.failure(input, "UNKNOWN_ACTION", `Unknown task action: ${input.action}`);
      const plugin = this.plugins.get(mapping.pluginName);
      if (!plugin) return this.failure(input, "PLUGIN_NOT_FOUND", `Plugin not found: ${mapping.pluginName}`);
      const output = await raceWithAbort(
        this.invokePlugin(plugin, mapping, input, active.abortController.signal, hooks),
        active.abortController.signal,
        () => new TaskInterruptedError(active.terminationReason ?? "cancelled"),
      );
      return {
        taskId: input.taskId,
        leaseId: lease.leaseId,
        correlationId: lease.correlationId,
        status: "success",
        retryable: false,
        output: typeof output === "string" ? output : JSON.stringify(output),
        metrics: { duration: Date.now() - startedAt },
      };
    } catch (error) {
      const duration = Date.now() - startedAt;
      if (error instanceof TaskInterruptedError) {
        return {
          taskId: input.taskId,
          leaseId: lease.leaseId,
          correlationId: lease.correlationId,
          status: error.reason,
          retryable: error.reason === "timeout",
          error: {
            code: error.reason === "timeout" ? "SANDBOX_TIMEOUT" : "SANDBOX_ABORTED",
            message: error.message,
          },
          metrics: { duration },
        };
      }
      const normalized = normalizeError(error);
      if (isSandboxUnavailable(error, normalized)) {
        await this.releaseLease(lease.leaseId);
        return {
          taskId: input.taskId,
          leaseId: lease.leaseId,
          correlationId: lease.correlationId,
          status: "sandbox_unavailable",
          retryable: true,
          error: {
            code: "SANDBOX_UNAVAILABLE",
            message: "Sandbox container became unavailable during execution",
            details: normalized.details,
          },
          metrics: { duration },
        };
      }
      return {
        taskId: input.taskId,
        leaseId: lease.leaseId,
        correlationId: lease.correlationId,
        status: "failure",
        retryable: false,
        error: normalized,
        metrics: { duration },
      };
    } finally {
      this.activeExecutions.delete(key);
      const timeout = this.taskTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.taskTimeouts.delete(key);
    }
  }

  private isActiveLease(lease: SandboxExecutionLease): boolean {
    const stored = this.leases.get(lease.leaseId);
    return (
      stored !== undefined &&
      stored.owner === lease.owner &&
      stored.correlationId === lease.correlationId &&
      stored.expiresAt === lease.expiresAt &&
      stored.generation === lease.generation &&
      workspaceLeaseKey(stored) === workspaceLeaseKey(lease) &&
      !isLeaseExpired(stored)
    );
  }

  private leaseFailure(input: TaskExecutionInput): TaskExecutionResult {
    return {
      taskId: input.taskId,
      leaseId: input.lease.leaseId,
      correlationId: input.lease.correlationId,
      status: "sandbox_unavailable",
      retryable: true,
      error: {
        code: "SANDBOX_LEASE_REQUIRED",
        message: "An active sandbox execution lease is required",
      },
    };
  }

  private failure(
    input: TaskExecutionInput,
    code: string,
    message: string,
  ): TaskExecutionResult {
    return {
      taskId: input.taskId,
      leaseId: input.lease.leaseId,
      correlationId: input.lease.correlationId,
      status: "failure",
      retryable: false,
      error: { code, message },
    };
  }

  private executionKey(leaseId: string, taskId: string): string {
    return `${leaseId}:${taskId}`;
  }

  private async withWorkspaceMutationLock<T>(
    lease: SandboxExecutionLease,
    execute: () => Promise<T>,
  ): Promise<T> {
    const workspaceKey = workspaceLeaseKey(lease);
    const prior = this.mutationTails.get(workspaceKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => current);
    this.mutationTails.set(workspaceKey, tail);
    await prior.catch(() => undefined);
    try {
      return await execute();
    } finally {
      release?.();
      if (this.mutationTails.get(workspaceKey) === tail) {
        this.mutationTails.delete(workspaceKey);
      }
    }
  }

  private async invokePlugin(
    plugin: IPlugin,
    mapping: TaskActionMapping,
    input: TaskExecutionInput,
    signal: AbortSignal,
    hooks?: TaskExecutionHooks,
  ): Promise<unknown> {
    if (mapping.method === "execute") {
      const pluginAction = resolveExecutePayloadAction(input.action, input.params);
      const runId = input.params.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        throw { code: "INVALID_INPUT", message: "runId is required for plugin execution" };
      }
      let logDrain = Promise.resolve();
      const result = await plugin.execute(
        this.sandbox,
        {
          ...input.params,
          action: pluginAction,
          __toolbox: { callId: input.taskId, runId, toolName: `${mapping.pluginName}.${pluginAction}` },
        } as Record<string, unknown> & { action: string } & ToolboxPayloadContext,
        (entry) => {
          const normalized = normalizeLogEntry(entry);
          if (normalized) logDrain = logDrain.then(() => hooks?.onLog?.(normalized));
        },
      );
      await logDrain;
      if (!result.success) throw { code: "PLUGIN_EXECUTION_FAILED", message: result.error ?? `Plugin ${mapping.pluginName} execution failed`, details: result.logs };
      return result.output ?? "";
    }
    const method = (plugin as unknown as Record<string, unknown>)[mapping.method];
    if (typeof method !== "function") throw { code: "METHOD_NOT_FOUND", message: `Method ${mapping.method} not found on plugin ${mapping.pluginName}` };
    return (method as (leaseId: string, params: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>).call(
      plugin,
      input.lease.leaseId,
      { ...input.params, __toolbox: { callId: input.taskId, runId: typeof input.params.runId === "string" ? input.params.runId : undefined, toolName: input.action } },
      { signal },
    );
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  createError: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(createError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function destroySandbox(sandbox: Sandbox): Promise<void> {
  const destroy = (sandbox as unknown as { destroy?: () => Promise<void> }).destroy;
  if (typeof destroy === "function") await destroy.call(sandbox);
}

function resolveExecutePayloadAction(action: string, params: Record<string, unknown>): string {
  const requested = params.action;
  if (typeof requested === "string" && requested.trim().length > 0) return requested.trim();
  if (!action.includes(".")) return action;
  throw { code: "INVALID_INPUT", message: "action is required for execute-style plugin routing" };
}

function getTaskActionMapping(action: string): TaskActionMapping | null {
  const parts = action.split(".");
  if (parts.length === 2 && parts[0] && parts[1]) return { pluginName: parts[0], method: parts[1] };
  const legacy: Record<string, TaskActionMapping> = {
    read_file: { pluginName: "filesystem", method: "execute" }, write_file: { pluginName: "filesystem", method: "execute" },
    edit_file: { pluginName: "filesystem", method: "execute" }, multi_edit: { pluginName: "filesystem", method: "execute" },
    format_file: { pluginName: "filesystem", method: "execute" }, language_diagnostics: { pluginName: "filesystem", method: "execute" },
    list_files: { pluginName: "filesystem", method: "execute" }, make_dir: { pluginName: "filesystem", method: "execute" },
    git_status: { pluginName: "git", method: "execute" }, git_diff: { pluginName: "git", method: "execute" }, git_commit: { pluginName: "git", method: "execute" }, git_push: { pluginName: "git", method: "execute" },
    execute_python: { pluginName: "python", method: "execute" }, execute_node: { pluginName: "node", method: "execute" }, execute_rust: { pluginName: "rust", method: "execute" },
  };
  return legacy[action] ?? null;
}

function normalizeLogEntry(entry: string | { message: string; source?: "stdout" | "stderr" }): { message: string; source?: "stdout" | "stderr" } | null {
  if (typeof entry === "string") return entry.length > 0 ? { message: entry } : null;
  return entry.message.length > 0 ? entry : null;
}

function normalizeError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof Error) {
    const typed = error as Error & { code?: unknown; details?: unknown };
    return { code: typeof typed.code === "string" ? typed.code : "EXECUTION_ERROR", message: error.message, details: typed.details ?? error.stack };
  }
  if (typeof error === "string") return { code: "EXECUTION_ERROR", message: error };
  if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.code === "string" && typeof error.message === "string") return { code: error.code, message: error.message, details: "details" in error ? error.details : undefined };
  return { code: "EXECUTION_ERROR", message: "Unknown error during task execution", details: error };
}

function isSandboxUnavailable(error: unknown, normalized: { code: string; message: string }): boolean {
  if (normalized.code === "SANDBOX_UNAVAILABLE" || normalized.code === "CONTAINER_EXITED") return true;
  if (error && typeof error === "object" && "exitCode" in error && error.exitCode === 137) return true;
  return /(?:exit|status|code)[ =:]*(?:137)\b/i.test(normalized.message);
}
