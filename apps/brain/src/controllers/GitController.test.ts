import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitController } from "./GitController";
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

  it("routes git status through the canonical session-authenticated API", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-git-1",
            token: "tok-git-1",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
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
      new Request("https://brain.local/api/git/status?runId=run-1&sessionId=session-1"),
      {
        SECURE_API: { fetch: fetchMock } as Env["SECURE_API"],
        NODE_ENV: "test",
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      branch: "main",
      gitAvailable: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0]!;
    expect(sessionUrl).toBe("http://internal/api/v1/session?session=session-1");
    expect(sessionInit?.method).toBe("POST");
    expect(JSON.parse(String(sessionInit?.body))).toMatchObject({
      runId: "run-1",
      taskId: "git-status-run-1",
      repoPath: ".",
    });

    const [executeUrl, executeInit] = fetchMock.mock.calls[1]!;
    expect(executeUrl).toBe("http://internal/api/v1/execute?session=session-1");
    expect(executeInit?.headers).toMatchObject({
      Authorization: "Bearer tok-git-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(executeInit?.body))).toMatchObject({
      sessionId: "sess-git-1",
      action: "git.execute",
      params: {
        action: "git_status",
        runId: "run-1",
      },
      timeout: GIT_STATUS_TIMEOUT_MS,
    });
  });

  it("maps git contract failures to a typed controller error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-git-2",
            token: "tok-git-2",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
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
      new Request("https://brain.local/api/git/status?runId=run-1"),
      {
        SECURE_API: { fetch: fetchMock } as Env["SECURE_API"],
        NODE_ENV: "test",
      } as Env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GIT_EXECUTION_CONTRACT_ERROR",
      retryable: true,
    });
  });

  it("retries transient git status failures and eventually succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-git-retry-1",
            token: "tok-git-retry-1",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
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
            sessionId: "sess-git-retry-2",
            token: "tok-git-retry-2",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
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
      new Request("https://brain.local/api/git/status?runId=run-retry"),
      {
        SECURE_API: { fetch: fetchMock } as Env["SECURE_API"],
        NODE_ENV: "test",
      } as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branch: "main",
      gitAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries local-dev-session proxy misses and eventually succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          "Couldn't find a local dev session for the \"default\" entrypoint of service \"shadowbox-api\" to proxy to",
          { status: 503, headers: { "Content-Type": "text/plain" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-git-retry-local-dev",
            token: "tok-git-retry-local-dev",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
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
      new Request("https://brain.local/api/git/status?runId=run-retry-local-dev"),
      {
        SECURE_API: { fetch: fetchMock } as Env["SECURE_API"],
        NODE_ENV: "test",
      } as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      branch: "main",
      gitAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
