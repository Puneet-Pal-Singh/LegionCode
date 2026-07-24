import { describe, expect, it } from "vitest";
import type { Env } from "../types/ai";
import { RunAdmissionService } from "./RunAdmissionService";

describe("RunAdmissionService", () => {
  it("blocks run submissions when emergency shutoff is active", async () => {
    const service = new RunAdmissionService(
      createEnv({
        LAUNCH_EMERGENCY_SHUTOFF_MODE: "block_runs",
      }),
    );

    await expect(
      service.enforce(
        {
          userId: "user-1",
          workspaceId: "workspace-1",
          mode: "build",
          workflowIntent: "build",
        },
        "corr-1",
      ),
    ).rejects.toMatchObject({
      code: "EMERGENCY_SHUTOFF_ACTIVE",
      status: 503,
    });
  });

  it("rate limits repeated submissions from the same user and workspace", async () => {
    const service = new RunAdmissionService(
      createEnv({
        RUN_SUBMISSION_RATE_LIMIT_MAX: "1",
        MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX: "1",
        ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX: "1",
        ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX: "1",
        ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX: "1",
        RUN_ADMISSION_LIMITER: createAdmissionLimiter([
          { allowed: true, retryAfterSeconds: 0 },
          { allowed: false, retryAfterSeconds: 60 },
        ]),
      }),
    );

    await expect(
      service.enforce(
        {
          userId: "user-2",
          workspaceId: "workspace-2",
          sessionId: "session-a",
          mode: "build",
          workflowIntent: "build",
        },
        "corr-2a",
      ),
    ).resolves.toMatchObject({ leaseId: expect.any(String) });

    await expect(
      service.enforce(
        {
          userId: "user-2",
          workspaceId: "workspace-2",
          sessionId: "session-a",
          mode: "build",
          workflowIntent: "build",
        },
        "corr-2b",
      ),
    ).rejects.toMatchObject({
      code: "RUN_SUBMISSION_RATE_LIMITED",
      status: 429,
    });
  });
});

function createEnv(overrides: Partial<Env>): Env {
  return {
    ...overrides,
  } as Env;
}

function createAdmissionLimiter(
  rateLimitDecisions: Array<{ allowed: boolean; retryAfterSeconds: number }>,
): Env["RUN_ADMISSION_LIMITER"] {
  let rateLimitCall = 0;
  return {
    idFromName: () => ({ toString: () => "run-admission-limiter" }),
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const url =
          input instanceof URL
            ? input
            : typeof input === "string"
              ? new URL(input)
              : new URL(input.url);
        if (url.pathname === "/enforce") {
          const decision = rateLimitDecisions[rateLimitCall++]!;
          return Response.json(decision);
        }
        if (url.pathname === "/acquire-concurrency") {
          return Response.json({
            allowed: true,
            retryAfterSeconds: 0,
            leaseId: "lease-1",
          });
        }
        if (url.pathname === "/release-concurrency") {
          return Response.json({ released: true });
        }
        return new Response("Not Found", { status: 404 });
      },
    }),
  } as unknown as Env["RUN_ADMISSION_LIMITER"];
}
