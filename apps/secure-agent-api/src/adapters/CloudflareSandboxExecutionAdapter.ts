import type { Sandbox } from "@cloudflare/sandbox";
import type { IPlugin, PluginExecutionContext } from "../interfaces/types";
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
import type { NativeCommandClosure } from "@repo/shared-types/native-command-closure";
import { sanitizeLogText } from "../core/security/LogSanitizer";

interface TaskActionMapping {
  pluginName: string;
  method: string;
}

type TerminationReason = "cancelled" | "timeout";

const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

interface ActiveTaskExecution {
  leaseId: string;
  taskId: string;
  abortController: AbortController;
  terminationReason?: TerminationReason;
  readonly quiescence: Promise<void>;
  readonly resolveQuiescence: () => void;
  pluginSettled: boolean;
  executionSettled: boolean;
  pluginOperation?: Promise<unknown>;
  readonly nativeCommands?: TaskExecutionInput["nativeCommands"];
  nativeClosure?: NativeCommandClosure;
}

interface LeaseRegistration {
  readonly lease: SandboxExecutionLease;
  release?: Promise<LeaseReleaseResult>;
  destruction?: Promise<void>;
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
  private readonly leases = new Map<string, LeaseRegistration>();
  private sandboxClosing = false;
  private readonly fencedLeases = new Set<string>();
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
    if (this.sandboxClosing || this.fencedLeases.has(lease.leaseId) || (existing && !sameRegisteredLease(existing.lease, lease))) {
      throw new SandboxLeaseError(
        "SANDBOX_LEASE_COLLISION",
        "A lease id cannot be rebound to a different workspace run-attempt",
        false,
        lease.correlationId,
      );
    }
    if (!existing) this.leases.set(lease.leaseId, { lease: Object.freeze({ ...lease, workspaceScope: Object.freeze({ ...lease.workspaceScope }) }) });
  }

  async acquireLease(
    request: SandboxExecutionLeaseRequest,
  ): Promise<SandboxExecutionLease> {
    const lease = await createSandboxLease(request);
    this.registerLease(lease);
    return lease;
  }

  async executeTask(
    leaseId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    // Capture all caller-owned dispatch data before the queue can yield. The
    // private server capability is deliberately retained by reference, not cloned.
    input = snapshotTaskInput(input);
    hooks = hooks ? Object.freeze({ onLog: hooks.onLog }) : undefined;
    if (leaseId !== input.lease.leaseId || !this.isActiveLease(input.lease)) {
      return this.leaseFailure(input);
    }
    const key = this.executionKey(leaseId, input.taskId);
    if (this.activeExecutions.has(key)) {
      return this.failure(input, "SANDBOX_TASK_ALREADY_OWNED", "The original task is already owned; reconcile it without redispatching.");
    }
    let resolveQuiescence!: () => void;
    const quiescence = new Promise<void>(resolve => { resolveQuiescence = resolve; });
    const active: ActiveTaskExecution = {
      leaseId, taskId: input.taskId, abortController: new AbortController(),
      quiescence, resolveQuiescence, pluginSettled: false, executionSettled: false,
      nativeCommands: input.nativeCommands,
    };
    // This same map reserves queued and running originals. Never overwrite an
    // original loan with a duplicate read-only or borrowed task.
    this.activeExecutions.set(key, active);
    const execute = async () => {
      try { return await this.executeTaskWithLease(input, active, hooks); }
      finally {
        active.executionSettled = true;
        if (!active.pluginOperation) this.markPluginSettled(key, active);
        if (active.nativeCommands) await this.refreshNativeClosure(active);
        // A settled plugin alone is not Native physical proof. Keep the exact
        // original entry and its receipt until positive lease release.
        if (!active.pluginSettled || (active.nativeCommands && active.nativeClosure?.state !== "settled")) {
          this.fenceLease(leaseId);
        }
        if (this.activeExecutions.get(key) === active) {
          const timeout = this.taskTimeouts.get(key);
          if (timeout) clearTimeout(timeout);
          this.taskTimeouts.delete(key);
        }
      }
    };
    return input.lease.mutationMode === "serialized"
      ? this.withWorkspaceMutationLock(input.lease, execute)
      : execute();
  }

  async cancelTask(leaseId: string, taskId: string): Promise<boolean> {
    const active = this.activeExecutions.get(this.executionKey(leaseId, taskId));
    if (!active || active.pluginSettled || active.terminationReason === "timeout") return false;
    active.terminationReason = "cancelled";
    active.abortController.abort();
    return await waitForQuiescence(active, 2_000);
  }

  async getHealth(_leaseId: string): Promise<{ healthy: boolean }> {
    return { healthy: this.plugins.size > 0 && this.leases.size > 0 };
  }

  async cleanup(leaseId: string): Promise<void> {
    this.fenceLease(leaseId);
    const originals: Promise<unknown>[] = [];
    for (const [key, active] of this.activeExecutions) {
      if (active.leaseId !== leaseId) continue;
      if (active.pluginOperation) originals.push(active.pluginOperation);
      active.terminationReason = "cancelled";
      active.abortController.abort();
      const timeout = this.taskTimeouts.get(key);
      if (timeout) clearTimeout(timeout);
      this.taskTimeouts.delete(key);
    }
    // Only actual original plugin operations, never this wrapper, queue tail or
    // executionSettled: self-release from a rejected plugin cannot deadlock.
    await Promise.allSettled(originals);
  }

  async releaseLease(
    leaseId: string,
    options: { destroySandbox?: boolean } = {},
  ): Promise<LeaseReleaseResult> {
    const registration = this.leases.get(leaseId);
    if (!registration) return { released: false, sandboxReleased: false };
    if (registration.release) return registration.release;
    // Retain the original release loan in this same owner registration before
    // cleanup can await. Concurrent release cannot destroy or drop it twice.
    const operation = Promise.resolve().then(() => this.releaseRegisteredLease(leaseId, registration, options.destroySandbox !== false));
    registration.release = operation;
    try { return await operation; }
    finally { if (registration.release === operation) registration.release = undefined; }
  }

  private async releaseRegisteredLease(
    leaseId: string, registration: LeaseRegistration, destroy: boolean,
  ): Promise<LeaseReleaseResult> {
    // Creator eligibility and physical reference ownership are separate. A
    // fenced registration still counts while its original work is closing.
    await this.cleanup(leaseId);
    const owned = [...this.activeExecutions.entries()].filter(([, active]) => active.leaseId === leaseId);
    for (const [, active] of owned) {
      if (active.nativeCommands) {
        await this.refreshNativeClosure(active);
        if (active.nativeClosure?.state !== "settled") return { released: false, sandboxReleased: false };
      }
    }
    if (this.leases.get(leaseId) !== registration) return { released: false, sandboxReleased: false };
    const sandboxReleased = this.leases.size === 1;
    if (sandboxReleased && destroy) {
      // Close admission synchronously before physical destruction can yield.
      // A failed destroy retains this fenced owner for exact retry/reconciliation.
      this.sandboxClosing = true;
      registration.destruction ??= Promise.resolve().then(() => this.sandbox.destroy());
      await destroySandbox(registration.destruction);
    }
    this.leases.delete(leaseId);
    for (const [key, active] of owned) {
      if (this.activeExecutions.get(key) === active) this.activeExecutions.delete(key);
    }
    return { released: true, sandboxReleased };
  }

  private async refreshNativeClosure(active: ActiveTaskExecution): Promise<void> {
    if (active.nativeClosure?.state === "settled" || !active.pluginSettled) return;
    try {
      // Seal the captured task's actual creator before reading evidence. The
      // stop boolean is ignored; only the typed physical receipt can release.
      await active.nativeCommands?.stop();
      const receipt = await active.nativeCommands?.closureEvidence?.();
      if (receipt?.state === "settled") active.nativeClosure = receipt;
    } catch { /* Missing/corrupt/originally unknown evidence remains owned. */ }
  }

  private async executeTaskWithLease(
    input: TaskExecutionInput,
    active: ActiveTaskExecution,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    const { lease } = input;
    // A serialized mutation can wait behind earlier work. The initial check
    // in executeTask() is therefore insufficient: validate the exact lease
    // again after the queue wait and immediately before dispatching the plugin.
    if (!this.isActiveLease(lease)) return this.leaseFailure(input);
    const startedAt = Date.now();
    const key = this.executionKey(lease.leaseId, input.taskId);
    if (this.activeExecutions.get(key) !== active) return this.leaseFailure(input);
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
      let launch!: () => void;
      const pluginOperation = new Promise<unknown>((resolve, reject) => {
        launch = () => {
          if (!this.isActiveLease(lease) || this.activeExecutions.get(key) !== active) {
            reject(new Error("Sandbox lease was fenced before dispatch")); return;
          }
          if (active.abortController.signal.aborted) {
            reject(new TaskInterruptedError(active.terminationReason ?? "cancelled")); return;
          }
          void this.invokePlugin(plugin, mapping, input, active.abortController.signal, hooks).then(resolve, reject);
        };
      });
      // Register the original promise before invokePlugin can produce effects.
      active.pluginOperation = pluginOperation;
      void pluginOperation.then(
        () => this.markPluginSettled(key, active),
        () => this.markPluginSettled(key, active),
      );
      launch();
      const output = await raceWithAbort(
        pluginOperation,
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
        if (!input.borrowedLease) {
          await this.releaseLease(lease.leaseId, { destroySandbox: false });
        }
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
    }
  }

  private markPluginSettled(key: string, active: ActiveTaskExecution): void {
    if (this.activeExecutions.get(key) !== active || active.pluginSettled) return;
    active.pluginSettled = true;
    active.resolveQuiescence();
  }

  private fenceLease(leaseId: string): void {
    // Keep its registration counted until the exact original owner releases it.
    this.fencedLeases.add(leaseId);
  }

  private isActiveLease(lease: SandboxExecutionLease): boolean {
    const stored = this.leases.get(lease.leaseId);
    return (
      stored !== undefined &&
      !this.fencedLeases.has(lease.leaseId) &&
      sameRegisteredLease(stored.lease, lease) &&
      !this.sandboxClosing &&
      !isLeaseExpired(stored.lease)
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
      if (runId !== input.lease.workspaceScope.runId) {
        throw {
          code: "WORKSPACE_SCOPE_MISMATCH",
          message: "Plugin run id does not match the active server-issued workspace scope",
        };
      }
      const pluginContext: PluginExecutionContext = {
        workspaceScope: input.lease.workspaceScope,
        ...(input.borrowedLease ? { borrowedLease: true } : {}),
        ...(input.nativeCommands ? { nativeCommands: input.nativeCommands } : {}),
      };
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
        pluginContext,
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

async function waitForQuiescence(
  active: ActiveTaskExecution,
  timeoutMs: number,
): Promise<boolean> {
  if (active.pluginSettled) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      active.quiescence,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Plugin did not quiesce")), timeoutMs);
      }),
    ]);
    return active.pluginSettled;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function destroySandbox(original: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Sandbox cleanup timed out")),
          SANDBOX_DESTROY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    format_file: { pluginName: "filesystem", method: "execute" },
    list_files: { pluginName: "filesystem", method: "execute" }, make_dir: { pluginName: "filesystem", method: "execute" },
    git_status: { pluginName: "git", method: "execute" }, git_diff: { pluginName: "git", method: "execute" }, git_commit: { pluginName: "git", method: "execute" }, git_push: { pluginName: "git", method: "execute" },
    execute_python: { pluginName: "python", method: "execute" }, execute_node: { pluginName: "node", method: "execute" }, execute_rust: { pluginName: "rust", method: "execute" },
  };
  return legacy[action] ?? null;
}

function normalizeLogEntry(entry: string | { message: string; source?: "stdout" | "stderr" }): { message: string; source?: "stdout" | "stderr" } | null {
  if (typeof entry === "string") {
    return entry.length > 0 ? { message: sanitizeLogText(entry) } : null;
  }
  return entry.message.length > 0
    ? { ...entry, message: sanitizeLogText(entry.message) }
    : null;
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

function sameRegisteredLease(a: SandboxExecutionLease, b: SandboxExecutionLease): boolean {
  return a.leaseId === b.leaseId && a.sandboxId === b.sandboxId && a.owner === b.owner &&
    a.correlationId === b.correlationId && a.expiresAt === b.expiresAt && a.generation === b.generation &&
    a.executionDomainDigest === b.executionDomainDigest && a.mutationMode === b.mutationMode &&
    Object.keys(a.workspaceScope).every(key => a.workspaceScope[key as keyof typeof a.workspaceScope] === b.workspaceScope[key as keyof typeof b.workspaceScope]);
}

function snapshotTaskInput(input: TaskExecutionInput): TaskExecutionInput {
  return Object.freeze({ ...input,
    params: freezeDispatchData(structuredClone(input.params)),
    lease: Object.freeze({ ...input.lease, workspaceScope: Object.freeze({ ...input.lease.workspaceScope }) }),
    nativeCommands: input.nativeCommands,
  });
}

function freezeDispatchData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value)) freezeDispatchData(nested, seen);
    Object.freeze(value);
  }
  return value;
}
