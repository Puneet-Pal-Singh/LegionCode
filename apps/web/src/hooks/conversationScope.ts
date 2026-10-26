import {
  TurnScopeBootstrapSchema,
  TurnScopeReadQuerySchema,
  RunIdSchema,
  TurnIdSchema,
} from "@legioncode/sdk";
import type { ConversationScope } from "@legioncode/sdk";
import { createHostedAppServerClient } from "../services/api/appServerClient";

export const CONVERSATION_SCOPE_READY_EVENT =
  "legioncode:conversation-scope-ready";

export function createConversationScope(input: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  revisionOfTurnId?: string;
  continuationOfTurnId?: string;
  originalPromptId?: string;
  sessionId: string;
  runId: string;
}): ConversationScope {
  const identity = TurnScopeBootstrapSchema.parse(input);
  return Object.freeze({
    ...identity,
    sessionId: input.sessionId,
    runId: input.runId,
  });
}

export function conversationScopeKey(scope: ConversationScope): string {
  return [scope.workspaceId, scope.threadId, scope.turnId, scope.runAttemptId]
    .map(encodeURIComponent)
    .join("/");
}

export function isTurnScopeRecoveryError(message: string | null): boolean {
  return Boolean(
    message &&
    (message.includes("Turn scope reconstruction failed") ||
      message.includes("TURN_SCOPE_")),
  );
}

export async function bootstrapConversationScope(
  sessionId: string,
  runId: string,
  clientMessageId: string,
  revisionOfTurnId?: string,
): Promise<ConversationScope> {
  const client = createHostedAppServerClient({
    timeoutMs: null,
    maxResponseBytes: null,
    requestHeaders: (envelope): Record<string, string> =>
      envelope.method === "turn/reserve"
        ? { "X-Correlation-Id": crypto.randomUUID() }
        : {},
  });
  const identity = await client.reserveTurnScope({
    sessionId,
    runId: RunIdSchema.parse(runId),
    clientMessageId,
    ...(revisionOfTurnId
      ? { revisionOfTurnId: TurnIdSchema.parse(revisionOfTurnId) }
      : {}),
  });
  return createConversationScope({ ...identity, sessionId, runId });
}

export async function resumeConversationScope(
  sessionId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ConversationScope | null> {
  const query = TurnScopeReadQuerySchema.safeParse({
    sessionId: sessionId.trim(),
    runId: runId.trim(),
  });
  if (!query.success) return null;

  const client = createHostedAppServerClient({
    signal,
    timeoutMs: null,
    maxResponseBytes: null,
  });
  const identity = await client.getTurnScope(query.data);
  if (!identity) return null;
  return createConversationScope({
    ...identity,
    sessionId: query.data.sessionId,
    runId: query.data.runId,
  });
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

export function isEstablishedRunScope(
  scope: ConversationScope | null,
  sessionId: string,
  runId: string,
): boolean {
  return scope?.sessionId === sessionId && scope.runId === runId;
}
