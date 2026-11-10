import { RepositoryIdentityConflictError } from "@repo/persistence";
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
import {
  GitHubAPIError,
  type GitHubAPIClient,
} from "@legioncode/github-bridge";
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
  const captured = { ...params, repository: { ...params.repository } };
  const authorized = await client.getRepository(
    captured.repository.owner,
    captured.repository.name,
  );
  const repository = { ...authorized, owner: { ...authorized.owner } };
  return withWorkspaceRepository(env, (workspaceRepo) =>
    new WorkspaceSelectionService(workspaceRepo).selectGitHubWorkspace({
      userId,
      repository,
      selectedBranch: captured.selectedBranch,
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
    select: (params) => {
      const captured = { ...params, repository: { ...params.repository } };
      return workspaceOperation(async () => {
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
            captured,
          ),
        };
      });
    },
  };
}

async function workspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppServerOperationError) throw error;
    if (error instanceof RepositoryIdentityConflictError) {
      throw new AppServerOperationError(
        409,
        "conflict",
        "Workspace repository identity conflicts; reviewed identity recovery is required",
        "WORKSPACE_REPOSITORY_IDENTITY_CONFLICT",
        false,
      );
    }
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
    // Capture all saved identity before authentication/provider awaits. The owner
    // may return a mutable object; later mutation cannot redirect this validation.
    const savedRepository = { ...current.repository };
    const expectedRepository = {
      id: savedRepository.id,
      providerRepoId: savedRepository.providerRepoId,
    };
    const auth = await getGitHubClient(request, env);
    if (!auth || auth.userId !== userId)
      throw new AppServerOperationError(401, "unauthorized", "Unauthorized");
    const savedProviderRepoId = expectedRepository.providerRepoId;
    if (!savedProviderRepoId || !/^[1-9][0-9]*$/u.test(savedProviderRepoId)) {
      throw new AppServerOperationError(
        409,
        "conflict",
        "Workspace repository identity is unavailable; reviewed identity recovery is required",
        "GITHUB_REPOSITORY_IDENTITY_UNAVAILABLE",
        false,
      );
    }
    // Repository identity comes only from the owned saved record. Classify
    // remote validation separately; persistence errors retain their own owner.
    try {
      const authorizedRepository = await auth.client.getRepository(
        savedRepository.owner,
        savedRepository.name,
      );
      if (savedProviderRepoId !== String(authorizedRepository.id)) {
        throw new AppServerOperationError(
          409,
          "conflict",
          "Workspace repository identity changed; reviewed identity recovery is required",
          "GITHUB_REPOSITORY_IDENTITY_CHANGED",
          false,
        );
      }
      if (params.patch.selectedBranch !== undefined) {
        await auth.client.getBranchSha(
          savedRepository.owner,
          savedRepository.name,
          params.patch.selectedBranch,
        );
      }
    } catch (error) {
      if (error instanceof AppServerOperationError) throw error;
      if (error instanceof GitHubAPIError)
        throw mapWorkspaceGitHubValidationError(error);
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        "GitHub repository validation is temporarily unavailable",
        "GITHUB_UNAVAILABLE",
        true,
      );
    }
    const result = await service.updateConfiguration({
      ...params,
      expectedRepository: {
        id: expectedRepository.id,
        providerRepoId: savedProviderRepoId,
      },
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

function mapWorkspaceGitHubValidationError(
  error: GitHubAPIError,
): AppServerOperationError {
  if (error.rateLimited || error.status === 429) {
    return new AppServerOperationError(
      429,
      "server_unavailable",
      "GitHub rate limit reached; retry later",
      "GITHUB_RATE_LIMITED",
      true,
    );
  }
  if (error.status === 401) {
    return new AppServerOperationError(
      401,
      "unauthorized",
      "GitHub authentication is unavailable; reconnect GitHub",
      "GITHUB_AUTHENTICATION_REQUIRED",
      false,
    );
  }
  if (error.status === 403) {
    return new AppServerOperationError(
      403,
      "forbidden",
      "GitHub repository access denied",
      "GITHUB_ACCESS_DENIED",
      false,
    );
  }
  if (error.status === 404) {
    return new AppServerOperationError(
      404,
      "not_found",
      "GitHub repository or branch not found",
      "GITHUB_RESOURCE_NOT_FOUND",
      false,
    );
  }
  if (error.status >= 400 && error.status < 500 && error.status !== 408) {
    return new AppServerOperationError(
      error.status,
      "invalid_request",
      "GitHub rejected repository or branch validation",
      "GITHUB_VALIDATION_FAILED",
      false,
    );
  }
  return new AppServerOperationError(
    503,
    "server_unavailable",
    "GitHub repository validation is temporarily unavailable",
    "GITHUB_UNAVAILABLE",
    true,
  );
}
