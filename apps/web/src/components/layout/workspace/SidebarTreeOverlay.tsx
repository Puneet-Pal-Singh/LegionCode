import type { CheckoutTurnIdentity } from "../../../services/api/checkoutReads";
import { useState, type RefObject } from "react";
import { WorkspaceTreeDrawer } from "@legioncode/client-ui";
import { FileExplorer, type FileExplorerHandle } from "../../FileExplorer";
import { ChangesList } from "@legioncode/client-ui";
import { RepoFileTree } from "../../github/RepoFileTree";
import { useGitReview } from "../../git/useGitReview";
import type { Repository } from "../../../services/GitHubService";
import type { TabType } from "./useWorkspaceState";
import { TreeFilter } from "@legioncode/client-ui";

interface SidebarTreeOverlayProps {
  activeTab: TabType;
  repo: Repository | null;
  isGitHubLoaded: boolean;
  repoTree: Array<{ path: string; type: string; sha: string }>;
  isLoadingTree: boolean;
  repoTreeError: string | null;
  retryRepoTree: () => void;
  branch: string;
  explorerRef: RefObject<FileExplorerHandle | null>;
  sandboxId: string;
  runId: string;
  checkoutTurn?: CheckoutTurnIdentity;
  onGitHubFileSelect: (path: string) => void;
  onLocalFileSelect: (path: string) => void;
  onChangedFileSelect: (path: string) => void;
  onClose: () => void;
}

export function SidebarTreeOverlay(props: SidebarTreeOverlayProps) {
  return (
    <WorkspaceTreeDrawer
      kind={
        props.activeTab === "changes" || props.activeTab === "files"
          ? props.activeTab
          : null
      }
      onClose={props.onClose}
    >
      {props.activeTab === "changes" ? (
        <ChangedFilesTree onFileSelect={props.onChangedFileSelect} />
      ) : (
        <WorkspaceFilesTree {...props} />
      )}
    </WorkspaceTreeDrawer>
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
  repoTreeError: string | null;
  retryRepoTree: () => void;
  onGitHubFileSelect: (path: string) => void;
  explorerRef: RefObject<FileExplorerHandle | null>;
  sandboxId: string;
  runId: string;
  checkoutTurn?: CheckoutTurnIdentity;
  onLocalFileSelect: (path: string) => void;
}

export function WorkspaceFilesTree({
  repo,
  isGitHubLoaded,
  branch,
  repoTree,
  isLoadingTree,
  repoTreeError,
  retryRepoTree,
  onGitHubFileSelect,
  explorerRef,
  sandboxId,
  runId,
  onLocalFileSelect,
  checkoutTurn,
}: WorkspaceFilesTreeProps) {
  const [query, setQuery] = useState("");
  const hasOwnedTurn = checkoutTurn !== undefined;

  const scope = JSON.stringify([
    sandboxId,
    runId,
    checkoutTurn?.turnId,
    checkoutTurn?.runAttemptId,
    repo?.full_name,
    branch,
  ]);
  const [choice, setChoice] = useState<{
    scope: string;
    source: "checkout" | "repository";
  } | null>(null);
  const source =
    choice?.scope === scope
      ? choice.source
      : hasOwnedTurn
        ? "checkout"
        : repo
          ? "repository"
          : "checkout";
  const tree =
    source === "repository" && repo ? (
      <RepoFileTree
        owner={repo.owner.login}
        repo={repo.name}
        branch={branch}
        tree={repoTree}
        isLoading={isLoadingTree || !isGitHubLoaded}
        loadError={repoTreeError}
        onRetry={retryRepoTree}
        filterQuery={query}
        onFileSelect={onGitHubFileSelect}
      />
    ) : hasOwnedTurn ? (
      <FileExplorer
        ref={explorerRef}
        sessionId={sandboxId}
        runId={runId}
        checkoutTurn={checkoutTurn}
        filterQuery={query}
        onFileClick={onLocalFileSelect}
      />
    ) : (
      <p className="px-4 py-3 text-xs text-zinc-400">
        Start a task to browse its checkout.
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {repo ? (
        <div
          className="flex gap-1 border-b border-zinc-800 p-2"
          role="group"
          aria-label="File source"
        >
          <button
            type="button"
            aria-pressed={source === "checkout"}
            disabled={!hasOwnedTurn}
            className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 aria-pressed:bg-zinc-800 disabled:opacity-40"
            onClick={() => {
              setChoice({ scope, source: "checkout" });
              setQuery("");
            }}
          >
            Task checkout
          </button>
          <button
            type="button"
            aria-pressed={source === "repository"}
            className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 aria-pressed:bg-zinc-800"
            onClick={() => {
              setChoice({ scope, source: "repository" });
              setQuery("");
            }}
          >
            Repository
          </button>
        </div>
      ) : null}
      <TreeFilter value={query} onChange={setQuery} />
      <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
    </div>
  );
}
