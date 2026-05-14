import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAPIClient, decryptToken } from "@shadowbox/github-bridge";
import { ExecutionService } from "./ExecutionService";
import type { Env } from "../types/ai";
import { GIT_STATUS_TIMEOUT_MS } from "./gitExecutionTimeouts";

vi.mock("@shadowbox/github-bridge", () => ({
  decryptToken: vi.fn(async (value: string) => `token:${value}`),
  GitHubAPIClient: vi.fn().mockImplementation(() => ({
    getRepository: vi.fn(async () => ({ default_branch: "main" })),
    createPullRequest: vi.fn(async () => ({
      number: 42,
      html_url: "https://github.com/acme/career-crew/pull/42",
    })),
  })),
}));

describe("ExecutionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a secure session once and executes canonical task requests", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-1",
            token: "tok-1",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-1",
            status: "success",
            output: "file contents",
            metrics: { duration: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-2",
            status: "success",
            output: "second call",
            metrics: { duration: 9 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-123",
      "run-456",
    );

    const first = await service.execute("filesystem", "read_file", {
      path: "src/index.ts",
    });
    const second = await service.execute("node", "run", {
      command: "pnpm test",
    });

    expect(first).toEqual({ success: true, output: "file contents" });
    expect(second).toEqual({ success: true, output: "second call" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0]!;
    expect(sessionUrl).toBe(
      "http://internal/api/v1/session?session=session-123",
    );
    expect(sessionInit?.method).toBe("POST");
    expect(JSON.parse(String(sessionInit?.body))).toMatchObject({
      runId: "run-456",
      taskId: "brain-session-session-123",
      repoPath: ".",
    });

    const [executeUrl, executeInit] = fetchMock.mock.calls[1]!;
    expect(executeUrl).toBe(
      "http://internal/api/v1/execute?session=session-123",
    );
    expect(executeInit?.headers).toMatchObject({
      Authorization: "Bearer tok-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      sessionId: "sess-1",
      action: "filesystem.execute",
      params: {
        action: "read_file",
        runId: "run-456",
        path: "src/index.ts",
      },
      timeout: 120000,
    });
  });

  it("maps task failures back into the legacy execution shape", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-2",
            token: "tok-2",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-fail",
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message: "command failed",
            },
            metrics: { duration: 12 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-abc",
      "run-def",
    );

    await expect(
      service.execute("node", "run", { command: "pnpm lint" }),
    ).resolves.toEqual({
      success: false,
      error: "command failed",
    });
  });

  it("normalizes git actions before sending execute payloads", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-git",
            token: "tok-git",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-git",
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-git",
      "run-git",
    );

    await service.execute("git", "status", {});

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "git.execute",
      params: {
        action: "git_status",
        runId: "run-git",
      },
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
  });

  it("hydrates runtime git commit payloads with stored commit identity", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-commit",
            token: "tok-commit",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-commit",
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-123"),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-123"
              ? JSON.stringify({
                  userId: "user-123",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
      } as unknown as Env,
      "session-commit",
      "run-commit",
      "user-123",
    );

    await service.execute("git", "git_commit", {
      message: "feat: add floating carousels to hero section",
    });

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "git.execute",
      params: {
        action: "git_commit",
        runId: "run-commit",
        message: "feat: add floating carousels to hero section",
        authorName: "Puneet Pal Singh",
        authorEmail: "puneet@example.com",
      },
    });
  });

  it("overrides model-provided git commit identity with OAuth session identity", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-commit-oauth",
            token: "tok-commit-oauth",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-commit-oauth",
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-commit-oauth"),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-commit-oauth"
              ? JSON.stringify({
                  userId: "user-commit-oauth",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
      } as unknown as Env,
      "session-commit-oauth",
      "run-commit-oauth",
      "user-commit-oauth",
    );

    await service.execute("git", "git_commit", {
      message: "feat: add coming soon indicator to newsletter",
      authorName: "Shubh",
      authorEmail: "shubh@example.com",
    });

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "git.execute",
      params: {
        action: "git_commit",
        runId: "run-commit-oauth",
        message: "feat: add coming soon indicator to newsletter",
        authorName: "Puneet Pal Singh",
        authorEmail: "puneet@example.com",
      },
    });
  });

  it("injects GitHub token for github connector actions without commit identity fields", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-github",
            token: "tok-github",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-github",
            status: "success",
            output: '{"number":228}',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-456"),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-456"
              ? JSON.stringify({
                  userId: "user-456",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
      } as unknown as Env,
      "session-github",
      "run-github",
      "user-456",
    );

    await service.execute("github", "pr_get", {
      owner: "acme",
      repo: "career-crew",
      number: 228,
    });

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "github.execute",
      params: {
        action: "pr_get",
        runId: "run-github",
        owner: "acme",
        repo: "career-crew",
        number: 228,
        token: "token:encrypted-token",
      },
    });

    expect(JSON.parse(String(executeInit?.body))).not.toMatchObject({
      params: {
        authorName: expect.any(String),
        authorEmail: expect.any(String),
      },
    });
  });

  it("injects GitHub token for bounded github_cli actions", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-github-cli",
            token: "tok-github-cli",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-github-cli",
            status: "success",
            output: '{"actionsJobId":1234}',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-789"),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-789"
              ? JSON.stringify({
                  userId: "user-789",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
      } as unknown as Env,
      "session-github-cli",
      "run-github-cli",
      "user-789",
    );

    await service.execute("github_cli", "actions_job_logs_get", {
      owner: "acme",
      repo: "career-crew",
      actionsJobId: 1234,
    });

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "github_cli.execute",
      params: {
        action: "actions_job_logs_get",
        runId: "run-github-cli",
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 1234,
        token: "token:encrypted-token",
      },
    });
  });

  it("fails fast on persisted missing-scope boundary for GitHub Actions logs", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-790", [
          "read:user",
          "user:email",
        ]),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-790"
              ? JSON.stringify({
                  userId: "user-790",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  githubScopes: ["read:user", "user:email"],
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
      } as unknown as Env,
      "session-github-cli-scope",
      "run-github-cli-scope",
      "user-790",
    );

    await expect(
      service.execute("github_cli", "actions_job_logs_get", {
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 1234,
      }),
    ).rejects.toThrow("Missing GitHub OAuth scope");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("does not allow payload to override canonical action or runId", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-node",
            token: "tok-node",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-node",
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-node",
      "run-owned-by-service",
    );

    await service.execute("node", "run", {
      action: "write_file",
      runId: "run-from-caller",
      command: "echo hi",
    });

    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "node.execute",
      params: {
        action: "run",
        runId: "run-owned-by-service",
        command: "echo hi",
      },
    });
  });

  it("filters streamed log polling by task id", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123456789);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    let logPollCount = 0;
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >(async (url) => {
      const value = String(url);

      if (value.startsWith("http://internal/api/v1/session")) {
        return new Response(
          JSON.stringify({
            sessionId: "sess-stream",
            token: "tok-stream",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }

      if (value.startsWith("http://internal/api/v1/logs")) {
        const parsed = new URL(value);
        const taskId = parsed.searchParams.get("taskId");
        expect(taskId).toMatch(/^filesystem-read_file-123456789-/);
        logPollCount += 1;
        const body =
          logPollCount >= 2
            ? `data: ${JSON.stringify({ taskId, timestamp: 2, level: "info", message: "chunk", source: "stdout" })}\n\n`
            : "";
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return new Response(
        JSON.stringify({
          taskId: "filesystem-read_file-task",
          status: "success",
          output: "done",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-stream",
      "run-stream",
    );

    const chunks: Array<{ message: string; source?: "stdout" | "stderr" }> = [];
    await service.execute(
      "filesystem",
      "read_file",
      { path: "src/index.ts" },
      {
        onOutput: async (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(chunks).toEqual([
      { message: "chunk", source: "stdout", timestamp: 2 },
    ]);
    nowSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("logs structured execution failures with plugin and action context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-failure",
            token: "tok-failure",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-failure",
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message: "Git commit author is not configured.",
              details: { stderr: "fatal: empty ident name" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-failure",
      "run-failure",
    );

    await expect(
      service.execute("git", "git_commit", { message: "feat: add hero" }),
    ).resolves.toEqual({
      success: false,
      error: "Git commit author is not configured.",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "[ExecutionService] git:git_commit failed",
      expect.objectContaining({
        status: "failure",
        errorCode: "PLUGIN_EXECUTION_FAILED",
        errorMessage: "Git commit author is not configured.",
      }),
    );

    errorSpy.mockRestore();
  });

  it("does not emit error logs for expected git status bootstrap misses", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-status",
            token: "tok-status",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message:
                "fatal: not a git repository (or any of the parent directories): .git",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-status",
      "run-status",
    );

    await expect(service.execute("git", "git_status", {})).resolves.toEqual({
      success: false,
      error:
        "fatal: not a git repository (or any of the parent directories): .git",
    });

    expect(errorSpy).not.toHaveBeenCalledWith(
      "[ExecutionService] git:git_status failed",
      expect.anything(),
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[ExecutionService] git:git_status expected bootstrap miss",
      expect.objectContaining({
        status: "failure",
        errorCode: "PLUGIN_EXECUTION_FAILED",
      }),
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("downgrades transient local-dev-session git status errors to non-error logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock.mockResolvedValueOnce(
      new Response(
        'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
        { status: 503, headers: { "Content-Type": "text/plain" } },
      ),
    );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
      } as unknown as Env,
      "session-status-local-dev",
      "run-status-local-dev",
    );

    await expect(service.execute("git", "git_status", {})).rejects.toThrow(
      /Couldn't find a local dev session/i,
    );

    expect(errorSpy).not.toHaveBeenCalledWith(
      "[ExecutionService] Error:",
      expect.anything(),
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[ExecutionService] git:git_status transient startup miss",
      expect.objectContaining({
        errorMessage: expect.stringMatching(
          /Couldn't find a local dev session/i,
        ),
      }),
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("creates pull requests through the dedicated GitHub-backed execution path", async () => {
    vi.mocked(decryptToken).mockResolvedValue("github-token");
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-pr",
            token: "tok-pr",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            status: "success",
            output: JSON.stringify({
              gitAvailable: true,
              branch: "feat/floating-hero-carousels",
              ahead: 1,
              behind: 0,
              files: [],
              hasStaged: false,
              hasUnstaged: false,
              repoIdentity: "github.com/acme/career-crew",
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-pr"),
        SESSIONS: {
          get: vi.fn(async (key: string) =>
            key === "user_session:user-pr"
              ? JSON.stringify({
                  userId: "user-pr",
                  login: "puneet",
                  avatar: "",
                  email: "puneet@example.com",
                  name: "Puneet Pal Singh",
                  encryptedToken: "encrypted-token",
                  createdAt: Date.now(),
                })
              : null,
          ),
        },
        GITHUB_TOKEN_ENCRYPTION_KEY: "test-key",
      } as unknown as Env,
      "session-pr",
      "run-pr",
      "user-pr",
    );

    const result = await service.execute("git", "git_create_pull_request", {
      owner: "acme",
      repo: "career-crew",
      title: "feat: add floating carousels to hero section",
      body: "Adds the floating carousel hero treatment.",
    });

    expect(result).toEqual({
      success: true,
      output:
        "Created pull request #42: https://github.com/acme/career-crew/pull/42",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, executeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "git.execute",
      params: {
        action: "git_status",
        runId: "run-pr",
        token: "github-token",
      },
    });

    expect(GitHubAPIClient).toHaveBeenCalledWith("github-token");
    const clientInstance = vi.mocked(GitHubAPIClient).mock.results[0]
      ?.value as {
      getRepository: ReturnType<typeof vi.fn>;
      createPullRequest: ReturnType<typeof vi.fn>;
    };
    expect(clientInstance.getRepository).toHaveBeenCalledWith(
      "acme",
      "career-crew",
    );
    expect(clientInstance.createPullRequest).toHaveBeenCalledWith(
      "acme",
      "career-crew",
      {
        title: "feat: add floating carousels to hero section",
        body: "Adds the floating carousel hero treatment.",
        head: "feat/floating-hero-carousels",
        base: "main",
      },
    );
  });

  it("normalizes malformed git status output during pull request creation", async () => {
    vi.mocked(decryptToken).mockResolvedValue("github-token");
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-pr",
            token: "tok-pr",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            status: "success",
            output: "not-json",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        AUTH_IDENTITY_REPOSITORY: createIdentityRepository("user-pr"),
        SESSIONS: {
          get: vi.fn(async () =>
            JSON.stringify({
              userId: "user-pr",
              login: "puneet",
              avatar: "",
              email: "puneet@example.com",
              name: "Puneet Pal Singh",
              encryptedToken: "encrypted-token",
              createdAt: Date.now(),
            }),
          ),
        },
        GITHUB_TOKEN_ENCRYPTION_KEY: "test-key",
      } as unknown as Env,
      "session-pr",
      "run-pr",
      "user-pr",
    );

    await expect(
      service.execute("git", "git_create_pull_request", {
        owner: "acme",
        repo: "career-crew",
        title: "feat: add floating carousels to hero section",
      }),
    ).resolves.toEqual({
      success: false,
      error:
        "Git status did not return a valid workspace state for pull request creation.",
    });
  });
});

function createIdentityRepository(userId: string, githubScopes = ["repo"]) {
  const record = {
    authSessionId: "session-1",
    userId,
    login: "puneet",
    avatar: "",
    email: "puneet@example.com",
    name: "Puneet Pal Singh",
    githubScopes,
    encryptedToken: "encrypted-token",
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  return {
    createGitHubSession: async () => {
      throw new Error("not used");
    },
    findSessionByHash: async () => record,
    findLatestGitHubSessionByUserId: async () => record,
    revokeSession: async () => undefined,
  };
}
