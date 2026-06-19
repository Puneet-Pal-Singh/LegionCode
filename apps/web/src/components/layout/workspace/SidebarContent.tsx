import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, type RefObject } from "react";
import type { DiffContent } from "@repo/shared-types";
import type { FileExplorerHandle } from "../../FileExplorer";
import { ChangesPanel } from "../../sidebar/ChangesPanel";
import { useGitReview } from "../../git/useGitReview";
import type { TabType, SelectedFile, SelectedDiff } from "./useWorkspaceState";
import type { Repository } from "../../../services/GitHubService";
import { SidebarTreeOverlay } from "./SidebarTreeOverlay";
import { WorkspaceSurfaceBody } from "./WorkspaceSurfaceBody";

interface SidebarContentProps {
  isViewingContent: boolean;
  activeTab: TabType;
  isLoadingContent: boolean;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;

  // GitHub / File Tree props
  repo: Repository | null;
  isGitHubLoaded: boolean;
  repoTree: Array<{ path: string; type: string; sha: string }>;
  isLoadingTree: boolean;
  branch: string;

  // Handlers
  handleGitHubFileSelect: (path: string) => void;
  handleFileClick: (path: string) => void;
  onDiffSelected?: (path: string, content: DiffContent) => void;

  // Explorer props
  explorerRef: RefObject<FileExplorerHandle | null>;
  sandboxId: string;
  runId: string;
  onOpenFiles: () => void;
  onCloseTree: () => void;
  onToggleChanges: () => void;
}

export function SidebarContent({
  isViewingContent,
  activeTab,
  isLoadingContent,
  selectedFile,
  selectedDiff,
  repo,
  isGitHubLoaded,
  repoTree,
  isLoadingTree,
  branch,
  handleGitHubFileSelect,
  handleFileClick,
  onDiffSelected,
  explorerRef,
  sandboxId,
  runId,
  onOpenFiles,
  onCloseTree,
  onToggleChanges,
}: SidebarContentProps) {
  const { diff } = useGitReview();
  const pendingDiffPathRef = useRef<string | null>(null);

  useEffect(() => {
    const pendingDiffPath = pendingDiffPathRef.current;
    if (!pendingDiffPath || !diff) {
      return;
    }

    if (diff.newPath !== pendingDiffPath && diff.oldPath !== pendingDiffPath) {
      return;
    }

    const diffPath = diff.newPath || diff.oldPath || pendingDiffPath;
    onDiffSelected?.(diffPath, diff);
    pendingDiffPathRef.current = null;
  }, [diff, onDiffSelected]);

  const handleChangedFileSelect = (path: string) => {
    pendingDiffPathRef.current = path;

    if (diff?.newPath === path || diff?.oldPath === path) {
      const diffPath = diff.newPath || diff.oldPath || path;
      onDiffSelected?.(diffPath, diff);
      pendingDiffPathRef.current = null;
    }
  };

  const treeOverlay = (
    <SidebarTreeOverlay
      activeTab={activeTab}
      repo={repo}
      isGitHubLoaded={isGitHubLoaded}
      repoTree={repoTree}
      isLoadingTree={isLoadingTree}
      branch={branch}
      explorerRef={explorerRef}
      sandboxId={sandboxId}
      runId={runId}
      onGitHubFileSelect={handleGitHubFileSelect}
      onLocalFileSelect={handleFileClick}
      onChangedFileSelect={handleChangedFileSelect}
      onClose={onCloseTree}
    />
  );

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={isViewingContent ? "content" : "review"}
            initial={
              isViewingContent
                ? { opacity: 0, scale: 0.98 }
                : { opacity: 0, x: 10 }
            }
            animate={
              isViewingContent ? { opacity: 1, scale: 1 } : { opacity: 1, x: 0 }
            }
            exit={
              isViewingContent
                ? { opacity: 0, scale: 0.98 }
                : { opacity: 0, x: 10 }
            }
            transition={{ duration: 0.15 }}
            className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
          >
            <WorkspaceSurfaceBody
              reviewActive={!isViewingContent}
              reviewContent={
                <ChangesPanel
                  mode="modal"
                  layout="stacked"
                  className="min-h-0 w-full"
                  isChangesOpen={activeTab === "changes"}
                  onToggleChanges={onToggleChanges}
                  showChangesRail={false}
                />
              }
              selectedFile={selectedFile}
              selectedDiff={selectedDiff}
              isLoadingContent={isLoadingContent}
              filesOpen={activeTab === "files"}
              onToggleFiles={onOpenFiles}
              overlay={treeOverlay}
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
