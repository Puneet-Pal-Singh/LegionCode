import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { DiffContent } from "@repo/shared-types";
import type { FileExplorerHandle } from "../../FileExplorer";
import type { SelectedDiff, SelectedFile, TabType } from "./useWorkspaceState";

interface UseSidebarOrchestrationProps {
  activeRunId: string;
  canonicalRunStatus?: string | null;
  isHydrating: boolean;
  isViewingContent: boolean;
  activeContentTabId: string | null;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  restoreLastViewedFile: () => void | void;
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
  canonicalRunStatus,
  isHydrating,
  isViewingContent,
  activeContentTabId,
  selectedFile,
  selectedDiff,
  restoreLastViewedFile,
  explorerRef,
  setIsViewingContent,
  setActiveTab,
  setIsRightSidebarOpen,
  reviewSidebarFocusRequest,
}: UseSidebarOrchestrationProps): UseSidebarOrchestrationResult {
  const previousReviewFocusRequestRef = useRef(reviewSidebarFocusRequest);

  const handleSidebarDiffSelected = useCallback(() => {
    setActiveTab("review");
    setIsViewingContent(false);
    setIsRightSidebarOpen?.(true);
  }, [setActiveTab, setIsRightSidebarOpen, setIsViewingContent]);

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
    explorerRef.current?.refresh();
  }, [activeRunId, canonicalRunStatus, explorerRef]);


  useEffect(() => {
    if (isHydrating) return;
    if (
      isViewingContent &&
      activeContentTabId !== "files" &&
      !selectedFile &&
      !selectedDiff
    ) {
      restoreLastViewedFile();
    }
  }, [
    isHydrating,
    isViewingContent,
    activeContentTabId,
    selectedFile,
    selectedDiff,
    restoreLastViewedFile,
  ]);

  return { handleSidebarDiffSelected };
}
