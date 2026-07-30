import { useRef, useEffect, useMemo, useCallback, useState } from "react";
import {
  RunIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
  type ContextBudgetSnapshot,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";
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
} from "./chat-interface/useActiveTurnProjection.js";
import { useCompletedTurnReview } from "./chat-interface/useCompletedTurnReview.js";
import { useReviewCommentSubmission } from "./chat-interface/useReviewCommentSubmission";
import {
  ChatComposerControls,
  type ComposerLayout,
} from "./chat-interface/ChatComposerControls";
import { ChatInterfaceView } from "./chat-interface/ChatInterfaceView";
import { createLifecycleClient } from "../../services/api/lifecycleClient";
import { useChatPresentation } from "./chat-interface/useChatPresentation";
import {
  hasArtifactChangedFileSnapshot,
  hasChangedFileSnapshot,
} from "./chat-interface/changedFiles";
import { useConversationLifecycleProjections } from "../../hooks/useConversationLifecycleProjections";
import type { LifecycleProjection } from "../../services/lifecycle/LifecycleProjection";
import { mergeLifecycleProjections } from "./chat-interface/mergeLifecycleProjections";

interface ChatInterfaceProps {
  chatProps: {
    messages: Message[];
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
  hasStartedSession?: boolean;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  permissionMode?: ProductMode;
  onPermissionModeChange?: (mode: ProductMode) => void;
  onPendingApprovalChange?: (hasPendingApproval: boolean) => void;
  onArtifactOpen?: (path: string, content: string) => void;
  onReviewOpen?: () => void;
  onContextOpen?: (
    budget: ContextBudgetSnapshot,
    usage: UsageCostSnapshot | null,
  ) => void;
  onModelSelect?: (providerId: ProviderId, modelId: string) => void;
  repoTree?: Array<{ path: string; type: string; sha: string }>;
  isLoadingRepoTree?: boolean;
}

export function ChatInterface({
  chatProps,
  sessionId,
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
}: ChatInterfaceProps) {
  const {
    messages,
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
  const awaitingCanonicalLifecycle = isLoading && !activeTurn.hasReplay;
  const activeRunLoading =
    activeTurn.isActive ||
    activeTurn.isTransportPending ||
    awaitingCanonicalLifecycle;
  const pendingWorkflowStartedAtRef = useRef<number | null>(null);
  if (
    awaitingCanonicalLifecycle &&
    pendingWorkflowStartedAtRef.current === null
  ) {
    pendingWorkflowStartedAtRef.current = Date.now();
  } else if (!awaitingCanonicalLifecycle) {
    pendingWorkflowStartedAtRef.current = null;
  }
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
    notice: approvalNoticeText,
    isResolutionPending: isApprovalResolutionPending,
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
  const historicalLifecycleProjections = useConversationLifecycleProjections(
    conversationTurns,
    lifecycleProjection?.turnId,
  );
  const [observedLifecycleProjections, setObservedLifecycleProjections] =
    useState<Record<string, LifecycleProjection>>({});

  useEffect(() => {
    setObservedLifecycleProjections({});
  }, [runId, sessionId]);

  useEffect(() => {
    if (!lifecycleProjection) return;
    setObservedLifecycleProjections((current) => ({
      ...current,
      [lifecycleProjection.turnId]: lifecycleProjection,
    }));
  }, [lifecycleProjection]);

  const lifecycleProjectionsByTurnId = useMemo(
    () =>
      mergeLifecycleProjections(
        historicalLifecycleProjections,
        observedLifecycleProjections,
        lifecycleProjection,
      ),
    [
      historicalLifecycleProjections,
      lifecycleProjection,
      observedLifecycleProjections,
    ],
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
    hasHydrated,
    isLoading: activeRunLoading,
    hasPendingApproval: Boolean(pendingApproval),
    hasStartedSession,
    lifecycleProjection,
    lifecycleProjectionsByTurnId,
  });
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
        notice: approvalNoticeText,
        isResolutionPending: isApprovalResolutionPending,
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
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const scrollScopeKey = `${sessionId}:${runId}`;
    const isInitialScopeScroll =
      previousScrollScopeKeyRef.current !== scrollScopeKey;
    previousScrollScopeKeyRef.current = scrollScopeKey;

    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: isInitialScopeScroll ? "auto" : "smooth",
    });
  }, [activeRunLoading, latestLifecycleSequence, messages, runId, sessionId]);

  return (
    <ChatInterfaceView
      ref={scrollRef}
      showHeroComposer={showHeroComposer}
      showSessionPlaceholder={showSessionPlaceholder}
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
      terminalReviewFiles={
        terminalViewModel &&
        (hasChangedFileSnapshot(changedFileSnapshotsByAssistantMessageId) ||
          hasArtifactChangedFileSnapshot(artifactSourcesByAssistantMessageId))
          ? []
          : completedTurnReview.files
      }
      terminalTurnDiff={lifecycleProjection?.turnDiff ?? null}
      loadArtifactChangedFileDiff={loadArtifactChangedFileDiff}
      loadCompletedTurnFileDiff={completedTurnReview.loadFileDiff}
      completedTurnReview={completedTurnReview}
      lifecycleProjection={lifecycleProjection}
      pendingWorkflowStartedAt={
        awaitingCanonicalLifecycle ? pendingWorkflowStartedAtRef.current : null
      }
    />
  );
}
