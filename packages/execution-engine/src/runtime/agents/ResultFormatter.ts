const PRIMARY_TEXT_KEYS = [
  "content",
  "output",
  "stdout",
  "message",
  "text",
  "result",
] as const;

export function formatExecutionResult(result: unknown): string {
  if (typeof result === "string") {
    return redactInternalRuntimeDetails(result);
  }
  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }
  if (!result) {
    return "";
  }
  if (isRecord(result)) {
    const directText = findPrimaryText(result);
    if (directText) {
      return redactInternalRuntimeDetails(directText);
    }
    if ("data" in result) {
      const nestedText = formatExecutionResult(result.data);
      if (nestedText) {
        return nestedText;
      }
    }
  }
  return redactInternalRuntimeDetails(safeStringify(result));
}

export function formatTaskOutput(outputContent: unknown): string {
  const formatted = formatExecutionResult(outputContent);
  return formatted || "no output";
}

export function extractExecutionFailure(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }

  const secureStatus = readStringField(result.status);
  if (secureStatus === "timeout") {
    return buildExecutionStatusFailure("TOOL_TIMEOUT", result);
  }
  if (secureStatus === "failure") {
    return buildExecutionStatusFailure("TOOL_FAILED", result);
  }
  if (secureStatus === "cancelled") {
    return buildExecutionStatusFailure("TOOL_CANCELLED", result);
  }

  if (result.success === false) {
    const explicitError = readErrorMessage(result.error);
    if (explicitError) {
      return redactInternalRuntimeDetails(explicitError);
    }

    const message =
      readStringField(result.message) ?? readStringField(result.stderr);
    if (message) {
      return redactInternalRuntimeDetails(message);
    }

    return "Execution failed";
  }

  const stderr = readStringField(result.stderr);
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return redactInternalRuntimeDetails(
      stderr ?? `Command failed with exit code ${result.exitCode}`,
    );
  }

  return null;
}

function buildExecutionStatusFailure(
  code: "TOOL_TIMEOUT" | "TOOL_FAILED" | "TOOL_CANCELLED",
  result: Record<string, unknown>,
): string {
  const message =
    readErrorMessage(result.error) ??
    readStringField(result.message) ??
    readStringField(result.stderr) ??
    readStringField(result.output) ??
    defaultExecutionStatusMessage(code);
  return `${code}: ${redactInternalRuntimeDetails(message)}`;
}

function readErrorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (isRecord(error)) {
    return readStringField(error.message) ?? readStringField(error.code);
  }
  return null;
}

function defaultExecutionStatusMessage(
  code: "TOOL_TIMEOUT" | "TOOL_FAILED" | "TOOL_CANCELLED",
): string {
  switch (code) {
    case "TOOL_TIMEOUT":
      return "Tool execution timed out.";
    case "TOOL_CANCELLED":
      return "Tool execution was cancelled.";
    case "TOOL_FAILED":
      return "Tool execution failed.";
  }
}

function findPrimaryText(record: Record<string, unknown>): string | null {
  for (const key of PRIMARY_TEXT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (isRecord(value) && typeof value.content === "string") {
      const nested = value.content.trim();
      if (nested.length > 0) {
        return nested;
      }
    }
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function redactInternalRuntimeDetails(text: string): string {
  return text
    .replace(
      /\/home\/sandbox\/runs\/(?:\[run\]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^\s"']+/gi,
      "the workspace file",
    )
    .replace(
      /\/home\/sandbox\/runs\/(?:\[run\]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
      "the workspace directory",
    )
    .replace(
      /(?:error:\s*)?cat:\s*(?:the workspace file|\[workspace-file\])\s*:?\s*no such file or directory/gi,
      "The requested file was not found in the current workspace.",
    )
    .replace(
      /(?:error:\s*)?cat:\s*(?:the workspace file|\[workspace-file\])\s*:?\s*is a directory/gi,
      "The requested path is a directory. Please provide a file path.",
    )
    .replace(/http:\/\/internal(?:\/[^\s"']*)?/gi, "[internal-url]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (isRecord(value)) {
    const content =
      typeof value.content === "string"
        ? value.content
        : typeof value.output === "string"
          ? value.output
          : typeof value.message === "string"
            ? value.message
            : typeof value.code === "string"
              ? value.code
          : null;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
  }

  return null;
}
