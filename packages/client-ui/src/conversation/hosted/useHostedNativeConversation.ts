import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildConversationTurns,
  dispatchHostedConversationSubmission,
  sameConversationScope,
  findSubmissionAttempt,
  interruptAndAwaitTerminal,
  mergeLifecycleProjections,
  readCanonicalTurnId,
  RunIdSchema,
  submitConversationMessage,
  TurnIdSchema,
  type ConversationScope,
  type SubmissionAttempt,
  type SubmissionOutcome,
} from "@legioncode/sdk";
import {
  ChatRequestBodySchema,
  userIdFromExternalId,
  type GetTurnDiffResponse,
  type SubmitLifecycleApprovalRequest,
  type ReplayLifecycleEventsResponse,
} from "@repo/platform-protocol";
import { useConversationTurnLifecycle } from "../chat-interface/useConversationTurnLifecycle.js";
import type { Message } from "@ai-sdk/react";
import {
  captureHostedNativeDraft,
  hostedConversationIdentity,
  hostedConversationScope,
  hostedLifecycleClient,
  hostedNativeRequest,
  hostedSubmissionClient,
  type HostedConversationIdentity,
  type HostedNativeConversationOptions,
  type HostedNativeDraft,
} from "./hostedNativeConversation.js";
import { useHostedConversationHistory } from "./useHostedConversationHistory.js";
import { HostedRecoveryObservation } from "./hostedRecoveryObservation.js";
import { buildChatAppendMessage } from "../chatImageAttachments.js";

type ApprovalDecision = Pick<SubmitLifecycleApprovalRequest, "approvalId" | "decision" | "grantScope">;
type ApprovalCommand = { readonly decision: ApprovalDecision; readonly operation: Promise<void> };
type Owner = { readonly identity: HostedConversationIdentity; readonly controller: AbortController };
interface DeliveryState {
  readonly identity: HostedConversationIdentity;
  readonly scope: ConversationScope | null;
  readonly acceptedScope: ConversationScope | null;
  readonly pendingDraft: HostedNativeDraft | null;
  readonly optimisticDraft: HostedNativeDraft | null;
  readonly optimisticScope: ConversationScope | null;
  readonly fingerprint: string | null;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly stopping: boolean;
}

/** Shared hosted Native controller. The injected client owns transport and authentication. */
export function useHostedNativeConversation(options: HostedNativeConversationOptions) {
  const { client, session, binding, runId, enabled } = options;
  const identity = useMemo(() => hostedConversationIdentity(options), [
    client, binding.target, binding.accountId, binding.generation, session.id, session.userId,
    session.workspaceId, session.threadId, session.archivedAt, runId, enabled,
  ]);
  const current = useRef(identity);
  current.current = identity;
  const owner = useRef<Owner | null>(null);
  const attempt = useRef<{ owner: Owner; attempt: SubmissionAttempt } | null>(null);
  const command = useRef<Promise<SubmissionOutcome> | null>(null);
  const stopCommand = useRef<Promise<void> | null>(null);
  const approvalCommand = useRef<ApprovalCommand | null>(null);
  const recoveryObserverRef = useRef<HostedRecoveryObservation | null>(null);
  if (!recoveryObserverRef.current) recoveryObserverRef.current = new HostedRecoveryObservation();
  const recoveryObserver = recoveryObserverRef.current;
  recoveryObserver.setIdentity(identity);
  const observedTerminal = useRef<{ identity: HostedConversationIdentity; eventId: string } | null>(null);
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const history = useHostedConversationHistory(identity);
  const visibleDelivery = identity.enabled && delivery?.identity === identity ? delivery : null;
  // A local reservation bridges admission to saved history. Once that exact
  // source user message is canonical, the server's current scope wins, including
  // a later turn started by another client. Older reads cannot acknowledge a
  // newer reservation because they lack its client message ID and turn identity.
  const deliveredScope = visibleDelivery?.scope;
  const deliveredDraft = visibleDelivery?.optimisticDraft;
  const deliveryAcknowledged = Boolean(deliveredScope && deliveredDraft &&
    !visibleDelivery.submitting && !visibleDelivery.pendingDraft && history.scope &&
    history.messages.some((message) => message.role === "user" &&
      message.id === deliveredDraft.id && readCanonicalTurnId(message) === deliveredScope.turnId));
  const scopeCandidate = deliveryAcknowledged ? history.scope : visibleDelivery?.scope ?? history.scope;
  const scope = recoveryObserver.selectScope(identity, scopeCandidate);
  const observeReplay = useCallback((page: ReplayLifecycleEventsResponse) => {
    recoveryObserver.observeReplay(identity, page);
  }, [identity, recoveryObserver]);
  const lifecycle = useMemo(() => hostedLifecycleClient(client, scope, identity, observeReplay), [client, scope, identity, observeReplay]);
  const live = useConversationTurnLifecycle(scope?.turnId, identity.enabled && scope !== null, lifecycle);
  const activeProjection = identity.enabled && live.isReplayReady ? live.projection : null;
  const selectedProjection = useRef(activeProjection);
  selectedProjection.current = activeProjection;
  const selectedContext = useRef(history.workspaceContext);
  selectedContext.current = history.workspaceContext;
  const projections = useMemo(() => mergeLifecycleProjections(history.projections, {}, activeProjection),
    [history.projections, activeProjection]);
  recoveryObserver.observeProjections(identity, history.projections, live.projection);
  const recovery = recoveryObserver.recovery;
  // Only the canonical history reader can confirm a durable source message.
  // Optimistic rows below may already carry reserved identity and are not receipts.
  const canonicalMessages: readonly Message[] = history.messages;
  const messages = useMemo(() => {
    const draft = visibleDelivery?.optimisticDraft;
    if (!draft || history.messages.some((message) => message.id === draft.id)) return history.messages;
    const appendMessage = buildChatAppendMessage(draft.prompt, [...draft.imageAttachments ?? []]);
    const message: Message = { id: draft.id, role: appendMessage.role, content: appendMessage.content as Message["content"] };
    const reserved = visibleDelivery?.optimisticScope;
    const metadata = {
      ...(appendMessage.imageMetadata ? { imageAttachments: appendMessage.imageMetadata } : {}),
      ...(reserved ? { canonicalIdentity: {
        workspaceId: reserved.workspaceId, threadId: reserved.threadId, turnId: reserved.turnId, runAttemptId: reserved.runAttemptId,
      } } : {}),
    };
    return [...history.messages, Object.keys(metadata).length > 0 ? Object.assign(message, { data: { metadata } }) : message];
  }, [history.messages, visibleDelivery?.optimisticDraft, visibleDelivery?.optimisticScope]);
  const conversationTurns = useMemo(() => buildConversationTurns(messages), [messages]);
  const active = (captured: Owner | null): captured is Owner => Boolean(
    captured && owner.current === captured && !captured.controller.signal.aborted &&
    current.current === captured.identity && captured.identity.enabled,
  );
  const assertMutationAllowed = (capturedIdentity: HostedConversationIdentity, target?: ConversationScope | null): void => {
    recoveryObserver.assertMutationAllowed(capturedIdentity, target);
  };
  const updateDelivery = (captured: Owner, update: Partial<DeliveryState>) => {
    if (!active(captured)) return;
    setDelivery((previous) => ({
      identity, scope: null, acceptedScope: null, pendingDraft: null, optimisticDraft: null, optimisticScope: null, fingerprint: null, error: null, submitting: false, stopping: false,
      ...(previous?.identity === identity ? previous : {}), ...update,
    }));
  };

  useEffect(() => {
    const captured: Owner = { identity, controller: new AbortController() };
    owner.current = captured;
    command.current = null;
    stopCommand.current = null;
    approvalCommand.current = null;
    attempt.current = null;
    return () => {
      captured.controller.abort();
      // Detaching observation is never a runtime Stop or a prompt retry.
      if (owner.current === captured) owner.current = null;
    };
  }, [identity]);

  useEffect(() => {
    if (!deliveryAcknowledged || !visibleDelivery) return;
    setDelivery((previous) => previous === visibleDelivery
      ? { ...previous, scope: null, optimisticDraft: null, optimisticScope: null } : previous);
  }, [deliveryAcknowledged, visibleDelivery]);

  useEffect(() => {
    if (!activeProjection?.terminal) return;
    if (observedTerminal.current?.identity === identity && observedTerminal.current.eventId === activeProjection.terminal.eventId) return;
    observedTerminal.current = { identity, eventId: activeProjection.terminal.eventId };
    const captured = owner.current;
    if (active(captured)) updateDelivery(captured, { stopping: false });
    stopCommand.current = null;
    history.reload();
  }, [identity, activeProjection?.terminal?.eventId]);

  useEffect(() => { approvalCommand.current = null; }, [identity, activeProjection?.pendingApproval?.approvalId]);

  const missingRunningScope = !scope && ["running", "waiting_for_approval", "paused"].includes(session.status);
  const pendingDraft = visibleDelivery?.pendingDraft ?? null;
  const isSubmitting = visibleDelivery?.submitting === true;
  const isStopping = visibleDelivery?.stopping === true;
  // Strict submit receipts and successful saved scope reads prove admission
  // before sequence 1. A reserved-only scope read returns recovery-required,
  // so neither the delivery reservation nor optimistic history is proof.
  const hasAcceptedScope = Boolean(scope && [
    visibleDelivery?.acceptedScope,
    history.historyReady && !history.scopeRecoveryError ? history.scope : null,
  ].some((acceptedScope) => acceptedScope &&
    scope.sessionId === acceptedScope.sessionId && scope.runId === acceptedScope.runId &&
    scope.workspaceId === acceptedScope.workspaceId && scope.threadId === acceptedScope.threadId &&
    scope.turnId === acceptedScope.turnId && scope.runAttemptId === acceptedScope.runAttemptId));
  const canSubmit = identity.enabled && history.historyReady && !history.loading &&
    history.workspaceContext?.workspaceStatus !== "archived" && !missingRunningScope &&
    !history.scopeRecoveryError &&
    !recovery && !pendingDraft && !isSubmitting && !isStopping && (!scope || Boolean(activeProjection?.terminal));
  const canStop = identity.enabled && !recovery && !isStopping && (isSubmitting || Boolean(scope &&
    !activeProjection?.terminal && (hasAcceptedScope || (activeProjection && activeProjection.lastSequence > 0) || pendingDraft)));

  async function submit(draft: HostedNativeDraft): Promise<SubmissionOutcome> {
    const captured = owner.current;
    const context = history.workspaceContext;
    if (!active(captured) || current.current !== identity || !history.isReadable() || !context ||
      history.loading || selectedContext.current !== context || recoveryObserver.selectedScope !== scope ||
      isStopping || context.workspaceStatus === "archived" || command.current) {
      return { status: "inactive" };
    }
    assertMutationAllowed(identity, recoveryObserver.selectedScope);
    // Capture caller-owned data before any await. A retry cannot replace this snapshot.
    const frozenDraft = captureHostedNativeDraft(draft);
    const fingerprint = JSON.stringify([identity.submissionKey, frozenDraft]);
    if (pendingDraft && (visibleDelivery?.fingerprint !== fingerprint || pendingDraft.id !== draft.id)) {
      throw new Error("Delivery is unconfirmed. Retry the unchanged prompt or read its saved status first.");
    }
    const remembered = findSubmissionAttempt(identity.sessionId, draft.id);
    const retrying = pendingDraft !== null || Boolean(remembered?.wireBody &&
      remembered.intentFingerprint === fingerprint && remembered.originalRunId === identity.runId);
    if (history.scopeRecoveryError && !retrying) return { status: "inactive" };
    if (missingRunningScope && !retrying) return { status: "inactive" };
    if (!retrying && scope && !activeProjection?.terminal) return { status: "inactive" };
    const intentKey = `explicit:${identity.submissionKey}:${draft.id}`;
    const isInvocationActive = () => active(captured);
    const stopExact = async (selected: ConversationScope) => {
      assertMutationAllowed(identity, selected);
      if (active(captured) && stopCommand.current) return stopCommand.current;
      await interruptAndAwaitTerminal({ ...hostedLifecycleClient(client, selected, identity, observeReplay), interruptTurn: (request) => {
        assertMutationAllowed(identity, selected);
        return client.interruptTurn(request);
      } },
        selected, () => { if (active(captured)) live.retry(); });
    };
    const operation = submitConversationMessage({
      sessionId: identity.sessionId, runId: identity.runId, runScopeGeneration: binding.generation,
      clientMessageId: draft.id, intentKey, intentFingerprint: fingerprint,
      lifecycleClient: hostedLifecycleClient(client, undefined, identity, observeReplay),
      resolveProviderConfig: async () => frozenDraft.configuration,
      isInvocationActive,
      onInactiveScopeAfterProviderResolution: () => undefined,
      isStopPending: () => attempt.current?.owner === captured && attempt.current.attempt.stopRequested,
      onAttemptAcquired: (acquired) => {
        attempt.current = { owner: captured, attempt: acquired };
        updateDelivery(captured, { acceptedScope: null, pendingDraft: frozenDraft, optimisticDraft: frozenDraft, optimisticScope: null, fingerprint, submitting: true, error: null });
      },
      reserveScope: async (acquired) => {
        assertMutationAllowed(identity, recoveryObserver.selectedScope);
        const reserved = await client.reserveTurnScope({
          sessionId: identity.sessionId, runId: RunIdSchema.parse(acquired.originalRunId),
          clientMessageId: acquired.clientMessageId,
        });
        const reservedScope = hostedConversationScope(identity, reserved, context);
        assertMutationAllowed(identity, reservedScope);
        return reservedScope;
      },
      onReserved: (reserved) => {
        if (!active(captured)) return false;
        assertMutationAllowed(identity, reserved);
        hostedConversationScope(identity, reserved, context);
        recoveryObserver.selectReservedScope(reserved);
        updateDelivery(captured, { scope: reserved, optimisticScope: reserved });
        return true;
      },
      dispatch: async ({ scope: reserved, attempt: acquired }) => {
        assertMutationAllowed(identity, reserved);
        const request = ChatRequestBodySchema.parse(hostedNativeRequest(frozenDraft, reserved, context));
        await dispatchHostedConversationSubmission({
          client: hostedSubmissionClient(client, () => {
            assertMutationAllowed(identity, reserved);
            if (!sameConversationScope(recoveryObserver.selectedScope, reserved))
              throw new Error("The hosted task changed before command dispatch.");
          }), attempt: acquired, request,
          onAcknowledgement: () => { if (active(captured)) live.retry(); },
        });
      },
      interruptAcceptedTurn: async (_acquired, reserved) => {
        try { await stopExact(reserved); }
        catch (error) {
          updateDelivery(captured, { error: error instanceof Error ? error.message : "Stop settlement is unconfirmed.", stopping: false });
          throw error;
        }
      },
      interruptUnconfirmedTurn: async (_acquired, reserved) => {
        try { await stopExact(reserved); return true; } catch { return false; }
      },
      onReservationCancelled: () => updateDelivery(captured, { scope: null }),
    }).then((outcome) => {
      if (!active(captured)) return outcome;
      const confirmed = outcome.status === "accepted" || (outcome.status === "cancelled" && outcome.admission !== "unconfirmed");
      updateDelivery(captured, {
        submitting: false,
        ...(outcome.status === "accepted" || (outcome.status === "cancelled" && outcome.admission === "accepted")
          ? { acceptedScope: outcome.scope ?? null } : {}),
        ...(confirmed ? { pendingDraft: null, fingerprint: null, error: null, stopping: false } : {}),
        ...(outcome.status === "cancelled" && outcome.admission === "not-dispatched" ? { optimisticDraft: null } : {}),
        ...(outcome.status === "unconfirmed" ? { error: outcome.message } : {}),
      });
      if (confirmed) history.reload();
      live.retry();
      return outcome;
    }).finally(() => { if (active(captured)) command.current = null; });
    command.current = operation;
    return operation;
  }

  async function stop(): Promise<void> {
    const captured = owner.current;
    const selected = recoveryObserver.selectedScope;
    if (!active(captured) || current.current !== identity || selected !== scope) return;
    assertMutationAllowed(identity, selected);
    const pending = attempt.current?.owner === captured && attempt.current.attempt.active ? attempt.current.attempt : null;
    if (pending) pending.stopRequested = true;
    if (pending && !pending.scope) {
      updateDelivery(captured, { stopping: true });
      return;
    }
    if (activeProjection?.terminal) return;
    if (!selected) {
      if (attempt.current?.owner === captured) updateDelivery(captured, { stopping: true });
      return;
    }
    if (stopCommand.current) return stopCommand.current;
    updateDelivery(captured, { stopping: true, error: null });
    const operation = interruptAndAwaitTerminal({ ...hostedLifecycleClient(client, selected, identity, observeReplay), interruptTurn: (request) => {
        assertMutationAllowed(identity, selected);
        return client.interruptTurn(request);
      } },
      selected, () => { if (active(captured)) live.retry(); }).then(() => {
      if (!active(captured)) return;
      updateDelivery(captured, { stopping: false });
      live.retry();
      history.reload();
    }).catch((error: unknown) => {
      updateDelivery(captured, { stopping: false, error: error instanceof Error ? error.message : "Stop settlement is unconfirmed." });
      throw error;
    }).finally(() => { if (active(captured)) stopCommand.current = null; });
    stopCommand.current = operation;
    return operation;
  }

  async function decideApproval(decision: ApprovalDecision): Promise<void> {
    assertMutationAllowed(identity, recoveryObserver.selectedScope);
    const captured = owner.current;
    const selected = scope;
    const approval = activeProjection?.pendingApproval;
    if (!active(captured) || current.current !== identity || recoveryObserver.selectedScope !== selected || !selected ||
      !approval || activeProjection?.terminal || approval.approvalId !== decision.approvalId) {
      throw new Error("Read the current hosted approval before deciding it.");
    }
    if (selectedProjection.current?.terminal || selectedProjection.current?.pendingApproval?.approvalId !== decision.approvalId) {
      throw new Error("The hosted approval changed before this decision.");
    }
    const chosen = Object.freeze({ ...decision });
    if (chosen.decision !== "approved" && chosen.grantScope !== undefined) {
      throw new Error("Only an approval can grant future access.");
    }
    const option = chosen.decision === "approved"
      ? chosen.grantScope === "matching_in_chat" ? "allow_matching_in_chat" : "allow_once"
      : chosen.decision === "denied" ? "deny" : "cancel";
    if (!approval.options.some((candidate) => candidate.id === option ||
      (option === "allow_once" && candidate.id === "approve") || (option === "cancel" && candidate.id === "abort"))) {
      throw new Error("This decision is not offered by the current runtime request.");
    }
    const pending = approvalCommand.current;
    if (pending) {
      if (pending.decision.approvalId === chosen.approvalId && pending.decision.decision === chosen.decision &&
        pending.decision.grantScope === chosen.grantScope) return pending.operation;
      throw new Error("A different decision for this approval is still pending.");
    }
    let capturedCommand: ApprovalCommand;
    assertMutationAllowed(identity, selected);
    const operation = client.submitLifecycleApproval({
      ...chosen, turnId: TurnIdSchema.parse(selected.turnId),
      decidedBy: userIdFromExternalId(identity.accountId), reason: null,
    }).then((receipt) => {
      if (!active(captured)) return;
      if (receipt.type !== "approval.decided" || receipt.turnId !== selected.turnId ||
        receipt.threadId !== selected.threadId || receipt.runAttemptId !== selected.runAttemptId ||
        receipt.approvalId !== chosen.approvalId || receipt.payload.status !== chosen.decision ||
        (chosen.grantScope === "matching_in_chat" && receipt.payload.grantScope !== chosen.grantScope)) {
        throw new Error("Approval receipt belongs to another hosted request.");
      }
      live.retry();
    }).catch((error: unknown) => {
      if (active(captured)) {
        if (approvalCommand.current === capturedCommand) approvalCommand.current = null;
        live.retry();
      }
      throw error;
    });
    capturedCommand = { decision: chosen, operation };
    approvalCommand.current = capturedCommand;
    return operation;
  }

  async function readTurnDiff(turnId: string): Promise<GetTurnDiffResponse> {
    const captured = owner.current;
    const projection = projections[turnId];
    if (!active(captured) || current.current !== identity || !history.isReadable() || !projection?.terminal ||
      (turnId !== scope?.turnId && !conversationTurns.some((turn) => turn.turnId === turnId))) {
      throw new Error("Read this task's canonical terminal turn before opening its saved diff.");
    }
    const result = await client.getTurnDiff({ turnId: TurnIdSchema.parse(turnId) });
    if (!active(captured)) throw new Error("The hosted task changed while its saved diff was loading.");
    if (result.diff && result.diff.turnId !== turnId) throw new Error("Saved diff belongs to another hosted turn.");
    return result;
  }

  return {
    messages, canonicalMessages, conversationTurns, projections, activeProjection, scope,
    workspaceContext: history.workspaceContext,
    historyReady: history.historyReady, loading: history.loading,
    historyError: history.historyError ?? (missingRunningScope && history.historyReady ? "The saved running task has no recoverable canonical turn scope." : null),
    scopeRecoveryError: history.scopeRecoveryError,
    historicalReplayError: history.replayError,
    deliveryError: visibleDelivery?.error ?? null,
    continuationError: identity.enabled ? recovery
      ? "This task needs recovery review. Work was not restarted." : live.error : null,
    continuationStatus: identity.enabled && !recovery ? live.continuationStatus : null,
    recoveryRequired: recovery !== null,
    recovery,
    isSubmitting, isStopping, canSubmit, canStop, pendingDraft,
    submit, stop, decideApproval, readTurnDiff,
    isMutationAllowed: () => recoveryObserver.isMutationAllowed(identity),
    reload: () => { if (current.current === identity) { history.reload(); live.retry(); } },
  };
}
