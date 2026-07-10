import type { Sandbox } from "@cloudflare/sandbox";
import type { IPlugin } from "../interfaces/types";
import type {
  SandboxExecutionPort,
  TaskExecutionHooks,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import {
  isLeaseExpired,
  workspaceLeaseKey,
  type SandboxExecutionLease,
  type SandboxExecutionLeaseRequest,
} from "../ports/SandboxExecutionLease";

interface TaskActionMapping {
  pluginName: string;
  method: string;
}

interface ActiveTaskExecution {
  leaseId: string;
  taskId: string;
  abortController: AbortController;
  startTime: number;
}

interface ToolboxPayloadContext {
  __toolbox: { callId: string; runId?: string; toolName: string };
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
  private readonly leaseKeys = new Map<string, string>();

  constructor(
    private readonly sandbox: Sandbox,
    private readonly plugins: Map<string, IPlugin>,
    initialLease?: SandboxExecutionLease,
  ) {
    if (initialLease) this.registerLease(initialLease);
  }

  registerLease(lease: SandboxExecutionLease): void {
    this.leases.set(lease.leaseId, lease);
    this.leaseKeys.set(workspaceLeaseKey(lease), lease.leaseId);
  }

  async acquireLease(
    request: SandboxExecutionLeaseRequest,
  ): Promise<SandboxExecutionLease> {
    const ttlMs = Math.min(Math.max(request.ttlMs ?? 900_000, 1_000), 3_600_000);
    const key = workspaceLeaseKey(request);
    const currentId = this.leaseKeys.get(key);
    const current = currentId ? this.leases.get(currentId) : undefined;
    if (current && !isLeaseExpired(current)) {
      if (current.owner !== request.owner) {
        throw new SandboxLeaseError(
          "SANDBOX_LEASE_CONFLICT",
          "The workspace run-attempt already has an active sandbox lease",
          false,
          request.correlationId,
        );
      }
      return current;
    }
    if (currentId) await this.releaseLease(currentId);
    const lease: SandboxExecutionLease = {
      leaseId: `lease_${crypto.randomUUID()}`,
      sandboxId: `run-${encodeSandboxId(key)}-${crypto.randomUUID().slice(0, 8)}`,
      workspaceId: request.workspaceId,
      runAttemptId: request.runAttemptId,
      mutationMode: request.mutationMode ?? "serialized",
      owner: request.owner,
      correlationId: request.correlationId,
      expiresAt: Date.now() + ttlMs,
    };
    this.registerLease(lease);
    return lease;
  }

  async executeTask(
    sessionId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    const lease = input.lease;
    if (lease && !this.leases.has(lease.leaseId)) this.registerLease(lease);
    if (!lease || !this.isActiveLease(lease)) {
      return {
        taskId: input.taskId,
        leaseId: lease?.leaseId ?? "",
        status: "failure",
        correlationId: lease?.correlationId,
        retryable: true,
        error: {
          code: "SANDBOX_LEASE_REQUIRED",
          message: "An active sandbox execution lease is required",
        },
      };
    }

    const startTime = Date.now();
    const abortController = new AbortController();
    const executionKey = `${lease.leaseId}:${input.taskId}`;
    this.activeExecutions.set(executionKey, {
      leaseId: lease.leaseId,
      taskId: input.taskId,
      abortController,
      startTime,
    });
    const timeout = input.timeout ?? 30_000;
    this.taskTimeouts.set(
      executionKey,
      setTimeout(() => abortController.abort(), timeout),
    );

    try {
      const mapping = getTaskActionMapping(input.action);
      if (!mapping) return this.failure(input, lease, "UNKNOWN_ACTION", `Unknown task action: ${input.action}`);
      const plugin = this.plugins.get(mapping.pluginName);
      if (!plugin) return this.failure(input, lease, "PLUGIN_NOT_FOUND", `Plugin not found: ${mapping.pluginName}`);
      const output = await this.invokePlugin(
        plugin,
        mapping,
        input.action,
        input.taskId,
        sessionId,
        input.params,
        abortController.signal,
        hooks,
      );
      return {
        taskId: input.taskId,
        status: "success",
        retryable: false,
        output: typeof output === "string" ? output : JSON.stringify(output),
        leaseId: lease.leaseId,
        correlationId: lease.correlationId,
        metrics: { duration: Date.now() - startTime },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const normalized = normalizeError(error);
      if (isSandboxUnavailable(error, normalized)) {
        await this.releaseLease(lease.leaseId);
        return {
          taskId: input.taskId,
          status: "failure",
          leaseId: lease.leaseId,
          correlationId: lease.correlationId,
          retryable: true,
          error: {
            code: "SANDBOX_UNAVAILABLE",
            message: "Sandbox container became unavailable during execution",
            details: normalized.details,
          },
          metrics: { duration },
        };
      }
      const timedOut = abortController.signal.aborted && duration >= timeout;
      return {
        taskId: input.taskId,
        status: timedOut ? "timeout" : "failure",
        leaseId: lease.leaseId,
        correlationId: lease.correlationId,
        retryable: timedOut,
        error: normalized,
        metrics: { duration },
      };
    } finally {
      this.activeExecutions.delete(executionKey);
      const timeoutHandle = this.taskTimeouts.get(executionKey);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.taskTimeouts.delete(executionKey);
    }
  }

  async cancelTask(_sessionId: string, taskId: string): Promise<boolean> {
    const entry = Array.from(this.activeExecutions.values()).find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!entry) return false;
    entry.abortController.abort();
    return true;
  }

  async getHealth(_sessionId: string): Promise<{ healthy: boolean; memoryUsed?: number; cpuUsage?: number }> {
    return { healthy: this.plugins.size > 0 };
  }

  async cleanup(sessionId: string): Promise<void> {
    for (const [key, entry] of this.activeExecutions) {
      if (entry.leaseId !== sessionId) continue;
      entry.abortController.abort();
      this.activeExecutions.delete(key);
      const timeout = this.taskTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.taskTimeouts.delete(key);
    }
  }

  async releaseLease(leaseId: string): Promise<boolean> {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    for (const [key, entry] of this.activeExecutions) {
      if (entry.leaseId !== leaseId) continue;
      entry.abortController.abort();
      this.activeExecutions.delete(key);
      const timeout = this.taskTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.taskTimeouts.delete(key);
    }
    this.leases.delete(leaseId);
    const key = workspaceLeaseKey(lease);
    if (this.leaseKeys.get(key) === leaseId) this.leaseKeys.delete(key);
    const destroy = (this.sandbox as unknown as { destroy?: () => Promise<void> }).destroy;
    if (typeof destroy === "function") await destroy.call(this.sandbox);
    return true;
  }

  private isActiveLease(lease: SandboxExecutionLease): boolean {
    return this.leases.get(lease.leaseId) === lease && !isLeaseExpired(lease);
  }

  private failure(
    input: TaskExecutionInput,
    lease: SandboxExecutionLease,
    code: string,
    message: string,
  ): TaskExecutionResult {
    return {
      taskId: input.taskId,
      status: "failure",
      leaseId: lease.leaseId,
      correlationId: lease.correlationId,
      retryable: false,
      error: { code, message },
    };
  }

  private async invokePlugin(
    plugin: IPlugin,
    mapping: TaskActionMapping,
    action: string,
    taskId: string,
    sessionId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    hooks?: TaskExecutionHooks,
  ): Promise<unknown> {
    if (mapping.method === "execute") {
      const pluginAction = resolveExecutePayloadAction(action, params);
      const runId = params.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        throw { code: "INVALID_INPUT", message: "runId is required for plugin execution" };
      }
      let logDrain = Promise.resolve();
      const result = await plugin.execute(
        this.sandbox,
        {
          ...params,
          action: pluginAction,
          __toolbox: { callId: taskId, runId, toolName: `${mapping.pluginName}.${pluginAction}` },
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
    const methodValue = (plugin as unknown as Record<string, unknown>)[mapping.method];
    if (typeof methodValue !== "function") throw { code: "METHOD_NOT_FOUND", message: `Method ${mapping.method} not found on plugin ${mapping.pluginName}` };
    return (methodValue as (sessionId: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>).call(
      plugin,
      sessionId,
      { ...params, __toolbox: { callId: taskId, runId: typeof params.runId === "string" ? params.runId : undefined, toolName: action } },
      { signal },
    );
  }
}

function encodeSandboxId(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
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
