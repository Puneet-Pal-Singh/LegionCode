import { useRef, useEffect, useState, useMemo } from "react";
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
import { GitCommitDialog } from "../git/GitCommitDialog";
import type { SessionStatus } from "../../types/session";
import { deriveWorkspaceRunUiState } from "./workspace/runUiState";

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
  onPendingApprovalStateChange?: (hasPendingApproval: boolean) => void;
  isRightSidebarOpen?: boolean;
  setIsRightSidebarOpen?: (open: boolean) => void;
  reviewSidebarFocusRequest?: number;
  isGitReviewOpen?: boolean;
  onGitReviewOpenChange?: (open: boolean) => void;
  onTabChange?: (tab: TabType) => void;
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
  onPendingApprovalStateChange,
  isRightSidebarOpen = false,
  setIsRightSidebarOpen,
  reviewSidebarFocusRequest = 0,
  isGitReviewOpen = false,
  onGitReviewOpenChange,
  onTabChange,
}: WorkspaceProps) {
  const explorerRef = useRef<FileExplorerHandle>(null);
  const sandboxId = sessionId;
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [productMode, setProductMode] = useState<ProductMode>(() =>
    loadStoredProductMode(sessionId),
  );

  // Custom Hooks
  const {
    activeTab,
    setActiveTab,
    sidebarWidth,
    setSidebarWidth,
    isResizing,
    setIsResizing,
    selectedFile,
    setSelectedFile,
    selectedDiff,
    setSelectedDiff,
    isViewingContent,
    setIsViewingContent,
    isLoadingContent,
    setIsLoadingContent,
  } = useWorkspaceState();

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
  const {
    status,
    gitAvailable,
    refetch: refetchGitStatus,
  } = useGitStatus(activeRunId, sessionId);
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
  const changesCount = status?.files?.length ?? 0;
  const repositoryOwner = repo?.owner?.login?.trim() ?? "";
  const repositoryName = repo?.name?.trim() ?? "";
  const repositoryBranch = (
    status?.branch?.trim() ||
    branch ||
    repo?.default_branch ||
    "main"
  ).trim();
  const repositoryBaseUrl = repo?.html_url;

  const { handleFileClick, handleGitHubFileSelect } = useFileLoader({
    sandboxId,
    runId: activeRunId,
    setIsLoadingContent,
    setIsViewingContent,
    setSelectedFile,
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
    isRunLoading,
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
    sessionId,
    status,
    repo,
    branch,
    isContextMismatch,
    isGitHubLoaded,
    isHydrating,
    isViewingContent,
    selectedFile,
    selectedDiff,
    switchBranch,
    handleFileClick,
    explorerRef,
    setIsViewingContent,
    setActiveTab,
    setSelectedFile,
    setSelectedDiff,
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
                handleSubmit,
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
                setSelectedFile({ path, content });
                setIsViewingContent(true);
                setIsRightSidebarOpen?.(true);
                setActiveTab("files");
              }}
              onReviewOpen={() => {
                setIsRightSidebarOpen?.(true);
                setActiveTab("review");
                setIsViewingContent(false);
                setSelectedFile(null);
                setSelectedDiff(null);
              }}
            />
          </main>

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
              <SidebarHeader
                isViewingContent={isViewingContent}
                activeTab={activeTab}
                changesCount={changesCount}
                hasPendingApproval={isApprovalWaitingRun}
                onExpand={() => {
                  setIsRightSidebarOpen?.(true);
                  onGitReviewOpenChange?.(true);
                }}
                onCommit={() => setIsCommitDialogOpen(true)}
                onBack={() => {
                  setIsViewingContent(false);
                  setSelectedFile(null);
                  setSelectedDiff(null);
                }}
                onTabChange={setActiveTab}
              />

              <SidebarContent
                isViewingContent={isViewingContent}
                activeTab={activeTab}
                isLoadingContent={isLoadingContent}
                selectedFile={selectedFile}
                selectedDiff={selectedDiff}
                onCloseContent={() => setIsViewingContent(false)}
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
              />
            </div>
          </motion.aside>
          <GitReviewDialog
            key={`${activeRunId}:${isGitReviewOpen ? "open" : "closed"}`}
          />
          <GitCommitDialog
            isOpen={isCommitDialogOpen}
            onClose={() => setIsCommitDialogOpen(false)}
          />
        </div>
      </GitReviewProvider>
    </RunContextProvider>
  );
}
