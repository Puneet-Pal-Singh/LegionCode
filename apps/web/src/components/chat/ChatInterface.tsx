import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { ChatSubmitAttachments } from "./chatImageAttachments";
import type { Message } from "@ai-sdk/react";
import {
  type ProductMode,
  type RunMode,
} from "@repo/shared-types";
import type { ProviderId } from "../../types/provider";
import type { ChatDebugEvent } from "../../types/chat-debug.js";
import { getProviderRecoveryAdvice } from "../../lib/provider-recovery";
import { useAuth } from "../../contexts/AuthContext";
import { useProviderStore } from "../../hooks/useProviderStore.js";
import { dispatchOpenSettingsDialog } from "../../lib/settings-dialog-events.js";
import {
  buildChatMessageMetadata,
  buildConversationTurns,
} from "./messageMetadata";
import { ActivityTurn } from "./activity/ActivityTurn.js";
import { WorkflowTimeline } from "./workflow/WorkflowTimeline.js";
import type { ActivityTurnViewModel } from "../../services/activity/ActivityFeedViewModel.js";
import { useGitReview } from "../git/useGitReview";
import { resolveModelLabel } from "./chat-interface/modelLabels";
import { useChangedFilesController } from "./chat-interface/useChangedFilesController";
import { useApprovalController } from "./chat-interface/useApprovalController";
import { useActiveTurnProjection } from "./chat-interface/useActiveTurnProjection.js";
import { useHistoricalRunBackfill } from "./chat-interface/useHistoricalRunBackfill.js";
import { useCompletedTurnReview } from "./chat-interface/useCompletedTurnReview.js";
import { useReviewCommentSubmission } from "./chat-interface/useReviewCommentSubmission";
import {
  ChatComposerControls,
  type ComposerLayout,
} from "./chat-interface/ChatComposerControls";
import { ChatInterfaceView } from "./chat-interface/ChatInterfaceView";
import { useActivityPresentation } from "./chat-interface/useActivityPresentation";
import { usePlanModeController } from "./chat-interface/usePlanModeController";
import { useChatPresentation } from "./chat-interface/useChatPresentation";
import {
  hasArtifactChangedFileSnapshot,
  hasChangedFileSnapshot,
} from "./chat-interface/changedFiles";

const SHOW_WORKFLOW_DEBUG_PANEL = false;
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
    serverTurnId?: string | null;
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
    serverTurnId,
  } = chatProps;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedActivityTurns, setExpandedActivityTurns] = useState<
    Record<string, boolean>
  >({});
  const [expandedActivityRows, setExpandedActivityRows] = useState<
    Record<string, boolean>
  >({});

  const activeTurn = useActiveTurnProjection({
    turnId: serverTurnId,
    transportLoading: isLoading,
  });
  const lifecycleProjection = activeTurn.projection;
  const { summary, events, feed } = useHistoricalRunBackfill({
    runId,
    enabled: !activeTurn.hasCanonicalTurn && !isLoading,
  });
  const activeRunLoading = activeTurn.isActive || activeTurn.isTransportPending;
  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return messages[index]?.id ?? null;
      }
    }
    return null;
  }, [messages]);
  const {
    status: gitStatus,
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
    scopedFeed,
    viewModel: activityViewModel,
    scrollSignal: activityScrollSignal,
  } = useActivityPresentation({
    runId,
    messages,
    feed,
    events,
    isLoading: activeTurn.isTransportPending,
  });
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
  const {
    snapshots: changedFileSnapshotsByAssistantMessageId,
    artifacts: artifactSourcesByAssistantMessageId,
    loadChangedFileDiff,
    loadArtifactChangedFileDiff,
  } = useChangedFilesController({
    messages,
    runId,
    sessionId,
    isLoading: activeTurn.isTransportPending,
    summaryStatus: summary?.status,
    gitFiles: gitStatus?.files ?? [],
    conversationTurns,
    activityTurns: activityViewModel.turns,
    hasScopedFeed: Boolean(scopedFeed),
    turnDiff: lifecycleProjection?.turnDiff ?? null,
  });
  useEffect(() => {
    // Reset expansion preferences when the active run changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedActivityTurns({});
    setExpandedActivityRows({});
  }, [runId]);

  const { usePlanInBuild: planHandoffAction } = usePlanModeController({
    runId,
    messages,
    mode,
    isLoading,
    handoffPrompt: summary?.planArtifact?.handoff?.prompt,
    append,
    restoreInput: handleInputChangeWrapper,
    onModeChange,
  });

  const recoveryAdvice = getProviderRecoveryAdvice(error);
  const openProviderRecoverySurface = useCallback(() => {
    if (recoveryAdvice.recoveryTarget === "auth") {
      login();
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
  const activeInlineTurn = activityViewModel.turns.find(
    (turn) => turn.isActiveTurn && turn.hasVisibleRows,
  );
  const {
    chatEntries,
    terminalViewModel,
    showHeroComposer,
    isTranscriptHydrating,
    showSessionPlaceholder,
  } = useChatPresentation({
    runId,
    messages,
    conversationTurns,
    activityTurns: activityViewModel.turns,
    summary,
    events,
    snapshots: changedFileSnapshotsByAssistantMessageId,
    artifacts: artifactSourcesByAssistantMessageId,
    hasHydrated,
    isLoading: activeRunLoading,
    hasPendingApproval: Boolean(pendingApproval),
    hasStartedSession,
    lifecycleProjection,
  });
  const showThinking = Boolean(
    lifecycleProjection?.activeThinking && !activeInlineTurn,
  );
  const renderActivityTurn = (turn: ActivityTurnViewModel) => (
    <ActivityTurn
      key={`activity:${turn.key}`}
      turn={turn}
      expanded={expandedActivityTurns[turn.key] ?? !turn.defaultCollapsed}
      onToggleTurn={() =>
        setExpandedActivityTurns((current) => ({
          ...current,
          [turn.key]: !(current[turn.key] ?? !turn.defaultCollapsed),
        }))
      }
      expandedRows={expandedActivityRows}
      onToggleRow={(rowKey, expanded) =>
        setExpandedActivityRows((current) => ({
          ...current,
          [rowKey]: !expanded,
        }))
      }
      onUsePlanInBuild={planHandoffAction}
    />
  );
  const renderComposerControls = (layout: ComposerLayout) => (
    <ChatComposerControls
      layout={layout}
      error={
        error
          ? { ...recoveryAdvice, onOpen: openProviderRecoverySurface }
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
          : (attachments) => handleSubmit(undefined, attachments)
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
    />
  );

  // Auto-scroll to bottom on new messages and live activity updates.
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
  }, [activityScrollSignal, isLoading, messages, runId, sessionId]);

  return (
    <ChatInterfaceView
      ref={scrollRef}
      showHeroComposer={showHeroComposer}
      showSessionPlaceholder={showSessionPlaceholder}
      renderComposer={renderComposerControls}
      showDebugPanel={showDebugPanel}
      debugEvents={debugEvents}
      chatEntries={chatEntries}
      messageMetadataById={messageMetadataById}
      renderActivityTurn={renderActivityTurn}
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
      showThinking={showThinking}
      lifecycleProjection={lifecycleProjection}
      workflowDebug={
        SHOW_WORKFLOW_DEBUG_PANEL ? (
          <details className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
              Workflow Debug
            </summary>
            <div className="mt-4">
              <WorkflowTimeline
                events={events}
                summary={summary}
                isLoading={isLoading}
                onJumpToLatest={() =>
                  scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                    behavior: "smooth",
                  })
                }
              />
            </div>
          </details>
        ) : null
      }
    />
  );
}
