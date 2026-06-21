import { useState, useEffect } from "react";
import { getRepositoryTree } from "../../../services/GitHubService";
import { useGitHub } from "../../github/GitHubContextProvider";
import { doesRepositorySelectionMatch } from "../../../lib/repository-context-match";

export function useGitHubTree(expectedRepo?: string) {
  const { repo, branch, switchBranch, isLoaded: isGitHubLoaded } = useGitHub();
  const [repoTree, setRepoTree] = useState<
    Array<{ path: string; type: string; sha: string }>
  >([]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);

  // If the current context doesn't match the expected repo, we are in a loading/switching state
  const isContextMismatch = !doesRepositorySelectionMatch(
    expectedRepo,
    repo?.full_name,
  );
  const effectiveRepo = isContextMismatch ? null : repo;
  const effectiveBranch = isContextMismatch ? "" : branch;

  useEffect(() => {
    if (isContextMismatch) {
      setRepoTree([]);
      return;
    }

    if (!repo || !isGitHubLoaded) {
      setRepoTree([]);
      return;
    }

    const fetchTree = async () => {
      setIsLoadingTree(true);
      try {
        const tree = await getRepositoryTree(
          repo.owner.login,
          repo.name,
          branch,
        );
        setRepoTree(tree);
      } catch (error) {
        console.error("[useGitHubTree] Failed to fetch repository tree:", error);
        setRepoTree([]);
      } finally {
        setIsLoadingTree(false);
      }
    };

    fetchTree();
  }, [repo, branch, isGitHubLoaded, expectedRepo, isContextMismatch]);

  return {
    repoTree,
    isLoadingTree: isLoadingTree || isContextMismatch,
    repo: effectiveRepo,
    branch: effectiveBranch,
    switchBranch,
    isGitHubLoaded,
    isContextMismatch,
  };
}
