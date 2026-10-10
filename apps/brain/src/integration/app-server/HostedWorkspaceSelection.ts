import { z } from "zod";
import { HostedWorkspaceSelectRequestSchema } from "@repo/platform-protocol";
import { AppServerOperationError, type AppServerComposition } from "@legioncode/app-server/server";
import { getGitHubClient, isSessionStoreUnavailableError } from "../../services/AuthService";
import type { GitHubAPIClient } from "@legioncode/github-bridge";
import type { Env } from "../../types/ai";
import { WorkspaceSelectionService } from "../../services/workspaces/WorkspaceSelectionService";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";

// The old HTTP controller delegates here only until the Web caller cutover.
export const SelectWorkspaceRequestSchema = HostedWorkspaceSelectRequestSchema.strip();

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

/** Authenticated hosted repository selection; never a local filesystem grant. */
export function composeHostedWorkspaceSelection(
  request: Request, env: Env, userId: string,
): NonNullable<AppServerComposition["hostedWorkspaceService"]> {
  return {
    list: () => workspaceOperation(() => listHostedWorkspaces(env, userId)),
    select: (params) => workspaceOperation(async () => {
      const auth = await getGitHubClient(request, env);
      if (!auth || auth.userId !== userId) throw new AppServerOperationError(401, "unauthorized", "Unauthorized");
      return { selection: await selectHostedWorkspace(env, userId, auth.client, params) };
    }),
  };
}

async function workspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    if (isSessionStoreUnavailableError(error)) {
      throw new AppServerOperationError(503, "server_unavailable", error.message);
    }
    throw new AppServerOperationError(500, "server_unavailable", "Failed to persist workspace state");
  }
}
