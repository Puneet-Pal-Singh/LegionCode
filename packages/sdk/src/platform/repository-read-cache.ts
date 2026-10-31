import type {
  RepositoryBranchesRequest,
  RepositoryBranchesResponse,
  RepositoryTreeRequest,
  RepositoryTreeResponse,
} from "@repo/platform-protocol";
import type { AppServerClient } from "./app-server-client.js";

const REQUEST_CACHE_TTL_MS = 15_000;

export class RepositoryReadAccountChangedError extends Error {
  constructor() {
    super("The authenticated account changed while loading repository data.");
    this.name = "RepositoryReadAccountChangedError";
  }
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

class RepositoryReadCache {
  private accountId: string | null | undefined;
  private generation = 0;
  private readonly branches = new Map<
    string,
    CacheEntry<RepositoryBranchesResponse>
  >();
  private readonly branchesInFlight = new Map<
    string,
    Promise<RepositoryBranchesResponse>
  >();
  private readonly trees = new Map<string, CacheEntry<RepositoryTreeResponse>>();
  private readonly treesInFlight = new Map<
    string,
    Promise<RepositoryTreeResponse>
  >();

  listBranches(
    client: AppServerClient,
    accountId: string | null,
    request: RepositoryBranchesRequest,
  ): Promise<RepositoryBranchesResponse> {
    const generation = this.selectAccount(accountId);
    const key = JSON.stringify([accountId, request.owner, request.repo]);
    return this.read(
      accountId,
      generation,
      this.branches,
      this.branchesInFlight,
      key,
      () => client.listRepositoryBranches(request),
    );
  }

  getTree(
    client: AppServerClient,
    accountId: string | null,
    request: RepositoryTreeRequest,
  ): Promise<RepositoryTreeResponse> {
    const normalizedRequest = { ...request, sha: request.sha ?? "HEAD" };
    const generation = this.selectAccount(accountId);
    const key = JSON.stringify([
      accountId,
      request.owner,
      request.repo,
      normalizedRequest.sha,
    ]);
    return this.read(
      accountId,
      generation,
      this.trees,
      this.treesInFlight,
      key,
      () => client.getRepositoryTree(normalizedRequest),
    );
  }

  private selectAccount(accountId: string | null): number {
    if (this.accountId !== accountId) {
      this.accountId = accountId;
      this.generation += 1;
      this.branches.clear();
      this.branchesInFlight.clear();
      this.trees.clear();
      this.treesInFlight.clear();
    }
    return this.generation;
  }

  private read<T>(
    accountId: string | null,
    generation: number,
    cache: Map<string, CacheEntry<T>>,
    inFlight: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    if (accountId === null) {
      return load().then((value) => {
        if (generation !== this.generation || accountId !== this.accountId) {
          throw new RepositoryReadAccountChangedError();
        }
        return value;
      });
    }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp <= REQUEST_CACHE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    if (cached) cache.delete(key);

    const existing = inFlight.get(key);
    if (existing) return existing;

    const request = load()
      .then((value) => {
        if (generation !== this.generation || accountId !== this.accountId) {
          throw new RepositoryReadAccountChangedError();
        }
        cache.set(key, { value, timestamp: Date.now() });
        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  }
}

const repositoryReadCache = new RepositoryReadCache();

export function listRepositoryBranches(
  client: AppServerClient,
  accountId: string | null,
  request: RepositoryBranchesRequest,
): Promise<RepositoryBranchesResponse> {
  return repositoryReadCache.listBranches(client, accountId, request);
}

export function getRepositoryTree(
  client: AppServerClient,
  accountId: string | null,
  request: RepositoryTreeRequest,
): Promise<RepositoryTreeResponse> {
  return repositoryReadCache.getTree(client, accountId, request);
}
