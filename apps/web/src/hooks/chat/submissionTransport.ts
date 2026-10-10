import {
  findSubmissionAttempt,
  freezeSubmissionWireBody,
  type SubmissionAttempt,
} from "./submissionAttemptRegistry";

export type AuthenticatedFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const responseAttempts = new WeakMap<Response, SubmissionAttempt>();

export function findAttemptForObservedResponse(
  response: Response,
): SubmissionAttempt | null {
  return responseAttempts.get(response) ?? null;
}

/** Observe the SDK's actual serialized dispatch without changing its payload. */
export function createSubmissionObservedFetch(
  authenticatedFetch: AuthenticatedFetch,
): AuthenticatedFetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : null;
    const request = parseSerializedChatRequest(body);
    const attempt = request
      ? findSubmissionAttempt(request.sessionId, request.clientMessageId)
      : null;
    let observedInit = init;
    if (attempt && body) {
      attempt.dispatched = true;
      observedInit = { ...init, body: freezeSubmissionWireBody(attempt, body) };
    }

    try {
      const response = await authenticatedFetch(input, observedInit);
      if (attempt) {
        responseAttempts.set(response, attempt);
        attempt.responseStatus = response.status;
        attempt.responseTupleMatches = responseMatchesSubmission(response, attempt);
      }
      return response;
    } catch (error) {
      if (attempt) {
        attempt.transportError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  };
}

function parseSerializedChatRequest(
  body: string | null,
): { sessionId: string; clientMessageId: string } | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object") return null;
    const request = value as Record<string, unknown>;
    return typeof request.sessionId === "string" &&
      typeof request.clientMessageId === "string"
      ? { sessionId: request.sessionId, clientMessageId: request.clientMessageId }
      : null;
  } catch {
    return null;
  }
}

function responseMatchesSubmission(
  response: Response,
  attempt: SubmissionAttempt,
): boolean {
  const scope = attempt.scope;
  if (!scope) return false;
  return (
    response.headers.get("X-Run-Id")?.trim() === scope.runId &&
    response.headers.get("X-Thread-Id")?.trim() === scope.threadId &&
    response.headers.get("X-Turn-Id")?.trim() === scope.turnId &&
    response.headers.get("X-Run-Attempt-Id")?.trim() === scope.runAttemptId
  );
}
