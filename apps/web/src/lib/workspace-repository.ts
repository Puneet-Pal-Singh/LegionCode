import type { Repository, WorkspaceSelection } from "../services/GitHubService";

export function repositoryFromWorkspaceSelection(
  selection: Pick<WorkspaceSelection, "repository" | "selectedBranch"> &
    Partial<WorkspaceSelection>,
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
