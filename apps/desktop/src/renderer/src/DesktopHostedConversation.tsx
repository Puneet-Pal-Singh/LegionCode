import {
  ApprovalDock,
  ChatErrorNotice,
  ChatInterfaceView,
  ConversationContinuationNotice,
  buildChatEntries,
  useChatAutoScroll,
  useCompletedTurnReview,
  useHostedNativeConversation,
  type HostedNativeConversationBinding,
} from "@legioncode/client-ui";
import { projectApprovalPresentation, type AppServerClient } from "@legioncode/sdk";
import type { GetTurnDiffResponse, HostedSession } from "@repo/platform-protocol";
import type { ApprovalDecisionKind, DiffContent, FileStatus } from "@repo/shared-types";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type DesktopHostedConversationController = ReturnType<typeof useHostedNativeConversation>;
export interface DesktopHostedReviewTurn {
  readonly turnId: string;
  readonly files: FileStatus[];
  readonly loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
  readonly error: string | null;
  readonly readDiff: () => Promise<GetTurnDiffResponse>;
}
export interface DesktopHostedComposerContext {
  readonly layout: "hero" | "docked";
  readonly controller: DesktopHostedConversationController;
  readonly approvalVisible: boolean;
}
export interface DesktopHostedConversationProps {
  readonly client: AppServerClient;
  readonly binding: HostedNativeConversationBinding;
  readonly session: HostedSession;
  readonly runId: string;
  /** Account/session readiness only; changing placement visibility must not detach execution. */
  readonly enabled?: boolean;
  readonly active: boolean;
  readonly projectName?: string;
  readonly renderComposer: (context: DesktopHostedComposerContext) => ReactNode;
  readonly onReviewTurn?: (turn: DesktopHostedReviewTurn) => void;
  /** Observe the current controller through a host ref; submission intent stays with the host. */
  readonly onControllerReady?: (controller: DesktopHostedConversationController | null) => void;
}

/** Hosted transport/controller bindings only; shared components own the presentation. */
export function DesktopHostedConversation({
  client, binding, session, runId, enabled = true, active, projectName,
  renderComposer, onReviewTurn, onControllerReady,
}: DesktopHostedConversationProps) {
  const controller = useHostedNativeConversation({ client, binding, session, runId, enabled });
  const scopeKey = JSON.stringify([binding.target, binding.accountId, binding.generation,
    session.id, session.workspaceId, session.threadId, runId]);
  const ready = useRef(onControllerReady);
  ready.current = onControllerReady;
  useEffect(() => { onControllerReady?.(controller); }, [controller, onControllerReady]);
  useEffect(() => () => { ready.current?.(null); }, []);

  const projection = controller.activeProjection;
  const entries = useMemo(() => buildChatEntries(controller.conversationTurns,
    controller.projections, projection?.turnId ?? null),
  [controller.conversationTurns, controller.projections, projection?.turnId]);
  const rootMessageId = controller.conversationTurns.find((turn) => turn.turnId === projection?.turnId)
    ?.userMessage?.id ?? null;
  const review = useCompletedTurnReview(projection, rootMessageId);
  const approval = projection?.terminal ? null : projection?.pendingApproval ?? null;
  const approvalVisible = Boolean(active && controller.historyReady && !controller.loading && approval);
  const approvalKey = approval && controller.scope
    ? JSON.stringify([scopeKey, controller.scope.turnId, controller.scope.runAttemptId, approval.approvalId]) : null;
  const current = useRef({ active, scopeKey, approvalKey });
  current.current = { active, scopeKey, approvalKey };
  const [decision, setDecision] = useState<{ key: string; value: ApprovalDecisionKind } | null>(null);
  const [commandError, setCommandError] = useState<{ key: string; message: string } | null>(null);
  const decisionRequest = useRef<{ key: string; operation: Promise<void> } | null>(null);
  const decisions = useMemo(() => [...new Set(approval?.options.flatMap((option): ApprovalDecisionKind[] => {
    switch (option.id) {
      case "approve": case "allow_once": return ["allow_once"];
      case "allow_matching_in_chat": return ["allow_persistent_rule"];
      case "deny": return ["deny"];
      case "cancel": case "abort": return ["abort"];
      default: return [];
    }
  }) ?? [])], [approval]);
  const presentation = approval ? projectApprovalPresentation(approval) : null;

  const resolveApproval = (value: ApprovalDecisionKind): Promise<void> => {
    if (!approval || !approvalKey || !current.current.active || current.current.approvalKey !== approvalKey) {
      return Promise.resolve();
    }
    if (decisionRequest.current?.key === approvalKey) return decisionRequest.current.operation;
    const key = approvalKey;
    setDecision({ key, value });
    setCommandError(null);
    const operation = controller.decideApproval({
      approvalId: approval.approvalId,
      decision: value === "deny" ? "denied" : value === "abort" ? "cancelled" : "approved",
      ...(value === "allow_persistent_rule" ? { grantScope: "matching_in_chat" as const } : {}),
    }).catch((error: unknown) => {
      if (current.current.approvalKey === key) setCommandError({ key,
        message: error instanceof Error ? error.message : "The approval decision could not be confirmed." });
    }).finally(() => {
      if (decisionRequest.current?.operation === operation) decisionRequest.current = null;
      setDecision((pending) => pending?.key === key ? null : pending);
    });
    decisionRequest.current = { key, operation };
    return operation;
  };
  const stopFromApproval = () => {
    if (!current.current.active || !approvalKey || current.current.approvalKey !== approvalKey) return;
    const key = approvalKey;
    setCommandError(null);
    void controller.stop().catch((error: unknown) => {
      if (current.current.approvalKey === key) setCommandError({ key,
        message: error instanceof Error ? error.message : "Stop settlement could not be confirmed." });
    });
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  const executionActive = Boolean(projection && projection.lastSequence > 0 && !projection.terminal);
  useChatAutoScroll({ activeRun: active && executionActive,
    latestMessageKey: lastEntry ? lastEntry.kind === "message" ? lastEntry.message.id : lastEntry.key : null,
    lifecycleSequence: projection?.lastSequence ?? 0,
    placeholderVisible: !active || controller.loading,
    scopeKey, scrollRef });
  const showHeroComposer = controller.historyReady && !controller.loading && entries.length === 0;
  const unavailableArtifact = async (): Promise<never> => {
    throw new Error("Open this reply's captured canonical changes to review its files.");
  };
  const continuation = controller.continuationStatus === "reconnecting" || controller.continuationStatus === "stopped"
    ? { status: controller.continuationStatus, onRetry: controller.reload } : null;

  return <ChatInterfaceView
    ref={scrollRef}
    workspaceId={controller.scope?.workspaceId ?? controller.workspaceContext?.workspaceId ?? session.workspaceId}
    threadId={controller.scope?.threadId ?? controller.workspaceContext?.threadId ?? session.threadId}
    runAttemptId={controller.scope?.runAttemptId ?? null}
    showHeroComposer={showHeroComposer}
    showProjectChip={false}
    projectName={projectName}
    showSessionPlaceholder={controller.loading && !controller.historyReady}
    placeholderError={controller.historyError ? {
      message: controller.historyError, remediation: "Read this cloud task's saved history before continuing.",
      actionLabel: "Reload saved history", onOpen: controller.reload,
    } : null}
    continuation={continuation}
    canStopPendingTurn={active && controller.canStop}
    onStopPendingTurn={active ? controller.stop : undefined}
    renderComposer={(layout) => <>
      {controller.deliveryError ? <ChatErrorNotice message={controller.deliveryError}
        remediation="Your unchanged draft is retained. Read saved status before retrying."
        actionLabel="Reload saved history" onOpen={controller.reload} /> : null}
      {controller.historyError && showHeroComposer ? <ChatErrorNotice message={controller.historyError}
        remediation="Your draft is retained. Read saved history before continuing."
        actionLabel="Reload saved history" onOpen={controller.reload} /> : null}
      {continuation ? <ConversationContinuationNotice status={continuation.status}
        error={controller.continuationError} onRetry={controller.reload} /> : null}
      {approvalVisible && approval && approvalKey ? <ApprovalDock
        question={approval.question}
        categoryLabel="Cloud action"
        title={presentation?.title}
        command={presentation?.command}
        matchingInChatOption={approval.options.find((option) => option.id === "allow_matching_in_chat") ?? null}
        decisions={decisions}
        busyDecision={decision?.key === approvalKey ? decision.value : null}
        error={commandError?.key === approvalKey ? commandError.message
          : decisions.length === 0 ? "This request has no supported decision option. Stop remains available." : null}
        onResolve={resolveApproval}
        onStop={stopFromApproval}
        canStop={controller.canStop}
      /> : null}
      {renderComposer({ layout, controller, approvalVisible })}
    </>}
    debugPanel={controller.historicalReplayError ? <ChatErrorNotice
      message={controller.historicalReplayError}
      remediation="An earlier saved workflow could not be loaded."
      actionLabel="Reload saved history" onOpen={controller.reload} /> : null}
    resolveHydratedImageSource={undefined}
    loadArtifactContent={undefined}
    chatEntries={entries}
    hydrationStatus={controller.loading ? "loading" : controller.historyError ? "failed" : entries.length ? "readable" : "empty"}
    hydrationError={controller.historyError}
    retryHydration={controller.reload}
    messageMetadataById={{}}
    modeLabel={session.mode === "plan" ? "Plan" : session.mode === "build" ? "Build" : "Mode unavailable"}
    resolveModelLabel={(modelId) => modelId}
    snapshots={{}}
    artifacts={{}}
    loadChangedFileDiff={unavailableArtifact}
    selectPromptArtifactReview={() => {}}
    selectCanonicalTurnReview={(source) => {
      const captured = controller.projections[source.turnId];
      if (!current.current.active || current.current.scopeKey !== scopeKey || !captured?.terminal ||
          captured.workspaceSnapshotState !== "captured" || captured.turnDiff?.turnId !== source.turnId) return;
      onReviewTurn?.({ ...source, readDiff: () => controller.readTurnDiff(source.turnId) });
    }}
    terminalViewModel={null}
    terminalReviewFiles={review.files}
    terminalTurnDiff={projection?.turnDiff ?? null}
    loadArtifactChangedFileDiff={unavailableArtifact}
    loadCompletedTurnFileDiff={review.loadFileDiff}
    completedTurnReview={review}
    lifecycleProjection={projection}
    pendingWorkflow={Boolean(controller.scope && !projection && !controller.historyError && controller.continuationStatus !== "stopped")}
  />;
}
