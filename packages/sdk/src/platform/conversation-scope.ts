import { workspaceIdFromExternalId } from "@repo/platform-protocol";

export function sameConversationScope(left: ConversationScope | null | undefined,
  right: ConversationScope | null | undefined): boolean {
  return Boolean(left && right && left.sessionId === right.sessionId && left.runId === right.runId &&
    workspaceIdFromExternalId(left.workspaceId) === workspaceIdFromExternalId(right.workspaceId) &&
    left.threadId === right.threadId && left.turnId === right.turnId && left.runAttemptId === right.runAttemptId);
}

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
