import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildConversationTurns,
  dispatchHostedConversationSubmission,
  findSubmissionAttempt,
  interruptAndAwaitTerminal,
  mergeLifecycleProjections,
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
} from "@repo/platform-protocol";
import { useConversationTurnLifecycle } from "../chat-interface/useConversationTurnLifecycle.js";
import type { Message } from "@ai-sdk/react";
import {
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

type ApprovalDecision = Pick<SubmitLifecycleApprovalRequest, "approvalId" | "decision" | "grantScope">;
type Owner = { readonly identity: HostedConversationIdentity; readonly controller: AbortController };
interface DeliveryState {
  readonly identity: HostedConversationIdentity;
  readonly scope: ConversationScope | null;
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
  const approvalCommand = useRef<{ approvalId: string; operation: Promise<void> } | null>(null);
  const observedTerminal = useRef<{ identity: HostedConversationIdentity; eventId: string } | null>(null);
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const history = useHostedConversationHistory(identity);
  const visibleDelivery = identity.enabled && delivery?.identity === identity ? delivery : null;
  const scope = visibleDelivery?.scope ?? history.scope;
  const selectedScope = useRef(scope);
  selectedScope.current = scope;
  const lifecycle = useMemo(() => hostedLifecycleClient(client, scope), [client, scope]);
  const live = useConversationTurnLifecycle(scope?.turnId, identity.enabled && scope !== null, lifecycle);
  const activeProjection = identity.enabled && live.isReplayReady ? live.projection : null;
  const selectedProjection = useRef(activeProjection);
  selectedProjection.current = activeProjection;
  const selectedContext = useRef(history.workspaceContext);
  selectedContext.current = history.workspaceContext;
  const projections = useMemo(() => mergeLifecycleProjections(history.projections, {}, activeProjection),
    [history.projections, activeProjection]);
  const messages = useMemo(() => {
    const draft = visibleDelivery?.optimisticDraft;
    if (!draft || history.messages.some((message) => message.id === draft.id)) return history.messages;
    const message: Message = { id: draft.id, role: "user", content: draft.prompt };
    const reserved = visibleDelivery?.optimisticScope;
    return [...history.messages, reserved ? Object.assign(message, {
      data: { metadata: { canonicalIdentity: {
        workspaceId: reserved.workspaceId, threadId: reserved.threadId, turnId: reserved.turnId, runAttemptId: reserved.runAttemptId,
      } } },
    }) : message];
  }, [history.messages, visibleDelivery?.optimisticDraft, visibleDelivery?.optimisticScope]);
  const conversationTurns = useMemo(() => buildConversationTurns(messages), [messages]);
  const active = (captured: Owner | null): captured is Owner => Boolean(
    captured && owner.current === captured && !captured.controller.signal.aborted &&
    current.current === captured.identity && captured.identity.enabled,
  );
  const updateDelivery = (captured: Owner, update: Partial<DeliveryState>) => {
    if (!active(captured)) return;
    setDelivery((previous) => ({
      identity, scope: null, pendingDraft: null, optimisticDraft: null, optimisticScope: null, fingerprint: null, error: null, submitting: false, stopping: false,
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
  const canSubmit = identity.enabled && history.historyReady && !history.loading &&
    history.workspaceContext?.workspaceStatus !== "archived" && !missingRunningScope &&
    !history.scopeRecoveryError &&
    !pendingDraft && !isSubmitting && !isStopping && (!scope || Boolean(activeProjection?.terminal));
  const canStop = identity.enabled && !isStopping && (isSubmitting || Boolean(scope &&
    !activeProjection?.terminal && ((activeProjection && activeProjection.lastSequence > 0) || pendingDraft)));

  async function submit(draft: HostedNativeDraft): Promise<SubmissionOutcome> {
    const captured = owner.current;
    const context = history.workspaceContext;
    if (!active(captured) || current.current !== identity || !history.isReadable() || !context ||
      history.loading || selectedContext.current !== context || selectedScope.current !== scope ||
      isStopping || context.workspaceStatus === "archived" || command.current) {
      return { status: "inactive" };
    }
    if (!draft.id.trim() || !draft.prompt.trim() || !draft.configuration.providerId ||
      !draft.configuration.modelId || !["build", "plan"].includes(draft.configuration.mode ?? "")) {
      throw new Error("Choose a model and Build or Plan, then enter a prompt.");
    }
    // Capture caller-owned data before any await. A retry cannot replace this snapshot.
    const configuration = ChatRequestBodySchema.pick({
      providerId: true, modelId: true, mode: true, productMode: true, reasoningEffort: true,
    }).parse(draft.configuration);
    const frozenDraft: HostedNativeDraft = Object.freeze({
      id: draft.id, prompt: draft.prompt, configuration: Object.freeze(configuration),
    });
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
      if (active(captured) && stopCommand.current) return stopCommand.current;
      await interruptAndAwaitTerminal({ ...hostedLifecycleClient(client, selected), interruptTurn: (request) => client.interruptTurn(request) },
        selected, () => { if (active(captured)) live.retry(); });
    };
    const operation = submitConversationMessage({
      sessionId: identity.sessionId, runId: identity.runId, runScopeGeneration: binding.generation,
      clientMessageId: draft.id, intentKey, intentFingerprint: fingerprint,
      lifecycleClient: hostedLifecycleClient(client),
      resolveProviderConfig: async () => frozenDraft.configuration,
      isInvocationActive,
      onInactiveScopeAfterProviderResolution: () => undefined,
      isStopPending: () => attempt.current?.owner === captured && attempt.current.attempt.stopRequested,
      onAttemptAcquired: (acquired) => {
        attempt.current = { owner: captured, attempt: acquired };
        updateDelivery(captured, { pendingDraft: frozenDraft, optimisticDraft: frozenDraft, optimisticScope: null, fingerprint, submitting: true, error: null });
      },
      reserveScope: async (acquired) => {
        const reserved = await client.reserveTurnScope({
          sessionId: identity.sessionId, runId: RunIdSchema.parse(acquired.originalRunId),
          clientMessageId: acquired.clientMessageId,
        });
        return hostedConversationScope(identity, reserved, context);
      },
      onReserved: (reserved) => {
        if (!active(captured)) return false;
        hostedConversationScope(identity, reserved, context);
        selectedScope.current = reserved;
        updateDelivery(captured, { scope: reserved, optimisticScope: reserved });
        return true;
      },
      dispatch: async ({ scope: reserved, attempt: acquired }) => {
        const request = ChatRequestBodySchema.parse(hostedNativeRequest(frozenDraft, reserved, context));
        await dispatchHostedConversationSubmission({
          client: hostedSubmissionClient(client), attempt: acquired, request,
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
    const selected = selectedScope.current;
    if (!active(captured) || current.current !== identity || selected !== scope) return;
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
    const operation = interruptAndAwaitTerminal({ ...hostedLifecycleClient(client, selected), interruptTurn: (request) => client.interruptTurn(request) },
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
    const captured = owner.current;
    const selected = scope;
    const approval = activeProjection?.pendingApproval;
    if (!active(captured) || current.current !== identity || selectedScope.current !== selected || !selected ||
      !approval || activeProjection?.terminal || approval.approvalId !== decision.approvalId) {
      throw new Error("Read the current hosted approval before deciding it.");
    }
    if (selectedProjection.current?.terminal || selectedProjection.current?.pendingApproval?.approvalId !== decision.approvalId) {
      throw new Error("The hosted approval changed before this decision.");
    }
    if (approvalCommand.current) return approvalCommand.current.operation;
    const option = decision.decision === "approved"
      ? decision.grantScope === "matching_in_chat" ? "allow_matching_in_chat" : "allow_once"
      : decision.decision === "denied" ? "deny" : "cancel";
    if (!approval.options.some((candidate) => candidate.id === option ||
      (option === "allow_once" && candidate.id === "approve") || (option === "cancel" && candidate.id === "abort"))) {
      throw new Error("This decision is not offered by the current runtime request.");
    }
    const operation = client.submitLifecycleApproval({
      ...decision, turnId: TurnIdSchema.parse(selected.turnId),
      decidedBy: userIdFromExternalId(identity.accountId), reason: null,
    }).then((receipt) => {
      if (!active(captured)) return;
      if (receipt.type !== "approval.decided" || receipt.turnId !== selected.turnId ||
        receipt.threadId !== selected.threadId || receipt.runAttemptId !== selected.runAttemptId ||
        receipt.approvalId !== decision.approvalId || receipt.payload.status !== decision.decision ||
        (decision.grantScope === "matching_in_chat" && receipt.payload.grantScope !== decision.grantScope)) {
        throw new Error("Approval receipt belongs to another hosted request.");
      }
      live.retry();
    }).catch((error: unknown) => {
      if (active(captured)) { approvalCommand.current = null; live.retry(); }
      throw error;
    });
    approvalCommand.current = { approvalId: decision.approvalId, operation };
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
    messages, conversationTurns, projections, activeProjection, scope,
    workspaceContext: history.workspaceContext,
    historyReady: history.historyReady, loading: history.loading,
    historyError: history.historyError ?? (missingRunningScope && history.historyReady ? "The saved running task has no recoverable canonical turn scope." : null),
    scopeRecoveryError: history.scopeRecoveryError,
    historicalReplayError: history.replayError,
    deliveryError: visibleDelivery?.error ?? null,
    continuationError: identity.enabled ? live.error : null,
    continuationStatus: identity.enabled ? live.continuationStatus : null,
    isSubmitting, isStopping, canSubmit, canStop, pendingDraft,
    submit, stop, decideApproval, readTurnDiff,
    reload: () => { if (current.current === identity) { history.reload(); live.retry(); } },
  };
}
