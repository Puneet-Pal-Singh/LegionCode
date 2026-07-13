import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  TurnScopeBootstrapSchema,
  type TurnScopeBootstrap,
} from "../lib/turn-scope-contract";

export const CONVERSATION_SCOPE_READY_EVENT =
  "legioncode:conversation-scope-ready";

export interface ConversationScope {
  /** Server-issued workspace boundary. */
  readonly workspaceId: string;
  /** Server-issued durable thread identity. */
  readonly threadId: string;
  /** Server-issued active turn identity. */
  readonly turnId: string;
  /** Server-issued run attempt identity. */
  readonly runAttemptId: string;
  /** Transport correlation fields; never used as the scope key. */
  readonly sessionId: string;
  readonly runId: string;
}

export function createConversationScope(input: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  sessionId: string;
  runId: string;
}): ConversationScope {
  const identity = TurnScopeBootstrapSchema.parse({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    runAttemptId: input.runAttemptId,
  });
  return Object.freeze({
    ...identity,
    sessionId: input.sessionId,
    runId: input.runId,
  });
}

export function conversationScopeKey(scope: ConversationScope): string {
  return [
    scope.workspaceId,
    scope.threadId,
    scope.turnId,
    scope.runAttemptId,
  ]
    .map(encodeURIComponent)
    .join("/");
}

export async function bootstrapConversationScope(
  sessionId: string,
  runId: string,
): Promise<ConversationScope> {
  const response = await fetch(`${getBrainHttpBase()}/turn/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({ sessionId, runId }),
  });

  if (!response.ok) {
    throw new Error(
      `Turn scope bootstrap failed with HTTP ${response.status}`,
    );
  }

  const identity: TurnScopeBootstrap = TurnScopeBootstrapSchema.parse(
    await response.json(),
  );
  return createConversationScope({ ...identity, sessionId, runId });
}

export function publishConversationScopeReady(scope: ConversationScope): void {
  window.dispatchEvent(
    new CustomEvent(CONVERSATION_SCOPE_READY_EVENT, {
      detail: {
        sessionId: scope.sessionId,
        runId: scope.runId,
        scopeKey: conversationScopeKey(scope),
      },
    }),
  );
}

export function sameConversationScope(
  left: ConversationScope,
  right: ConversationScope,
): boolean {
  return conversationScopeKey(left) === conversationScopeKey(right);
}
