import { decryptToken, GitHubAPIClient } from "@shadowbox/github-bridge";
import {
  WorkspaceSnapshotSchema,
  createWorkspaceSnapshotId,
  userIdFromExternalId,
  workspaceIdFromExternalId,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import { DomainError } from "../../domain/errors";
import { getUserSessionByUserId } from "../../services/AuthService";
import type { Env } from "../../types/ai";

export interface AuthorizedRepositorySelection {
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  readonly baseUrl?: string;
}

export interface WorkspaceSnapshotCaptureInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly repository: AuthorizedRepositorySelection;
  readonly correlationId: string;
}

export interface WorkspaceSnapshotCapturePort {
  capture(input: WorkspaceSnapshotCaptureInput): Promise<WorkspaceSnapshot>;
}

/**
 * Resolves an authenticated repository selection to an immutable Git commit
 * and tree. The caller-provided branch is advisory only; GitHub and the user's
 * OAuth session are the authority for repository access and resolution.
 */
export class AuthorizedWorkspaceSnapshotCaptureService implements WorkspaceSnapshotCapturePort {
  constructor(private readonly env: Env) {}

  async capture(
    input: WorkspaceSnapshotCaptureInput,
  ): Promise<WorkspaceSnapshot> {
    assertGitHubRepositorySelection(input.repository, input.correlationId);
    const session = await getUserSessionByUserId(this.env, input.userId);
    if (!session) {
      throw new DomainError(
        "TASK_SNAPSHOT_AUTH_REQUIRED",
        "Reconnect GitHub before starting an isolated cloud task.",
        401,
        false,
        input.correlationId,
      );
    }

    let client: GitHubAPIClient;
    try {
      const token = await decryptToken(
        session.encryptedToken,
        this.env.GITHUB_TOKEN_ENCRYPTION_KEY,
      );
      client = new GitHubAPIClient(token);
    } catch {
      throw new DomainError(
        "TASK_SNAPSHOT_AUTH_INVALID",
        "GitHub authorization could not be used to capture this task workspace. Reconnect GitHub and retry.",
        401,
        false,
        input.correlationId,
      );
    }

    try {
      const repository = await client.getRepository(
        input.repository.owner,
        input.repository.repo,
      );
      const requestedRef =
        input.repository.branch?.trim() || repository.default_branch;
      const commitId = await client.getBranchSha(
        repository.owner.login,
        repository.name,
        requestedRef,
      );
      const commit = await client.getCommit(
        repository.owner.login,
        repository.name,
        commitId,
      );
      const workspaceId = workspaceIdFromExternalId(input.workspaceId);
      const authorizedByUserId = userIdFromExternalId(input.userId);
      const resolvedRef = `refs/heads/${requestedRef}`;
      const repositoryIdentity = {
        provider: "github" as const,
        owner: repository.owner.login,
        name: repository.name,
        canonicalUrl: repository.html_url,
      };
      const capturedAt = new Date().toISOString();

      return WorkspaceSnapshotSchema.parse({
        kind: "workspace_snapshot",
        snapshotId: createWorkspaceSnapshotId(),
        workspaceId,
        repository: repositoryIdentity,
        authorizedCommitId: commit.sha,
        authorizedTreeId: commit.tree.sha,
        manifestDigest: await sha256Canonical({
          version: 1,
          workspaceId,
          repository: repositoryIdentity,
          commitId: commit.sha,
          treeId: commit.tree.sha,
        }),
        configDigest: await sha256Canonical({
          version: 1,
          source: "repository_selection",
          requestedRef,
          resolvedRef,
        }),
        capturedAt,
        provenance: {
          kind: "authorized_repository",
          requestedRef,
          resolvedRef,
          authorizedByUserId,
          authorizationContextDigest: await sha256Canonical({
            version: 1,
            subject: authorizedByUserId,
            repositoryId: repository.id,
            repository: repository.full_name,
            private: repository.private,
          }),
        },
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "TASK_SNAPSHOT_RESOLUTION_FAILED",
        "The selected repository and branch could not be resolved to an authorized immutable commit.",
        409,
        true,
        input.correlationId,
      );
    }
  }
}

function assertGitHubRepositorySelection(
  repository: AuthorizedRepositorySelection,
  correlationId: string,
): void {
  const baseUrl = repository.baseUrl?.trim();
  if (
    !repository.owner.trim() ||
    !repository.repo.trim() ||
    (baseUrl && !/^https:\/\/(?:www\.)?github\.com(?:\/|$)/iu.test(baseUrl))
  ) {
    throw new DomainError(
      "TASK_SNAPSHOT_REPOSITORY_UNSUPPORTED",
      "Select an authorized GitHub repository before starting this cloud task.",
      428,
      false,
      correlationId,
    );
  }
}

async function sha256Canonical(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify(sortCanonical(value)),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonical(child)]),
  );
}
