import type { Repository } from "../services/GitHubService";
import type { SessionGitHubContext } from "../types/session";

const DEFAULT_GIT_BRANCH = "main";

export function inferSessionGitHubContext(
  repositoryFullName: string,
  currentRepo: Repository | null,
  currentBranch: string,
): SessionGitHubContext | null {
  const normalizedFullName = repositoryFullName.trim();
  const [repoOwner, repoName, extraSegment] = normalizedFullName
    .split("/")
    .map((segment) => segment.trim());

  if (!repoOwner || !repoName || extraSegment) {
    return null;
  }

  return {
    repoOwner,
    repoName,
    fullName: `${repoOwner}/${repoName}`,
    branch: resolveSessionBranch(normalizedFullName, currentRepo, currentBranch),
  };
}

function resolveSessionBranch(
  repositoryFullName: string,
  currentRepo: Repository | null,
  currentBranch: string,
): string {
  const normalizedBranch = currentBranch.trim();
  if (currentRepo?.full_name === repositoryFullName && normalizedBranch) {
    return normalizedBranch;
  }

  const defaultBranch = currentRepo?.default_branch?.trim();
  if (currentRepo?.full_name === repositoryFullName && defaultBranch) {
    return defaultBranch;
  }

  return DEFAULT_GIT_BRANCH;
}
