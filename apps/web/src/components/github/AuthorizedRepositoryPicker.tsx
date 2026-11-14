import { useMemo } from "react";
import { AuthorizedRepositoryPicker as SharedAuthorizedRepositoryPicker, type AuthorizedRepositoryReadPort } from "@legioncode/client-ui";
import type { Repository } from "../../services/GitHubService";
import * as GitHubService from "../../services/GitHubService";
import { useAuth } from "../../contexts/AuthContext";

interface AuthorizedRepositoryPickerProps {
  onRepoSelect: (repo: Repository, branch: string) => void | Promise<void>;
  onClose?: () => void;
}

/** Web authentication and cached GitHub reads adapt to the shared presentation. */
export function AuthorizedRepositoryPicker(props: AuthorizedRepositoryPickerProps) {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const readPort = useMemo<AuthorizedRepositoryReadPort>(() => ({
    listRepositories: async ({ type, sort }) => ({
      repositories: await GitHubService.listRepositories(type, sort),
    }),
    listRepositoryBranches: async ({ owner, repo }) => ({
      branches: await GitHubService.listBranches(owner, repo, accountId),
    }),
  }), [accountId]);
  return <SharedAuthorizedRepositoryPicker
    {...props}
    accountId={accountId}
    readPort={readPort}
    onManageGitHubAccess={GitHubService.initiateGitHubReauthorization}
  />;
}
