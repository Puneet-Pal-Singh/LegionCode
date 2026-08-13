import type { AgenticLoopToolCall } from "./AgenticLoop.js";
import { getToolPresentation } from "../lib/ToolPresentation.js";

export function resolveToolStepCommentary(
  visibleText: string,
  toolCalls: readonly AgenticLoopToolCall[],
): string | null {
  const modelCommentary = visibleText.trim();
  if (modelCommentary) return modelCommentary;
  const firstToolCall = toolCalls[0];
  if (!firstToolCall) return null;
  try {
    return getToolPresentation(firstToolCall.toolName, firstToolCall.args)
      .summary;
  } catch {
    return `Running ${firstToolCall.toolName.replaceAll("_", " ")}.`;
  }
}
