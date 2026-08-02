import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { Env } from "../../types/ai";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";

const WORKSPACE_SCOPE: SecureExecutionWorkspaceScope = {
  runId: "run-1",
  threadId: "thread-1",
  turnId: "turn-1",
  runAttemptId: "attempt-1",
  workspaceId: "workspace-1",
  root: "/workspace/checkouts/checkout-1",
};

describe("SecureGitArtifactClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the checkout-bound execution session instead of creating another session", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        taskId: "edit-artifact-git_status-run-1",
        status: "success",
        output: JSON.stringify({
          files: [],
          ahead: 0,
          behind: 0,
          branch: "task/checkout-1",
          hasStaged: false,
          hasUnstaged: false,
          gitAvailable: true,
        }),
      }),
    );
    const acquire = vi.fn(async () => ({
      sessionId: "secure-session-1",
      token: "secure-token-1",
      expiresAt: Date.now() + 60_000,
      lease: {
        leaseId: "lease_123456" as never,
        sandboxId: "sandbox-1",
        generation: 0,
      },
    }));
    const client = new SecureGitArtifactClient(
      { SECURE_API: { fetch: fetchMock } as Env["SECURE_API"] } as Env,
      "brain-session-1",
      "run-1",
      WORKSPACE_SCOPE,
      {
        acquire,
        recoverAfterSandboxLoss: vi.fn(),
        cancelTask: vi.fn(),
        release: vi.fn(),
      },
    );

    await expect(client.getStatus()).resolves.toMatchObject({
      branch: "task/checkout-1",
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://internal/api/v1/execute?session=brain-session-1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secure-token-1",
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/session?"),
      expect.anything(),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const requestBody = JSON.parse(String(request?.body)) as {
      taskId: string;
      params: Record<string, unknown>;
    };
    expect(requestBody).toMatchObject({
      params: {
        runId: "run-1",
        workspaceScope: WORKSPACE_SCOPE,
      },
    });
    expect(requestBody.taskId).toMatch(
      /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const runtimeEventIdempotencyKey = [
      "run_1196d241e79d4ebaa9041dc9096184b7",
      "sess_1785262656991_475e25e78714cc96",
      requestBody.taskId,
      "runtime.task.finished",
    ].join(":");
    expect(runtimeEventIdempotencyKey.length).toBeLessThanOrEqual(200);
  });

  it("accepts every canonical Git snapshot status", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        taskId: "artifact-test",
        status: "success",
        output: JSON.stringify({
          files: [
            {
              path: "src/new.ts",
              previousPath: "src/old.ts",
              status: "copied",
              additions: 2,
              deletions: 0,
            },
          ],
          patch: "diff --git a/src/old.ts b/src/new.ts",
        }),
      }),
    );
    const client = new SecureGitArtifactClient(
      { SECURE_API: { fetch: fetchMock } as Env["SECURE_API"] } as Env,
      "brain-session-1",
      "run-1",
      WORKSPACE_SCOPE,
      {
        acquire: vi.fn(async () => ({
          sessionId: "secure-session-1",
          token: "secure-token-1",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_123456" as never,
            sandboxId: "sandbox-1",
            generation: 0,
          },
        })),
        recoverAfterSandboxLoss: vi.fn(),
        cancelTask: vi.fn(),
        release: vi.fn(),
      },
    );

    await expect(
      client.diffWorktreeSnapshots({
        startTree: "a".repeat(40),
        terminalTree: "b".repeat(40),
      }),
    ).resolves.toMatchObject({
      files: [{ status: "copied", previousPath: "src/old.ts" }],
    });
  });
});
