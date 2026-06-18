import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState, type RefObject } from "react";
import { Search } from "lucide-react";
import { FileExplorer, type FileExplorerHandle } from "../../FileExplorer";
import { ChangesList } from "../../diff/ChangesList";
import { RepoFileTree } from "../../github/RepoFileTree";
import { useGitReview } from "../../git/useGitReview";
import type { Repository } from "../../../services/GitHubService";
import type { TabType } from "./useWorkspaceState";

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
}

export function SidebarTreeOverlay(props: SidebarTreeOverlayProps) {
  const isOpen = props.activeTab === "changes" || props.activeTab === "files";
  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.aside
          key={props.activeTab}
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="absolute inset-y-0 right-0 z-30 flex w-1/2 min-w-0 flex-col overflow-hidden border-l border-zinc-800 bg-black shadow-[-18px_0_36px_rgba(0,0,0,0.35)]"
        >
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

function ChangedFilesTree({ onFileSelect }: { onFileSelect: (path: string) => void }) {
  const review = useGitReview();
  const [query, setQuery] = useState("");
  const files = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery
      ? review.reviewFiles.filter((file) =>
          file.path.toLowerCase().includes(normalizedQuery),
        )
      : review.reviewFiles;
  }, [query, review.reviewFiles]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TreeFilter value={query} onChange={setQuery} />
      <ChangesList
        files={files}
        selectedFile={review.selectedFile}
        onSelectFile={(file) => {
          review.selectFile(file);
          onFileSelect(file.path);
        }}
        reviewScope={review.reviewScope}
        onReviewScopeChange={review.setReviewScope}
        showToolbar={false}
      />
    </div>
  );
}

function TreeFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="m-3 flex h-9 shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-zinc-500 focus-within:border-zinc-600">
      <Search size={15} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter files..."
        className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
      />
    </label>
  );
}

function WorkspaceFilesTree({
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
}: SidebarTreeOverlayProps) {
  if (repo && isGitHubLoaded) {
    return (
      <RepoFileTree
        owner={repo.owner.login}
        repo={repo.name}
        branch={branch}
        tree={repoTree}
        isLoading={isLoadingTree}
        onFileSelect={onGitHubFileSelect}
      />
    );
  }

  return (
    <FileExplorer
      ref={explorerRef}
      sessionId={sandboxId}
      runId={runId}
      onFileClick={onLocalFileSelect}
    />
  );
}
