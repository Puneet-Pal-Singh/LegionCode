import { useCallback, useState } from "react";
import type { Repository } from "../services/GitHubService";
import { SessionStateService } from "../services/SessionStateService";

export interface GitHubContextData {
  repo: Repository | null;
  branch: string;
  owner: string;
}

/** The active session projects its repository here; no global selection is restored. */
export function useGitHubContext() {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [branch, setBranch] = useState("");

  const setContext = useCallback(
    (repository: Repository, selectedBranch: string) => {
      setRepo(repository);
      setBranch(selectedBranch);
    },
    [],
  );

  const clearContext = useCallback(() => {
    setRepo(null);
    setBranch("");
  }, []);

  const saveSessionContext = useCallback(
    (sessionId: string) => {
      if (!repo) return;
      SessionStateService.saveSessionGitHubContext(sessionId, {
        repoOwner: repo.owner.login,
        repoName: repo.name,
        fullName: repo.full_name,
        branch,
      });
    },
    [repo, branch],
  );

  return {
    repo,
    branch,
    owner: repo?.owner.login ?? "",
    isLoaded: true,
    setContext,
    switchBranch: setBranch,
    clearContext,
    saveSessionContext,
  };
}
