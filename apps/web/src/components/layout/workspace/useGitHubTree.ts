import { useState, useEffect, useRef } from "react";
import { getRepositoryTree } from "../../../services/GitHubService";
import { useGitHub } from "../../github/GitHubContextProvider";
import { doesRepositorySelectionMatch } from "../../../lib/repository-context-match";
import { useAuth } from "../../../contexts/AuthContext";

export function useGitHubTree(expectedRepo?: string) {
  const { repo, branch, switchBranch, isLoaded: isGitHubLoaded } = useGitHub();
  const { user } = useAuth();
  const [repoTree, setRepoTree] = useState<
    Array<{ path: string; type: string; sha: string }>
  >([]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [repoTreeError, setRepoTreeError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [treeResultKey, setTreeResultKey] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const currentTreeKey = JSON.stringify([
    user?.id ?? null,
    repo?.full_name ?? null,
    branch,
  ]);

  // If the current context doesn't match the expected repo, we are in a loading/switching state
  const isContextMismatch = !doesRepositorySelectionMatch(
    expectedRepo,
    repo?.full_name,
  );
  const effectiveRepo = isContextMismatch ? null : repo;
  const effectiveBranch = isContextMismatch ? "" : branch;

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    let active = true;
    if (isContextMismatch) {
      setRepoTree([]);
      setRepoTreeError(null);
      setIsLoadingTree(false);
      return;
    }

    if (!repo || !isGitHubLoaded) {
      setRepoTree([]);
      setRepoTreeError(null);
      setIsLoadingTree(false);
      return;
    }

    const fetchTree = async () => {
      setRepoTree([]);
      setRepoTreeError(null);
      setIsLoadingTree(true);
      try {
        const tree = await getRepositoryTree(
          repo.owner.login,
          repo.name,
          branch,
          user?.id ?? null,
        );
        if (!active || generation !== requestGenerationRef.current) return;
        setRepoTree(tree);
        setTreeResultKey(currentTreeKey);
      } catch (error) {
        if (!active || generation !== requestGenerationRef.current) return;
        console.error("[useGitHubTree] Failed to fetch repository tree:", error);
        setRepoTreeError("Repository files could not be loaded.");
        setTreeResultKey(currentTreeKey);
      } finally {
        if (active && generation === requestGenerationRef.current) {
          setIsLoadingTree(false);
        }
      }
    };

    void fetchTree();
    return () => {
      active = false;
      if (requestGenerationRef.current === generation) {
        requestGenerationRef.current += 1;
      }
    };
  }, [repo, branch, isGitHubLoaded, expectedRepo, isContextMismatch, retryCount, user?.id, currentTreeKey]);

  return {
    repoTree: treeResultKey === currentTreeKey ? repoTree : [],
    repoTreeError: treeResultKey === currentTreeKey ? repoTreeError : null,
    retryRepoTree: () => setRetryCount((count) => count + 1),
    isLoadingTree: isLoadingTree || isContextMismatch || Boolean(repo && treeResultKey !== currentTreeKey),
    repo: effectiveRepo,
    branch: effectiveBranch,
    switchBranch,
    isGitHubLoaded,
    isContextMismatch,
  };
}
