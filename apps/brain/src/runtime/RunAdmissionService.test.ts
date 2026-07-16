import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";
import { RunAdmissionService } from "./RunAdmissionService";

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
