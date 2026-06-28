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
import { useRunSummary } from "../../hooks/useRunSummary";
import { cn } from "../../lib/utils";
import { useGitStatus } from "../../hooks/useGitStatus";
import { Resizer } from "../ui/Resizer";
import { useWorkspaceState } from "./workspace/useWorkspaceState";
import { useGitHubTree } from "./workspace/useGitHubTree";
import { useFileLoader } from "./workspace/useFileLoader";
import { useStatusSync } from "./workspace/useStatusSync";
import { useBootstrap } from "./workspace/useBootstrap";
import { useSidebarOrchestration } from "./workspace/useSidebarOrchestration";
import { SidebarHeader } from "./workspace/SidebarHeader";
import { SidebarContent } from "./workspace/SidebarContent";
import { TabType } from "./workspace/useWorkspaceState";
import {
  loadStoredProductMode,
  persistProductMode,
} from "../../lib/product-mode-storage";
import { normalizeRunStatus } from "../../lib/run-status";
import { GitReviewProvider } from "../git/GitReviewContext";
import { GitReviewDialog } from "../git/GitReviewDialog";
import { WorkspaceFilesTree } from "./workspace/SidebarTreeOverlay";
import { GitCommitDialog } from "../git/GitCommitDialog";
import type { SessionStatus } from "../../types/session";
import { deriveWorkspaceRunUiState } from "./workspace/runUiState";
import { logClientEvent } from "../../lib/client-logger.js";

interface WorkspaceProps {
  sessionId: string;
  runId: string;
  repository: string;
  mode?: RunMode;
  onModeChange?: (mode: RunMode) => void;
  isSessionRunning?: boolean;
  hasStartedSession?: boolean;
  allowPendingQueryRestore?: boolean;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onPromptSubmitted?: (prompt: string) => void;
  onPendingApprovalStateChange?: (hasPendingApproval: boolean) => void;
  isRightSidebarOpen?: boolean;
  setIsRightSidebarOpen?: (open: boolean) => void;
  rightSidebarWidth?: number;
  setRightSidebarWidth?: Dispatch<SetStateAction<number>>;
  reviewSidebarFocusRequest?: number;
  isGitReviewOpen?: boolean;
  onGitReviewOpenChange?: (open: boolean) => void;
  onTabChange?: (tab: TabType) => void;
  summaryActionRequest?: { id: number; action: "changes" | "commit" } | null;
}

export function Workspace({
  sessionId,
  runId: initialRunId,
  repository,
  mode = "build",
  onModeChange,
  isSessionRunning = false,
  hasStartedSession = false,
  allowPendingQueryRestore = true,
  onSessionStatusChange,
  onPromptSubmitted,
  onPendingApprovalStateChange,
  isRightSidebarOpen = false,
  setIsRightSidebarOpen,
  rightSidebarWidth,
  setRightSidebarWidth,
  reviewSidebarFocusRequest = 0,
  isGitReviewOpen = false,
  onGitReviewOpenChange,
  onTabChange,
  summaryActionRequest,
}: WorkspaceProps) {
  const explorerRef = useRef<FileExplorerHandle>(null);
  const sandboxId = sessionId;
  const [productMode, setProductMode] = useState<ProductMode>(() =>
    loadStoredProductMode(sessionId),
  );
  const [isGitCommitOpen, setIsGitCommitOpen] = useState(false);

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
    openFileTab,
    openFilesTab,
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
    input,
    handleInputChange,
    handleSubmit,
    append,
    stop,
    isLoading,
    isHydrating,
    hasHydrated,
    runId: activeRunId,
    error: chatError,
    debugEvents,
  } = useChat(
    sessionId,
    initialRunId,
    () => {
      explorerRef.current?.refresh();
    },
    mode,
    productMode,
    allowPendingQueryRestore,
  );
  const { summary: runSummary } = useRunSummary(activeRunId, true);
  const runSummaryMatchesActiveRun = runSummary?.runId === activeRunId;
  const canonicalRunStatus = runSummaryMatchesActiveRun
    ? normalizeRunStatus(runSummary.status)
    : null;
  const hasPendingApproval =
    runSummaryMatchesActiveRun && Boolean(runSummary?.pendingApproval);
  const pendingApprovalRequestId = runSummaryMatchesActiveRun
    ? (runSummary?.pendingApproval?.requestId ?? null)
    : null;
  const lastMessage = messages[messages.length - 1];
  const [locallyStoppedRunId, setLocallyStoppedRunId] = useState<string | null>(
    null,
  );
  const isLocallyStoppedRun = locallyStoppedRunId === activeRunId;
  const runUiState = useMemo(
    () =>
      deriveWorkspaceRunUiState({
        canonicalRunStatus,
        hasPendingApproval,
        isChatLoading: isLoading,
        isSessionRunning,
        isLocallyStoppedRun,
        lastMessage,
      }),
    [
      canonicalRunStatus,
      hasPendingApproval,
      isLoading,
      isLocallyStoppedRun,
      isSessionRunning,
      lastMessage,
    ],
  );
  const {
    isApprovalWaitingRun,
    isStaleCanonicalActiveRun,
    isEffectiveCanonicalRunActive,
    isRunLoading,
    canStopRun,
  } = runUiState;
  const passiveGitProbeEnabled =
    !activeRunId || (runSummaryMatchesActiveRun && !isRunLoading);
  useEffect(() => {
    logClientEvent("run/ui-state", "derived", {
      runId: activeRunId,
      kind: runUiState.kind,
      canonicalStatus: canonicalRunStatus,
      summaryMatches: runSummaryMatchesActiveRun,
      pendingApproval: hasPendingApproval,
      pendingApprovalRequestId,
      chatLoading: isLoading,
      sessionRunning: isSessionRunning,
      locallyStopped: isLocallyStoppedRun,
      runLoading: isRunLoading,
      approvalWaiting: isApprovalWaitingRun,
      canStop: canStopRun,
      passiveGitProbeEnabled,
    });
  }, [
    activeRunId,
    canStopRun,
    canonicalRunStatus,
    hasPendingApproval,
    isApprovalWaitingRun,
    isLoading,
    isLocallyStoppedRun,
    isRunLoading,
    isSessionRunning,
    passiveGitProbeEnabled,
    pendingApprovalRequestId,
    runSummaryMatchesActiveRun,
    runUiState.kind,
  ]);
  const {
    status,
    gitAvailable,
    refetch: refetchGitStatus,
  } = useGitStatus(activeRunId, sessionId, passiveGitProbeEnabled);
  const repositoryOwner = repo?.owner?.login?.trim() ?? "";
  const repositoryName = repo?.name?.trim() ?? "";
  const repositoryBranch = (
    status?.branch?.trim() ||
    branch ||
    repo?.default_branch ||
    "main"
  ).trim();
  const repositoryBaseUrl = repo?.html_url;

  const handleOpenFileTab = useCallback(
    (file: { path: string; content: string }) => {
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
    isStaleCanonicalActiveRun,
    isEffectiveCanonicalRunActive,
    isLoading,
    chatError,
    hasPendingApproval,
    isLocallyStoppedRun,
    setLocallyStoppedRunId,
    stop,
    refetchGitStatus,
    onSessionStatusChange,
  });
  const isGitWorkspaceRecovering = useBootstrap({
    sessionId,
    activeRunId,
    gitAvailable,
    isRunLoading: !passiveGitProbeEnabled || isRunLoading,
    isContextMismatch,
    isGitHubLoaded,
    repositoryOwner,
    repositoryName,
    repositoryBranch,
    repositoryBaseUrl,
    refetchGitStatus,
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

  const handleSubmitWithSessionMetadata = useCallback<typeof handleSubmit>(
    async (...args) => {
      onPromptSubmitted?.(input);
      return await handleSubmit(...args);
    },
    [handleSubmit, input, onPromptSubmitted],
  );

  return (
    <RunContextProvider runId={activeRunId} sessionId={sessionId}>
      <GitReviewProvider
        key={`${sessionId}:${activeRunId}`}
        isReviewOpen={isGitReviewOpen}
        isReviewActive={
          isGitReviewOpen || activeTab === "review" || activeTab === "changes"
        }
        isReviewDataEnabled={passiveGitProbeEnabled}
        onReviewOpenChange={onGitReviewOpenChange ?? (() => undefined)}
        isGitWorkspaceRecovering={isGitWorkspaceRecovering}
      >
        <div className="ui-center-surface flex-1 flex overflow-hidden relative">
          {/* Chat Area */}
          <main className="ui-center-surface flex-1 flex flex-col min-w-0 relative">
            <ChatInterface
              chatProps={{
                messages,
                runId: activeRunId,
                input,
                handleInputChange,
                handleSubmit: handleSubmitWithSessionMetadata,
                append,
                stop: handleStopRun,
                canStop: canStopRun,
                isLoading: isRunLoading,
                hasHydrated,
                error: chatError,
                debugEvents,
              }}
              sessionId={sessionId}
              hasStartedSession={hasStartedSession}
              mode={mode}
              onModeChange={onModeChange}
              permissionMode={productMode}
              onPermissionModeChange={setProductMode}
              onPendingApprovalChange={onPendingApprovalStateChange}
              repoTree={repoTree}
              isLoadingRepoTree={isLoadingTree || isHydrating}
              onArtifactOpen={(path, content) => {
                handleOpenFileTab({ path, content });
              }}
              onReviewOpen={() => {
                setIsRightSidebarOpen?.(true);
                setActiveTab("review");
                setIsViewingContent(false);
              }}
            />
          </main>

          {isRightSidebarOpen ? (
            <SidebarHeader
              sidebarWidth={sidebarWidth}
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
            animate={{
              width: isRightSidebarOpen ? sidebarWidth : 0,
            }}
            transition={
              isResizing
                ? { duration: 0 }
                : { duration: 0.15, ease: [0.23, 1, 0.32, 1] }
            }
            className={cn(
              "border-l border-zinc-800 bg-black flex flex-col overflow-hidden shrink-0 relative",
              !isRightSidebarOpen && "border-transparent",
            )}
          >
            {isRightSidebarOpen && (
              <Resizer
                side="right"
                onResizeStart={() => setIsResizing(true)}
                onResizeEnd={() => setIsResizing(false)}
                onResize={(delta) =>
                  setSidebarWidth((prev) =>
                    Math.max(280, Math.min(600, prev + delta)),
                  )
                }
              />
            )}

            <div
              className="flex-1 flex flex-col min-w-[280px]"
              style={{ width: sidebarWidth }}
            >
              <SidebarContent
                isViewingContent={isViewingContent}
                activeTab={activeTab}
                isLoadingContent={isLoadingContent}
                contentError={contentError}
                selectedFile={selectedFile}
                selectedDiff={selectedDiff}
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
          <GitCommitDialog
            isOpen={isGitCommitOpen}
            onClose={() => setIsGitCommitOpen(false)}
          />
        </div>
      </GitReviewProvider>
    </RunContextProvider>
  );
}
