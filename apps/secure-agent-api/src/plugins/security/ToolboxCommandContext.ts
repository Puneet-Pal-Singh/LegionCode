import type { SafeCommandSpec } from "./SafeCommand";
import type { PluginExecutionContext } from "../../interfaces/types";
import type { NativeCommandCapability } from "../../toolbox/contracts/OwnedSandboxCommand";

export interface ToolboxCommandContext {
  callId?: string;
  runId?: string;
  toolName?: string;
  borrowedLease?: boolean;
  nativeCommands?: NativeCommandCapability;
}

export function readToolboxCommandContext(
  payload: unknown,
  execution?: PluginExecutionContext,
): ToolboxCommandContext {
  const trusted = { borrowedLease: execution?.borrowedLease, nativeCommands: execution?.nativeCommands };
  if (!payload || typeof payload !== "object") {
    return trusted;
  }

  const candidate = (payload as { __toolbox?: unknown }).__toolbox;
  if (!candidate || typeof candidate !== "object") {
    return trusted;
  }

  const record = candidate as Record<string, unknown>;

  return {
    ...trusted,
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
    nativeCommands: spec.nativeCommands ?? context.nativeCommands,
  };
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
