import type { SafeCommandSpec } from "./SafeCommand";

export interface ToolboxCommandContext {
  callId?: string;
  runId?: string;
  toolName?: string;
  borrowedLease?: boolean;
}

export function readToolboxCommandContext(
  payload: unknown,
): ToolboxCommandContext {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const candidate = (payload as { __toolbox?: unknown }).__toolbox;
  if (!candidate || typeof candidate !== "object") {
    return {};
  }

  const record = candidate as Record<string, unknown>;

  return {
    callId: readOptionalString(record.callId),
    runId: readOptionalString(record.runId),
    toolName: readOptionalString(record.toolName),
  };
}

export function withToolboxCommandContext(
  spec: SafeCommandSpec,
  context: ToolboxCommandContext,
  toolName?: string,
): SafeCommandSpec {
  return {
    ...spec,
    callId: spec.callId ?? context.callId,
    runId: spec.runId ?? context.runId,
    toolName: spec.toolName ?? toolName ?? context.toolName,
    borrowedLease: spec.borrowedLease ?? context.borrowedLease,
  };
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
