import { useEffect, useState } from "react";
import type { Repository, WorkspaceSelection } from "../services/GitHubService";
import * as GitHubService from "../services/GitHubService";

export type WorkspaceSelectionBootstrapStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed";

interface UseWorkspaceSelectionBootstrapInput {
  enabled: boolean;
  currentRepository: Repository | null;
  setContext: (repository: Repository, branch: string) => void;
}

export function useWorkspaceSelectionBootstrap({
  enabled,
  currentRepository,
  setContext,
}: UseWorkspaceSelectionBootstrapInput): WorkspaceSelectionBootstrapStatus {
  const [status, setStatus] = useState<WorkspaceSelectionBootstrapStatus>(
    enabled ? "loading" : "idle",
  );

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    if (currentRepository) {
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    void GitHubService.listWorkspaces()
      .then((workspaceState) => {
        if (cancelled) return;
        if (workspaceState.selection) {
          const selection = workspaceState.selection;
          setContext(
            repositoryFromWorkspaceSelection(selection),
            selection.selectedBranch,
          );
        }
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [currentRepository, enabled, setContext]);

  return status;
}

export function repositoryFromWorkspaceSelection(
  selection: WorkspaceSelection,
): Repository {
  const { repository } = selection;
  return {
    id: Number(repository.providerRepoId ?? 0),
    name: repository.name,
    full_name: repository.fullName,
    owner: { login: repository.owner, avatar_url: "" },
    description: null,
    private: false,
    html_url: repository.repoUrl,
    clone_url: `${repository.repoUrl}.git`,
    default_branch: selection.selectedBranch || repository.defaultBranch,
    stargazers_count: 0,
    language: null,
    updated_at: repository.updatedAt,
  };
}
