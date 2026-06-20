/**
 * CloudflareSandboxExecutionAdapter - Implements SandboxExecutionPort using Cloudflare Sandbox.
 *
 * Adapts Cloudflare sandbox primitives to the canonical SandboxExecutionPort interface.
 * Encapsulates plugin execution, error handling, and health monitoring.
 *
 * Canonical alignment: ExecutionSandboxPort (Charter 46)
 */

import { Sandbox } from "@cloudflare/sandbox";
import {
  SandboxExecutionPort,
  TaskExecutionHooks,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import { IPlugin } from "../interfaces/types";

/**
 * Maps task action to plugin name and method.
 * Ensures deterministic routing of tasks to correct plugins.
 */
interface TaskActionMapping {
  pluginName: string;
  method: string;
}

/**
 * Tracks active task executions for cancellation support.
 */
interface ActiveTaskExecution {
  taskId: string;
  abortController: AbortController;
  startTime: number;
}

interface ToolboxPayloadContext {
  __toolbox: {
    callId: string;
    runId?: string;
    toolName: string;
  };
}

function resolveExecutePayloadAction(
  taskAction: string,
  params: Record<string, unknown>,
): string {
  const requestedAction = params.action;
  if (typeof requestedAction === "string") {
    const normalizedAction = requestedAction.trim();
    if (normalizedAction.length > 0) {
      return normalizedAction;
    }
  }
  if (!taskAction.includes(".")) {
    return taskAction;
  }
  throw {
    code: "INVALID_INPUT",
    message: "action is required for execute-style plugin routing",
  };
}

export class CloudflareSandboxExecutionAdapter implements SandboxExecutionPort {
  private activeExecutions = new Map<string, ActiveTaskExecution>();
  private taskTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private sandbox: Sandbox,
    private plugins: Map<string, IPlugin>,
  ) {}

  /**
   * Execute a single task by routing to the appropriate plugin.
   * Implements timeout, abort, and error handling.
   */
  async executeTask(
    sessionId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    const startTime = Date.now();
    const abortController = new AbortController();
    const activeTask: ActiveTaskExecution = {
      taskId: input.taskId,
      abortController,
      startTime,
    };

    this.activeExecutions.set(input.taskId, activeTask);

    try {
      // Determine timeout: use provided, or fallback to 30s
      const timeout = input.timeout ?? 30000;

      // Set up timeout cleanup
      const timeoutHandle = setTimeout(() => {
        abortController.abort();
        this.activeExecutions.delete(input.taskId);
      }, timeout);

      this.taskTimeouts.set(input.taskId, timeoutHandle);

      // Route task to appropriate plugin
      const mapping = this.getTaskActionMapping(input.action);
      if (!mapping) {
        return {
          taskId: input.taskId,
          status: "failure",
          error: {
            code: "UNKNOWN_ACTION",
            message: `Unknown task action: ${input.action}`,
          },
        };
      }

      const plugin = this.plugins.get(mapping.pluginName);
      if (!plugin) {
        return {
          taskId: input.taskId,
          status: "failure",
          error: {
            code: "PLUGIN_NOT_FOUND",
            message: `Plugin not found: ${mapping.pluginName}`,
          },
        };
      }

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

      const duration = Date.now() - startTime;

      return {
        taskId: input.taskId,
        status: "success",
        output: typeof output === "string" ? output : JSON.stringify(output),
        metrics: { duration },
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = this.normalizeError(err);

      // Detect timeout vs other errors
      let status: "failure" | "timeout" = "failure";
      if (
        abortController.signal.aborted &&
        duration >= (input.timeout ?? 30000)
      ) {
        status = "timeout";
      }

      const normalizedError = {
        code: error.code || "EXECUTION_ERROR",
        message: error.message || "Unknown error",
        details: error.details,
      };

      return {
        taskId: input.taskId,
        status,
        error: normalizedError,
        metrics: { duration },
      };
    } finally {
      // Clean up
      this.activeExecutions.delete(input.taskId);
      const timeoutHandle = this.taskTimeouts.get(input.taskId);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        this.taskTimeouts.delete(input.taskId);
      }
    }
  }

  /**
   * Cancel an ongoing task execution.
   * Signals the abort controller to stop the task.
   */
  async cancelTask(sessionId: string, taskId: string): Promise<boolean> {
    const activeTask = this.activeExecutions.get(taskId);
    if (!activeTask) {
      return false; // Task not found or already completed
    }

    activeTask.abortController.abort();
    return true;
  }

  /**
   * Get sandbox health status.
   * Checks if sandbox is operational and resources available.
   */
  async getHealth(
    sessionId: string,
  ): Promise<{ healthy: boolean; memoryUsed?: number; cpuUsage?: number }> {
    try {
      // Basic health check: if plugins are loaded, assume healthy
      const healthy = this.plugins.size > 0;
      return {
        healthy,
        // Cloudflare sandbox doesn't expose detailed metrics
        // in a portable way, so we keep these optional
      };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Clean up sandbox resources for a session.
   * Called when session ends to free resources.
   */
  async cleanup(sessionId: string): Promise<void> {
    // Cancel any active executions for this session
    // (In a real implementation, we'd track session->taskId mappings)
    // For now, we just ensure timeouts are cleared
    this.taskTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.taskTimeouts.clear();
    this.activeExecutions.clear();
  }

  /**
   * Maps task action strings to plugin method calls.
   * Deterministic routing ensures same action always routes to same plugin.
   */
  private getTaskActionMapping(action: string): TaskActionMapping | null {
    // Standard action patterns: "plugin.method"
    const parts = action.split(".");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return {
        pluginName: parts[0],
        method: parts[1],
      };
    }

    // Legacy mappings for backward compatibility
    const legacyMappings: Record<string, TaskActionMapping> = {
      read_file: { pluginName: "filesystem", method: "execute" },
      write_file: { pluginName: "filesystem", method: "execute" },
      edit_file: { pluginName: "filesystem", method: "execute" },
      multi_edit: { pluginName: "filesystem", method: "execute" },
      format_file: { pluginName: "filesystem", method: "execute" },
      language_diagnostics: { pluginName: "filesystem", method: "execute" },
      list_files: { pluginName: "filesystem", method: "execute" },
      make_dir: { pluginName: "filesystem", method: "execute" },
      git_status: { pluginName: "git", method: "execute" },
      git_diff: { pluginName: "git", method: "execute" },
      git_commit: { pluginName: "git", method: "execute" },
      git_push: { pluginName: "git", method: "execute" },
      execute_python: { pluginName: "python", method: "execute" },
      execute_node: { pluginName: "node", method: "execute" },
      execute_rust: { pluginName: "rust", method: "execute" },
    };

    return legacyMappings[action] ?? null;
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
      const payload: Record<string, unknown> & {
        action: string;
      } & ToolboxPayloadContext = {
        ...params,
        action: pluginAction,
        __toolbox: {
          callId: taskId,
          runId: typeof runId === "string" ? runId : undefined,
          toolName: `${mapping.pluginName}.${pluginAction}`,
        },
      };
      if (typeof runId !== "string" || runId.length === 0) {
        throw {
          code: "INVALID_INPUT",
          message: "runId is required for plugin execution",
        };
      }
      let logDrain = Promise.resolve();
      const result = await plugin.execute(this.sandbox, payload, (entry) => {
        const normalized = normalizeLogEntry(entry);
        if (!normalized) {
          return;
        }
        logDrain = logDrain.then(async () => {
          await hooks?.onLog?.(normalized);
        });
      });
      await logDrain;
      if (!result.success) {
        throw {
          code: "PLUGIN_EXECUTION_FAILED",
          message:
            result.error ?? `Plugin ${mapping.pluginName} execution failed`,
          details: result.logs,
        };
      }
      return result.output ?? "";
    }

    const methodValue = (plugin as unknown as Record<string, unknown>)[
      mapping.method
    ];
    if (typeof methodValue !== "function") {
      throw {
        code: "METHOD_NOT_FOUND",
        message: `Method ${mapping.method} not found on plugin ${mapping.pluginName}`,
      };
    }

    const invoker = methodValue as (
      sessionIdArg: string,
      paramsArg: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    const payload: Record<string, unknown> & ToolboxPayloadContext = {
      ...params,
      __toolbox: {
        callId: taskId,
        runId: typeof params.runId === "string" ? params.runId : undefined,
        toolName: action,
      },
    };
    return invoker.call(plugin, sessionId, payload, { signal });
  }

  /**
   * Normalize error objects to canonical TaskExecutionResult error format.
   */
  private normalizeError(err: unknown): {
    code: string;
    message: string;
    details?: unknown;
  } {
    if (err instanceof Error) {
      const errorLike = err as Error & { code?: unknown; details?: unknown };
      const code =
        typeof errorLike.code === "string" ? errorLike.code : "EXECUTION_ERROR";
      return {
        code,
        message: err.message,
        details: errorLike.details ?? err.stack,
      };
    }

    if (typeof err === "string") {
      return {
        code: "EXECUTION_ERROR",
        message: err,
      };
    }

    if (isErrorShape(err)) {
      return {
        code: err.code,
        message: err.message,
        details: err.details,
      };
    }

    return {
      code: "EXECUTION_ERROR",
      message: "Unknown error during task execution",
      details: err,
    };
  }
}

function normalizeLogEntry(
  entry:
    | string
    | {
        message: string;
        source?: "stdout" | "stderr";
      },
): { message: string; source?: "stdout" | "stderr" } | null {
  if (typeof entry === "string") {
    if (entry.length === 0) {
      return null;
    }
    return {
      message: entry,
    };
  }

  if (entry.message.length === 0) {
    return null;
  }

  return {
    message: entry.message,
    source: entry.source,
  };
}

function isErrorShape(
  value: unknown,
): value is { code: string; message: string; details?: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  return (
    typeof candidate.code === "string" && typeof candidate.message === "string"
  );
}
