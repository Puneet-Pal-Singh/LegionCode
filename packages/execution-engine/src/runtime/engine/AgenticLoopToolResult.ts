import {
  extractExecutionFailure,
  formatExecutionResult,
} from "../agents/ResultFormatter.js";
import type { TaskResult } from "../types.js";

export function buildMutationResult(taskId: string, result: unknown): TaskResult {
  const failure = extractExecutionFailure(result);
  return failure
    ? buildFailureResult(taskId, failure)
    : buildSuccessResult(taskId, formatExecutionResult(result));
}

export function buildSuccessResult(
  taskId: string,
  content: string,
  metadata?: Record<string, unknown>,
): TaskResult {
  return {
    taskId,
    status: "DONE",
    output: {
      content,
      metadata,
    },
    completedAt: new Date(),
  };
}

export function buildFailureResult(
  taskId: string,
  message: string,
  metadata?: Record<string, unknown>,
): TaskResult {
  return {
    taskId,
    status: "FAILED",
    error: { message },
    output: metadata
      ? {
          content: message,
          metadata,
        }
      : undefined,
    completedAt: new Date(),
  };
}
