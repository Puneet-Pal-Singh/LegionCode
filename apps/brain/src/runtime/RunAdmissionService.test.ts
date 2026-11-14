import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";
import { RunAdmissionService } from "./RunAdmissionService";
import { ThreadInputCommandService } from "../services/thread-inputs/ThreadInputCommandService";

describe("RunAdmissionService", () => {
  it("requires canonical user, workspace, thread, and run-attempt identities", async () => {
    const service = new RunAdmissionService(createEnv());

    await expect(
      service.enforce(
        {
          userId: "user-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
        },
        "corr-1",
      ),
    ).rejects.toMatchObject({
      code: "RUN_ADMISSION_IDENTITY_MISSING",
      status: 400,
    });
  });

  it("blocks emergency shutoff before contacting the limiter", async () => {
    const env = createEnv({ LAUNCH_EMERGENCY_SHUTOFF_MODE: "block_runs" });
    const service = new RunAdmissionService(env);

    await expect(
      service.enforce(canonicalInput(), "corr-2"),
    ).rejects.toMatchObject({
      code: "EMERGENCY_SHUTOFF_ACTIVE",
      status: 503,
    });
  });

  it("releases the exact run-attempt lease after admission", async () => {
    const calls: string[] = [];
    const env = createEnv({
      RUN_ADMISSION_LIMITER: createLimiterNamespace((url, body) => {
        calls.push(`${url.pathname}:${body.leaseId ?? ""}`);
        if (url.pathname === "/acquire-concurrency") {
          return { allowed: true, retryAfterSeconds: 0, leaseId: body.leaseId };
        }
        return url.pathname === "/release-concurrency"
          ? { released: true }
          : { allowed: true, retryAfterSeconds: 0 };
      }),
    });
    const service = new RunAdmissionService(env);

    const grant = await service.enforce(canonicalInput(), "corr-3");
    await service.release(grant, "corr-3");

    expect(calls).toContain(
      "/acquire-concurrency:run-attempt:run-attempt-1",
    );
    expect(calls).toContain(
      "/release-concurrency:run-attempt:run-attempt-1",
    );
    await service.releaseAttempt(canonicalInput().runAttemptId, "corr-3");
    expect(calls.filter(call => call === "/release-concurrency:run-attempt:run-attempt-1")).toHaveLength(2);
    const failedRelease = new RunAdmissionService(createEnv({
      RUN_ADMISSION_LIMITER: createLimiterNamespace(() => ({ released: false })),
    }));
    await expect(failedRelease.releaseAttempt(canonicalInput().runAttemptId, "corr-3")).rejects.toMatchObject({
      code: "RUN_ADMISSION_LEASE_NOT_FOUND",
    });
    const admission = Object.freeze({ userId: "user-1", sessionId: "session-1", workspaceId: "workspace-1",
      threadId: "thr_attempt01", turnId: "trn_attempt01", runAttemptId: "attempt_attempt01", runId: "run_attempt01",
      clientMessageId: "client-1", state: "admitted" as const, executionState: "settled" as const,
      revisionOfTurnId: null, continuationOfTurnId: null, originalPromptId: null, continuationTerminalSequence: null,
      requestFingerprint: null, admissionOrder: 1, createdAt: "2026-11-14T00:00:00Z", admittedAt: "2026-11-14T00:00:00Z" });
    const order: string[] = [];
    const terminalQueue = vi.spyOn(ThreadInputCommandService.prototype, "onTurnTerminal").mockImplementation(async () => { order.push("queue"); });
    const original = { admission, correlationId: "corr-original" };
    const ownedEnv = { ...env,
      AUTH_TURN_ADMISSION_REPOSITORY: { getByTurnId: async () => admission },
      RUN_ENGINE_RUNTIME: { idFromName: () => ({}), get: () => ({ fetch: async () => Response.json({
        events: [{ type: "turn.completed", threadId: admission.threadId, turnId: admission.turnId, runAttemptId: admission.runAttemptId }], nextSequence: null,
      }) }) },
      RUN_ADMISSION_LIMITER: createLimiterNamespace(url => {
        if (url.pathname === "/release-concurrency") order.push("release");
        return { released: true };
      }),
    } as unknown as Env;
    try {
      await new ThreadInputCommandService(ownedEnv).onNativeAttemptSettled(new Request("https://run-engine/execute"), original);
      expect(order).toEqual(["release", "queue"]);
      terminalQueue.mockClear();
      await expect(new ThreadInputCommandService({ ...ownedEnv,
        RUN_ADMISSION_LIMITER: createLimiterNamespace(() => ({ released: false })),
      }).onNativeAttemptSettled(new Request("https://run-engine/execute"), original)).rejects.toMatchObject({ code: "RUN_ADMISSION_LEASE_NOT_FOUND" });
      expect(terminalQueue).not.toHaveBeenCalled();
    } finally { terminalQueue.mockRestore(); }


  });

  it("preserves admission blocked as a non-provider error", async () => {
    const service = new RunAdmissionService(
      createEnv({
        RUN_ADMISSION_LIMITER: createLimiterNamespace((url) =>
          url.pathname === "/acquire-concurrency"
            ? {
                allowed: false,
                retryAfterSeconds: 7,
                blockedBucket: "concurrent_expensive_run_workspace",
              }
            : { allowed: true, retryAfterSeconds: 0 },
        ),
      }),
    );

    await expect(
      service.enforce(canonicalInput(), "corr-4"),
    ).rejects.toMatchObject({
      code: "RUN_ADMISSION_BLOCKED",
      status: 429,
      metadata: {
        admissionState: "blocked",
        blockedBucket: "concurrent_expensive_run_workspace",
      },
    });
  });

  it("classifies deployed sandbox exhaustion as a typed capacity failure", async () => {
    const service = new RunAdmissionService(
      createEnv({
        RUN_ADMISSION_LIMITER: createLimiterNamespace((url) =>
          url.pathname === "/acquire-concurrency"
            ? {
                allowed: false,
                retryAfterSeconds: 9,
                blockedBucket: "cloudflare_sandbox_capacity",
              }
            : { allowed: true, retryAfterSeconds: 0 },
        ),
      }),
    );

    await expect(
      service.enforce(canonicalInput(), "corr-capacity"),
    ).rejects.toMatchObject({
      code: "RUN_CAPACITY_EXHAUSTED",
      status: 429,
      retryable: true,
      metadata: {
        admissionState: "blocked",
        failureKind: "capacity_exhausted",
        blockedBucket: "cloudflare_sandbox_capacity",
        retryAfterSeconds: 9,
      },
    });
  });
});

function canonicalInput() {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runAttemptId: "run-attempt-1",
    mode: "build" as const,
    workflowIntent: "build" as const,
  };
}

function createLimiterNamespace(
  response: (url: URL, body: Record<string, unknown>) => unknown,
): Env["RUN_ADMISSION_LIMITER"] {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(input.toString());
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return new Response(JSON.stringify(response(url, body)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const stub = { fetch };
  return {
    idFromName: vi.fn(() => ({ toString: () => "admission" })),
    get: vi.fn(() => stub),
  } as unknown as Env["RUN_ADMISSION_LIMITER"];
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}
