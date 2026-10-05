import {
  useRef,
  useEffect,
  useState,
  useMemo,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { type ProductMode, type RunMode } from "@repo/shared-types";
import { motion } from "framer-motion";
import { FileExplorerHandle } from "../FileExplorer";
import { ChatInterface } from "../chat/ChatInterface";
import { RunContextProvider } from "../../hooks/useRunContext";
import { useChat } from "../../hooks/useChat";
import { buildChatAppendMessage } from "../../hooks/useChatCore";
import { cn } from "../../lib/utils";
import { useGitStatus } from "../../hooks/useGitStatus";
import { Resizer } from "../ui/Resizer";
import { useWorkspaceState } from "./workspace/useWorkspaceState";
import { useGitHubTree } from "./workspace/useGitHubTree";
import { useFileLoader } from "./workspace/useFileLoader";
import { useStatusSync } from "./workspace/useStatusSync";
import { useSidebarOrchestration } from "./workspace/useSidebarOrchestration";
import { SidebarHeader } from "./workspace/SidebarHeader";
import { SidebarContent } from "./workspace/SidebarContent";
import { TabType, type SelectedFile } from "./workspace/useWorkspaceState";
import {
  loadStoredProductMode,
  persistProductMode,
} from "../../lib/product-mode-storage";
import { GitReviewProvider } from "../git/GitReviewContext";
import { GitReviewDialog } from "../git/GitReviewDialog";
import { WorkspaceFilesTree } from "./workspace/SidebarTreeOverlay";
import { GitCommitDialog } from "../git/GitCommitDialog";
import type { SessionStatus } from "../../types/session";
import type { SessionPersistenceStatus } from "../../lib/session-persistence";
import { isSessionPersistenceReady } from "../../lib/session-persistence";
import {
  deriveCanonicalRunStatus,
  deriveWorkspaceRunUiState,
} from "./workspace/runUiState";
import { logClientEvent } from "../../lib/client-logger.js";
import {
  claimInitialPromptSubmission,
  clearInitialPromptSubmissionFailure,
  isInitialPromptSubmissionFailed,
  markInitialPromptSubmissionFailed,
  releaseInitialPromptSubmissionClaim,
} from "./workspace/initialPromptSubmissionGuard";
import type {
  InitialPromptSubmission,
  InitialPromptSubmissionId,
} from "../../lib/initial-prompt-submission";
import { useCompletedTurnReview } from "../chat/chat-interface/useCompletedTurnReview.js";
import {
  buildHookSettingsAuditReadModel,
  type HookSettingsAuditReadModel,
} from "../../services/api/lifecycleClient.js";
import { useWorkspaceViewport } from "../../hooks/useWorkspaceViewport";

interface WorkspaceProps {
  sessionId: string;
  sessionTitle?: string;
  sessionCreatedAt?: string;
  sessionUpdatedAt?: string;
  runId: string;
  repository: string;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  isSessionRunning?: boolean;
  hasStartedSession?: boolean;
  sessionPersistenceStatus?: SessionPersistenceStatus;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onPromptSubmitted?: (prompt: string) => void;
  onServerProjectionAvailable?: () => void;
  initialPromptSubmission?: InitialPromptSubmission | null;
  onInitialPromptHandled?: (id: InitialPromptSubmissionId) => void;
  onHookSettingsContextChange?: (context: {
    workspaceId: string;
    audits: readonly HookSettingsAuditReadModel[];
  }) => void;
  isRightSidebarOpen?: boolean;
  setIsRightSidebarOpen?: (open: boolean) => void;
  rightSidebarWidth?: number;
  setRightSidebarWidth?: Dispatch<SetStateAction<number>>;
  reviewSidebarFocusRequest?: number;
  isGitReviewOpen?: boolean;
  onGitReviewOpenChange?: (open: boolean) => void;
  onTabChange?: (tab: TabType) => void;
  summaryActionRequest?: { id: number; action: "changes" | "commit" } | null;
  onOpenRepositoryPicker?: () => void;
}

export function Workspace({
  sessionId,
  sessionTitle,
  sessionCreatedAt,
  sessionUpdatedAt,
  runId: initialRunId,
  repository,
  mode = "build",
  onModeChange,
  isSessionRunning = false,
  hasStartedSession = false,
  sessionPersistenceStatus,
  onSessionStatusChange,
  onPromptSubmitted,
  onServerProjectionAvailable,
  initialPromptSubmission = null,
  onInitialPromptHandled,
  onHookSettingsContextChange,
  isRightSidebarOpen = false,
  setIsRightSidebarOpen,
  rightSidebarWidth,
  setRightSidebarWidth,
  reviewSidebarFocusRequest = 0,
  isGitReviewOpen = false,
  onGitReviewOpenChange,
  onTabChange,
  summaryActionRequest,
  onOpenRepositoryPicker,
}: WorkspaceProps) {
  const isSessionPersisted = isSessionPersistenceReady(sessionPersistenceStatus);
  const { isCompact, isMobile } = useWorkspaceViewport();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const sandboxId = sessionId;
  const [productMode, setProductMode] = useState<ProductMode>(() =>
    loadStoredProductMode(sessionId),
  );
  const [isGitCommitOpen, setIsGitCommitOpen] = useState(false);
  const [isConversationSurfaceReady, setIsConversationSurfaceReady] =
    useState(false);

  // Custom Hooks
  const {
    activeTab,
    setActiveTab,
    sidebarWidth: internalSidebarWidth,
    setSidebarWidth: setInternalSidebarWidth,
    isResizing,
    setIsResizing,
    contentTabs,
    activeContentTabId,
    selectedFile,
    selectedDiff,
    selectedContext,
    openFileTab,
    openFilesTab,
    openContextTab,
    selectContentTab,
    closeContentTab,
    isViewingContent,
    setIsViewingContent,
    isLoadingContent,
    setIsLoadingContent,
    contentError,
    setContentError,
  } = useWorkspaceState();
  const sidebarWidth = rightSidebarWidth ?? internalSidebarWidth;
  const renderedSidebarWidth = isMobile
    ? "100vw"
    : isCompact
      ? "min(560px, 86vw)"
      : sidebarWidth;
  const setSidebarWidth = setRightSidebarWidth ?? setInternalSidebarWidth;

  useEffect(() => {
    if (!summaryActionRequest) return;
    if (summaryActionRequest.action === "commit") {
      setIsGitCommitOpen(true);
      return;
    }
    setIsRightSidebarOpen?.(true);
    setIsViewingContent(false);
    setActiveTab("changes");
  }, [
    summaryActionRequest,
    setActiveTab,
    setIsRightSidebarOpen,
    setIsViewingContent,
  ]);

  useEffect(() => {
    onTabChange?.(activeTab);
  }, [activeTab, onTabChange]);

  const {
    repoTree,
    isLoadingTree,
    repo,
    branch,
    switchBranch,
    isGitHubLoaded,
    isContextMismatch,
  } = useGitHubTree(repository);

  const {
    messages,
    optimisticUserMessageId,
    input,
    handleInputChange,
    handleSubmit,
    append,
    reviseTurn,
    stop,
    isLoading,
    isHydrating,
    hasHydrated,
    hydrationStatus,
    hydrationError,
    retryHydration,
    runId: activeRunId,
    error: chatError,
    clearNonCanonicalError,
    debugEvents,
    isModelConfigReady,
    scope: conversationScope,
    serverTurnId,
    activeTurnProjection: activeTurn,
  } = useChat(
    sessionId,
    initialRunId,
    () => {
      explorerRef.current?.refresh();
    },
    mode,
    productMode,
    onServerProjectionAvailable,
    isSessionPersisted,
  );
  const appendWhenPersisted = useCallback<typeof append>(
    async (...args) => {
      if (!isSessionPersisted) {
        throw new Error("This conversation is still being saved. Retry after it is saved.");
      }
      return append(...args);
    },
    [append, isSessionPersisted],
  );
  const reviseTurnWhenPersisted = useCallback<typeof reviseTurn>(
    async (...args) => {
      if (!isSessionPersisted) return false;
      return reviseTurn(...args);
    },
    [isSessionPersisted, reviseTurn],
  );
  const handleSubmitWhenPersisted = useCallback<typeof handleSubmit>(
    async (...args) => {
      if (!isSessionPersisted) return false;
      onPromptSubmitted?.(input);
      return handleSubmit(...args);
    },
    [handleSubmit, input, isSessionPersisted, onPromptSubmitted],
  );
  useEffect(() => {
    if (activeTurn.hasReplay && chatError) {
      clearNonCanonicalError();
    }
  }, [activeTurn.hasReplay, chatError, clearNonCanonicalError]);
  const hookSettingsAudits = useMemo(
    () =>
      activeTurn.projection
        ? buildHookSettingsAuditReadModel({
            events: activeTurn.projection.hookAudits,
          })
        : [],
    [activeTurn.projection],
  );
  useEffect(() => {
    const workspaceId = conversationScope?.workspaceId;
    if (!workspaceId) return;
    onHookSettingsContextChange?.({
      workspaceId,
      audits: hookSettingsAudits,
    });
  }, [
    conversationScope?.workspaceId,
    hookSettingsAudits,
    onHookSettingsContextChange,
  ]);
  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return messages[index]?.id ?? null;
      }
    }
    return null;
  }, [messages]);
  const completedTurnReview = useCompletedTurnReview(
    activeTurn.projection,
    latestAssistantMessageId,
  );
  const canonicalRunStatus = deriveCanonicalRunStatus({
    hasCanonicalTurn: activeTurn.hasCanonicalTurn,
    hasReplay: activeTurn.hasReplay,
    terminalState: activeTurn.projection?.terminal?.state ?? null,
  });
  const hasPendingApproval = Boolean(activeTurn.projection?.pendingApproval);
  const pendingApprovalRequestId =
    activeTurn.projection?.pendingApproval?.approvalId ?? null;
  const runUiState = useMemo(
    () =>
      deriveWorkspaceRunUiState({
        canonicalRunStatus,
        hasPendingApproval,
        isChatLoading: activeTurn.isTransportPending,
        isSessionRunning: activeTurn.isActive,
        lastMessage: undefined,
      }),
    [
      activeTurn.isTransportPending,
      canonicalRunStatus,
      hasPendingApproval,
      activeTurn.isActive,
    ],
  );
  const handledInitialPromptIdRef = useRef<InitialPromptSubmissionId | null>(
    null,
  );
  const failedInitialPromptIdRef = useRef<InitialPromptSubmissionId | null>(null);
  const [failedInitialPromptId, setFailedInitialPromptId] = useState<InitialPromptSubmissionId | null>(null);
  const [initialPromptRetryRevision, setInitialPromptRetryRevision] = useState(0);

  const retryInitialPrompt = useCallback(() => {
    const failedId = initialPromptSubmission?.id;
    if (!failedId || !isInitialPromptSubmissionFailed(failedId)) return;
    clearInitialPromptSubmissionFailure(failedId);
    failedInitialPromptIdRef.current = null;
    setFailedInitialPromptId(null);
    setInitialPromptRetryRevision((revision) => revision + 1);
  }, [initialPromptSubmission?.id]);

  useEffect(() => {
    if (!initialPromptSubmission) {
      return;
    }
    if (isInitialPromptSubmissionFailed(initialPromptSubmission.id)) {
      failedInitialPromptIdRef.current = initialPromptSubmission.id;
      setFailedInitialPromptId(initialPromptSubmission.id);
      return;
    }
    if (!isSessionPersisted) {
      return;
    }
    if (!isModelConfigReady) {
      return;
    }
    if (failedInitialPromptIdRef.current === initialPromptSubmission.id) {
      return;
    }
    if (handledInitialPromptIdRef.current === initialPromptSubmission.id) {
      return;
    }
    if (!claimInitialPromptSubmission(initialPromptSubmission.id)) {
      return;
    }

    const prompt = initialPromptSubmission.prompt.trim();
    if (!prompt) {
      onInitialPromptHandled?.(initialPromptSubmission.id);
      return;
    }

    handledInitialPromptIdRef.current = initialPromptSubmission.id;
    void appendWhenPersisted(
      {
        ...buildChatAppendMessage(
          prompt,
          initialPromptSubmission.attachments?.imageAttachments ?? [],
        ),
        // Keep the admission key stable if the server accepted the request but
        // its response was lost and the queued prompt is retried.
        id: `client_msg_${initialPromptSubmission.id}`,
      },
      )
      .then((outcome) => {
        if (
          outcome.status === "accepted" ||
          (outcome.status === "cancelled" && outcome.admission !== "unconfirmed")
        ) {
          clearInitialPromptSubmissionFailure(initialPromptSubmission.id);
          failedInitialPromptIdRef.current = null;
          setFailedInitialPromptId(null);
          onInitialPromptHandled?.(initialPromptSubmission.id);
          return;
        }
        {
          const message = outcome.status === "unconfirmed"
            ? outcome.message
            : outcome.status === "cancelled"
              ? "The stopped request may have been admitted. Check the saved conversation before retrying."
              : "The queued prompt belongs to a conversation that is no longer active.";
          console.warn("[Workspace] Setup prompt was not confirmed:", message);
          if (outcome.status === "unconfirmed") onSessionStatusChange?.("failed");
          markInitialPromptSubmissionFailed(initialPromptSubmission.id);
          failedInitialPromptIdRef.current = initialPromptSubmission.id;
          setFailedInitialPromptId(initialPromptSubmission.id);
          handledInitialPromptIdRef.current = null;
          releaseInitialPromptSubmissionClaim(initialPromptSubmission.id);
          return;
        }
      })
      .catch((error) => {
        console.error("[Workspace] Failed to submit setup prompt:", error);
        onSessionStatusChange?.("failed");
        // Keep the queued prompt stable, but wait for an explicit retry so a
        // parent rerender or callback identity change cannot resubmit it.
        markInitialPromptSubmissionFailed(initialPromptSubmission.id);
        failedInitialPromptIdRef.current = initialPromptSubmission.id;
        setFailedInitialPromptId(initialPromptSubmission.id);
        handledInitialPromptIdRef.current = null;
        releaseInitialPromptSubmissionClaim(initialPromptSubmission.id);
      });
  }, [
    appendWhenPersisted,
    initialPromptSubmission,
    isModelConfigReady,
    isSessionPersisted,
    onInitialPromptHandled,
    onSessionStatusChange,
    initialPromptRetryRevision,
  ]);
  const {
    isApprovalWaitingRun,
    isEffectiveCanonicalRunActive,
    isRunLoading,
    canStopRun,
  } = runUiState;
  const explicitReviewOpen =
    isGitReviewOpen ||
    (isRightSidebarOpen && (activeTab === "review" || activeTab === "changes"));
  const liveGitReviewEnabled =
    explicitReviewOpen &&
    isEffectiveCanonicalRunActive &&
    !completedTurnReview.turnId;
  useEffect(() => {
    logClientEvent("run/ui-state", "derived", {
      runId: activeRunId,
      kind: runUiState.kind,
      canonicalStatus: canonicalRunStatus,
      canonicalTurn: activeTurn.hasCanonicalTurn,
      pendingApproval: hasPendingApproval,
      pendingApprovalRequestId,
      chatLoading: activeTurn.isTransportPending,
      sessionRunning: isSessionRunning,
      runLoading: isRunLoading,
      approvalWaiting: isApprovalWaitingRun,
      canStop: canStopRun,
      liveGitReviewEnabled,
    });
  }, [
    activeRunId,
    canStopRun,
    canonicalRunStatus,
    hasPendingApproval,
    isApprovalWaitingRun,
    activeTurn.isTransportPending,
    isRunLoading,
    activeTurn.hasCanonicalTurn,
    isSessionRunning,
    liveGitReviewEnabled,
    pendingApprovalRequestId,
    explicitReviewOpen,
    runUiState.kind,
  ]);
  const { status, refetch: refetchGitStatus } = useGitStatus(
    activeRunId,
    sessionId,
    liveGitReviewEnabled,
  );

  const handleOpenFileTab = useCallback(
    (file: SelectedFile) => {
      openFileTab(file);
      setActiveTab("review");
      setIsRightSidebarOpen?.(true);
    },
    [openFileTab, setActiveTab, setIsRightSidebarOpen],
  );
  const toggleChangesPanel = useCallback(() => {
    setIsViewingContent(false);
    setActiveTab((current) => (current === "changes" ? "review" : "changes"));
  }, [setActiveTab, setIsViewingContent]);
  const toggleFilesPanel = useCallback(() => {
    if (activeTab === "files") {
      setActiveTab("review");
      return;
    }
    if (!isViewingContent) {
      openFilesTab();
    }
    setActiveTab("files");
  }, [activeTab, isViewingContent, openFilesTab, setActiveTab]);

  const { handleFileClick, handleGitHubFileSelect } = useFileLoader({
    sandboxId,
    runId: activeRunId,
    setIsLoadingContent,
    setContentError,
    openFileTab: handleOpenFileTab,
  });
  const {
    handleFileClick: handleFullscreenFileClick,
    handleGitHubFileSelect: handleFullscreenGitHubFileSelect,
  } = useFileLoader({
    sandboxId,
    runId: activeRunId,
    setIsLoadingContent,
    setContentError,
    openFileTab,
  });

  // Composed orchestration hooks
  const { handleStopRun } = useStatusSync({
    activeRunId,
    canonicalRunStatus,
    isApprovalWaitingRun,
    pendingApprovalRequestId,
    isEffectiveCanonicalRunActive,
    chatError,
    stop,
    refetchGitStatus,
    onSessionStatusChange,
  });
  const { handleSidebarDiffSelected } = useSidebarOrchestration({
    activeRunId,
    status,
    repo,
    branch,
    isContextMismatch,
    isGitHubLoaded,
    isHydrating,
    isViewingContent,
    activeContentTabId,
    selectedFile,
    selectedDiff,
    switchBranch,
    handleFileClick,
    explorerRef,
    setIsViewingContent,
    setActiveTab,
    setIsRightSidebarOpen,
    reviewSidebarFocusRequest,
  });

  useEffect(() => {
    setProductMode(loadStoredProductMode(sessionId));
  }, [sessionId]);

  useEffect(() => {
    persistProductMode(sessionId, productMode);
  }, [productMode, sessionId]);

  return (
    <RunContextProvider runId={activeRunId} sessionId={sessionId}>
      <GitReviewProvider
        key={`${sessionId}:${activeRunId}`}
        isReviewOpen={isGitReviewOpen}
        isReviewActive={
          isGitReviewOpen || activeTab === "review" || activeTab === "changes"
        }
        isReviewDataEnabled={liveGitReviewEnabled}
        onReviewOpenChange={onGitReviewOpenChange ?? (() => undefined)}
        isGitWorkspaceRecovering={false}
        artifactIdentity={conversationScope}
        canonicalTurnReview={
          completedTurnReview.turnId
            ? {
                turnId: completedTurnReview.turnId,
                files: completedTurnReview.files,
                loadFileDiff: completedTurnReview.loadFileDiff,
                error: completedTurnReview.error,
              }
            : null
        }
      >
        <div className="ui-center-surface flex-1 flex overflow-hidden relative">
          {/* Chat Area */}
          <main className="ui-center-surface flex-1 flex flex-col min-w-0 relative">
            {initialPromptSubmission &&
            failedInitialPromptId === initialPromptSubmission.id ? (
              <div role="alert" className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
                <span>The setup prompt was not admitted. It remains queued.</span>
                <button
                  type="button"
                  className="rounded-md border border-amber-200/30 px-3 py-1 font-medium hover:bg-amber-500/15"
                  onClick={retryInitialPrompt}
                >
                  Retry setup prompt
                </button>
              </div>
            ) : null}
            <ChatInterface
              chatProps={{
                messages,
                optimisticUserMessageId,
                runId: activeRunId,
                input,
                handleInputChange,
                handleSubmit: handleSubmitWhenPersisted,
                append: appendWhenPersisted,
                reviseTurn: reviseTurnWhenPersisted,
                stop: handleStopRun,
                isLoading,
                hasHydrated,
                hydrationStatus,
                hydrationError,
                retryHydration,
                error: chatError,
                debugEvents,
                serverTurnId,
                conversationScope,
                activeTurnProjection: activeTurn,
              }}
              sessionId={sessionId}
              initialPromptSubmission={initialPromptSubmission}
              hasStartedSession={hasStartedSession}
              mode={mode}
              onModeChange={onModeChange}
              permissionMode={productMode}
              onPermissionModeChange={setProductMode}
              repoTree={repoTree}
              isLoadingRepoTree={isLoadingTree || isHydrating}
              projectName={repository.split("/").filter(Boolean).at(-1)}
              onProjectClick={onOpenRepositoryPicker}
              onPresentationReadyChange={setIsConversationSurfaceReady}
              onArtifactOpen={(path, content, options) => {
                if (options?.refreshFromWorkspace) {
                  void handleFileClick(path);
                  return;
                }
                handleOpenFileTab({
                  path,
                  content,
                  startingLineNumber: options?.startingLineNumber,
                });
              }}
              onReviewOpen={() => {
                setIsViewingContent(false);
                setActiveTab("review");
                setIsRightSidebarOpen?.(true);
              }}
              onContextOpen={(budget, usage) => {
                openContextTab(budget, usage, {
                  title: sessionTitle ?? sessionId,
                  messageCount: messages.length,
                  userMessageCount: messages.filter(
                    (message) => message.role === "user",
                  ).length,
                  assistantMessageCount: messages.filter(
                    (message) => message.role === "assistant",
                  ).length,
                  createdAt: sessionCreatedAt ?? "",
                  updatedAt: sessionUpdatedAt ?? "",
                });
                setIsRightSidebarOpen?.(true);
                setActiveTab("review");
              }}
            />
          </main>

          {isConversationSurfaceReady && isRightSidebarOpen ? (
            <SidebarHeader
              sidebarWidth={renderedSidebarWidth}
              isViewingContent={isViewingContent}
              contentTabs={contentTabs}
              activeContentTabId={activeContentTabId}
              onSelectReview={() => {
                setIsViewingContent(false);
                setActiveTab("review");
              }}
              onSelectContent={(id) => {
                selectContentTab(id);
                setActiveTab("review");
              }}
              onCloseReview={() => setIsRightSidebarOpen?.(false)}
              onCloseContent={closeContentTab}
              onOpenFiles={toggleFilesPanel}
              onOpenChanges={toggleChangesPanel}
              onExpand={() => {
                setIsRightSidebarOpen?.(true);
                onGitReviewOpenChange?.(true);
              }}
              onCloseSidebar={() => setIsRightSidebarOpen?.(false)}
            />
          ) : null}

          {/* Combined Sidebar */}
          <motion.aside
            initial={false}
            animate={{ width: isRightSidebarOpen ? renderedSidebarWidth : 0 }}
            transition={
              isResizing
                ? { duration: 0 }
                : { duration: 0.15, ease: [0.23, 1, 0.32, 1] }
            }
            className={cn(
              "relative flex shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-black",
              "max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-50 max-[1100px]:shadow-[-24px_0_60px_rgba(0,0,0,0.55)]",
              isMobile && "border-l-0",
              !isRightSidebarOpen && "border-transparent",
            )}
          >
            {isConversationSurfaceReady && isRightSidebarOpen && (
              <Resizer
                side="right"
                onResizeStart={() => setIsResizing(true)}
                onResizeEnd={() => setIsResizing(false)}
                onResize={(delta) =>
                  setSidebarWidth((prev) =>
                    Math.max(320, Math.min(720, prev + delta)),
                  )
                }
              />
            )}

            <div
              className="flex flex-1 flex-col min-w-0"
              style={{ width: renderedSidebarWidth }}
            >
              <SidebarContent
                isViewingContent={isViewingContent}
                activeTab={activeTab}
                isLoadingContent={isLoadingContent}
                contentError={contentError}
                selectedFile={selectedFile}
                selectedDiff={selectedDiff}
                selectedContext={selectedContext}
                repo={repo}
                isGitHubLoaded={isGitHubLoaded}
                repoTree={repoTree}
                isLoadingTree={!!isLoadingTree}
                branch={branch}
                handleGitHubFileSelect={handleGitHubFileSelect}
                handleFileClick={handleFileClick}
                onDiffSelected={handleSidebarDiffSelected}
                explorerRef={explorerRef}
                sandboxId={sandboxId}
                runId={activeRunId}
                onOpenFiles={toggleFilesPanel}
                onCloseTree={() => setActiveTab("review")}
                onToggleChanges={toggleChangesPanel}
              />
            </div>
          </motion.aside>
          {isConversationSurfaceReady ? (
            <GitReviewDialog
              key={`${activeRunId}:${isGitReviewOpen ? "open" : "closed"}`}
              contentTabs={contentTabs}
              isLoadingContent={isLoadingContent}
              contentError={contentError}
              onSelectContent={selectContentTab}
              onCloseContent={closeContentTab}
              onOpenFilesTab={openFilesTab}
              renderFilesRail={(onFileOpened) => (
                <WorkspaceFilesTree
                  repo={repo}
                  isGitHubLoaded={isGitHubLoaded}
                  branch={branch}
                  repoTree={repoTree}
                  isLoadingTree={Boolean(isLoadingTree)}
                  onGitHubFileSelect={(path) => {
                    onFileOpened(path);
                    void handleFullscreenGitHubFileSelect(path);
                  }}
                  explorerRef={explorerRef}
                  sandboxId={sandboxId}
                  runId={activeRunId}
                  onLocalFileSelect={(path) => {
                    onFileOpened(path);
                    void handleFullscreenFileClick(path);
                  }}
                />
              )}
            />
          ) : null}
          {!isConversationSurfaceReady ? (
            <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black">
              <div
                aria-hidden="true"
                className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-800 border-t-zinc-300"
              />
            </div>
          ) : null}
          <GitCommitDialog
            isOpen={isGitCommitOpen}
            onClose={() => setIsGitCommitOpen(false)}
          />
        </div>
      </GitReviewProvider>
    </RunContextProvider>
  );
}
