import { describe, expect, it, vi } from "vitest";
import type {
  TaskWorkspaceRepository,
  SettleTaskCheckoutInput,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  WorkspaceSnapshotSchema,
  type TaskCheckout,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import {
  SecureTaskCheckoutRootCapability,
  TaskCheckoutExecutionOrchestrator,
  type TaskCheckoutRootCapabilityPort,
} from "./TaskCheckoutExecutionOrchestrator";

const identity = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  threadId: "thr_123456",
  turnId: "trn_123456",
  runAttemptId: "attempt_123456",
} as const;

describe("TaskCheckoutExecutionOrchestrator", () => {
  it("requires an authoritative checkout record for the run attempt", async () => {
    const repository = new MemoryTaskWorkspaceRepository(createCheckout());
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      { assertCheckoutRootSupported: vi.fn() },
      repository,
    );

    await expect(
      orchestrator.claimForExecution(
        { ...identity, runAttemptId: "attempt_missing" },
        "corr-0",
      ),
    ).rejects.toMatchObject({ code: "TASK_CHECKOUT_REQUIRED", status: 503 });
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("atomically activates the one checkout bound to the run attempt", async () => {
    const repository = new MemoryTaskWorkspaceRepository(createCheckout());
    const capability: TaskCheckoutRootCapabilityPort = {
      assertCheckoutRootSupported: vi.fn(),
    };
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      capability,
      repository,
    );

    const claimed = await orchestrator.claimForExecution(identity, "corr-1");

    expect(claimed.status).toBe("active");
    expect(repository.activate).toHaveBeenCalledOnce();
    expect(capability.assertCheckoutRootSupported).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutId: "checkout_123456" }),
      "corr-1",
    );
  });

  it("reuses an active checkout idempotently without replacing its lease", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({ status: "active" }),
    );
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      { assertCheckoutRootSupported: vi.fn() },
      repository,
    );

    const claimed = await orchestrator.claimForExecution(identity, "corr-2");

    expect(claimed.leaseId).toBe("lease_123456");
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("resolves only an active scoped checkout for secure Git and tool callers", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({ status: "active" }),
    );
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      new SecureTaskCheckoutRootCapability(),
      repository,
    );

    await expect(
      orchestrator.resolveActiveCheckout(identity, "corr-scope"),
    ).resolves.toMatchObject({
      checkoutId: "checkout_123456",
      filesystemRoot: "/home/sandbox/checkouts/checkout_123456",
      status: "active",
    });
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("does not expose a ready checkout before runtime claims it", async () => {
    const repository = new MemoryTaskWorkspaceRepository(createCheckout());
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      new SecureTaskCheckoutRootCapability(),
      repository,
    );

    await expect(
      orchestrator.resolveActiveCheckout(identity, "corr-scope-ready"),
    ).rejects.toMatchObject({
      code: "TASK_CHECKOUT_NOT_ACTIVE",
      status: 409,
    });
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("rejects a checkout bound to another turn before runtime execution", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({ turnId: "trn_654321" }),
    );
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      { assertCheckoutRootSupported: vi.fn() },
      repository,
    );

    await expect(
      orchestrator.claimForExecution(identity, "corr-3"),
    ).rejects.toMatchObject({
      code: "TASK_CHECKOUT_SCOPE_MISMATCH",
      status: 409,
    });
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("accepts the persisted canonical checkout root now honored by secure tools", async () => {
    const repository = new MemoryTaskWorkspaceRepository(createCheckout());
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      new SecureTaskCheckoutRootCapability(),
      repository,
    );

    await expect(
      orchestrator.claimForExecution(identity, "corr-4"),
    ).resolves.toMatchObject({
      status: "active",
      filesystemRoot: "/home/sandbox/checkouts/checkout_123456",
    });
    expect(repository.activate).toHaveBeenCalledOnce();
  });

  it("rejects a persisted checkout whose filesystem paths cannot be safely projected", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({ filesystemRoot: "/home/sandbox/runs/attempt_123456" }),
    );
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      new SecureTaskCheckoutRootCapability(),
      repository,
    );

    await expect(
      orchestrator.claimForExecution(identity, "corr-4-invalid"),
    ).rejects.toMatchObject({
      code: "TASK_CHECKOUT_SCOPE_INVALID",
      status: 409,
    });
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("does not reuse a terminal checkout", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({
        status: "failed",
        settledAt: "2026-07-18T12:01:00.000Z",
        failureCode: "sandbox_lost",
      }),
    );
    const capability = { assertCheckoutRootSupported: vi.fn() };
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      capability,
      repository,
    );

    await expect(
      orchestrator.claimForExecution(identity, "corr-5"),
    ).rejects.toMatchObject({ code: "TASK_CHECKOUT_TERMINAL", status: 409 });
    expect(capability.assertCheckoutRootSupported).not.toHaveBeenCalled();
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("settles only the matching active checkout", async () => {
    const repository = new MemoryTaskWorkspaceRepository(
      createCheckout({ status: "active" }),
    );
    const orchestrator = new TaskCheckoutExecutionOrchestrator(
      {} as Env,
      { assertCheckoutRootSupported: vi.fn() },
      repository,
    );

    await expect(
      orchestrator.settleExecution("checkout_123456", {
        status: "failed",
        failureCode: "RUNTIME_EXECUTION_FAILED",
      }),
    ).resolves.toMatchObject({
      checkoutId: "checkout_123456",
      status: "failed",
      failureCode: "RUNTIME_EXECUTION_FAILED",
    });
  });
});

class MemoryTaskWorkspaceRepository implements TaskWorkspaceRepository {
  readonly activate = vi.fn(async (checkoutId) => {
    if (checkoutId !== this.checkout.checkoutId) throw new Error("not found");
    this.checkout = TaskCheckoutSchema.parse({
      ...this.checkout,
      status: "active",
    });
    return this.checkout;
  });

  constructor(private checkout: TaskCheckout) {}

  async issueSnapshotCheckout(): Promise<never> {
    throw new Error("not implemented in this execution-claim fixture");
  }

  async createSnapshot(snapshot: WorkspaceSnapshot) {
    return WorkspaceSnapshotSchema.parse(snapshot);
  }

  async getBySnapshotId() {
    return null;
  }

  async createCheckout(checkout: TaskCheckout) {
    this.checkout = TaskCheckoutSchema.parse(checkout);
    return this.checkout;
  }

  async getByCheckoutId() {
    return this.checkout;
  }

  async getByRunAttemptId(runAttemptId: string) {
    return runAttemptId === this.checkout.runAttemptId ? this.checkout : null;
  }

  async getByLeaseId(leaseId: string) {
    return leaseId === this.checkout.leaseId ? this.checkout : null;
  }

  async settle(input: SettleTaskCheckoutInput) {
    if (input.checkoutId !== this.checkout.checkoutId) {
      throw new Error("not found");
    }
    this.checkout = TaskCheckoutSchema.parse({
      ...this.checkout,
      status: input.status,
      settledAt: input.settledAt,
      failureCode: input.failureCode,
    });
    return this.checkout;
  }
}

function createCheckout(overrides: Partial<TaskCheckout> = {}): TaskCheckout {
  return TaskCheckoutSchema.parse({
    kind: "task_checkout",
    checkoutId: "checkout_123456",
    snapshotId: "wsnap_123456",
    workspaceId: "wrk_00000000-0000-4000-8000-000000000001",
    threadId: identity.threadId,
    turnId: identity.turnId,
    runAttemptId: identity.runAttemptId,
    leaseId: "lease_123456",
    sandboxId: "sandbox-123456",
    filesystemRoot: "/home/sandbox/checkouts/checkout_123456",
    gitDir: "/home/sandbox/checkouts/checkout_123456/.git",
    indexFile: "/home/sandbox/checkouts/checkout_123456/.git/index",
    workingBranch: "task/checkout-123456",
    startTreeId: "a".repeat(40),
    generation: 1,
    status: "ready",
    settledAt: null,
    failureCode: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  });
}
