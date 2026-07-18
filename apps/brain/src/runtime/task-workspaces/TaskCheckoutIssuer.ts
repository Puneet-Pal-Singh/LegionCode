import {
  PostgresTaskWorkspaceRepository,
  type TaskWorkspaceRepository,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  RunAttemptIdSchema,
  createTaskCheckoutId,
  workspaceIdFromExternalId,
  type TaskCheckout,
  type WorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import {
  toSecureExecutionWorkspaceScope,
  type SecureExecutionWorkspaceScope,
} from "../RuntimeWorkspaceScope";
import {
  SecureExecutionSessionClient,
  canonicalTaskCheckoutRoot,
  type PersistedSecureExecutionSessionReference,
  type SecureExecutionSessionHandle,
  type SecureExecutionSessionPort,
} from "../../services/secure-execution/SecureExecutionSessionClient";
import { DomainError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import {
  AuthorizedWorkspaceSnapshotCaptureService,
  type WorkspaceSnapshotCapturePort,
} from "./AuthorizedWorkspaceSnapshotCaptureService";
import {
  TaskCheckoutBoundExecutionSession,
  TaskCheckoutLeaseCoordinator,
} from "./TaskCheckoutLeaseCoordinator";

export interface IssuedTaskCheckout {
  readonly checkout: TaskCheckout;
  readonly authorizedCommitId: string;
  readonly workspaceScope: SecureExecutionWorkspaceScope;
  readonly executionSession: SecureExecutionSessionPort;
}

export type SecureExecutionSessionFactory = (input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceScope: SecureExecutionWorkspaceScope;
  readonly persistedReference?: PersistedSecureExecutionSessionReference;
}) => SecureExecutionSessionPort;

export class TaskCheckoutIssuer {
  constructor(
    private readonly env: Env,
    private readonly capture: WorkspaceSnapshotCapturePort = new AuthorizedWorkspaceSnapshotCaptureService(
      env,
    ),
    private readonly repositoryOverride?: TaskWorkspaceRepository,
    private readonly sessionFactory: SecureExecutionSessionFactory = (input) =>
      new SecureExecutionSessionClient(
        env,
        input.sessionId,
        input.runId,
        input.workspaceScope,
        input.persistedReference,
      ),
  ) {}

  async issue(payload: ExecuteRunPayload): Promise<IssuedTaskCheckout> {
    const identity = payload.identity;
    const repository = payload.input.repositoryContext;
    if (!identity || !payload.userId || !payload.workspaceId || !repository) {
      throw new DomainError(
        "TASK_CHECKOUT_INPUT_REQUIRED",
        "An authenticated repository workspace is required before isolated cloud execution can start.",
        428,
        false,
        payload.correlationId,
      );
    }
    if (!repository.owner || !repository.repo) {
      throw new DomainError(
        "TASK_CHECKOUT_REPOSITORY_REQUIRED",
        "Select a repository before starting this cloud task.",
        428,
        false,
        payload.correlationId,
      );
    }

    const existing = await this.findExistingCheckout(
      identity.runAttemptId,
      payload.correlationId,
    );
    if (existing) {
      return await this.resumeExisting(payload, existing.checkout, existing.snapshot);
    }

    const snapshot = await this.capture.capture({
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      repository: {
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch,
        baseUrl: repository.baseUrl,
      },
      correlationId: payload.correlationId,
    });
    const checkoutId = createTaskCheckoutId();
    const filesystemRoot = canonicalTaskCheckoutRoot(checkoutId);
    const workspaceScope = toSecureExecutionWorkspaceScope({
      runId: payload.runId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      runAttemptId: identity.runAttemptId,
      workspaceId: identity.workspaceId,
      root: filesystemRoot,
    });
    const executionSession = this.sessionFactory({
      sessionId: payload.sessionId,
      runId: payload.runId,
      workspaceScope,
    });

    try {
      const session = await executionSession.acquire();
      const checkout = TaskCheckoutSchema.parse({
        kind: "task_checkout",
        checkoutId,
        snapshotId: snapshot.snapshotId,
        workspaceId: snapshot.workspaceId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
        secureSessionId: session.sessionId,
        leaseId: session.lease.leaseId,
        sandboxId: session.lease.sandboxId,
        filesystemRoot,
        gitDir: `${filesystemRoot}/.git`,
        indexFile: `${filesystemRoot}/.git/index`,
        workingBranch: `task/${checkoutId}`,
        startTreeId: snapshot.authorizedTreeId,
        generation: session.lease.generation,
        status: "ready",
        settledAt: null,
        failureCode: null,
        createdAt: new Date().toISOString(),
      });
      const issued = await withBrainPersistenceRepository(
        this.env,
        this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
        (client) => new PostgresTaskWorkspaceRepository(client),
        async (taskWorkspaces) =>
          await taskWorkspaces.issueSnapshotCheckout(snapshot, checkout),
      );
      return {
        checkout: issued.checkout,
        authorizedCommitId: snapshot.authorizedCommitId,
        workspaceScope,
        executionSession: new TaskCheckoutBoundExecutionSession(
          executionSession,
          issued.checkout,
          new TaskCheckoutLeaseCoordinator(
            this.env,
            this.repositoryOverride,
          ),
        ),
      };
    } catch (error) {
      try {
        await executionSession.release();
      } catch {
        throw new DomainError(
          "TASK_CHECKOUT_COMPENSATION_FAILED",
          "The isolated checkout could not be issued or safely released. Retry after capacity recovery.",
          503,
          true,
          payload.correlationId,
          {
            checkoutId,
            runAttemptId: identity.runAttemptId,
          },
        );
      }
      throw error;
    }
  }

  private async findExistingCheckout(
    runAttemptId: string,
    correlationId: string,
  ): Promise<
    | {
        readonly checkout: TaskCheckout;
        readonly snapshot: WorkspaceSnapshot;
      }
    | null
  > {
    return await withBrainPersistenceRepository(
      this.env,
      this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
      (client) => new PostgresTaskWorkspaceRepository(client),
      async (taskWorkspaces) => {
        const checkout = await taskWorkspaces.getByRunAttemptId(
          RunAttemptIdSchema.parse(runAttemptId),
        );
        if (!checkout) return null;
        const snapshot = await taskWorkspaces.getBySnapshotId(
          checkout.snapshotId,
        );
        if (!snapshot) {
          throw new DomainError(
            "TASK_CHECKOUT_SNAPSHOT_MISSING",
            "The isolated checkout has lost its immutable snapshot provenance.",
            503,
            false,
            correlationId,
          );
        }
        return { checkout, snapshot };
      },
    );
  }

  private async resumeExisting(
    payload: ExecuteRunPayload,
    checkout: TaskCheckout,
    snapshot: WorkspaceSnapshot,
  ): Promise<IssuedTaskCheckout> {
    const identity = payload.identity!;
    if (
      checkout.workspaceId !== workspaceIdFromExternalId(identity.workspaceId) ||
      checkout.threadId !== identity.threadId ||
      checkout.turnId !== identity.turnId ||
      checkout.runAttemptId !== identity.runAttemptId ||
      checkout.snapshotId !== snapshot.snapshotId ||
      checkout.startTreeId !== snapshot.authorizedTreeId
    ) {
      throw new DomainError(
        "TASK_CHECKOUT_SCOPE_MISMATCH",
        "The persisted isolated checkout does not match this turn.",
        409,
        false,
        payload.correlationId,
        { checkoutId: checkout.checkoutId },
      );
    }
    if (checkout.status === "settled" || checkout.status === "failed") {
      throw new DomainError(
        "TASK_CHECKOUT_TERMINAL",
        "The isolated checkout has already settled and cannot be resumed.",
        409,
        false,
        payload.correlationId,
        { checkoutId: checkout.checkoutId, checkoutStatus: checkout.status },
      );
    }
    const workspaceScope = toSecureExecutionWorkspaceScope({
      runId: payload.runId,
      threadId: checkout.threadId,
      turnId: checkout.turnId,
      runAttemptId: checkout.runAttemptId,
      workspaceId: checkout.workspaceId,
      root: checkout.filesystemRoot,
    });
    const executionSession = this.sessionFactory({
      sessionId: payload.sessionId,
      runId: payload.runId,
      workspaceScope,
      persistedReference: {
        secureSessionId: checkout.secureSessionId,
        leaseId: checkout.leaseId,
        sandboxId: checkout.sandboxId,
        generation: checkout.generation,
      },
    });
    let handle: SecureExecutionSessionHandle;
    try {
      handle = await executionSession.acquire();
    } catch {
      throw new DomainError(
        "TASK_CHECKOUT_RESUME_UNAVAILABLE",
        "The isolated checkout session could not be resumed. Retry after secure runtime recovery.",
        503,
        true,
        payload.correlationId,
        { checkoutId: checkout.checkoutId },
      );
    }
    const resumedCheckout =
      handle.lease.leaseId === checkout.leaseId &&
      handle.lease.sandboxId === checkout.sandboxId &&
      handle.lease.generation === checkout.generation
        ? checkout
        : await new TaskCheckoutLeaseCoordinator(
            this.env,
            this.repositoryOverride,
          ).adopt(checkout, handle);
    return {
      checkout: resumedCheckout,
      authorizedCommitId: snapshot.authorizedCommitId,
      workspaceScope,
      executionSession: new TaskCheckoutBoundExecutionSession(
        executionSession,
        resumedCheckout,
        new TaskCheckoutLeaseCoordinator(
          this.env,
          this.repositoryOverride,
        ),
      ),
    };
  }
}
