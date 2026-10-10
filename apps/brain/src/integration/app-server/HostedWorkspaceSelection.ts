import { z } from "zod";
import type { GitHubAPIClient } from "@legioncode/github-bridge";
import type { Env } from "../../types/ai";
import { WorkspaceSelectionService } from "../../services/workspaces/WorkspaceSelectionService";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";

export const SelectWorkspaceRequestSchema = z.object({
  repository: z.object({ owner: z.string().min(1), name: z.string().min(1) }),
  selectedBranch: z.string().min(1),
});

export function listHostedWorkspaces(env: Env, userId: string) {
  return withWorkspaceRepository(env, (repository) =>
    new WorkspaceSelectionService(repository).getWorkspaceList(userId),
  );
}

export async function selectHostedWorkspace(
  env: Env,
  userId: string,
  client: Pick<GitHubAPIClient, "getRepository">,
  params: z.infer<typeof SelectWorkspaceRequestSchema>,
) {
  const repository = await client.getRepository(params.repository.owner, params.repository.name);
  return withWorkspaceRepository(env, (workspaceRepo) =>
    new WorkspaceSelectionService(workspaceRepo).selectGitHubWorkspace({
      userId, repository, selectedBranch: params.selectedBranch,
    }),
  );
}
