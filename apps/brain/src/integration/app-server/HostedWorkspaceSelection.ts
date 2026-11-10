import {
  HostedWorkspaceConfigurationReadRequestSchema,
  HostedWorkspaceConfigurationUpdateRequestSchema,
  type HostedWorkspaceConfigurationReadRequest,
  type HostedWorkspaceConfigurationUpdateRequest,
  type HostedWorkspaceSelectRequest,
} from "@repo/platform-protocol";
import {
  AppServerOperationError,
  type AppServerComposition,
} from "@legioncode/app-server/server";
import {
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../../services/AuthService";
import type { GitHubAPIClient } from "@legioncode/github-bridge";
import type { Env } from "../../types/ai";
import {
  WorkspaceSelectionService,
  toConfigurationView,
} from "../../services/workspaces/WorkspaceSelectionService";
import { withWorkspaceRepository } from "../../services/workspaces/WorkspacePersistenceFactory";

export function listHostedWorkspaces(env: Env, userId: string) {
  return withWorkspaceRepository(env, (repository) =>
    new WorkspaceSelectionService(repository).getWorkspaceList(userId),
  );
}

export async function selectHostedWorkspace(
  env: Env,
  userId: string,
  client: Pick<GitHubAPIClient, "getRepository">,
  params: HostedWorkspaceSelectRequest,
) {
  const repository = await client.getRepository(
    params.repository.owner,
    params.repository.name,
  );
  return withWorkspaceRepository(env, (workspaceRepo) =>
    new WorkspaceSelectionService(workspaceRepo).selectGitHubWorkspace({
      userId,
      repository,
      selectedBranch: params.selectedBranch,
    }),
  );
}

/** Authenticated hosted repository selection; never a local filesystem grant. */
export function composeHostedWorkspaceSelection(
  request: Request,
  env: Env,
  userId: string,
): NonNullable<AppServerComposition["hostedWorkspaceService"]> {
  return {
    readConfiguration: (params) =>
      workspaceOperation(() => readConfiguration(env, userId, params)),
    updateConfiguration: (params) =>
      workspaceOperation(() =>
        updateConfiguration(request, env, userId, params),
      ),
    list: () => workspaceOperation(() => listHostedWorkspaces(env, userId)),
    select: (params) =>
      workspaceOperation(async () => {
        const auth = await getGitHubClient(request, env);
        if (!auth || auth.userId !== userId)
          throw new AppServerOperationError(
            401,
            "unauthorized",
            "Unauthorized",
          );
        return {
          selection: await selectHostedWorkspace(
            env,
            userId,
            auth.client,
            params,
          ),
        };
      }),
  };
}

async function workspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    if (isSessionStoreUnavailableError(error)) {
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        error.message,
      );
    }
    throw new AppServerOperationError(
      500,
      "server_unavailable",
      "Failed to persist workspace state",
    );
  }
}

async function readConfiguration(
  env: Env,
  userId: string,
  input: HostedWorkspaceConfigurationReadRequest,
) {
  const params = HostedWorkspaceConfigurationReadRequestSchema.parse(input);
  return withWorkspaceRepository(env, async (repository) => {
    const configuration = await new WorkspaceSelectionService(
      repository,
    ).getConfiguration(userId, params.workspaceId);
    if (!configuration) throw workspaceNotFound();
    return toConfigurationView(configuration);
  });
}

async function updateConfiguration(
  request: Request,
  env: Env,
  userId: string,
  input: HostedWorkspaceConfigurationUpdateRequest,
) {
  const params = HostedWorkspaceConfigurationUpdateRequestSchema.parse(input);
  return withWorkspaceRepository(env, async (repository) => {
    const service = new WorkspaceSelectionService(repository);
    const current = await service.getConfiguration(userId, params.workspaceId);
    if (!current) throw workspaceNotFound();
    const auth = await getGitHubClient(request, env);
    if (!auth || auth.userId !== userId)
      throw new AppServerOperationError(401, "unauthorized", "Unauthorized");
    // Repository identity comes only from the owned saved record.
    await auth.client.getRepository(
      current.repository.owner,
      current.repository.name,
    );
    if (params.patch.selectedBranch !== undefined) {
      await auth.client.getBranchSha(
        current.repository.owner,
        current.repository.name,
        params.patch.selectedBranch,
      );
    }
    const result = await service.updateConfiguration({
      ...params,
      userId,
      now: new Date().toISOString(),
    });
    if (result.status === "not_found") throw workspaceNotFound();
    if (result.status === "conflict")
      throw new AppServerOperationError(
        409,
        "conflict",
        "Workspace configuration changed; read it again before updating",
        "WORKSPACE_CONFIGURATION_CONFLICT",
        false,
      );
    return toConfigurationView(result.configuration);
  });
}

function workspaceNotFound() {
  return new AppServerOperationError(
    404,
    "not_found",
    "Workspace configuration not found",
  );
}
