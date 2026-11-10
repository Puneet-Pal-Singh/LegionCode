import {
  createAppServerClient,
  createAppServerHttpTransport,
} from "@legioncode/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptToken,
  GitHubAPIClient,
  GitHubAPIError,
  type Repository,
} from "@legioncode/github-bridge";
import {
  MemoryWorkspaceRepository,
  MemoryTranscriptRepository,
  MemoryRunRepository,
} from "@repo/persistence";
import {
  AppServerResponseSchema,
  APP_SERVER_PROTOCOL_VERSION,
} from "@legioncode/app-server/protocol";
import { AppServerController } from "../../controllers/AppServerController";
import { resolveAuthorizedWorkspaceRepositoryContext } from "../../services/workspaces/AuthorizedWorkspaceRepositoryContext";
import type { Env } from "../../types/ai";

const USER = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_USER = "550e8400-e29b-41d4-a716-446655440002";
const repository: Repository = {
  id: 42,
  name: "repo",
  full_name: "acme/repo",
  owner: { login: "acme", avatar_url: "" },
  description: null,
  private: true,
  html_url: "https://github.com/acme/repo",
  clone_url: "https://github.com/acme/repo.git",
  default_branch: "main",
  stargazers_count: 0,
  language: null,
  updated_at: "2026-10-01T00:00:00.000Z",
};

describe("authenticated hosted workspace selection", () => {
  let env: Env;
  let workspaces: MemoryWorkspaceRepository;
  beforeEach(async () => {
    workspaces = new MemoryWorkspaceRepository();
    env = await createEnv(workspaces, USER);
    vi.spyOn(GitHubAPIClient.prototype, "getRepository").mockResolvedValue(
      repository,
    );
    vi.spyOn(GitHubAPIClient.prototype, "getBranchSha").mockResolvedValue(
      "a".repeat(40),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("retains owned selection and branch through a fresh authenticated read", async () => {
    expect(await command(env, "workspace/list")).toMatchObject({
      ok: true,
      result: { workspaces: [], selection: null },
    });
    const selected = await command(env, "workspace/select", {
      repository: { owner: "acme", name: "repo" },
      selectedBranch: "feature/task",
    });
    expect(selected).toMatchObject({
      ok: true,
      result: {
        selection: {
          selectedBranch: "feature/task",
          repository: { fullName: "acme/repo", providerRepoId: "42" },
        },
      },
    });
    expect(GitHubAPIClient.prototype.getRepository).toHaveBeenCalledWith(
      "acme",
      "repo",
    );
    const reloaded = await command(
      await createEnv(workspaces, USER),
      "workspace/list",
    );
    expect(reloaded).toMatchObject({
      ok: true,
      result: {
        selection: { selectedBranch: "feature/task" },
        workspaces: [
          {
            selected: true,
            workspace: { userId: USER, lastSelectedBranch: "feature/task" },
          },
        ],
      },
    });
    expect(
      await command(await createEnv(workspaces, OTHER_USER), "workspace/list"),
    ).toMatchObject({ ok: true, result: { workspaces: [], selection: null } });
  });

  it("round-trips persisted hosted records through the actual SDK transport", async () => {
    const client = createAppServerClient({
      clientId: "web-fixture",
      clientVersion: "0.1.0",
      transport: createAppServerHttpTransport({
        baseUrl: "https://brain.local",
        credentials: "include",
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Cookie", "legioncode_session=workspace-fixture");
          return AppServerController.request(
            new Request(input, { ...init, headers }),
            env,
          );
        },
      }),
    });
    const selected = await client.selectHostedWorkspace({
      repository: { owner: "acme", name: "repo" },
      selectedBranch: "feature/sdk",
    });
    expect(selected).toMatchObject({
      selectedBranch: "feature/sdk",
      repository: { fullName: "acme/repo" },
    });
    expect(await client.listHostedWorkspaces()).toMatchObject({
      selection: { workspaceId: selected.workspaceId },
      workspaces: [{ workspace: { id: selected.workspaceId, userId: USER } }],
    });
    const params = { workspaceId: selected.workspaceId };
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockClear();
    expect(await client.readHostedWorkspaceConfiguration(params)).toMatchObject(
      {
        ...params,
        name: "acme/repo",
        selectedBranch: "feature/sdk",
        version: 1,
      },
    );
    expect(GitHubAPIClient.prototype.getRepository).not.toHaveBeenCalled();
    for (const [failure, serverCode, statusCode, retryable] of [
      [
        new GitHubAPIError(404, "private-branch-body", false),
        "not_found",
        404,
        false,
      ],
      [
        new GitHubAPIError(403, "private-rate-body", true),
        "server_unavailable",
        429,
        true,
      ],
    ] as const) {
      vi.mocked(GitHubAPIClient.prototype.getBranchSha).mockRejectedValueOnce(
        failure,
      );
      await expect(
        client.updateHostedWorkspaceConfiguration({
          ...params,
          expectedVersion: 1,
          patch: { selectedBranch: "unavailable" },
        }),
      ).rejects.toMatchObject({
        serverCode,
        serverError: { statusCode, retryable },
      });
      expect(
        await client.readHostedWorkspaceConfiguration(params),
      ).toMatchObject({ version: 1, selectedBranch: "feature/sdk" });
    }
    const updated = await client.updateHostedWorkspaceConfiguration({
      ...params,
      expectedVersion: 1,
      patch: {
        name: "Configured project",
        selectedBranch: "feature/configured",
      },
    });
    expect(updated).toMatchObject({
      name: "Configured project",
      selectedBranch: "feature/configured",
      version: 2,
    });
    expect(GitHubAPIClient.prototype.getBranchSha).toHaveBeenCalledWith(
      "acme",
      "repo",
      "feature/configured",
    );
    expect(
      await command(
        await createEnv(workspaces, USER),
        "workspace/configuration/read",
        params,
      ),
    ).toMatchObject({ ok: true, result: updated });
    expect(await client.listHostedWorkspaces()).toMatchObject({
      selection: {
        selectedBranch: "feature/configured",
        workspaceName: "Configured project",
      },
      workspaces: [
        {
          workspace: {
            name: "Configured project",
            lastSelectedBranch: "feature/configured",
          },
        },
      ],
    });
    await expect(
      client.updateHostedWorkspaceConfiguration({
        ...params,
        expectedVersion: 1,
        patch: { name: "stale" },
      }),
    ).rejects.toMatchObject({
      serverCode: "conflict",
      serverError: {
        statusCode: 409,
        operationCode: "WORKSPACE_CONFIGURATION_CONFLICT",
      },
    });
    expect(
      await client.updateHostedWorkspaceConfiguration({
        ...params,
        expectedVersion: 2,
        patch: { name: "Configured project" },
      }),
    ).toEqual(updated);
    await client.selectHostedWorkspace({
      repository: { owner: "acme", name: "repo" },
      selectedBranch: "feature/configured",
    });
    expect(await client.readHostedWorkspaceConfiguration(params)).toMatchObject(
      { name: "Configured project", version: 2 },
    );
    await client.selectHostedWorkspace({
      repository: { owner: "acme", name: "repo" },
      selectedBranch: "feature/reselected",
    });
    expect(await client.readHostedWorkspaceConfiguration(params)).toMatchObject(
      { name: "Configured project", version: 3 },
    );
    await expect(
      client.updateHostedWorkspaceConfiguration({
        ...params,
        expectedVersion: 2,
        patch: { selectedBranch: "feature/configured" },
      }),
    ).rejects.toMatchObject({ serverCode: "conflict" });

    const transcripts = new MemoryTranscriptRepository();
    const runs = new MemoryRunRepository();
    env.AUTH_TRANSCRIPT_REPOSITORY = transcripts;
    env.AUTH_RUN_REPOSITORY = runs;
    const sessionId = "550e8400-e29b-41d4-a716-446655440011";
    const runId = "run_configuration810";
    await transcripts.ensureSession({
      sessionId,
      userId: USER,
      workspaceId: selected.workspaceId,
      repository: "acme/repo",
      activeRunId: runId,
    });
    await runs.ensureRun({
      id: runId,
      userId: USER,
      workspaceId: selected.workspaceId,
      sessionId,
      taskId: sessionId,
      branch: "feature/admitted",
      status: "running",
    });
    const admitted = structuredClone(await runs.getRun(runId, USER));
    await client.updateHostedWorkspaceConfiguration({
      ...params,
      expectedVersion: 3,
      patch: { selectedBranch: "feature/future" },
    });
    expect(
      await client.getSessionWorkspaceContext(sessionId, runId),
    ).toMatchObject({
      selectedBranch: "feature/future",
      runBranch: "feature/admitted",
    });
    const newSessionId = "550e8400-e29b-41d4-a716-446655440012";
    await transcripts.ensureSession({
      sessionId: newSessionId,
      userId: USER,
      workspaceId: selected.workspaceId,
      repository: "acme/repo",
    });
    expect(await client.getSessionWorkspaceContext(newSessionId)).toMatchObject(
      { selectedBranch: "feature/future", runBranch: null },
    );
    expect(
      await resolveAuthorizedWorkspaceRepositoryContext({
        env,
        userId: USER,
        workspaceId: selected.workspaceId,
      }),
    ).toMatchObject({ repositoryBranch: "feature/future" });
    expect(
      await resolveAuthorizedWorkspaceRepositoryContext({
        env,
        userId: USER,
        workspaceId: selected.workspaceId,
        preferredBranch: admitted?.branch,
      }),
    ).toMatchObject({ repositoryBranch: "feature/admitted" });
    expect(await runs.getRun(runId, USER)).toEqual(admitted);

    vi.mocked(GitHubAPIClient.prototype.getRepository).mockResolvedValueOnce({
      ...repository,
      id: 43,
      name: "other",
      full_name: "acme/other",
    });
    const other = await client.selectHostedWorkspace({
      repository: { owner: "acme", name: "other" },
      selectedBranch: "other-branch",
    });
    await client.updateHostedWorkspaceConfiguration({
      ...params,
      expectedVersion: 4,
      patch: { selectedBranch: "unselected-edit" },
    });
    expect(await client.listHostedWorkspaces()).toMatchObject({
      selection: {
        workspaceId: other.workspaceId,
        selectedBranch: "other-branch",
      },
    });
  });

  it("never persists a selection when GitHub denies repository access", async () => {
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockRejectedValue(
      new Error("Repository inaccessible"),
    );
    expect(
      await command(env, "workspace/select", {
        repository: { owner: "acme", name: "repo" },
        selectedBranch: "main",
      }),
    ).toMatchObject({ ok: false, error: { code: "server_unavailable" } });
    expect(await workspaces.listWorkspaces(USER)).toEqual([]);
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockResolvedValue(
      repository,
    );
    const selected = await workspaces.selectWorkspace({
      userId: USER,
      selectedBranch: "main",
      now: new Date().toISOString(),
      repository: {
        provider: "github",
        owner: "acme",
        name: "repo",
        fullName: "acme/repo",
        repoUrl: repository.html_url,
        defaultBranch: "main",
        now: new Date().toISOString(),
      },
    });
    const configParams = {
      workspaceId: selected.workspace.id,
      expectedVersion: 1,
      patch: { name: "unauthorized change" },
    };
    const persist = vi.spyOn(workspaces, "updateWorkspaceConfiguration");
    for (const [failure, code, responseStatus, retryable] of [
      [new GitHubAPIError(401, "private-provider-body", false), "unauthorized", 401, false],
      [new GitHubAPIError(403, "private-provider-body", false), "forbidden", 403, false],
      [new GitHubAPIError(404, "private-provider-body", false), "not_found", 404, false],
      [new GitHubAPIError(422, "private-provider-body", false), "invalid_request", 422, false],
      [new GitHubAPIError(403, "private-provider-body", true), "server_unavailable", 429, true],
      [new GitHubAPIError(429, "private-provider-body", false), "server_unavailable", 429, true],
      [new GitHubAPIError(503, "private-provider-body", false), "server_unavailable", 503, true],
      [new TypeError("private-provider-body: fetch failed"), "server_unavailable", 503, true],
      [new SyntaxError("private-provider-body: invalid JSON"), "server_unavailable", 503, true],
    ] as const) {
      vi.mocked(GitHubAPIClient.prototype.getRepository).mockRejectedValue(failure);
      const denied = await command(
        env,
        "workspace/configuration/update",
        configParams,
      );
      expect(denied).toMatchObject({
        ok: false,
        error: { code, statusCode: responseStatus, retryable },
      });
      if (!(failure instanceof GitHubAPIError)) {
        expect(denied).toMatchObject({ error: {
          message: "GitHub repository validation is temporarily unavailable",
          operationCode: "GITHUB_UNAVAILABLE",
        } });
      }
      expect(JSON.stringify(denied)).not.toContain("private-provider-body");
      expect(persist).not.toHaveBeenCalled();
      expect(
        await workspaces.findWorkspaceConfiguration(
          USER,
          selected.workspace.id,
        ),
      ).toMatchObject({ version: 1, workspace: { name: "acme/repo", lastSelectedBranch: "main" } });
    }
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockResolvedValue(
      repository,
    );
    vi.mocked(GitHubAPIClient.prototype.getBranchSha).mockRejectedValue(
      new GitHubAPIError(404, "private-branch-body", false),
    );
    const missingBranch = await command(env, "workspace/configuration/update", {
      ...configParams,
      patch: { selectedBranch: "missing" },
    });
    expect(missingBranch).toMatchObject({
      ok: false,
      error: {
        code: "not_found",
        statusCode: 404,
        retryable: false,
        operationCode: "GITHUB_RESOURCE_NOT_FOUND",
      },
    });
    expect(JSON.stringify(missingBranch)).not.toContain("private-branch-body");
    expect(persist).not.toHaveBeenCalled();
    expect(
      await workspaces.findWorkspaceConfiguration(USER, selected.workspace.id),
    ).toMatchObject({ version: 1, workspace: { lastSelectedBranch: "main" } });
  });

  it("rejects missing authentication and caller-supplied ownership before writes", async () => {
    const params = {
      repository: { owner: "acme", name: "repo" },
      selectedBranch: "main",
    };
    expect(await command(env, "workspace/select", params, false)).toMatchObject(
      { ok: false, error: { code: "unauthorized" } },
    );
    expect(
      await command(env, "workspace/select", { ...params, userId: OTHER_USER }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(
      await command(env, "workspace/select", { ...params, path: "/tmp/repo" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(GitHubAPIClient.prototype.getRepository).not.toHaveBeenCalled();
    expect(await workspaces.listWorkspaces(USER)).toEqual([]);
    const update = {
      workspaceId: "workspace-foreign",
      expectedVersion: 1,
      patch: { name: "changed" },
    };
    expect(
      await command(env, "workspace/configuration/update", update, false),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    for (const patch of [
      {},
      { script: "echo unsupported" },
      { name: "   " },
      { selectedBranch: "../bad" },
      { selectedBranch: "-option" },
    ]) {
      expect(
        await command(env, "workspace/configuration/update", {
          ...update,
          patch,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(
      await command(env, "workspace/configuration/update", {
        ...update,
        expectedVersion: 1.5,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(
      await command(env, "workspace/configuration/update", {
        ...update,
        userId: OTHER_USER,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await command(env, "workspace/select", params);
    const owned = (await workspaces.listWorkspaces(USER))[0]!;
    vi.mocked(GitHubAPIClient.prototype.getRepository).mockClear();
    const foreignEnv = await createEnv(workspaces, OTHER_USER);
    expect(
      await command(foreignEnv, "workspace/configuration/read", {
        workspaceId: owned.workspace.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await command(foreignEnv, "workspace/configuration/update", {
        ...update,
        workspaceId: owned.workspace.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(GitHubAPIClient.prototype.getRepository).not.toHaveBeenCalled();
    expect(
      await workspaces.findWorkspaceConfiguration(USER, owned.workspace.id),
    ).toMatchObject({ version: 1 });
  });
});

async function command(
  env: Env,
  method:
    | "workspace/list"
    | "workspace/select"
    | "workspace/configuration/read"
    | "workspace/configuration/update",
  params: unknown = {},
  authenticated = true,
) {
  const response = await AppServerController.request(
    new Request("https://brain.local/app-server/request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { Cookie: "legioncode_session=workspace-fixture" }
          : {}),
      },
      body: JSON.stringify({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method,
        params,
      }),
    }),
    env,
  );
  return AppServerResponseSchema.parse(await response.json());
}

async function createEnv(
  workspaces: MemoryWorkspaceRepository,
  userId: string,
): Promise<Env> {
  const encryptedToken = await encryptToken(
    "fixture-github-token",
    "fixture-encryption-key",
  );
  return {
    AUTH_WORKSPACE_REPOSITORY: workspaces,
    GITHUB_TOKEN_ENCRYPTION_KEY: "fixture-encryption-key",
    AUTH_IDENTITY_REPOSITORY: {
      createGitHubSession: async () => {
        throw new Error("not used");
      },
      findSessionByHash: async () => ({
        authSessionId: "550e8400-e29b-41d4-a716-446655440003",
        userId,
        login: "fixture",
        avatar: "",
        email: null,
        name: null,
        githubScopes: ["repo"],
        encryptedToken,
        createdAt: Date.now(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      findLatestGitHubSessionByUserId: async () => null,
      revokeSession: async () => undefined,
    },
  } as Env;
}
