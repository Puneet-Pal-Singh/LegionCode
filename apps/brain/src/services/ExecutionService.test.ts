import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAPIClient, decryptToken } from "@shadowbox/github-bridge";
import { ExecutionService } from "./ExecutionService";
import type { Env } from "../types/ai";
import { GIT_STATUS_TIMEOUT_MS } from "./gitExecutionTimeouts";
import { createIdentityRepository } from "../test-utils/identityTestHelpers";
import {
  SecureExecutionSessionRecoveryError,
  type SecureExecutionSessionPort,
} from "./secure-execution/SecureExecutionSessionClient";

vi.mock("@shadowbox/github-bridge", () => ({
  decryptToken: vi.fn(async () => "token:encrypted-token"),
  GitHubAPIClient: vi.fn().mockImplementation(() => ({
    getRepository: vi.fn(async () => ({ default_branch: "main" })),
    createPullRequest: vi.fn(async () => ({
      number: 42,
      html_url: "https://github.com/acme/career-crew/pull/42",
    })),
  })),
}));

function testLease() {
  return {
    leaseId: "lease_test001",
    sandboxId: "sb-test001",
    generation: 0,
  };
}

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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-1",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
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
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
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
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-123",
      "run-456",
      undefined,
      scopeFor("run-456"),
    );

    const first = await service.execute("filesystem", "read_file", {
      path: "src/index.ts",
    });
    const second = await service.execute("node", "run", {
      command: "pnpm test",
    });

    expect(first).toEqual({
      success: true,
      status: "success",
      output: "file contents",
      metrics: { duration: 8 },
    });
    expect(second).toEqual({
      success: true,
      status: "success",
      output: "second call",
      metrics: { duration: 9 },
    });
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
      workspaceScope: scopeFor("run-456"),
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
        workspaceScope: scopeFor("run-456"),
      },
      timeout: 120000,
    });
  });

  it("rejects a secure execution request before transport when scope is absent", async () => {
    const fetchMock = vi.fn();
    expect(
      () =>
        new ExecutionService(
          {
            SECURE_API: { fetch: fetchMock },
            INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
          } as unknown as Env,
          "session-unscoped",
          "run-unscoped",
        ),
    ).toThrow("workspaceScope is required for secure execution");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries secure session creation while the local shadowbox-api worker is still registering", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
          { status: 503, headers: { "Content-Type": "text/plain" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-retry",
            token: "tok-retry",
            expiresAt: Date.now() + 60_000,
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-retry",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "file contents",
            metrics: { duration: 7 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-retry",
      "run-retry",
      undefined,
      scopeFor("run-retry"),
    );

    const result = await service.execute("filesystem", "read_file", {
      path: "README.md",
    });

    expect(result).toMatchObject({
      success: true,
      output: "file contents",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps task failures back into the legacy execution shape", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-fail",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message: "command failed",
            },
            metrics: { duration: 12 },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-abc",
      "run-def",
      undefined,
      scopeFor("run-def"),
    );

    await expect(
      service.execute("node", "run", { command: "pnpm lint" }),
    ).resolves.toMatchObject({
      success: false,
      status: "failure",
      error: {
        code: "PLUGIN_EXECUTION_FAILED",
        message: "command failed",
      },
      metrics: { duration: 12 },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.result-failed"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"plugin":"node","action":"run"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"secureStatus":"failure"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"errorCode":"PLUGIN_EXECUTION_FAILED"'),
    );
    errorSpy.mockRestore();
  });

  it("preserves typed secure execution timeout failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-timeout",
            token: "tok-timeout",
            expiresAt: Date.now() + 60_000,
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-timeout",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "timeout",
            output: "partial output",
            error: {
              code: "EXECUTION_TIMEOUT",
              message: "Execution request timed out after 120000ms",
              details: { timeoutMs: 120000 },
            },
            metrics: { duration: 120000 },
          }),
          { status: 504, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-timeout",
      "run-timeout",
      undefined,
      scopeFor("run-timeout"),
    );

    await expect(
      service.execute("filesystem", "read_file", { path: "src/index.ts" }),
    ).resolves.toMatchObject({
      success: false,
      status: "timeout",
      output: "partial output",
      error: {
        code: "EXECUTION_TIMEOUT",
        message: "Execution request timed out after 120000ms",
        details: { timeoutMs: 120000 },
      },
      metrics: { duration: 120000 },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.result-failed"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"plugin":"filesystem","action":"read_file"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"secureStatus":"timeout"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"errorCode":"EXECUTION_TIMEOUT"'),
    );
    errorSpy.mockRestore();
  });

  it("bridges sandbox infrastructure failure identity into the runtime port", async () => {
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-sandbox",
            token: "tok-sandbox",
            expiresAt: Date.now() + 60_000,
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-sandbox",
            leaseId: "lease-sandbox",
            correlationId: "secure-correlation-sandbox",
            retryable: true,
            status: "sandbox_unavailable",
            error: {
              code: "SANDBOX_UNAVAILABLE",
              message: "Sandbox container became unavailable during execution",
              details: { exitCode: 137 },
            },
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-sandbox",
            token: "tok-sandbox",
            expiresAt: Date.now() + 60_000,
            lease: {
              leaseId: "lease_replacement01",
              sandboxId: "sb-replacement01",
              generation: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-sandbox",
      "run-sandbox",
      undefined,
      scopeFor("run-sandbox"),
    );

    const result = await service.execute(
      "filesystem",
      "read_file",
      { path: "src/index.ts" },
      {
        scope: {
          runId: "run-sandbox",
          threadId: "thread-run-sandbox",
          turnId: "turn-run-sandbox",
          runAttemptId: "attempt-run-sandbox",
          workspaceId: "workspace-run-sandbox",
          root: "/home/sandbox/runs/run-sandbox",
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      status: "sandbox_unavailable",
      metadata: {
        success: false,
        runtimeFailure: {
          code: "worker_unavailable",
          retryable: true,
          correlationId: "secure-correlation-sandbox",
          details: {
            secureStatus: "sandbox_unavailable",
            secureCode: "SANDBOX_UNAVAILABLE",
            taskId: "task-sandbox",
            leaseId: "lease-sandbox",
            workspaceScope: {
              threadId: "thread-run-sandbox",
              turnId: "turn-run-sandbox",
              runAttemptId: "attempt-run-sandbox",
              workspaceId: "workspace-run-sandbox",
            },
          },
        },
      },
    });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "/api/v1/session/sess-sandbox/resume",
    );
  });

  it("preserves non-retryable sandbox recovery exhaustion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskId: "task-sandbox-exhausted",
          leaseId: "lease-sandbox-exhausted",
          correlationId: "secure-correlation-sandbox-exhausted",
          retryable: true,
          status: "sandbox_unavailable",
          error: {
            code: "SANDBOX_UNAVAILABLE",
            message: "Sandbox container became unavailable during execution",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const executionSession: SecureExecutionSessionPort = {
      acquire: vi.fn(async () => ({
        sessionId: "sess-sandbox-exhausted",
        token: "tok-sandbox-exhausted",
        expiresAt: Date.now() + 60_000,
        lease: {
          leaseId: "lease_sandbox_exhausted",
          sandboxId: "sb-sandbox-exhausted",
          generation: 1,
        },
      })),
      recoverAfterSandboxLoss: vi.fn(async () => {
        throw new SecureExecutionSessionRecoveryError();
      }),
      cancelTask: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    };
    const service = new ExecutionService(
      { SECURE_API: { fetch: fetchMock } } as unknown as Env,
      "session-sandbox-exhausted",
      "run-sandbox-exhausted",
      undefined,
      scopeFor("run-sandbox-exhausted"),
      executionSession,
    );

    const result = await service.execute(
      "filesystem",
      "read_file",
      { path: "src/index.ts" },
      { scope: scopeFor("run-sandbox-exhausted") },
    );

    expect(result).toMatchObject({
      success: false,
      status: "sandbox_unavailable",
      error: {
        code: "SANDBOX_RECOVERY_EXHAUSTED",
        message: "The task sandbox replacement budget is exhausted.",
      },
      metadata: {
        runtimeFailure: {
          retryable: false,
          details: {
            secureCode: "SANDBOX_RECOVERY_EXHAUSTED",
          },
        },
      },
    });
  });

  it("rejects a 2xx secure failure payload as a typed contract violation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "sess-contract",
            token: "tok-contract",
            expiresAt: Date.now() + 60_000,
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-contract",
            leaseId: "lease-contract",
            correlationId: "secure-correlation-contract",
            retryable: true,
            status: "failure",
            error: { code: "COMMAND_FAILED", message: "command failed" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-contract",
      "run-contract",
      undefined,
      scopeFor("run-contract"),
    );

    await expect(
      service.execute("filesystem", "read_file", { path: "src/index.ts" }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SECURE_EXECUTION_CONTRACT_VIOLATION" },
      metadata: {
        runtimeFailure: {
          code: "internal_error",
          details: {
            failureKind: "secure_execution_contract_violation",
            httpStatus: 200,
          },
        },
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.contract-violation"'),
    );
    errorSpy.mockRestore();
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-git",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-git",
      "run-git",
      undefined,
      scopeFor("run-git"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-commit",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-commit"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-commit-oauth",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-commit-oauth"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-github",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: '{"number":228}',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-github"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-github-cli",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: '{"actionsJobId":1234}',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-github-cli"),
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn<
      Parameters<Env["SECURE_API"]["fetch"]>,
      ReturnType<Env["SECURE_API"]["fetch"]>
    >();

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-github-cli-scope"),
    );

    await expect(
      service.execute("github_cli", "actions_job_logs_get", {
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 1234,
      }),
    ).rejects.toThrow("Missing GitHub OAuth scope");
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.threw"'),
    );
    errorSpy.mockRestore();
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-node",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "ok",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-node",
      "run-owned-by-service",
      undefined,
      scopeFor("run-owned-by-service"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-failure",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message: "Git commit author is not configured.",
              details: { stderr: "fatal: empty ident name" },
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-failure",
      "run-failure",
      undefined,
      scopeFor("run-failure"),
    );

    await expect(
      service.execute("git", "git_commit", { message: "feat: add hero" }),
    ).resolves.toMatchObject({
      success: false,
      status: "failure",
      error: {
        code: "PLUGIN_EXECUTION_FAILED",
        message: "Git commit author is not configured.",
        details: { stderr: "fatal: empty ident name" },
      },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.result-failed"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"plugin":"git","action":"git_commit"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"secureStatus":"failure"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"errorCode":"PLUGIN_EXECUTION_FAILED"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"errorMessage":"Git commit author is not configured."',
      ),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "failure",
            error: {
              code: "PLUGIN_EXECUTION_FAILED",
              message:
                "fatal: not a git repository (or any of the parent directories): .git",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-status",
      "run-status",
      undefined,
      scopeFor("run-status"),
    );

    await expect(
      service.execute("git", "git_status", {}),
    ).resolves.toMatchObject({
      success: false,
      status: "failure",
      error: {
        code: "PLUGIN_EXECUTION_FAILED",
        message:
          "fatal: not a git repository (or any of the parent directories): .git",
      },
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.http-warning"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.result-warning"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"plugin":"git","action":"git_status"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"warning":"expected bootstrap miss"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"secureStatus":"failure"'),
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

    fetchMock.mockImplementation(
      async () =>
        new Response(
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
          { status: 503, headers: { "Content-Type": "text/plain" } },
        ),
    );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
      } as unknown as Env,
      "session-status-local-dev",
      "run-status-local-dev",
      undefined,
      scopeFor("run-status-local-dev"),
    );

    await expect(service.execute("git", "git_status", {})).rejects.toThrow(
      /Couldn't find a local dev session/i,
    );

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('"event":"execution.tool.threw"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"execution.tool.transient-startup-miss"',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"runId":"run-status-local-dev","sessionId":"session-status-local-dev"',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/"errorMessage":".*local dev session/i),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
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
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-pr"),
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
            lease: testLease(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "task-status",
            leaseId: "lease-test",
            correlationId: "secure-correlation-test",
            retryable: true,
            status: "success",
            output: "not-json",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const service = new ExecutionService(
      {
        SECURE_API: { fetch: fetchMock },
        INTERNAL_RUNTIME_EVENT_SECRET: "test-internal-secret",
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
      scopeFor("run-pr"),
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

function scopeFor(runId: string) {
  return {
    runId,
    threadId: `thread-${runId}`,
    turnId: `turn-${runId}`,
    runAttemptId: `attempt-${runId}`,
    workspaceId: `workspace-${runId}`,
    root: `/home/sandbox/runs/${runId}`,
  };
}
