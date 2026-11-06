import {
  GitHubAPIError,
  type GitHubAPIClient,
} from "@legioncode/github-bridge";
import {
  RepositoryBranchesRequestSchema,
  RepositoryBranchesResponseSchema,
  RepositoryContentsRequestSchema,
  RepositoryContentsResultSchema,
  RepositoryListRequestSchema,
  RepositoryListResponseSchema,
  RepositoryTreeRequestSchema,
  RepositoryTreeResponseSchema,
} from "@repo/platform-protocol";

type RepositoryReadClient = Pick<
  GitHubAPIClient,
  | "listRepositories"
  | "listBranches"
  | "getTree"
  | "getRepository"
  | "getContents"
>;

export async function listRepositories(
  client: RepositoryReadClient,
  input: unknown,
) {
  const query = RepositoryListRequestSchema.parse(input);
  const repositories = await client.listRepositories(
    query.type ?? "all",
    query.sort ?? "updated",
    query.perPage ?? 30,
  );
  return RepositoryListResponseSchema.parse({ repositories });
}

export async function listRepositoryBranches(
  client: RepositoryReadClient,
  input: unknown,
) {
  const query = RepositoryBranchesRequestSchema.parse(input);
  const branches = await client.listBranches(
    query.owner,
    query.repo,
    query.perPage,
  );
  return RepositoryBranchesResponseSchema.parse({ branches });
}

export async function readRepositoryTree(
  client: RepositoryReadClient,
  input: unknown,
) {
  const query = RepositoryTreeRequestSchema.parse(input);
  const tree = await getTreeWithDefaultBranchFallback(
    client,
    query.owner,
    query.repo,
    query.sha ?? "HEAD",
  );
  return RepositoryTreeResponseSchema.parse(tree);
}

export async function readRepositoryContents(
  client: RepositoryReadClient,
  input: unknown,
) {
  const query = RepositoryContentsRequestSchema.parse(input);
  const contents = await client.getContents(
    query.owner,
    query.repo,
    query.path || "",
    query.ref || undefined,
  );
  return RepositoryContentsResultSchema.parse({ contents });
}

type TreeResult = {
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
  requestedRefUnavailable?: boolean;
  resolvedRef?: string;
};

async function getTreeWithDefaultBranchFallback(
  client: Pick<GitHubAPIClient, "getTree" | "getRepository">,
  owner: string,
  repo: string,
  sha: string,
): Promise<TreeResult> {
  try {
    return { tree: await client.getTree(owner, repo, sha) };
  } catch (error) {
    if (!isGitHubApiStatus(error, 404)) {
      throw error;
    }

    const repository = await client.getRepository(owner, repo);
    const defaultBranch = repository.default_branch;
    if (!defaultBranch || defaultBranch === sha) {
      throw error;
    }

    console.warn("[GitHub] Tree ref unavailable; using default branch tree:", {
      owner,
      repo,
      sha,
      defaultBranch,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      tree: await client.getTree(owner, repo, defaultBranch),
      requestedRefUnavailable: true,
      resolvedRef: defaultBranch,
    };
  }
}

function isGitHubApiStatus(error: unknown, status: number): boolean {
  return error instanceof GitHubAPIError && error.status === status;
}
