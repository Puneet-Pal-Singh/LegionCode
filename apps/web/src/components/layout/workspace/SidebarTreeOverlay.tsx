import { AnimatePresence, motion } from "framer-motion";
import { useState, type RefObject } from "react";
import { Resizer } from "../../ui/Resizer";
import { FileExplorer, type FileExplorerHandle } from "../../FileExplorer";
import { ChangesList } from "../../diff/ChangesList";
import { RepoFileTree } from "../../github/RepoFileTree";
import { useGitReview } from "../../git/useGitReview";
import type { Repository } from "../../../services/GitHubService";
import type { TabType } from "./useWorkspaceState";
import { TreeFilter } from "./TreeFilter";

interface SidebarTreeOverlayProps {
  activeTab: TabType;
  repo: Repository | null;
  isGitHubLoaded: boolean;
  repoTree: Array<{ path: string; type: string; sha: string }>;
  isLoadingTree: boolean;
  branch: string;
  explorerRef: RefObject<FileExplorerHandle | null>;
  sandboxId: string;
  runId: string;
  onGitHubFileSelect: (path: string) => void;
  onLocalFileSelect: (path: string) => void;
  onChangedFileSelect: (path: string) => void;
  onClose: () => void;
}

export function SidebarTreeOverlay(props: SidebarTreeOverlayProps) {
  const isOpen = props.activeTab === "changes" || props.activeTab === "files";
  const [drawerWidth, setDrawerWidth] = useState<number | null>(null);
  const resizeDrawer = (delta: number) => {
    setDrawerWidth((currentWidth) => {
      const drawer = document.querySelector<HTMLElement>(
        "[data-sidebar-tree-drawer]",
      );
      const parentWidth = drawer?.parentElement?.clientWidth ?? 0;
      const nextWidth = Math.min(
        parentWidth,
        (currentWidth ?? drawer?.offsetWidth ?? 0) + delta,
      );
      if (nextWidth <= 80) {
        props.onClose();
        return null;
      }
      return nextWidth;
    });
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.aside
          key={props.activeTab}
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          data-sidebar-tree-drawer
          className="absolute bottom-0 right-0 top-[60px] z-30 flex min-w-0 max-w-full flex-col overflow-hidden border-l border-zinc-800 bg-black shadow-[-18px_0_36px_rgba(0,0,0,0.35)]"
          style={{ width: drawerWidth ?? "50%" }}
        >
          <Resizer side="right" onResize={resizeDrawer} />
          {props.activeTab === "changes" ? (
            <ChangedFilesTree onFileSelect={props.onChangedFileSelect} />
          ) : (
            <WorkspaceFilesTree {...props} />
          )}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function ChangedFilesTree({
  onFileSelect,
}: {
  onFileSelect: (path: string) => void;
}) {
  const review = useGitReview();

  return (
    <ChangesList
      files={review.reviewFiles}
      selectedFile={review.selectedFile}
      onSelectFile={(file) => {
        review.selectFile(file);
        onFileSelect(file.path);
      }}
      reviewScope={review.reviewScope}
      onReviewScopeChange={review.setReviewScope}
      showToolbar={false}
      searchable
    />
  );
}

export interface WorkspaceFilesTreeProps {
  repo: Repository | null;
  isGitHubLoaded: boolean;
  branch: string;
  repoTree: Array<{ path: string; type: string; sha: string }>;
  isLoadingTree: boolean;
  onGitHubFileSelect: (path: string) => void;
  explorerRef: RefObject<FileExplorerHandle | null>;
  sandboxId: string;
  runId: string;
  onLocalFileSelect: (path: string) => void;
}

export function WorkspaceFilesTree({
  repo,
  isGitHubLoaded,
  branch,
  repoTree,
  isLoadingTree,
  onGitHubFileSelect,
  explorerRef,
  sandboxId,
  runId,
  onLocalFileSelect,
}: WorkspaceFilesTreeProps) {
  const [query, setQuery] = useState("");

  const tree = repo && isGitHubLoaded ? (
    <RepoFileTree
      owner={repo.owner.login}
      repo={repo.name}
      branch={branch}
      tree={repoTree}
      isLoading={isLoadingTree}
      filterQuery={query}
      onFileSelect={onGitHubFileSelect}
    />
  ) : (
    <FileExplorer
      ref={explorerRef}
      sessionId={sandboxId}
      runId={runId}
      filterQuery={query}
      onFileClick={onLocalFileSelect}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TreeFilter value={query} onChange={setQuery} />
      <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
    </div>
  );
}
