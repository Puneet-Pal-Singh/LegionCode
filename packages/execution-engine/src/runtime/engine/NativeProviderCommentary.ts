interface CommentaryToolCall {
  toolName: string;
}

export function resolveModelCommentary(
  visibleText: string,
  toolCalls: readonly CommentaryToolCall[] = [],
): string | null {
  const modelCommentary = visibleText.trim();
  if (modelCommentary) return modelCommentary;
  if (toolCalls.length === 0) return null;

  const toolNames = toolCalls.map((toolCall) => toolCall.toolName);
  if (toolNames.some(isMutationTool)) {
    return "I’ll update the relevant files next.";
  }
  if (toolNames.some(isGitTool)) {
    return "I’ll inspect the repository state next.";
  }
  if (toolNames.some(isCommandTool)) {
    return "I’ll run the focused command next.";
  }
  if (toolNames.some(isWorkspaceInspectionTool)) {
    return "I’ll inspect the relevant project files next.";
  }
  return "I’ll continue with the next tool step.";
}

function isMutationTool(toolName: string): boolean {
  return /(?:^|_)(?:apply_patch|edit|write|create|delete|remove|move|rename)(?:_|$)/i.test(
    toolName,
  );
}

function isGitTool(toolName: string): boolean {
  return /(?:^|_)git(?:_|$)/i.test(toolName);
}

function isCommandTool(toolName: string): boolean {
  return /(?:bash|shell|command|terminal|exec)/i.test(toolName);
}

function isWorkspaceInspectionTool(toolName: string): boolean {
  return /(?:read|list|glob|grep|search|find|view)/i.test(toolName);
}
