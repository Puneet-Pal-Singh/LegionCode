import {
  buildInvalidToolInputError,
  type RunCapabilityManifest,
  type StructuredToolError,
} from "../capabilities/index.js";

interface ToolCallRef {
  toolName: string;
  args: Record<string, unknown>;
}

export function buildReadOnlyToolFingerprint(
  toolCall: ToolCallRef,
): string {
  return `${toolCall.toolName}:${stableSerialize(toolCall.args)}`;
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function buildStructuredToolFailureError(input: {
  toolName: string;
  errorMessage: string;
  manifest: RunCapabilityManifest;
}): StructuredToolError | null {
  if (!isValidationFailure(input.errorMessage, input.toolName)) {
    return null;
  }
  return buildInvalidToolInputError({
    attemptedTool: input.toolName,
    validationMessage: input.errorMessage,
    manifest: input.manifest,
  });
}

export function isValidationFailure(message: string, toolName: string): boolean {
  return message.startsWith(`Invalid ${toolName} input.`);
}
