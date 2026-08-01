import {
  safeParseToolActivityMetadata,
  type ToolActivityMetadata,
} from "@repo/shared-types";
import { isMutatingCodingToolId } from "../tools/CodingToolRegistry.js";
import {
  GitToolFailureClassifier,
  shouldClassifyAsGitOrShellFailure,
} from "./GitToolFailureClassifier.js";

const gitToolFailureClassifier = new GitToolFailureClassifier();

export function isTerminalToolFailure(input: {
  toolName: string;
  error: string;
  failureCode?: string;
  metadata?: unknown;
}): boolean {
  if (
    input.failureCode === "validation_failed" ||
    isRecoverableToolFailure(input.toolName, input.error)
  ) {
    return false;
  }

  const metadata = extractToolActivityMetadata(input.metadata);
  if (
    shouldClassifyAsGitOrShellFailure({
      toolName: input.toolName,
      metadata,
    })
  ) {
    return gitToolFailureClassifier.classify({
      toolName: input.toolName,
      message: input.error,
      metadata,
    }).terminal;
  }

  return isMutatingCodingToolId(input.toolName);
}

function isRecoverableToolFailure(toolName: string, error: string): boolean {
  const normalizedError = error.trim().toLowerCase();

  if (toolName === "edit_file" || toolName === "multi_edit") {
    return (
      normalizedError.includes("exact edit text was not found") ||
      normalizedError.includes("exact replacement text was not found") ||
      normalizedError.includes("exact edit is ambiguous") ||
      normalizedError.includes(
        "multi_edit cannot target the same path more than once",
      )
    );
  }

  if (
    toolName === "read_file" ||
    toolName === "list_files" ||
    toolName === "glob" ||
    toolName === "grep"
  ) {
    return (
      normalizedError.includes("no such file or directory") ||
      normalizedError.includes("file not found") ||
      normalizedError.includes("cannot stat") ||
      normalizedError.includes("cannot statx") ||
      normalizedError.includes("not found")
    );
  }

  return false;
}

function extractToolActivityMetadata(
  metadata: unknown,
): ToolActivityMetadata | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const activity = (metadata as Record<string, unknown>).activity;
  const parsed = safeParseToolActivityMetadata(activity);
  return parsed.success ? parsed.data : undefined;
}
