import {
  extractExecutionFailure,
  formatExecutionResult,
} from "../agents/ResultFormatter.js";
import type { TaskResult } from "../types.js";

export function buildMutationResult(taskId: string, result: unknown): TaskResult {
  const failure = extractExecutionFailure(result);
  const runtimeFailure = readRuntimeFailure(result);
  return failure
    ? buildFailureResult(
        taskId,
        failure,
        runtimeFailure ? { runtimeFailure } : undefined,
      )
    : buildSuccessResult(taskId, formatExecutionResult(result));
}

function readRuntimeFailure(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const metadata = (result as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const runtimeFailure = (metadata as Record<string, unknown>).runtimeFailure;
  if (
    !runtimeFailure ||
    typeof runtimeFailure !== "object" ||
    Array.isArray(runtimeFailure) ||
    typeof (runtimeFailure as Record<string, unknown>).code !== "string"
  ) {
    return null;
  }
  return runtimeFailure as Record<string, unknown>;
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
