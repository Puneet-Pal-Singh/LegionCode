import {
  PostgresTaskWorkspaceRepository,
  type TaskWorkspaceRepository,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  createTaskCheckoutId,
  type TaskCheckout,
} from "@repo/platform-protocol";
import type { ExecuteRunPayload } from "../parsing/ExecuteRunPayloadSchema";
import {
  toSecureExecutionWorkspaceScope,
  type SecureExecutionWorkspaceScope,
} from "../RuntimeWorkspaceScope";
import {
  SecureExecutionSessionClient,
  canonicalTaskCheckoutRoot,
  type SecureExecutionSessionPort,
} from "../../services/secure-execution/SecureExecutionSessionClient";
import { DomainError } from "../../domain/errors";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../../services/persistence/BrainPersistenceRepositoryFactory";
import {
  AuthorizedWorkspaceSnapshotCaptureService,
  type WorkspaceSnapshotCapturePort,
} from "./AuthorizedWorkspaceSnapshotCaptureService";

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
        leaseId: session.lease.leaseId,
        sandboxId: session.lease.sandboxId,
        filesystemRoot,
        gitDir: `${filesystemRoot}/.git`,
        indexFile: `${filesystemRoot}/.git/index`,
        workingBranch: `task/${checkoutId}`,
        startTreeId: snapshot.authorizedTreeId,
        generation: session.lease.generation + 1,
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
        executionSession,
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
}
