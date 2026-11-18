import { createHash } from "node:crypto";
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
    const { root: workspaceRoot, ...knownWorkspace } = workspaceScope;
    const executionDomain = {
      version: 1,
      domain: "legioncode_native",
      scope: { userId: "usr_resume01", brainSessionId: "brain-session-1", ...knownWorkspace },
    } as const;
    // SHA-256 of this fixture's canonical server execution-domain serialization.
    const domainDigest = "4c7e95dd5a087cd12a2438df30f6eecd1ec912dd334f5a29b7412162cea5905b";
    const nativeSandboxBinding = {
      version: 1, backend: "cloudflareSandbox", binding: "NativeSandbox",
      profile: "basic", schedulingPolicy: "default", sandboxObjectId: "e".repeat(64),
    } as const;
    const nativeCommandClosure = {
      state: "settled", profile: "linux-pid-namespace-cgroup-v2", originalTransportSettled: true, operationId: "a".repeat(64), nonce: "a".repeat(64),
      scope: { ...knownWorkspace, executionDomainDigest: domainDigest, workspaceRoot, sessionId: "sess_resume001", leaseId: "lease_resume001", sandboxId: "sandbox-resume001", generation: 2, taskId: "task_resume001" },
      root: { device: "1", inode: "9007199254740993" }, sandboxBootId: "123e4567-e89b-42d3-a456-426614174000",
      namespace: { device: "2", inode: "3", initHostPid: 4 }, cgroup: { device: "5", inode: "6" },
      metadataIdentity: "linux-git-metadata-v1:"+"d".repeat(64), receiptSha256: "b".repeat(64),
    };
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
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        sessionId: "sess_resume001", token: "native-secret-token", expiresAt: Date.now() + 60_000,
        nativeSandboxBinding,
        lease: { leaseId: "lease_resume001", sandboxId: "sandbox-resume001", generation: 2,
          expiresAt: Date.now() + 60_000, executionDomainDigest: domainDigest },
      }))
      .mockResolvedValueOnce(Response.json({ cancelled: true, nativeCommandClosure }));
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
    const nativeClient = new SecureExecutionSessionClient(
      { ...env, SECURE_API: { fetch: nativeFetch } } as unknown as Env,
      "brain-session-1", workspaceScope.runId, workspaceScope,
      { secureSessionId: "sess_resume001", leaseId: "lease_resume001", sandboxId: "sandbox-resume001",
        generation: 2, executionDomainDigest: domainDigest, nativeSandboxBinding },
      executionDomain,
    );
    await nativeClient.acquire();
    const cancelled = await nativeClient.cancelTaskWithNativeClosure("task_resume001");
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.nativeCommandClosure).toEqual(nativeCommandClosure);
    await expect(nativeClient.parseNativeClosure({ ...nativeCommandClosure, scope: { ...nativeCommandClosure.scope, generation: 3 } }, "task_resume001")).resolves.toBeNull();
    await expect(nativeClient.parseNativeClosure({ ...nativeCommandClosure, originalTransportSettled: false }, "task_resume001")).resolves.toBeNull();
    await expect(nativeClient.parseNativeClosure({ ...nativeCommandClosure, nonce: "c".repeat(64) }, "task_resume001")).resolves.toBeNull();
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
    const cancelRequest = nativeFetch.mock.calls[1]!;
    expect(JSON.parse(String(cancelRequest[1]?.body))).toEqual({ sessionId: "sess_resume001", taskId: "task_resume001" });
    const releaseRequest = fetch.mock.calls[1]!;
    expect(releaseRequest[1]?.headers).toMatchObject({
      Authorization: "Bearer rotated-secret-token",
    });

    const domain = {
      version: 1 as const,
      domain: "delegated_harness" as const,
      delegatedRouteDigest: "a".repeat(64),
      scope: {
        userId: "user-resume",
        brainSessionId: "brain-session-1",
        runId: workspaceScope.runId,
        workspaceId: workspaceScope.workspaceId,
        threadId: workspaceScope.threadId,
        turnId: workspaceScope.turnId,
        runAttemptId: workspaceScope.runAttemptId,
      },
    };
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          version: domain.version,
          domain: domain.domain,
          scope: {
            userId: domain.scope.userId,
            brainSessionId: domain.scope.brainSessionId,
            workspaceId: domain.scope.workspaceId,
            threadId: domain.scope.threadId,
            turnId: domain.scope.turnId,
            runId: domain.scope.runId,
            runAttemptId: domain.scope.runAttemptId,
          },
          delegatedRouteDigest: domain.delegatedRouteDigest,
        }),
      )
      .digest("hex");
    const reference = {
      secureSessionId: "sess_resume001",
      leaseId: "lease_resume001",
      sandboxId: "sandbox-resume001",
      generation: 2,
      executionDomainDigest: digest,
    };
    const originalFetch = vi.fn().mockResolvedValue(
      Response.json({
        sessionId: reference.secureSessionId,
        token: "original-token",
        expiresAt: Date.now() + 60_000,
        lease: { ...reference, expiresAt: Date.now() + 60_000 },
      }),
    );
    const marked = new SecureExecutionSessionClient(
      { ...env, SECURE_API: { fetch: originalFetch } } as unknown as Env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      reference,
      domain,
    );
    const original = await marked.acquire();
    await expect(marked.acquire()).resolves.toBe(original);
    expect(Object.isFrozen(original.lease)).toBe(true);
    expect(String(originalFetch.mock.calls[0]![0])).toContain(
      "/sess_resume001/borrow?",
    );
    expect(originalFetch.mock.calls[0]![1]?.headers).toMatchObject({
      "X-Internal-Runtime-Secret": "internal-test-secret",
    });
    expect(JSON.parse(String(originalFetch.mock.calls[0]![1]?.body))).toEqual({
      runId: workspaceScope.runId,
      workspaceScope,
      executionDomain: domain,
      lease: {
        leaseId: reference.leaseId,
        sandboxId: reference.sandboxId,
        generation: 2,
      },
    });
    await expect(marked.recoverAfterSandboxLoss()).rejects.toThrow(
      "SECURE_ORIGINAL_SESSION_RECOVERY_REQUIRED",
    );
    expect(originalFetch).toHaveBeenCalledOnce();

    const invalidReference = {
      ...reference,
      executionDomainDigest: "b".repeat(64),
    };
    const invalid = new SecureExecutionSessionClient(
      { ...env, SECURE_API: { fetch: originalFetch } } as unknown as Env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      invalidReference,
      domain,
    );
    await expect(invalid.acquire()).rejects.toThrow(
      "EXECUTION_DOMAIN_BINDING_UNAVAILABLE",
    );
    await expect(invalid.acquire()).rejects.toThrow(
      "EXECUTION_DOMAIN_BINDING_UNAVAILABLE",
    );
    expect(originalFetch).toHaveBeenCalledOnce();

    const missingDigestFetch = vi.fn().mockResolvedValue(
      Response.json({
        sessionId: reference.secureSessionId,
        token: "unmarked-token",
        expiresAt: Date.now() + 60_000,
        lease: {
          leaseId: reference.leaseId,
          sandboxId: reference.sandboxId,
          generation: 2,
        },
      }),
    );
    const missingDigest = new SecureExecutionSessionClient(
      { ...env, SECURE_API: { fetch: missingDigestFetch } } as unknown as Env,
      "brain-session-1",
      workspaceScope.runId,
      workspaceScope,
      undefined,
      domain,
    );
    await expect(missingDigest.acquire()).rejects.toThrow(
      "EXECUTION_DOMAIN_BINDING_UNAVAILABLE",
    );
    await expect(missingDigest.acquire()).rejects.toThrow(
      "EXECUTION_DOMAIN_BINDING_UNAVAILABLE",
    );
    expect(missingDigestFetch).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(missingDigestFetch.mock.calls[0]![1]?.body))
        .executionDomain,
    ).toEqual(domain);
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
