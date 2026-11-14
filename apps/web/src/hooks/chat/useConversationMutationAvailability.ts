import { useCallback, useLayoutEffect, useRef } from "react";
import { userIdFromExternalId, workspaceIdFromExternalId } from "@repo/platform-protocol";
import type { AppServerRequest, ConversationScope, LifecycleProjection, PlatformClient } from "@legioncode/sdk";
import { useAuth } from "../../contexts/AuthContext";
import type { ActiveTurnProjection } from "../useActiveTurnProjection";
import { prepareConversationRequestGuard } from "./conversationRequestGuard";

export const CONVERSATION_RECOVERY_REASON = "This task needs recovery review. Work was not restarted.";

/** Recheck after transport preparation, before the SDK freezes and marks its
 * original envelope dispatched. Response/late-ACK custody remains unchanged. */
export function guardHostedConversationSubmission(
  client: Pick<PlatformClient, "submitHostedChat">,
  isMutationAllowed: () => boolean,
): Pick<PlatformClient, "submitHostedChat"> {
  return {
    submitHostedChat: (request, options) => client.submitHostedChat(request, {
      ...options,
      beforeSendHostedChatEnvelope: (envelope) => {
        if (!isMutationAllowed()) throw new Error(CONVERSATION_RECOVERY_REASON);
        return options?.beforeSendHostedChatEnvelope?.(envelope) ?? envelope;
      },
    }),
  };
}

function mutationUnavailableReason(accountId: string | null, scope: ConversationScope | null,
  projection: LifecycleProjection | null): string | undefined {
  if (!accountId) return "Sign in before changing this task's execution.";
  const value = projection?.recovery;
  if (!scope || !value || (projection?.turnId !== scope.turnId && value.turnId !== scope.turnId)) return undefined;
  const matches = projection?.turnId === scope.turnId &&
    value.userId === userIdFromExternalId(accountId) && value.sessionId === scope.sessionId &&
    value.runId === scope.runId && value.workspaceId === workspaceIdFromExternalId(scope.workspaceId) &&
    value.threadId === scope.threadId && value.turnId === scope.turnId && value.runAttemptId === scope.runAttemptId;
  return matches ? CONVERSATION_RECOVERY_REASON : "The saved execution identity could not be confirmed. Reload this task's status before changing it.";
}

/** Availability derives from the existing authenticated SDK reader, never a second replay or recovery store. */
export function useConversationMutationAvailability(sessionId: string, runId: string,
  scope: ConversationScope | null, activeTurn: ActiveTurnProjection) {
  const { user } = useAuth();
  const accountId = user ? String(user.id) : null;
  const ownerKey = JSON.stringify([accountId, sessionId, runId]);
  const current = useRef({ accountId, scope, activeTurn, ownerKey });
  useLayoutEffect(() => {
    current.current = { accountId, scope, activeTurn, ownerKey };
  }, [accountId, scope, activeTurn, ownerKey]);
  const isMutationAllowed = useCallback((target?: ConversationScope | null): boolean => {
    const selected = current.current;
    if (!selected.accountId || selected.ownerKey !== ownerKey) return false;
    const projection = selected.activeTurn.readCurrentProjection();
    return !mutationUnavailableReason(selected.accountId, selected.scope, projection) &&
      !mutationUnavailableReason(selected.accountId, target ?? null, projection);
  }, [ownerKey]);
  const requiresRecoveryReview = useCallback((target: ConversationScope): boolean => {
    const selected = current.current;
    if (!selected.accountId || selected.ownerKey !== ownerKey) return false;
    const projection = selected.activeTurn.readCurrentProjection();
    return Boolean(projection?.recovery && mutationUnavailableReason(selected.accountId, target, projection));
  }, [ownerKey]);
  const prepareMutationRequest = useCallback((envelope: AppServerRequest, readSelectedScope: () => ConversationScope | null) =>
    prepareConversationRequestGuard(envelope, { ...current.current, scope: readSelectedScope() },
      () => ({ ...current.current, scope: readSelectedScope() }), isMutationAllowed),
  [isMutationAllowed]);
  return {
    isMutationAllowed,
    requiresRecoveryReview,
    prepareMutationRequest,
    unavailableReason: mutationUnavailableReason(accountId, scope, activeTurn.projection),
  };
}
