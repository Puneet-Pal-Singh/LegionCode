import { resolveHydratedChatImageSource } from "./chatMessageImagePresentation";
import { loadColdStorageArtifact } from "../../services/ArtifactService";
import { ChatDebugPanel } from "./chat-interface/ChatDebugPanel";
import { buildConversationTurns } from "@legioncode/sdk";
import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import {
  RunIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
} from "@legioncode/sdk";
import type { ChatSubmitAttachments } from "@legioncode/client-ui";
import type { Message } from "@ai-sdk/react";
import { type ProductMode, type RunMode } from "@repo/shared-types";
import type { ProviderId } from "../../types/provider";
import type { ChatDebugEvent } from "../../types/chat-debug.js";
import type { ConversationScope } from "@legioncode/sdk";
import type { ConversationScopeHttpError } from "@legioncode/sdk";
import type { SubmissionOutcome } from "@legioncode/sdk";
import type { HydrationStatus } from "../../services/ChatHydrationService";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery";
import { useAuth } from "../../contexts/AuthContext";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { dispatchOpenSettingsDialog } from "../../lib/settings-dialog-events.js";
import {
  buildChatMessageMetadata,
} from "@legioncode/client-ui";
import { useGitReview } from "../git/useGitReview";
import { resolveModelLabel } from "./chat-interface/modelLabels";
import { useChangedFilesController } from "./chat-interface/useChangedFilesController";
import { useApprovalController } from "./chat-interface/useApprovalController";
import {
  useActiveTurnProjection,
  type ActiveTurnProjection,
} from "../../hooks/useActiveTurnProjection.js";
import { useCompletedTurnReview } from "@legioncode/client-ui";
import { useReviewCommentSubmission } from "./chat-interface/useReviewCommentSubmission";
import {
  ChatComposerControls,
  type ComposerLayout,
} from "./chat-interface/ChatComposerControls";
import { ChatInterfaceView } from "@legioncode/client-ui";
import { createWebPlatformClient } from "../../services/api/platformClient";
import { useChatPresentation } from "@legioncode/client-ui";
import type { InitialPromptSubmission } from "../../lib/initial-prompt-submission";
import { useConversationLifecycleProjections } from "../../hooks/useConversationLifecycleProjections";
import { mergeLifecycleProjections } from "@legioncode/sdk";
import { updateComposerPreferences } from "../../lib/composer-preferences";
import { type ChatErrorNoticeProps, ThreadInputQueuePanel, type ComposerDelivery, resumeUnavailableMessage } from "@legioncode/client-ui";
import { useThreadInputQueue } from "../../hooks/chat/useThreadInputQueue";
import type { ArtifactOpenHandler } from "@legioncode/client-ui";
import { useStableChatLoadingIndicator } from "@legioncode/client-ui";
import { useChatAutoScroll } from "@legioncode/client-ui";
import type { ConversationHistoryDisplayRecord } from "@legioncode/sdk";

interface ChatInterfaceProps {
  chatProps: {
    messages: Message[];
    historyDisplayRecords?: ConversationHistoryDisplayRecord[];
    optimisticUserMessageId?: string | null;
    runId: string;
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: (
      event?: React.FormEvent,
      attachments?: ChatSubmitAttachments,
      delivery?: ComposerDelivery,
    ) => Promise<boolean>;
    submitFollowUp: (
      text: string,
      attachments: ChatSubmitAttachments | undefined,
      delivery: ComposerDelivery,
    ) => Promise<boolean>;
    resumeInterruptedTurn: (
      expectedTerminalSequence: number,
    ) => Promise<boolean>;
    applyStartedQueueReceipt: (
      receipt: Extract<
        import("@legioncode/sdk").ThreadInputReceipt,
        { status: "started" }
      >,
      expectedScope: ConversationScope,
    ) => boolean;
    append: (
      message: { role: "user"; content: string },
      delivery?: ComposerDelivery,
    ) => Promise<SubmissionOutcome>;
    reviseTurn?: (turnId: string, content: string) => Promise<boolean>;
    stop: () => void;
    isLoading: boolean;
    hasHydrated?: boolean;
    hydrationStatus?: HydrationStatus | "loading" | "idle";
    hydrationError?: string | null;
    retryHydration?: () => void;
    error?: string | null;
    scopeRecoveryError: ConversationScopeHttpError | null;
    retryScopeRead: () => Promise<void>;
    debugEvents?: ChatDebugEvent[];
    conversationScope?: ConversationScope | null;
    serverTurnId?: string | null;
    activeTurnProjection?: ActiveTurnProjection;
  };
  sessionId: string;
  initialPromptSubmission?: InitialPromptSubmission | null;
  hasStartedSession?: boolean;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  permissionMode?: ProductMode;
  onPermissionModeChange?: (mode: ProductMode) => void;
  onArtifactOpen?: ArtifactOpenHandler;
  onReviewOpen?: () => void;
  onContextOpen?: (
    budget: ContextBudgetSnapshot,
    usage: UsageCostSnapshot | null,
  ) => void;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  repoTree?: Array<{ path: string; type: string; sha: string }>;
  isLoadingRepoTree?: boolean;
  projectName?: string;
  onProjectClick?: () => void;
  onPresentationReadyChange?: (ready: boolean) => void;
}

export function ChatInterface({
  chatProps,
  sessionId,
  initialPromptSubmission = null,
  hasStartedSession = false,
  mode = "build",
  onModeChange,
  permissionMode,
  onPermissionModeChange,
  onArtifactOpen,
  onReviewOpen,
  onContextOpen,
  onModelSelect,
  repoTree = [],
  isLoadingRepoTree = false,
  projectName,
  onProjectClick,
  onPresentationReadyChange,
}: ChatInterfaceProps) {
  const {
    messages,
    optimisticUserMessageId = null,
    runId,
    input,
    handleInputChange,
    handleSubmit,
    append,
    stop,
    isLoading,
    hasHydrated = true,
    hydrationStatus = "idle",
    hydrationError,
    retryHydration,
    error,
    scopeRecoveryError,
    retryScopeRead,
    debugEvents = [],
    conversationScope,
    serverTurnId,
  } = chatProps;
  const scrollRef = useRef<HTMLDivElement>(null);

  const localActiveTurn = useActiveTurnProjection({
    turnId: serverTurnId,
    transportLoading: isLoading,
    enabled: !chatProps.activeTurnProjection,
  });
  const activeTurn = chatProps.activeTurnProjection ?? localActiveTurn;
  const lifecycleProjection = activeTurn.projection;
  const compactActiveTurn = useCallback(async () => {
    const scope = conversationScope;
    if (!scope) return;
    await createWebPlatformClient().compactTurn({
      runId: RunIdSchema.parse(runId),
      sessionId: scope.sessionId,
      workspaceId: WorkspaceIdSchema.parse(scope.workspaceId),
      threadId: ThreadIdSchema.parse(scope.threadId),
      turnId: TurnIdSchema.parse(scope.turnId),
      runAttemptId: RunAttemptIdSchema.parse(scope.runAttemptId),
    });
  }, [conversationScope, runId]);
  // The canonical lifecycle projection is the only workflow/activity source.
  // RunEvent and persisted activity backfills are deliberately not rendered.
  const awaitingCanonicalLifecycle =
    activeTurn.isTransportPending ||
    (activeTurn.hasCanonicalTurn && !activeTurn.isReplayReady) ||
    (isLoading && activeTurn.isTerminal);
  const activeRunLoading =
    activeTurn.isActive ||
    activeTurn.isTransportPending ||
    awaitingCanonicalLifecycle;
  const activeQueueTarget = useMemo(
    () =>
      activeRunLoading && conversationScope
        ? {
            turnId: conversationScope.turnId,
            runAttemptId: conversationScope.runAttemptId,
          }
        : null,
    [activeRunLoading, conversationScope],
  );
  const queue = useThreadInputQueue(
    conversationScope ?? null,
    activeQueueTarget,
    `${activeTurn.projection?.turnId ?? ""}:${activeTurn.projection?.lastSequence ?? 0}:${activeTurn.continuationStatus}`,
  );
  const { applyStartedQueueReceipt } = chatProps;
  const refreshQueue = queue.refresh;
  useEffect(() => {
    const snapshot = queue.snapshot;
    const started = snapshot?.latestStarted?.receipt;
    if (
      !snapshot ||
      !started ||
      !conversationScope ||
      snapshot.activeRunId !== started.runId ||
      conversationScope.runId === started.runId
    ) {
      return;
    }
    applyStartedQueueReceipt(started, conversationScope);
  }, [applyStartedQueueReceipt, conversationScope, queue.snapshot]);
  const submitFollowUp = useCallback(
    async (
      attachments: ChatSubmitAttachments | undefined,
      delivery: ComposerDelivery,
    ) => {
      const accepted = await chatProps.submitFollowUp(
        input,
        attachments,
        delivery,
      );
      if (accepted) void refreshQueue();
      return accepted;
    },
    [chatProps, input, refreshQueue],
  );
  const continuationRecovery =
    activeTurn.continuationStatus === "reconnecting" ||
    activeTurn.continuationStatus === "stopped"
      ? {
          status: activeTurn.continuationStatus,
          error: activeTurn.continuationError,
          onRetry: activeTurn.retryContinuation,
        }
      : null;
  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return messages[index]?.id ?? null;
      }
    }
    return null;
  }, [messages]);
  const {
    selectedReviewComments,
    selectPromptArtifactReview,
    selectCanonicalTurnReview,
    toggleReviewCommentSelected,
    markReviewCommentsDispatching,
    markReviewCommentsDispatched,
    markReviewCommentsDispatchFailed,
  } = useGitReview();
  const showDebugPanel =
    import.meta.env.VITE_ENABLE_CHAT_DEBUG_PANEL === "true";
  const { providerModels } = useProviderStore(runId);
  const { login, refreshSession } = useAuth();
  const {
    reviewCommentError,
    changeInput: handleInputChangeWrapper,
    removeComment: handleRemoveReviewComment,
    submitWithComments: handleSubmitWithReviewComments,
  } = useReviewCommentSubmission({
    comments: selectedReviewComments,
    input,
    isLoading,
    error,
    append,
    handleInputChange,
    toggleSelected: toggleReviewCommentSelected,
    markDispatching: markReviewCommentsDispatching,
    markDispatched: markReviewCommentsDispatched,
    markDispatchFailed: markReviewCommentsDispatchFailed,
  });
  const submitComposer = useCallback(
    async (
      attachments?: ChatSubmitAttachments,
      delivery?: ComposerDelivery,
    ): Promise<boolean> => {
      if (input.trim() !== "/compact") {
        return handleSubmit(undefined, attachments, delivery);
      }
      const budget = lifecycleProjection?.contextBudget;
      if (
        !lifecycleProjection ||
        lifecycleProjection.terminal ||
        !budget ||
        budget.utilizationPercent < budget.warningThresholdPercent
      ) {
        return false;
      }
      await compactActiveTurn();
      handleInputChangeWrapper("");
      return true;
    },
    [
      compactActiveTurn,
      handleInputChangeWrapper,
      handleSubmit,
      input,
      lifecycleProjection,
    ],
  );

  const messageMetadataById = useMemo(() => {
    return buildChatMessageMetadata(
      messages,
      debugEvents,
      (modelId) => resolveModelLabel(modelId, providerModels),
      mode === "plan" ? "Plan" : "Build",
    );
  }, [messages, debugEvents, mode, providerModels]);
  const {
    pendingApproval,
    matchingInChatOption,
    decisions: displayedApprovalDecisions,
    busyDecision: approvalBusyDecision,
    error: approvalError,
    resolve: resolveApprovalDecision,
  } = useApprovalController({
    lifecycleProjection,
    sessionId,
  });
  const completedTurnReview = useCompletedTurnReview(
    lifecycleProjection,
    latestAssistantMessageId,
  );
  const conversationTurns = useMemo(
    () => buildConversationTurns(messages),
    [messages],
  );
  const hasImmediateUserSubmission = useMemo(
    () =>
      optimisticUserMessageId !== null &&
      messages.some((message) => message.id === optimisticUserMessageId),
    [messages, optimisticUserMessageId],
  );
  const {
    projections: historicalLifecycleProjections,
    isLoading: areHistoricalLifecyclesLoading,
  } = useConversationLifecycleProjections(
    conversationTurns,
    lifecycleProjection?.turnId,
  );
  const lifecycleProjectionsByTurnId = useMemo(
    () =>
      mergeLifecycleProjections(
        historicalLifecycleProjections,
        {},
        lifecycleProjection,
      ),
    [historicalLifecycleProjections, lifecycleProjection],
  );
  const latestLifecycleProjection = useMemo(() => {
    if (lifecycleProjection) return lifecycleProjection;
    for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
      const turnId = conversationTurns[index]?.turnId;
      if (turnId && lifecycleProjectionsByTurnId[turnId]) {
        return lifecycleProjectionsByTurnId[turnId];
      }
    }
    return null;
  }, [conversationTurns, lifecycleProjection, lifecycleProjectionsByTurnId]);
  const {
    snapshots: changedFileSnapshotsByAssistantMessageId,
    artifacts: artifactSourcesByAssistantMessageId,
    loadChangedFileDiff,
    loadArtifactChangedFileDiff,
  } = useChangedFilesController({
    messages,
    runId,
    isLoading: activeTurn.isTransportPending,
    summaryStatus: null,
    turnDiff: lifecycleProjection?.turnDiff ?? null,
    artifactIdentity: conversationScope,
  });
  const recoveryAdvice = getProviderRecoveryAdvice(error, scopeRecoveryError);
  const openProviderRecoverySurface = useCallback(() => {
    if (recoveryAdvice.recoveryTarget === "auth") {
      login(true);
      return;
    }
    if (
      recoveryAdvice.recoveryTarget === "scope" ||
      recoveryAdvice.recoveryTarget === "general"
    ) {
      return;
    }
    dispatchOpenSettingsDialog(recoveryAdvice.recoveryTarget);
  }, [login, recoveryAdvice.recoveryTarget]);
  const chatErrorNotice: ChatErrorNoticeProps | null = error
    ? {
        ...recoveryAdvice,
        message: error.startsWith("Stop not confirmed yet.")
          ? error
          : recoveryAdvice.message,
        onOpen:
          recoveryAdvice.recoveryTarget === "scope"
            ? retryScopeRead
            : recoveryAdvice.recoveryTarget === "general"
              ? undefined
              : openProviderRecoverySurface,
      }
    : null;

  useEffect(() => {
    if (recoveryAdvice.recoveryTarget !== "auth") {
      return;
    }
    void refreshSession();
  }, [recoveryAdvice.recoveryTarget, refreshSession]);
  const {
    chatEntries,
    terminalViewModel,
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder,
  } = useChatPresentation({
    messages,
    conversationTurns,
    historyDisplayRecords: chatProps.historyDisplayRecords ?? [],
    hasHydrated:
      hasHydrated &&
      !areHistoricalLifecyclesLoading &&
      (!activeTurn.hasCanonicalTurn || activeTurn.isReplayReady),
    isLoading: activeRunLoading,
    hasPendingApproval: Boolean(pendingApproval),
    hasStartedSession,
    lifecycleProjection,
    lifecycleProjectionsByTurnId,
    initialPromptSubmission,
    hasImmediateUserSubmission,
  });
  const showStableSessionPlaceholder = useStableChatLoadingIndicator(
    showSessionPlaceholder,
    hasImmediateUserSubmission ||
      Boolean(initialPromptSubmission?.prompt.trim()),
  );
  useEffect(() => {
    onPresentationReadyChange?.(!showStableSessionPlaceholder);
  }, [onPresentationReadyChange, showStableSessionPlaceholder]);
  const renderComposerControls = (layout: ComposerLayout) => (
    <ChatComposerControls
      layout={layout}
      error={chatErrorNotice}
      continuation={continuationRecovery}
      approval={{
        pending: pendingApproval,
        matchingInChatOption,
        decisions: displayedApprovalDecisions,
        busyDecision: approvalBusyDecision,
        error: approvalError,
        onResolve: resolveApprovalDecision,
      }}
      input={input}
      onInputChange={handleInputChangeWrapper}
      onSubmit={(attachments, delivery) =>
        selectedReviewComments.length > 0
          ? handleSubmitWithReviewComments(delivery)
          : submitComposer(attachments, delivery)
      }
      onFollowUpSubmit={
        conversationScope
          ? (attachments, delivery) => submitFollowUp(attachments, delivery)
          : undefined
      }
      queuePanel={
        <ThreadInputQueuePanel
          onDisableQueuing={() => updateComposerPreferences({ followUpBehavior: "steer" })}
          snapshot={queue.snapshot}
          error={queue.error}
          active={activeRunLoading}
          onUpdate={queue.update}
          onRemove={queue.remove}
          onSteer={queue.steer}
          onStart={async (itemId, version, revision) => {
            const expectedScope = conversationScope;
            if (!expectedScope) return null;
            const receipt = await queue.start(itemId, version, revision);
            if (receipt?.status === "started") {
              chatProps.applyStartedQueueReceipt(receipt, expectedScope);
            }
            return receipt;
          }}
        />
      }
      resumeUnavailableMessage={
        resumeUnavailableMessage(
          activeTurn.projection,
          Boolean(conversationScope),
        ) ?? null
      }
      canResume={Boolean(
        conversationScope &&
        activeTurn.projection?.terminal?.state === "interrupted" &&
        activeTurn.projection.workspaceSnapshotState === "captured" &&
        activeTurn.projection.resumeSnapshotAvailable === true,
      )}
      onResume={() => {
        const projection = activeTurn.projection;
        if (
          projection?.terminal?.state === "interrupted" &&
          projection.workspaceSnapshotState === "captured" &&
          projection.resumeSnapshotAvailable === true
        ) {
          void chatProps.resumeInterruptedTurn(projection.lastSequence);
        }
      }}
      reviewComments={selectedReviewComments}
      onRemoveReviewComment={handleRemoveReviewComment}
      reviewCommentError={reviewCommentError}
      onStop={stop}
      canStop={activeRunLoading}
      isLoading={activeRunLoading || isTranscriptHydrating}
      sessionId={sessionId}
      runId={runId}
      mode={mode}
      onModeChange={onModeChange}
      hasMessages={messages.length > 0}
      onModelSelect={onModelSelect}
      repoTree={repoTree}
      isLoadingRepoTree={isLoadingRepoTree}
      permissionMode={permissionMode}
      onPermissionModeChange={onPermissionModeChange}
      contextBudget={latestLifecycleProjection?.contextBudget ?? null}
      usage={latestLifecycleProjection?.usage ?? null}
      onCompact={
        lifecycleProjection && !lifecycleProjection.terminal
          ? () => void compactActiveTurn()
          : undefined
      }
      onContextOpen={
        latestLifecycleProjection?.contextBudget && onContextOpen
          ? () =>
              onContextOpen(
                latestLifecycleProjection.contextBudget!,
                latestLifecycleProjection.usage,
              )
          : undefined
      }
    />
  );

  const latestLifecycleSequence = latestLifecycleProjection?.lastSequence ?? 0;
  const latestMessage = messages.at(-1);
  useChatAutoScroll({
    activeRun: activeRunLoading,
    latestMessageKey: latestMessage
      ? `${latestMessage.id}:${latestMessage.role}`
      : null,
    lifecycleSequence: latestLifecycleSequence,
    placeholderVisible: showStableSessionPlaceholder,
    scopeKey: `${sessionId}:${runId}`,
    scrollRef,
  });

  return (
    <ChatInterfaceView
      ref={scrollRef}
      showHeroComposer={showHeroComposer}
      projectName={projectName}
      onProjectClick={onProjectClick}
      showSessionPlaceholder={showStableSessionPlaceholder}
      placeholderError={chatErrorNotice}
      continuation={continuationRecovery}
      canStopPendingTurn={
        Boolean(conversationScope) && activeRunLoading && !activeTurn.isTerminal
      }
      onStopPendingTurn={stop}
      renderComposer={renderComposerControls}
      debugPanel={showDebugPanel ? <ChatDebugPanel events={debugEvents} /> : null}
      resolveHydratedImageSource={resolveHydratedChatImageSource}
      loadArtifactContent={loadColdStorageArtifact}
      chatEntries={chatEntries}
      hydrationStatus={hydrationStatus}
      hydrationError={hydrationError ?? null}
      retryHydration={retryHydration}
      workspaceId={conversationScope?.workspaceId ?? null}
      threadId={conversationScope?.threadId ?? null}
      runAttemptId={conversationScope?.runAttemptId ?? null}
      artifactIdentity={conversationScope}
      messageMetadataById={messageMetadataById}
      modeLabel={mode === "plan" ? "Plan" : "Build"}
      resolveModelLabel={(modelId) =>
        resolveModelLabel(modelId, providerModels)
      }
      onArtifactOpen={onArtifactOpen}
      onReviewOpen={onReviewOpen}
      snapshots={changedFileSnapshotsByAssistantMessageId}
      artifacts={artifactSourcesByAssistantMessageId}
      loadChangedFileDiff={loadChangedFileDiff}
      selectPromptArtifactReview={selectPromptArtifactReview}
      selectCanonicalTurnReview={selectCanonicalTurnReview}
      terminalViewModel={terminalViewModel}
      terminalReviewFiles={terminalViewModel ? completedTurnReview.files : []}
      terminalTurnDiff={lifecycleProjection?.turnDiff ?? null}
      loadArtifactChangedFileDiff={loadArtifactChangedFileDiff}
      loadCompletedTurnFileDiff={completedTurnReview.loadFileDiff}
      completedTurnReview={completedTurnReview}
      lifecycleProjection={lifecycleProjection}
      onUserMessageEdit={chatProps.reviseTurn}
      pendingWorkflow={awaitingCanonicalLifecycle}
    />
  );
}
