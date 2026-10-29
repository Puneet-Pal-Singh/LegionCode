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
      withGitHubClient(request, env, userId, (client) =>
        listRepositories(client, params),
      ),
    branches: (params: RepositoryBranchesRequest) =>
      withGitHubClient(request, env, userId, (client) =>
        listRepositoryBranches(client, params),
      ),
    tree: (params: RepositoryTreeRequest) =>
      withGitHubClient(request, env, userId, (client) =>
        readRepositoryTree(client, params),
      ),
    contents: (params: RepositoryContentsRequest) =>
      withGitHubClient(request, env, userId, (client) =>
        readRepositoryContents(client, params),
      ),
  };
}

async function withGitHubClient<T>(
  request: Request,
  env: Env,
  userId: string,
  operation: (client: GitHubAPIClient) => Promise<T>,
): Promise<T> {
  try {
    const auth = await getGitHubClient(request, env);
    if (!auth || auth.userId !== userId) {
      throw new AppServerOperationError(401, "unauthorized", "Unauthorized");
    }
    return await operation(auth.client);
  } catch (error) {
    throw mapRepositoryReadError(error);
  }
}

function mapRepositoryReadError(error: unknown): AppServerOperationError {
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
  if (error instanceof GitHubAPIError) {
    if (error.rateLimited) {
      return new AppServerOperationError(
        429,
        "server_unavailable",
        "GitHub rate limit reached. Please retry.",
        "GITHUB_RATE_LIMITED",
        true,
      );
    }
    return new AppServerOperationError(
      error.status,
      statusCategory(error.status),
      error.message,
      "GITHUB_API_ERROR",
      error.status >= 500 || error.status === 408,
    );
  }
  if (error instanceof ZodError) {
    return new AppServerOperationError(
      502,
      "server_unavailable",
      "GitHub returned an invalid repository response",
      "INVALID_RESPONSE_CONTRACT",
      false,
    );
  }
  return new AppServerOperationError(
    503,
    "server_unavailable",
    "GitHub repository data is unavailable",
    "GITHUB_API_ERROR",
    true,
  );
}

function statusCategory(
  status: number,
):
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "server_unavailable" {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500 || status === 408 || status === 429)
    return "server_unavailable";
  return "invalid_request";
}
