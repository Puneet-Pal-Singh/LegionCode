import { AppServerOperationError } from "@legioncode/app-server/server";
import {
  GitHubAPIError,
  type GitHubAPIClient,
} from "@legioncode/github-bridge";
import { ZodError } from "zod";
import {
  type RepositoryBranchesRequest,
  type RepositoryContentsRequest,
  type RepositoryListRequest,
  type RepositoryTreeRequest,
} from "@repo/platform-protocol";
import {
  getGitHubClient,
  isSessionStoreUnavailableError,
} from "../../services/AuthService";
import {
  listRepositories,
  listRepositoryBranches,
  readRepositoryContents,
  readRepositoryTree,
} from "../../services/RepositoryReadService";
import type { Env } from "../../types/ai";

/** Composes repository reads around the authenticated user's existing GitHub grant. */
export function composeHostedRepositoryReads(
  request: Request,
  env: Env,
  userId: string,
) {
  return {
    list: (params: RepositoryListRequest) =>
      withGitHubClient(request, env, userId, "Failed to list repositories", (client) =>
        listRepositories(client, params),
      ),
    branches: (params: RepositoryBranchesRequest) =>
      withGitHubClient(request, env, userId, "Failed to list branches", (client) =>
        listRepositoryBranches(client, params),
      ),
    tree: (params: RepositoryTreeRequest) =>
      withGitHubClient(request, env, userId, "Failed to get tree", (client) =>
        readRepositoryTree(client, params),
      ),
    contents: (params: RepositoryContentsRequest) =>
      withGitHubClient(request, env, userId, "Failed to get contents", (client) =>
        readRepositoryContents(client, params),
      ),
  };
}

async function withGitHubClient<T>(
  request: Request,
  env: Env,
  userId: string,
  fallbackMessage: string,
  operation: (client: GitHubAPIClient) => Promise<T>,
): Promise<T> {
  try {
    const auth = await getGitHubClient(request, env);
    if (!auth || auth.userId !== userId) {
      throw new AppServerOperationError(401, "unauthorized", "Unauthorized");
    }
    return await operation(auth.client);
  } catch (error) {
    throw mapRepositoryReadError(error, fallbackMessage);
  }
}

function mapRepositoryReadError(
  error: unknown,
  fallbackMessage: string,
): AppServerOperationError {
  if (error instanceof AppServerOperationError) {
    return error;
  }
  if (isSessionStoreUnavailableError(error)) {
    return new AppServerOperationError(
      503,
      "server_unavailable",
      error.message,
      "SESSION_STORE_UNAVAILABLE",
      true,
    );
  }
  if (error instanceof GitHubAPIError || error instanceof ZodError) {
    return new AppServerOperationError(
      500,
      "server_unavailable",
      error.message,
      error instanceof GitHubAPIError ? "GITHUB_API_ERROR" : "INVALID_RESPONSE_CONTRACT",
      true,
    );
  }
  return new AppServerOperationError(
    500,
    "server_unavailable",
    error instanceof Error ? error.message : fallbackMessage,
    "GITHUB_API_ERROR",
    true,
  );
}
