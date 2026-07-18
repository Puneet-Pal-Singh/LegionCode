import {
  PostgresTaskWorkspaceRepository,
  type TaskWorkspaceRepository,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  RunAttemptIdSchema,
  workspaceIdFromExternalId,
  type TaskCheckout,
} from "@repo/platform-protocol";
import { DomainError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";

export interface TaskCheckoutExecutionIdentity {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
}

export interface TaskCheckoutRootCapabilityPort {
  assertCheckoutRootSupported(
    checkout: TaskCheckout,
    correlationId: string,
  ): void;
}

export interface TaskCheckoutExecutionPort {
  claimForExecution(
    identity: TaskCheckoutExecutionIdentity,
    correlationId: string,
  ): Promise<TaskCheckout>;
}

/**
 * Secure tools accept only a server-issued workspace scope. This capability
 * verifies that a persisted checkout can be projected to that scope without
 * falling back to a run-derived root.
 */
export class SecureTaskCheckoutRootCapability
  implements TaskCheckoutRootCapabilityPort
{
  assertCheckoutRootSupported(
    checkout: TaskCheckout,
    correlationId: string,
  ): void {
    const expectedRoot = `/home/sandbox/checkouts/${checkout.checkoutId}`;
    const expectedGitDir = `${expectedRoot}.git`;
    const expectedIndexFile = `/home/sandbox/indexes/${checkout.checkoutId}.index`;
    if (
      checkout.filesystemRoot === expectedRoot &&
      checkout.gitDir === expectedGitDir &&
      checkout.indexFile === expectedIndexFile
    ) {
      return;
    }

    throw new DomainError(
      "TASK_CHECKOUT_SCOPE_INVALID",
      "The task checkout does not have the canonical isolated secure-runtime paths.",
      409,
      false,
      correlationId,
      { checkoutId: checkout.checkoutId },
    );
  }
}

/**
 * Canonical Brain-side claim boundary for a persisted TaskCheckout.
 *
 * It never creates snapshot, checkout, sandbox, or lease identifiers. Those
 * values must already have been issued by their authoritative capture and
 * secure-execution owners. Claiming is idempotent for an already-active
 * checkout and atomically activates a ready checkout through the repository.
 */
export class TaskCheckoutExecutionOrchestrator
  implements TaskCheckoutExecutionPort
{
  constructor(
    private readonly env: Env,
    private readonly rootCapability: TaskCheckoutRootCapabilityPort =
      new SecureTaskCheckoutRootCapability(),
    private readonly repositoryOverride?: TaskWorkspaceRepository,
  ) {}

  async claimForExecution(
    identity: TaskCheckoutExecutionIdentity,
    correlationId: string,
  ): Promise<TaskCheckout> {
    return await withBrainPersistenceRepository(
      this.env,
      this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
      (client) => new PostgresTaskWorkspaceRepository(client),
      async (repository) => {
        const checkout = await repository.getByRunAttemptId(
          RunAttemptIdSchema.parse(identity.runAttemptId),
        );
        if (!checkout) {
          throw new DomainError(
            "TASK_CHECKOUT_REQUIRED",
            "A server-owned isolated task checkout is required before execution can start.",
            503,
            true,
            correlationId,
            {
              failureKind: "task_checkout_missing",
              runAttemptId: identity.runAttemptId,
            },
          );
        }

        assertCheckoutScope(checkout, identity, correlationId);
        if (checkout.status === "settled" || checkout.status === "failed") {
          throw new DomainError(
            "TASK_CHECKOUT_TERMINAL",
            "The isolated task checkout has already settled and cannot be reused by another execution.",
            409,
            false,
            correlationId,
            {
              checkoutId: checkout.checkoutId,
              checkoutStatus: checkout.status,
              runAttemptId: checkout.runAttemptId,
            },
          );
        }

        this.rootCapability.assertCheckoutRootSupported(
          checkout,
          correlationId,
        );

        if (checkout.status === "ready") {
          return TaskCheckoutSchema.parse(
            await repository.activate(checkout.checkoutId),
          );
        }
        if (checkout.status === "active") {
          return TaskCheckoutSchema.parse(checkout);
        }

        return assertNever(checkout);
      },
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected task checkout state: ${String(value)}`);
}

function assertCheckoutScope(
  checkout: TaskCheckout,
  identity: TaskCheckoutExecutionIdentity,
  correlationId: string,
): void {
  const workspaceId = workspaceIdFromExternalId(identity.workspaceId);
  if (
    checkout.workspaceId === workspaceId &&
    checkout.threadId === identity.threadId &&
    checkout.turnId === identity.turnId &&
    checkout.runAttemptId === identity.runAttemptId
  ) {
    return;
  }

  throw new DomainError(
    "TASK_CHECKOUT_SCOPE_MISMATCH",
    "The isolated task checkout does not match the server-owned turn scope.",
    409,
    false,
    correlationId,
    {
      checkoutId: checkout.checkoutId,
      runAttemptId: identity.runAttemptId,
    },
  );
}
