import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import type { DiffContent } from "@repo/shared-types";
import { FileExplorer, type FileExplorerHandle } from "../../FileExplorer";
import { ChangesPanel } from "../../sidebar/ChangesPanel";
import { ArtifactView } from "../../chat/ArtifactView";
import { DiffViewer } from "../../diff/DiffViewer";
import { RepoFileTree } from "../../github/RepoFileTree";
import { useGitReview } from "../../git/GitReviewContext";
import type { TabType, SelectedFile, SelectedDiff } from "./useWorkspaceState";
import type { Repository } from "../../../services/GitHubService";

interface SidebarContentProps {
  isViewingContent: boolean;
  activeTab: TabType;
  isLoadingContent: boolean;
  selectedFile: SelectedFile | null;
  selectedDiff: SelectedDiff | null;
  onCloseContent: () => void;
  
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
}

export function SidebarContent({
  isViewingContent,
  activeTab,
  isLoadingContent,
  selectedFile,
  selectedDiff,
  onCloseContent,
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

  return (
    <div className="flex-1 overflow-hidden relative">
      <AnimatePresence mode="wait" initial={false}>
        {isViewingContent ? (
          <motion.div
            key="content"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="absolute inset-0 flex flex-col overflow-y-auto"
          >
            {isLoadingContent ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2
                  size={24}
                  className="animate-spin text-zinc-600"
                />
              </div>
            ) : selectedFile ? (
              <ArtifactView
                isOpen={true}
                onClose={onCloseContent}
                title={selectedFile.path}
                content={selectedFile.content}
              />
            ) : selectedDiff ? (
              <DiffViewer
                diff={selectedDiff.content}
                className="flex-1"
              />
            ) : null}
          </motion.div>
        ) : activeTab === "review" ? (
          <motion.div
            key="review"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 overflow-hidden"
          >
            <ChangesPanel
              mode="modal"
              layout="stacked"
              className="p-3"
            />
          </motion.div>
        ) : activeTab === "files" ? (
          <motion.div
            key="files"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 overflow-y-auto"
          >
            <AnimatePresence>
              {repo && isGitHubLoaded ? (
                <motion.div
                  key="repo-tree"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <RepoFileTree
                    owner={repo.owner.login}
                    repo={repo.name}
                    branch={branch}
                    tree={repoTree}
                    isLoading={isLoadingTree}
                    onFileSelect={handleGitHubFileSelect}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="local-explorer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <FileExplorer
                    ref={explorerRef}
                    sessionId={sandboxId}
                    runId={runId}
                    onFileClick={handleFileClick}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="changes"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 overflow-y-auto"
          >
            <ChangesPanel
              mode="sidebar"
              showToolbar={false}
              onFileSelect={handleChangedFileSelect}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
