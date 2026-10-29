import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitController, type OwnedGitExecution } from "./GitController";
import type { Env } from "../types/ai";
import { GIT_STATUS_TIMEOUT_MS } from "../services/gitExecutionTimeouts";

describe("GitController", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes git status through a run-scoped canonical session", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "git-status-task",
            status: "success",
            output: JSON.stringify({
              files: [],
              ahead: 0,
              behind: 0,
              branch: "main",
              hasStaged: false,
              hasUnstaged: false,
              gitAvailable: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.getStatus(
      new Request(
        "https://brain.local/api/git/status?runId=run_git_01&sessionId=session-1",
      ),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_git_01"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      branch: "main",
      gitAvailable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [executeUrl, executeInit] = fetchMock.mock.calls[0]!;
    expect(executeUrl).toBe(
      "http://internal/api/v1/execute?session=session-1",
    );
    expect(executeInit?.headers).toMatchObject({
      Authorization: "Bearer tok-git-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      sessionId: "sess-git-1",
      action: "git.execute",
      borrowedLease: {
        leaseId: "lease_git_test",
        sandboxId: "sandbox_git_test",
        generation: 2,
      },
      params: {
        action: "git_status",
        runId: "run_git_01",
        workspaceScope: {
          runId: "run_git_01",
          threadId: "thr_git_test",
          turnId: "trn_git_test",
          runAttemptId: "attempt_git_test",
          workspaceId: "wrk_00000000-0000-0000-0000-000000000001",
          root: "/home/sandbox/checkouts/checkout_run_git_01",
        },
      },
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
  });

  it("maps the unstage API operation to canonical git_unstage execution", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "git-unstage-task",
            status: "success",
            output: "Files unstaged",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.stageFiles(
      new Request("https://brain.local/api/git/stage", {
        method: "POST",
        body: JSON.stringify({
          runId: "run_unstage",
          files: ["src/app.ts"],
          unstage: true,
        }),
      }),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_unstage"),
    );

    expect(response.status).toBe(200);
    const executeInit = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      action: "git.execute",
      params: {
        action: "git_unstage",
        runId: "run_unstage",
        files: ["src/app.ts"],
      },
    });
  });

  it("maps git contract failures to a typed controller error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "Validation failed: action invalid enum value, received 'git.execute'",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.getStatus(
      new Request("https://brain.local/api/git/status?runId=run_git_01"),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_git_01"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GIT_EXECUTION_CONTRACT_ERROR",
      retryable: true,
    });
  });

  it("returns an empty diff while workspace bootstrap is still preparing git", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "git-diff-task",
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message: "fatal: not a git repository",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.getDiff(
      new Request(
        "https://brain.local/api/git/diff?runId=run_git_01&sessionId=session-1&path=src%2Fmain.ts",
      ),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_git_01"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      oldPath: "",
      newPath: "",
      hunks: [],
    });
  });

  it("retries transient git status failures and eventually succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "SandboxError: HTTP error! status: 500",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "git-status-task-retry",
            status: "success",
            output: JSON.stringify({
              files: [],
              ahead: 0,
              behind: 0,
              branch: "main",
              hasStaged: false,
              hasUnstaged: false,
              gitAvailable: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.getStatus(
      new Request("https://brain.local/api/git/status?runId=run_retry_1"),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_retry_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branch: "main",
      gitAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries local-dev-session proxy misses and eventually succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          'Couldn\'t find a local dev session for the "default" entrypoint of service "legioncode-api" to proxy to',
          { status: 503, headers: { "Content-Type": "text/plain" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "git-status-task-retry-local-dev",
            status: "success",
            output: JSON.stringify({
              files: [],
              ahead: 0,
              behind: 0,
              branch: "main",
              hasStaged: false,
              hasUnstaged: false,
              gitAvailable: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const response = await GitController.getStatus(
      new Request(
        "https://brain.local/api/git/status?runId=run_retry_local_dev",
      ),
      {
        ...createTestEnv(fetchMock),
      },
      createOwnedExecution("run_retry_local_dev"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branch: "main",
      gitAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function createTestEnv(
  fetchMock: ReturnType<typeof vi.fn>,
): Env {
  return {
    SECURE_API: { fetch: fetchMock } as Env["SECURE_API"],
    NODE_ENV: "test",
  } as Env;
}

function createOwnedExecution(runId: string): OwnedGitExecution {
  return {
    runId,
    brainSessionId: "session-1",
    workspaceScope: {
      runId,
      threadId: "thr_git_test",
      turnId: "trn_git_test",
      runAttemptId: "attempt_git_test",
      workspaceId: "wrk_00000000-0000-0000-0000-000000000001",
      root: `/home/sandbox/checkouts/checkout_${runId}`,
    },
    session: {
      sessionId: "sess-git-1",
      token: "tok-git-1",
      expiresAt: Date.now() + 60_000,
      lease: {
        leaseId: "lease_git_test",
        sandboxId: "sandbox_git_test",
        generation: 2,
      },
    },
  } as unknown as OwnedGitExecution;
}
