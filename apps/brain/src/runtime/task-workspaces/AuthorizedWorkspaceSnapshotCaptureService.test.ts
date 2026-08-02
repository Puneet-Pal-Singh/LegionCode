import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, GitHubAPIClient } from "@shadowbox/github-bridge";
import { getUserSessionByUserId } from "../../services/AuthService";
import type { Env } from "../../types/ai";
import { AuthorizedWorkspaceSnapshotCaptureService } from "./AuthorizedWorkspaceSnapshotCaptureService";

vi.mock("@shadowbox/github-bridge", () => ({
  decryptToken: vi.fn(async () => "github-token"),
  GitHubAPIClient: vi.fn(),
}));
vi.mock("../../services/AuthService", () => ({
  getUserSessionByUserId: vi.fn(),
}));

describe("AuthorizedWorkspaceSnapshotCaptureService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserSessionByUserId).mockResolvedValue({
      userId: "github-user-1",
      login: "launch-user",
      name: "Launch User",
      email: null,
      avatarUrl: null,
      encryptedToken: {
        version: 1,
        ciphertext: "encrypted",
        iv: "initialization-vector",
      },
      githubScopes: "repo",
      expiresAt: null,
      createdAt: new Date("2026-07-18T12:00:00.000Z"),
      updatedAt: new Date("2026-07-18T12:00:00.000Z"),
    });
  });

  it("uses the authenticated repository owner to capture immutable commit and tree ids", async () => {
    const getRepository = vi.fn(async () => ({
      id: 123,
      name: "LegionCode",
      full_name: "Canonical-Owner/LegionCode",
      owner: { login: "Canonical-Owner", avatar_url: "" },
      description: null,
      private: true,
      html_url: "https://github.com/Canonical-Owner/LegionCode",
      clone_url: "https://github.com/Canonical-Owner/LegionCode.git",
      default_branch: "dev",
      stargazers_count: 0,
      language: null,
      updated_at: "2026-07-18T12:00:00.000Z",
    }));
    const getBranchSha = vi.fn(async () => "a".repeat(40));
    const getCommit = vi.fn(async () => ({
      sha: "a".repeat(40),
      tree: { sha: "b".repeat(40), url: "https://api.github.test/tree" },
    }));
    vi.mocked(GitHubAPIClient).mockImplementation(
      () =>
        ({
          getRepository,
          getBranchSha,
          getCommit,
        }) as unknown as GitHubAPIClient,
    );

    const snapshot = await new AuthorizedWorkspaceSnapshotCaptureService({
      GITHUB_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    } as Env).capture({
      userId: "github-user-1",
      workspaceId: "workspace-1",
      repository: {
        owner: "user-supplied-owner",
        repo: "LegionCode",
        branch: "dev",
      },
      correlationId: "corr-capture",
    });

    expect(decryptToken).toHaveBeenCalledOnce();
    expect(getBranchSha).toHaveBeenCalledWith(
      "Canonical-Owner",
      "LegionCode",
      "dev",
    );
    expect(getCommit).toHaveBeenCalledWith(
      "Canonical-Owner",
      "LegionCode",
      "a".repeat(40),
    );
    expect(snapshot).toMatchObject({
      workspaceId: "wrk_workspace-1",
      repository: {
        owner: "Canonical-Owner",
        name: "LegionCode",
      },
      authorizedCommitId: "a".repeat(40),
      authorizedTreeId: "b".repeat(40),
      provenance: {
        kind: "authorized_repository",
        requestedRef: "dev",
        resolvedRef: "refs/heads/dev",
        authorizedByUserId: "usr_github-user-1",
      },
    });
  });

  it("fails closed when no authenticated repository session exists", async () => {
    vi.mocked(getUserSessionByUserId).mockResolvedValue(null);

    await expect(
      new AuthorizedWorkspaceSnapshotCaptureService({} as Env).capture({
        userId: "github-user-1",
        workspaceId: "workspace-1",
        repository: { owner: "owner", repo: "repo", branch: "dev" },
        correlationId: "corr-auth",
      }),
    ).rejects.toMatchObject({
      code: "TASK_SNAPSHOT_AUTH_REQUIRED",
      status: 401,
    });
    expect(GitHubAPIClient).not.toHaveBeenCalled();
  });
});
