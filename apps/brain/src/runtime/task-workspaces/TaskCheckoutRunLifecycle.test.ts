import { describe, expect, it, vi } from "vitest";
import { TaskCheckoutSchema } from "@repo/platform-protocol";
import type { SecureExecutionSessionPort } from "../../services/secure-execution/SecureExecutionSessionClient";
import type { TaskCheckoutSettlementPort } from "./TaskCheckoutExecutionOrchestrator";
import { TaskCheckoutRunLifecycle } from "./TaskCheckoutRunLifecycle";

describe("TaskCheckoutRunLifecycle", () => {
  it("settles the matching checkout exactly once", async () => {
    const settleExecution = vi.fn(async (_checkoutId, outcome) =>
      TaskCheckoutSchema.parse({
        ...checkout,
        status: outcome.status,
        settledAt: "2026-07-18T12:01:00.000Z",
        failureCode: outcome.status === "failed" ? outcome.failureCode : null,
      }),
    );
    const lifecycle = new TaskCheckoutRunLifecycle(
      checkout.checkoutId,
      { settleExecution } satisfies TaskCheckoutSettlementPort,
      executionSession(),
    );

    await expect(
      lifecycle.settle({
        status: "failed",
        failureCode: "RUN_PIPELINE_FAILED",
      }),
    ).resolves.toMatchObject({
      checkoutId: checkout.checkoutId,
      status: "failed",
      failureCode: "RUN_PIPELINE_FAILED",
    });
    expect(lifecycle.isSettled).toBe(true);
    await expect(lifecycle.settle({ status: "settled" })).rejects.toThrow(
      "already settled",
    );
    expect(settleExecution).toHaveBeenCalledOnce();
  });

  it("releases only through the issued secure execution session", async () => {
    const session = executionSession();
    const lifecycle = new TaskCheckoutRunLifecycle(
      checkout.checkoutId,
      {
        settleExecution: vi.fn(),
      },
      session,
    );

    await lifecycle.release();

    expect(session.release).toHaveBeenCalledOnce();
  });
});

const checkout = TaskCheckoutSchema.parse({
  kind: "task_checkout",
  checkoutId: "checkout_123456",
  snapshotId: "wsnap_123456",
  workspaceId: "wrk_00000000-0000-4000-8000-000000000001",
  threadId: "thr_123456",
  turnId: "trn_123456",
  runAttemptId: "attempt_123456",
  secureSessionId: "sess_secure001",
  leaseId: "lease_123456",
  sandboxId: "sandbox-123456",
  filesystemRoot: "/home/sandbox/checkouts/checkout_123456",
  gitDir: "/home/sandbox/checkouts/checkout_123456/.git",
  indexFile: "/home/sandbox/checkouts/checkout_123456/.git/index",
  workingBranch: "task/checkout-123456",
  startTreeId: "a".repeat(40),
  generation: 1,
  status: "active",
  settledAt: null,
  failureCode: null,
  createdAt: "2026-07-18T12:00:00.000Z",
});

function executionSession(): SecureExecutionSessionPort {
  return {
    acquire: vi.fn(),
    recoverAfterSandboxLoss: vi.fn(),
    release: vi.fn(async () => undefined),
  };
}
