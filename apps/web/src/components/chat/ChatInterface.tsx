import {
  useRef,
  useEffect,
  useLayoutEffect,
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
} from "@repo/platform-client-sdk";
import type { ChatSubmitAttachments } from "./chatImageAttachments";
import type { Message } from "@ai-sdk/react";
import { type ProductMode, type RunMode } from "@repo/shared-types";
import type { ProviderId } from "../../types/provider";
import type { ChatDebugEvent } from "../../types/chat-debug.js";
import type { ConversationScope } from "../../hooks/conversationScope";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery";
import { useAuth } from "../../contexts/AuthContext";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { dispatchOpenSettingsDialog } from "../../lib/settings-dialog-events.js";
import {
  buildChatMessageMetadata,
  buildConversationTurns,
} from "./messageMetadata";
import { useGitReview } from "../git/useGitReview";
import { resolveModelLabel } from "./chat-interface/modelLabels";
import { useChangedFilesController } from "./chat-interface/useChangedFilesController";
import { useApprovalController } from "./chat-interface/useApprovalController";
import {
  useActiveTurnProjection,
  type ActiveTurnProjection,
} from "../../hooks/useActiveTurnProjection.js";
import { useCompletedTurnReview } from "./chat-interface/useCompletedTurnReview.js";
import { useReviewCommentSubmission } from "./chat-interface/useReviewCommentSubmission";
import {
  ChatComposerControls,
  type ComposerLayout,
} from "./chat-interface/ChatComposerControls";
import { ChatInterfaceView } from "./chat-interface/ChatInterfaceView";
import { createLifecycleClient } from "../../services/api/lifecycleClient";
import { useChatPresentation } from "./chat-interface/useChatPresentation";
import type { InitialPromptSubmission } from "../../lib/initial-prompt-submission";
import { useConversationLifecycleProjections } from "../../hooks/useConversationLifecycleProjections";
import { mergeLifecycleProjections } from "./chat-interface/mergeLifecycleProjections";
import type { ArtifactOpenHandler } from "./artifactOpen";
import { useStableChatLoadingIndicator } from "./chat-interface/useStableChatLoadingIndicator.js";

interface ChatInterfaceProps {
  chatProps: {
    messages: Message[];
    optimisticUserMessageId?: string | null;
    runId: string;
    input: string;
    handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    handleSubmit: (
      event?: React.FormEvent,
      attachments?: ChatSubmitAttachments,
    ) => Promise<boolean>;
    append: (message: { role: "user"; content: string }) => Promise<void>;
    stop: () => void;
    isLoading: boolean;
    hasHydrated?: boolean;
    error?: string | null;
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
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
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
  onPendingApprovalChange,
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
    error,
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
    await createLifecycleClient().compactTurn({
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
    (activeTurn.hasCanonicalTurn && !activeTurn.hasReplay) ||
    (isLoading && activeTurn.isTerminal);
  const activeRunLoading =
    activeTurn.isActive ||
    activeTurn.isTransportPending ||
    awaitingCanonicalLifecycle;
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
    openPromptArtifactReview,
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
    async (attachments?: ChatSubmitAttachments): Promise<boolean> => {
      if (input.trim() !== "/compact") {
        return handleSubmit(undefined, attachments);
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
  const previousScrollScopeKeyRef = useRef<string | null>(null);
  const previousPlaceholderVisibilityRef = useRef(true);

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
    decisions: displayedApprovalDecisions,
    busyDecision: approvalBusyDecision,
    error: approvalError,
    resolve: resolveApprovalDecision,
  } = useApprovalController({
    lifecycleProjection,
    onPendingApprovalChange,
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
  const recoveryAdvice = getProviderRecoveryAdvice(error);
  const openProviderRecoverySurface = useCallback(() => {
    if (recoveryAdvice.recoveryTarget === "auth") {
      login(true);
      return;
    }
    dispatchOpenSettingsDialog(recoveryAdvice.recoveryTarget);
  }, [login, recoveryAdvice.recoveryTarget]);

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
    hasHydrated:
      hasHydrated &&
      !areHistoricalLifecyclesLoading &&
      (!activeTurn.hasCanonicalTurn || activeTurn.hasReplay),
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
      error={
        error
          ? {
              ...recoveryAdvice,
              onOpen:
                recoveryAdvice.recoveryTarget === "general"
                  ? undefined
                  : openProviderRecoverySurface,
            }
          : null
      }
      approval={{
        pending: pendingApproval,
        decisions: displayedApprovalDecisions,
        busyDecision: approvalBusyDecision,
        error: approvalError,
        onResolve: resolveApprovalDecision,
      }}
      input={input}
      onInputChange={handleInputChangeWrapper}
      onSubmit={
        selectedReviewComments.length > 0
          ? () => handleSubmitWithReviewComments()
          : submitComposer
      }
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

  // Keep the active turn visible as canonical lifecycle activity arrives.
  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    const isLoaderReveal = previousPlaceholderVisibilityRef.current;
    previousPlaceholderVisibilityRef.current = showStableSessionPlaceholder;
    if (!scrollContainer || showStableSessionPlaceholder) {
      return;
    }

    const scrollScopeKey = `${sessionId}:${runId}`;
    const isInitialScopeScroll =
      previousScrollScopeKeyRef.current !== scrollScopeKey;
    previousScrollScopeKeyRef.current = scrollScopeKey;

    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: isInitialScopeScroll || isLoaderReveal ? "auto" : "smooth",
    });
  }, [
    activeRunLoading,
    latestLifecycleSequence,
    messages,
    runId,
    sessionId,
    showStableSessionPlaceholder,
  ]);

  return (
    <ChatInterfaceView
      ref={scrollRef}
      showHeroComposer={showHeroComposer}
      projectName={projectName}
      onProjectClick={onProjectClick}
      showSessionPlaceholder={showStableSessionPlaceholder}
      renderComposer={renderComposerControls}
      showDebugPanel={showDebugPanel}
      debugEvents={debugEvents}
      chatEntries={chatEntries}
      workspaceId={conversationScope?.workspaceId ?? null}
      threadId={conversationScope?.threadId ?? null}
      runAttemptId={conversationScope?.runAttemptId ?? null}
      artifactIdentity={conversationScope}
      messageMetadataById={messageMetadataById}
      onArtifactOpen={onArtifactOpen}
      onReviewOpen={onReviewOpen}
      snapshots={changedFileSnapshotsByAssistantMessageId}
      artifacts={artifactSourcesByAssistantMessageId}
      loadChangedFileDiff={loadChangedFileDiff}
      openPromptArtifactReview={openPromptArtifactReview}
      terminalViewModel={terminalViewModel}
      terminalReviewFiles={terminalViewModel ? completedTurnReview.files : []}
      terminalTurnDiff={lifecycleProjection?.turnDiff ?? null}
      loadArtifactChangedFileDiff={loadArtifactChangedFileDiff}
      loadCompletedTurnFileDiff={completedTurnReview.loadFileDiff}
      completedTurnReview={completedTurnReview}
      lifecycleProjection={lifecycleProjection}
      pendingWorkflow={awaitingCanonicalLifecycle}
    />
  );
}
