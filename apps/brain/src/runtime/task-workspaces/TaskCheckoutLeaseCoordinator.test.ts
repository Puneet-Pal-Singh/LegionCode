import { describe, expect, it, vi } from "vitest";
import type { TaskWorkspaceRepository } from "@repo/persistence";
import { TaskCheckoutSchema } from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import type { SecureExecutionSessionPort } from "../../services/secure-execution/SecureExecutionSessionClient";
import {
  TaskCheckoutBoundExecutionSession,
  TaskCheckoutLeaseCoordinator,
} from "./TaskCheckoutLeaseCoordinator";

const checkout = TaskCheckoutSchema.parse({
  kind: "task_checkout",
  checkoutId: "checkout_recovery01",
  snapshotId: "wsnap_recovery01",
  workspaceId: "wrk_recovery01",
  threadId: "thr_recovery01",
  turnId: "trn_recovery01",
  runAttemptId: "attempt_recovery01",
  secureSessionId: "sess_recovery01",
  leaseId: "lease_recovery01",
  sandboxId: "sb-recovery01",
  filesystemRoot: "/home/sandbox/checkouts/checkout_recovery01",
  gitDir: "/home/sandbox/checkouts/checkout_recovery01/.git",
  indexFile: "/home/sandbox/checkouts/checkout_recovery01/.git/index",
  workingBranch: "task/checkout-recovery01",
  startTreeId: "a".repeat(40),
  generation: 0,
  status: "active",
  settledAt: null,
  failureCode: null,
  createdAt: "2026-07-18T12:00:00.000Z",
});

describe("TaskCheckoutBoundExecutionSession", () => {
  it("persists the replacement generation before returning control to the tool loop", async () => {
    const replacement = {
      sessionId: checkout.secureSessionId,
      token: "replacement-token",
      expiresAt: Date.now() + 60_000,
      lease: {
        leaseId: "lease_recovery02",
        sandboxId: "sb-recovery02",
        generation: 1,
      },
    };
    const repository = repositoryMock();
    repository.replaceLease.mockResolvedValueOnce(
      TaskCheckoutSchema.parse({
        ...checkout,
        leaseId: replacement.lease.leaseId,
        sandboxId: replacement.lease.sandboxId,
        generation: replacement.lease.generation,
      }),
    );
    const delegate = {
      acquire: vi.fn(async () => ({
        sessionId: checkout.secureSessionId,
        token: "initial-token",
        expiresAt: Date.now() + 60_000,
        lease: {
          leaseId: checkout.leaseId,
          sandboxId: checkout.sandboxId,
          generation: checkout.generation,
        },
      })),
      recoverAfterSandboxLoss: vi.fn(async () => replacement),
      release: vi.fn(async () => undefined),
    } satisfies SecureExecutionSessionPort;
    const session = new TaskCheckoutBoundExecutionSession(
      delegate,
      checkout,
      new TaskCheckoutLeaseCoordinator({} as Env, repository),
    );

    await expect(session.recoverAfterSandboxLoss()).resolves.toEqual(
      replacement,
    );
    expect(repository.replaceLease).toHaveBeenCalledWith({
      checkoutId: checkout.checkoutId,
      expectedLeaseId: checkout.leaseId,
      expectedGeneration: 0,
      nextLeaseId: replacement.lease.leaseId,
      nextSandboxId: replacement.lease.sandboxId,
      nextGeneration: 1,
    });
  });
});

function repositoryMock() {
  return {
    issueSnapshotCheckout: vi.fn(),
    createSnapshot: vi.fn(),
    getBySnapshotId: vi.fn(),
    createCheckout: vi.fn(),
    getByCheckoutId: vi.fn(),
    getByRunAttemptId: vi.fn(),
    getByLeaseId: vi.fn(),
    activate: vi.fn(),
    replaceLease: vi.fn(),
    settle: vi.fn(),
  } satisfies TaskWorkspaceRepository;
}
