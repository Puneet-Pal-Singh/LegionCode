import {
  PostgresTaskWorkspaceRepository,
  type TaskWorkspaceRepository,
} from "@repo/persistence";
import type { TaskCheckout } from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import type {
  SecureExecutionSessionHandle,
  SecureExecutionSessionPort,
} from "../../services/secure-execution/SecureExecutionSessionClient";

/**
 * The only Brain owner allowed to adopt a Secure API replacement lease for an
 * existing checkout. Snapshot, checkout, root, Git, and artifact provenance
 * remain immutable; the lease advances through one compare-and-set generation.
 */
export class TaskCheckoutLeaseCoordinator {
  constructor(
    private readonly env: Env,
    private readonly repositoryOverride?: TaskWorkspaceRepository,
  ) {}

  async adopt(
    checkout: TaskCheckout,
    handle: SecureExecutionSessionHandle,
  ): Promise<TaskCheckout> {
    if (
      checkout.secureSessionId === handle.sessionId &&
      checkout.leaseId === handle.lease.leaseId &&
      checkout.sandboxId === handle.lease.sandboxId &&
      checkout.generation === handle.lease.generation
    ) {
      return checkout;
    }
    return await withBrainPersistenceRepository(
      this.env,
      this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
      (client) => new PostgresTaskWorkspaceRepository(client),
      async (taskWorkspaces) => {
        try {
          return await taskWorkspaces.replaceLease({
            checkoutId: checkout.checkoutId,
            expectedLeaseId: checkout.leaseId,
            expectedGeneration: checkout.generation,
            nextLeaseId: handle.lease.leaseId,
            nextSandboxId: handle.lease.sandboxId,
            nextGeneration: handle.lease.generation,
          });
        } catch (error) {
          const current = await taskWorkspaces.getByCheckoutId(
            checkout.checkoutId,
          );
          if (
            current &&
            current.secureSessionId === handle.sessionId &&
            current.leaseId === handle.lease.leaseId &&
            current.sandboxId === handle.lease.sandboxId &&
            current.generation === handle.lease.generation
          ) {
            return current;
          }
          throw error;
        }
      },
    );
  }
}

/**
 * Keeps the persisted checkout lease synchronized before another tool can use
 * a Secure API replacement. ExecutionService depends only on the narrow
 * session port and does not reach into persistence.
 */
export class TaskCheckoutBoundExecutionSession
  implements SecureExecutionSessionPort
{
  constructor(
    private readonly delegate: SecureExecutionSessionPort,
    private checkout: TaskCheckout,
    private readonly coordinator: TaskCheckoutLeaseCoordinator,
  ) {}

  async acquire(): Promise<SecureExecutionSessionHandle> {
    return await this.delegate.acquire();
  }

  async recoverAfterSandboxLoss(): Promise<SecureExecutionSessionHandle> {
    const recovered = await this.delegate.recoverAfterSandboxLoss();
    this.checkout = await this.coordinator.adopt(this.checkout, recovered);
    return recovered;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    return await this.delegate.cancelTask(taskId);
  }

  async release(): Promise<void> {
    await this.delegate.release();
  }
}
