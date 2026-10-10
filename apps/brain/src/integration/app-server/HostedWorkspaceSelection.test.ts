import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken, GitHubAPIClient, type Repository } from "@legioncode/github-bridge";
import { MemoryWorkspaceRepository } from "@repo/persistence";
import { AppServerResponseSchema, APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { AppServerController } from "../../controllers/AppServerController";
import type { Env } from "../../types/ai";

const USER = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_USER = "550e8400-e29b-41d4-a716-446655440002";
const repository: Repository = {
  id: 42, name: "repo", full_name: "acme/repo", owner: { login: "acme", avatar_url: "" },
  description: null, private: true, html_url: "https://github.com/acme/repo",
  clone_url: "https://github.com/acme/repo.git", default_branch: "main",
  stargazers_count: 0, language: null, updated_at: "2026-10-01T00:00:00.000Z",
};

describe("authenticated hosted workspace selection", () => {
  let env: Env;
  let workspaces: MemoryWorkspaceRepository;
  beforeEach(async () => {
    workspaces = new MemoryWorkspaceRepository();
    env = await createEnv(workspaces, USER);
    vi.spyOn(GitHubAPIClient.prototype, "getRepository").mockResolvedValue(repository);
  });
  afterEach(() => vi.restoreAllMocks());

  it("retains owned selection and branch through a fresh authenticated read", async () => {
    expect(await command(env, "workspace/list")).toMatchObject({ ok: true, result: { workspaces: [], selection: null } });
    const selected = await command(env, "workspace/select", { repository: { owner: "acme", name: "repo" }, selectedBranch: "feature/task" });
    expect(selected).toMatchObject({ ok: true, result: { selection: { selectedBranch: "feature/task", repository: { fullName: "acme/repo", providerRepoId: "42" } } } });
    expect(GitHubAPIClient.prototype.getRepository).toHaveBeenCalledWith("acme", "repo");
    const reloaded = await command(await createEnv(workspaces, USER), "workspace/list");
    expect(reloaded).toMatchObject({ ok: true, result: { selection: { selectedBranch: "feature/task" }, workspaces: [{ selected: true, workspace: { userId: USER, lastSelectedBranch: "feature/task" } }] } });
    expect(await command(await createEnv(workspaces, OTHER_USER), "workspace/list")).toMatchObject({ ok: true, result: { workspaces: [], selection: null } });
  });

  it("never persists a selection when GitHub denies repository access", async () => {
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockRejectedValue(new Error("Repository inaccessible"));
    expect(await command(env, "workspace/select", { repository: { owner: "acme", name: "repo" }, selectedBranch: "main" })).toMatchObject({ ok: false, error: { code: "server_unavailable" } });
    expect(await workspaces.listWorkspaces(USER)).toEqual([]);
  });

  it("rejects missing authentication and caller-supplied ownership before writes", async () => {
    const params = { repository: { owner: "acme", name: "repo" }, selectedBranch: "main" };
    expect(await command(env, "workspace/select", params, false)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await command(env, "workspace/select", { ...params, userId: OTHER_USER })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await command(env, "workspace/select", { ...params, path: "/tmp/repo" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(GitHubAPIClient.prototype.getRepository).not.toHaveBeenCalled();
    expect(await workspaces.listWorkspaces(USER)).toEqual([]);
  });
});

async function command(env: Env, method: "workspace/list" | "workspace/select", params: unknown = {}, authenticated = true) {
  const response = await AppServerController.request(new Request("https://brain.local/app-server/request", {
    method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { Cookie: "legioncode_session=workspace-fixture" } : {}) },
    body: JSON.stringify({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, method, params }),
  }), env);
  return AppServerResponseSchema.parse(await response.json());
}

async function createEnv(workspaces: MemoryWorkspaceRepository, userId: string): Promise<Env> {
  const encryptedToken = await encryptToken("fixture-github-token", "fixture-encryption-key");
  return {
    AUTH_WORKSPACE_REPOSITORY: workspaces,
    GITHUB_TOKEN_ENCRYPTION_KEY: "fixture-encryption-key",
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => { throw new Error("not used"); },
      findSessionByHash: async () => ({
        authSessionId: "550e8400-e29b-41d4-a716-446655440003", userId,
        login: "fixture", avatar: "", email: null, name: null, githubScopes: ["repo"],
        encryptedToken, createdAt: Date.now(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      findLatestGitHubSessionByUserId: async () => null,
      revokeSession: async () => undefined,
    },
  } as Env;
}
