import type { WorkspaceListItem } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withWorkspaceRepository } from "./WorkspacePersistenceFactory";

export interface AuthorizedWorkspaceRepositoryContext {
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly repositoryBaseUrl: string;
  readonly repositoryBranch: string;
}

/** Resolve repository details from the exact user-owned workspace, never the mutable global selection. */
export async function resolveAuthorizedWorkspaceRepositoryContext(input: {
  readonly env: Env;
  readonly userId: string;
  readonly workspaceId: string;
  readonly preferredBranch?: string | null;
}): Promise<AuthorizedWorkspaceRepositoryContext | null> {
  return await withWorkspaceRepository(input.env, async (repository) => {
    const workspaces = await repository.listWorkspaces(input.userId);
    const entry = workspaces.find(
      (candidate: WorkspaceListItem) =>
        candidate.workspace.id === input.workspaceId &&
        candidate.workspace.userId === input.userId &&
        candidate.workspace.status === "active",
    );
    if (!entry) return null;

    return {
      repositoryOwner: entry.repository.owner,
      repositoryName: entry.repository.name,
      repositoryBaseUrl: entry.repository.repoUrl,
      repositoryBranch:
        input.preferredBranch?.trim() ||
        entry.workspace.lastSelectedBranch ||
        entry.workspace.defaultBranch ||
        entry.repository.defaultBranch,
    };
  });
}
