import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { DiffContent } from "@repo/shared-types";
import type { Repository } from "../../../services/GitHubService";
import type { FileExplorerHandle } from "../../FileExplorer";
import type { SelectedDiff, SelectedFile, TabType } from "./useWorkspaceState";

interface UseSidebarOrchestrationProps {
  activeRunId: string;
  sessionId: string;
  status: { branch?: string } | null | undefined;
  repo: Repository | null;
  branch: string;
  isContextMismatch: boolean;
  isGitHubLoaded: boolean;
  isHydrating: boolean;
  isViewingContent: boolean;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  switchBranch: (branch: string) => void;
  handleFileClick: (path: string) => Promise<void> | void;
  explorerRef: RefObject<FileExplorerHandle | null>;
  setIsViewingContent: (viewing: boolean) => void;
  setActiveTab: (tab: TabType) => void;
  setIsRightSidebarOpen?: (open: boolean) => void;
  reviewSidebarFocusRequest: number;
}

export interface UseSidebarOrchestrationResult {
  handleSidebarDiffSelected: (path: string, content: DiffContent) => void;
}

export function useSidebarOrchestration({
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
  setIsRightSidebarOpen,
  reviewSidebarFocusRequest,
}: UseSidebarOrchestrationProps): UseSidebarOrchestrationResult {
  const previousReviewFocusRequestRef = useRef(reviewSidebarFocusRequest);

  const handleSidebarDiffSelected = useCallback(
    () => {
      setActiveTab("review");
      setIsViewingContent(false);
      setIsRightSidebarOpen?.(true);
    },
    [setActiveTab, setIsRightSidebarOpen, setIsViewingContent],
  );

  useEffect(() => {
    if (previousReviewFocusRequestRef.current === reviewSidebarFocusRequest) {
      return;
    }
    previousReviewFocusRequestRef.current = reviewSidebarFocusRequest;
    setIsRightSidebarOpen?.(true);
    setActiveTab("review");
    setIsViewingContent(false);
  }, [
    reviewSidebarFocusRequest,
    setActiveTab,
    setIsRightSidebarOpen,
    setIsViewingContent,
  ]);

  useEffect(() => {
    if (sessionId && activeRunId) {
      localStorage.setItem(`shadowbox_runId:${sessionId}`, activeRunId);
    }
  }, [sessionId, activeRunId]);

  useEffect(() => {
    explorerRef.current?.refresh();
  }, [activeRunId, explorerRef]);

  useEffect(() => {
    if (isContextMismatch || !isGitHubLoaded || !repo) return;
    const currentWorkspaceBranch = status?.branch?.trim();
    const currentGitHubContextBranch = branch?.trim();
    if (!currentWorkspaceBranch || !currentGitHubContextBranch) return;
    if (currentWorkspaceBranch === currentGitHubContextBranch) return;
    switchBranch(currentWorkspaceBranch);
  }, [
    branch,
    isContextMismatch,
    isGitHubLoaded,
    repo,
    status?.branch,
    switchBranch,
  ]);

  useEffect(() => {
    if (isHydrating) return;
    const savedPath = localStorage.getItem("shadowbox_last_viewed_path");
    if (isViewingContent && savedPath && !selectedFile && !selectedDiff) {
      void handleFileClick(savedPath);
    }
  }, [
    isHydrating,
    isViewingContent,
    selectedFile,
    selectedDiff,
    handleFileClick,
  ]);

  return { handleSidebarDiffSelected };
}
