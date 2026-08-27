import type { CodingToolId } from "../tools/CodingToolRegistry.js";
import type { TaskInput, TaskResult } from "../types.js";
import { formatRuntimeDiagnosticLogLine } from "../lib/RuntimeDiagnosticLog.js";

interface ToolDiagnosticContext {
  taskId: string;
  toolName: CodingToolId;
  routePlugin: string;
  routeAction: string;
  startedAt: number;
}

export function logAgenticLoopToolStarted(
  context: ToolDiagnosticContext,
  toolInput: TaskInput,
): void {
  console.log(
    formatRuntimeDiagnosticLogLine("agentic-loop/tool-executor", "started", {
      taskId: context.taskId,
      toolName: context.toolName,
      routePlugin: context.routePlugin,
      routeAction: context.routeAction,
      argKeys: Object.keys(toolInput).sort(),
    }),
  );
}

export function logAgenticLoopToolFinished(
  context: ToolDiagnosticContext,
  result: TaskResult,
  boundErrorMessage: (value: string) => string,
): void {
  console.log(
    formatRuntimeDiagnosticLogLine("agentic-loop/tool-executor", "finished", {
      taskId: context.taskId,
      toolName: context.toolName,
      routePlugin: context.routePlugin,
      routeAction: context.routeAction,
      status: result.status,
      elapsedMs: Date.now() - context.startedAt,
      outputChars: result.output?.content.length ?? 0,
      errorCode: result.error?.code ?? null,
      errorMessage: result.error?.message
        ? boundErrorMessage(result.error.message)
        : null,
    }),
  );
}

export function logAgenticLoopToolThrew(
  context: ToolDiagnosticContext,
  error: unknown,
  boundErrorMessage: (value: string) => string,
): void {
  console.error(
    formatRuntimeDiagnosticLogLine("agentic-loop/tool-executor", "threw", {
      taskId: context.taskId,
      toolName: context.toolName,
      routePlugin: context.routePlugin,
      routeAction: context.routeAction,
      elapsedMs: Date.now() - context.startedAt,
      errorMessage:
        error instanceof Error
          ? boundErrorMessage(error.message)
          : String(error),
    }),
  );
}
