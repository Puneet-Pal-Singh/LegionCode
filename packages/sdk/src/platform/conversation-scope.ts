export interface ConversationScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
  readonly revisionOfTurnId?: string;
  readonly continuationOfTurnId?: string;
  readonly originalPromptId?: string;
  /** Transport correlation fields; never used as the scope key. */
  readonly sessionId: string;
  readonly runId: string;
}
