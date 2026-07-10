export interface ConversationScope {
  /** Server-issued workspace boundary. */
  readonly workspaceId: string;
  /** Server-issued session/thread identity. */
  readonly sessionId: string;
  /** Canonical active turn, when a run has started one. */
  readonly turnId: string | null;
  /** Server-issued run attempt identity. */
  readonly runId: string;
}

export function createConversationScope(input: {
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId?: string | null;
}): ConversationScope {
  return Object.freeze({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    runId: input.runId,
  });
}

export function conversationScopeKey(scope: ConversationScope): string {
  return [
    scope.workspaceId,
    scope.sessionId,
    scope.turnId ?? "no-turn",
    scope.runId,
  ]
    .map(encodeURIComponent)
    .join("/");
}

export function sameConversationScope(
  left: ConversationScope,
  right: ConversationScope,
): boolean {
  return conversationScopeKey(left) === conversationScopeKey(right);
}
