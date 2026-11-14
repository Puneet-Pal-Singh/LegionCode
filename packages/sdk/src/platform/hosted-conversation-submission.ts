import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import type { ChatRequestBody, HostedChatSubmissionResult } from "@repo/platform-protocol";
import {
  freezeSubmissionWireBody,
  observeSubmissionAcknowledgement,
  type SubmissionAttempt,
} from "./submission-attempt-registry.js";
import type { PlatformClient, PlatformClientOperationOptions } from "./types.js";

export interface HostedConversationSubmissionBindings {
  readonly client: Pick<PlatformClient, "submitHostedChat">;
  readonly attempt: SubmissionAttempt;
  readonly request: ChatRequestBody;
  /** Host notifications run only after the existing registry records the ACK. */
  readonly onAcknowledgement?: PlatformClientOperationOptions["onChatSubmissionResponse"];
}

/**
 * Dispatch through the existing hosted transport and submission registry. The
 * surrounding submitConversationMessage owner still decides admission from the
 * matching ACK or canonical replay, including after ambiguous HTTP delivery.
 */
export async function dispatchHostedConversationSubmission(
  input: HostedConversationSubmissionBindings,
): Promise<HostedChatSubmissionResult> {
  const { attempt } = input;
  const controller = new AbortController();
  attempt.transportAbortController = controller;
  try {
    return await input.client.submitHostedChat(input.request, {
      signal: controller.signal,
      beforeSendHostedChatEnvelope: (serializedEnvelope) => {
        const frozenEnvelope = freezeSubmissionWireBody(attempt, serializedEnvelope);
        assertReservedSubmissionEnvelope(attempt, frozenEnvelope);
        attempt.dispatched = true;
        return frozenEnvelope;
      },
      onChatSubmissionResponse: (response) => {
        observeSubmissionAcknowledgement(attempt, response);
        input.onAcknowledgement?.(response);
      },
    });
  } finally {
    if (attempt.transportAbortController === controller) {
      attempt.transportAbortController = null;
    }
  }
}

function assertReservedSubmissionEnvelope(
  attempt: SubmissionAttempt,
  frozenEnvelope: string,
): void {
  let envelope: unknown;
  try {
    envelope = JSON.parse(frozenEnvelope) as unknown;
  } catch {
    throw new Error("Frozen chat submission envelope is invalid.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Frozen chat submission envelope is invalid.");
  }
  const record = envelope as Record<string, unknown>;
  const params = record.params;
  if (
    record.protocolVersion !== APP_SERVER_PROTOCOL_VERSION ||
    record.method !== "turn/submit" ||
    !params || typeof params !== "object" || Array.isArray(params)
  ) {
    throw new Error("Frozen chat submission envelope is invalid.");
  }
  const body = params as Record<string, unknown>;
  const identity = body.identity as Record<string, unknown> | undefined;
  const scope = attempt.scope;
  if (
    !scope ||
    body.sessionId !== attempt.sessionId ||
    body.runId !== scope.runId ||
    body.clientMessageId !== attempt.clientMessageId ||
    identity?.workspaceId !== scope.workspaceId ||
    identity.threadId !== scope.threadId ||
    identity.turnId !== scope.turnId ||
    identity.runAttemptId !== scope.runAttemptId
  ) {
    throw new Error("Frozen chat submission envelope does not match its retained reservation.");
  }
}
