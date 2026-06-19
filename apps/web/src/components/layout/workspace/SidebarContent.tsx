import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { DiffContent } from "@repo/shared-types";
import type { FileExplorerHandle } from "../../FileExplorer";
import { ChangesPanel } from "../../sidebar/ChangesPanel";
import { ArtifactView } from "../../chat/ArtifactView";
import { DiffViewer } from "../../diff/DiffViewer";
import { useGitReview } from "../../git/useGitReview";
import type { TabType, SelectedFile, SelectedDiff } from "./useWorkspaceState";
import type { Repository } from "../../../services/GitHubService";
import { SidebarTreeOverlay } from "./SidebarTreeOverlay";
import { FileNavigationBar } from "./FileNavigationBar";

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
  const [wordWrap, setWordWrap] = useState(true);
  const [richPreviewByPath, setRichPreviewByPath] = useState<
    Record<string, boolean>
  >({});
  const pendingDiffPathRef = useRef<string | null>(null);
  const selectedPath = selectedFile?.path ?? selectedDiff?.path ?? "/";
  const markdownPath = selectedFile && /\.mdx?$/i.test(selectedFile.path)
    ? selectedFile.path
    : null;
  const richPreview = markdownPath
    ? (richPreviewByPath[markdownPath] ?? true)
    : false;

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
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {isViewingContent || activeTab === "files" ? (
        <FileNavigationBar
          path={selectedPath}
          content={selectedFile?.content}
          filesOpen={activeTab === "files"}
          wordWrap={wordWrap}
          onWordWrapChange={setWordWrap}
          onOpenFiles={onOpenFiles}
          richPreview={richPreview}
          onRichPreviewChange={
            markdownPath
              ? (enabled) => {
                  setRichPreviewByPath((current) => ({
                    ...current,
                    [markdownPath]: enabled,
                  }));
                }
              : undefined
          }
        />
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
                title={selectedFile.path}
                content={selectedFile.content}
                wordWrap={wordWrap}
                richPreview={richPreview}
              />
            ) : selectedDiff ? (
              <DiffViewer
                diff={selectedDiff.content}
                className="flex-1"
                wordWrap={wordWrap}
                onWordWrapChange={setWordWrap}
                showHeader={false}
              />
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="review"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
          >
            <ChangesPanel
              mode="modal"
              layout="stacked"
              className="min-h-0 w-full"
              isChangesOpen={activeTab === "changes"}
              onToggleChanges={onToggleChanges}
            />
          </motion.div>
        )}
      </AnimatePresence>
      </div>
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
    </div>
  );
}
