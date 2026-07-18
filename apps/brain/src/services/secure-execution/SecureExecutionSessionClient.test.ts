import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import {
  SecureExecutionSessionClient,
  SecureExecutionSessionRecoveryError,
} from "./SecureExecutionSessionClient";

const workspaceScope = {
  runId: "run_resume01",
  threadId: "thr_resume01",
  turnId: "trn_resume01",
  runAttemptId: "attempt_resume01",
  workspaceId: "wrk_resume01",
  root: "/home/sandbox/checkouts/checkout_resume01",
};

describe("SecureExecutionSessionClient resume", () => {
  it("rotates through the internal exact-scope endpoint and releases with the new bearer", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sessionId: "sess_resume001",
          token: "rotated-secret-token",
          expiresAt: Date.now() + 60_000,
          lease: {
            leaseId: "lease_resume001",
            sandboxId: "sandbox-resume001",
            generation: 2,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true }));
    const env = {
      SECURE_API: { fetch },
      INTERNAL_RUNTIME_EVENT_SECRET: "internal-test-secret",
    } as unknown as Env;
    const client = new SecureExecutionSessionClient(
      env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      {
        secureSessionId: "sess_resume001",
        leaseId: "lease_resume001",
        sandboxId: "sandbox-resume001",
        generation: 2,
      },
    );

    await expect(client.acquire()).resolves.toMatchObject({
      sessionId: "sess_resume001",
      lease: { leaseId: "lease_resume001", generation: 2 },
    });
    await client.release();

    const resumeRequest = fetch.mock.calls[0]!;
    expect(String(resumeRequest[0])).toContain(
      "/api/v1/session/sess_resume001/resume",
    );
    expect(resumeRequest[1]?.headers).toMatchObject({
      "X-Internal-Runtime-Secret": "internal-test-secret",
    });
    expect(JSON.parse(String(resumeRequest[1]?.body))).toEqual({
      workspaceScope,
      lease: {
        leaseId: "lease_resume001",
        sandboxId: "sandbox-resume001",
        generation: 2,
      },
    });
    const releaseRequest = fetch.mock.calls[1]!;
    expect(releaseRequest[1]?.headers).toMatchObject({
      Authorization: "Bearer rotated-secret-token",
    });
  });

  it("fails closed when internal service authentication is absent", async () => {
    const client = new SecureExecutionSessionClient(
      { SECURE_API: { fetch: vi.fn() } } as unknown as Env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      {
        secureSessionId: "sess_resume001",
        leaseId: "lease_resume001",
        sandboxId: "sandbox-resume001",
        generation: 2,
      },
    );

    await expect(client.acquire()).rejects.toThrow(
      "Internal runtime authentication is required",
    );
  });

  it("preserves a typed non-retryable recovery exhaustion response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          code: "SANDBOX_RECOVERY_EXHAUSTED",
          error: "internal detail must not become the public failure",
        },
        { status: 503 },
      ),
    );
    const client = new SecureExecutionSessionClient(
      {
        SECURE_API: { fetch },
        INTERNAL_RUNTIME_EVENT_SECRET: "internal-test-secret",
      } as unknown as Env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      {
        secureSessionId: "sess_resume001",
        leaseId: "lease_resume001",
        sandboxId: "sandbox-resume001",
        generation: 1,
      },
    );

    await expect(client.acquire()).rejects.toMatchObject({
      name: "SecureExecutionSessionRecoveryError",
      code: "SANDBOX_RECOVERY_EXHAUSTED",
      retryable: false,
      message: "The task sandbox replacement budget is exhausted.",
    } satisfies Partial<SecureExecutionSessionRecoveryError>);
  });
});
