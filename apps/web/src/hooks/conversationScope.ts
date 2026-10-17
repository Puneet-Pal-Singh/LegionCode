import { getBrainHttpBase } from "../lib/platform-endpoints.js";
import {
  TurnScopeBootstrapSchema,
  TurnScopeReadQuerySchema,
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
  /** The latest terminal turn this turn supersedes, when editing/retrying. */
  readonly revisionOfTurnId?: string;
}

export class ConversationScopeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "ConversationScopeHttpError";
    this.status = input.status;
    this.code = input.code;
    this.retryable =
      input.retryable ??
      (input.status >= 500 || input.status === 408 || input.status === 429);
  }
}

export function createConversationScope(input: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  sessionId: string;
  runId: string;
  revisionOfTurnId?: string;
}): ConversationScope {
  const identity = TurnScopeBootstrapSchema.parse({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    runAttemptId: input.runAttemptId,
    ...(input.revisionOfTurnId
      ? { revisionOfTurnId: input.revisionOfTurnId }
      : {}),
  });
  return Object.freeze({
    ...identity,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(identity.revisionOfTurnId
      ? { revisionOfTurnId: identity.revisionOfTurnId }
      : {}),
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

async function readScopeError(
  response: Response,
): Promise<ConversationScopeHttpError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : null;
  const code =
    typeof record?.code === "string" ? record.code : `HTTP_${response.status}`;
  const message =
    typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : `Conversation scope request failed (HTTP ${response.status}).`;
  return new ConversationScopeHttpError({
    status: response.status,
    code,
    message,
    retryable:
      typeof record?.retryable === "boolean" ? record.retryable : undefined,
  });
}

export async function bootstrapConversationScope(
  sessionId: string,
  runId: string,
  clientMessageId?: string,
  revisionOfTurnId?: string,
): Promise<ConversationScope> {
  const response = await fetch(`${getBrainHttpBase()}/turn/start`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      sessionId,
      runId,
      clientMessageId,
      ...(revisionOfTurnId ? { revisionOfTurnId } : {}),
    }),
  });

  if (!response.ok) {
    throw await readScopeError(response);
  }

  const identity: TurnScopeBootstrap = TurnScopeBootstrapSchema.parse(
    await response.json(),
  );
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
  if (!query.success) {
    return null;
  }
  const { sessionId: normalizedSessionId, runId: normalizedRunId } = query.data;
  const response = await fetch(
    `${getBrainHttpBase()}/turn/scope?runId=${encodeURIComponent(normalizedRunId)}&sessionId=${encodeURIComponent(normalizedSessionId)}`,
    { credentials: "include", signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw await readScopeError(response);
  }
  const identity: TurnScopeBootstrap = TurnScopeBootstrapSchema.parse(
    await response.json(),
  );
  return createConversationScope({
    ...identity,
    sessionId: normalizedSessionId,
    runId: normalizedRunId,
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
