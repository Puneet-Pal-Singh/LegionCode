import {
  PostgresTaskWorkspaceRepository,
  type TaskWorkspaceRepository,
} from "@repo/persistence";
import {
  TaskCheckoutSchema,
  RunAttemptIdSchema,
  createTaskCheckoutId,
  userIdFromExternalId,
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
import { SecureGitArtifactClient } from "../../services/edit-artifacts/SecureGitArtifactClient";
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
import {
  ResumeWorkspaceSnapshotRefSchema,
  ResumeWorkspaceSnapshotStore,
  type ResumeWorkspaceSnapshotRef,
} from "./ResumeWorkspaceSnapshotStore";

export interface IssuedTaskCheckout {
  readonly checkout: TaskCheckout;
  readonly authorizedCommitId: string;
  readonly workspaceScope: SecureExecutionWorkspaceScope;
  readonly executionSession: SecureExecutionSessionPort;
  /** Called after the canonical pinned repository bootstrap and before model work. */
  readonly restoreWorkspaceProgress?: () => Promise<void>;
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

  async issue(
    payload: ExecuteRunPayload,
    options?: { readonly resumeSnapshot?: ResumeWorkspaceSnapshotRef },
  ): Promise<IssuedTaskCheckout> {
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

    const resumeSnapshot = options?.resumeSnapshot
      ? ResumeWorkspaceSnapshotRefSchema.parse(options.resumeSnapshot)
      : undefined;
    if (resumeSnapshot) this.assertResumeSnapshotScope(payload, resumeSnapshot);

    const existing = await this.findExistingCheckout(
      identity.runAttemptId,
      payload.correlationId,
    );
    if (existing) {
      if (
        resumeSnapshot &&
        (existing.checkout.snapshotId !== resumeSnapshot.baseSnapshotId ||
          existing.snapshot.authorizedCommitId !== resumeSnapshot.baseCommitSha)
      ) {
        throw new DomainError(
          "RESUME_WORKSPACE_BASE_MISMATCH",
          "The persisted checkout does not match the saved workspace progress base.",
          409,
          false,
          payload.correlationId,
        );
      }
      return await this.resumeExisting(
        payload,
        existing.checkout,
        existing.snapshot,
        resumeSnapshot,
      );
    }

    const snapshot = resumeSnapshot
      ? await this.findResumeBaseSnapshot(payload, resumeSnapshot)
      : await this.capture.capture({
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
      const issuedCheckout: IssuedTaskCheckout = {
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
      } satisfies IssuedTaskCheckout;
      if (resumeSnapshot) {
        return {
          ...issuedCheckout,
          restoreWorkspaceProgress: () =>
            this.restoreResumeSnapshotSafely(
              payload,
              resumeSnapshot,
              snapshot,
              issued.checkout,
              workspaceScope,
              issuedCheckout.executionSession,
            ),
        };
      }
      return issuedCheckout;
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

  private async findResumeBaseSnapshot(
    payload: ExecuteRunPayload,
    ref: ResumeWorkspaceSnapshotRef,
  ): Promise<WorkspaceSnapshot> {
    this.assertResumeSnapshotScope(payload, ref);
    return await withBrainPersistenceRepository(
      this.env,
      this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
      (client) => new PostgresTaskWorkspaceRepository(client),
      async (taskWorkspaces) => {
        const snapshot = await taskWorkspaces.getBySnapshotId(
          ref.baseSnapshotId,
        );
        if (
          !snapshot ||
          snapshot.workspaceId !== ref.workspaceId ||
          snapshot.authorizedCommitId !== ref.baseCommitSha ||
          snapshot.provenance.kind !== "authorized_repository" ||
          snapshot.provenance.authorizedByUserId !==
            userIdFromExternalId(payload.userId!)
        ) {
          throw new DomainError(
            "RESUME_WORKSPACE_BASE_UNAVAILABLE",
            "The authorized base for this saved workspace progress is unavailable.",
            409,
            false,
            payload.correlationId,
          );
        }
        const selection = payload.input.repositoryContext;
        if (
          !selection ||
          !selection.owner ||
          !selection.repo ||
          snapshot.repository.owner?.toLowerCase() !==
            selection.owner.toLowerCase() ||
          snapshot.repository.name.toLowerCase() !==
            selection.repo.toLowerCase()
        ) {
          throw new DomainError(
            "RESUME_WORKSPACE_REPOSITORY_MISMATCH",
            "The saved workspace progress does not match the selected repository.",
            409,
            false,
            payload.correlationId,
          );
        }
        return snapshot;
      },
    );
  }

  private assertResumeSnapshotScope(
    payload: ExecuteRunPayload,
    ref: ResumeWorkspaceSnapshotRef,
  ): void {
    const identity = payload.identity!;
    if (
      ref.userId !== userIdFromExternalId(payload.userId!) ||
      ref.workspaceId !== workspaceIdFromExternalId(identity.workspaceId) ||
      ref.threadId !== identity.threadId
    ) {
      throw new DomainError(
        "RESUME_WORKSPACE_SNAPSHOT_SCOPE_MISMATCH",
        "The saved workspace progress belongs to another user, thread, or workspace.",
        409,
        false,
        payload.correlationId,
      );
    }
  }

  private async restoreResumeSnapshot(
    payload: ExecuteRunPayload,
    ref: ResumeWorkspaceSnapshotRef,
    baseSnapshot: WorkspaceSnapshot,
    checkout: TaskCheckout,
    workspaceScope: SecureExecutionWorkspaceScope,
    executionSession: SecureExecutionSessionPort,
  ): Promise<void> {
    if (!this.env.EDIT_ARTIFACTS) {
      throw new DomainError(
        "RESUME_WORKSPACE_ARTIFACT_UNAVAILABLE",
        "Saved workspace progress cannot be restored because its artifact store is unavailable.",
        503,
        false,
        payload.correlationId,
      );
    }
    try {
      const patch = await new ResumeWorkspaceSnapshotStore(
        this.env.EDIT_ARTIFACTS,
      ).read(ref, {
        userId: userIdFromExternalId(payload.userId!),
        workspaceId: workspaceIdFromExternalId(payload.identity!.workspaceId),
        threadId: payload.identity!.threadId,
      });
      if (
        ref.workspaceId !== checkout.workspaceId ||
        ref.threadId !== checkout.threadId
      ) {
        throw new Error("Workspace snapshot scope does not match the checkout");
      }
      const git = new SecureGitArtifactClient(
        this.env,
        payload.sessionId,
        payload.runId,
        workspaceScope,
        executionSession,
      );
      const currentTree = await git.captureWorktreeSnapshot();
      const restoredTree =
        currentTree.treeSha === ref.terminalTreeSha
          ? currentTree.treeSha
          : currentTree.treeSha === baseSnapshot.authorizedTreeId
            ? await git.restoreWorktreeSnapshot(patch)
            : "";
      if (
        restoredTree !== ref.terminalTreeSha ||
        checkout.startTreeId !== baseSnapshot.authorizedTreeId
      ) {
        throw new Error("Restored workspace tree did not match its provenance");
      }
    } catch {
      throw new DomainError(
        "RESUME_WORKSPACE_RESTORE_FAILED",
        "Saved workspace progress could not be verified in the fresh checkout. No model request was started.",
        503,
        false,
        payload.correlationId,
        { runAttemptId: checkout.runAttemptId },
      );
    }
  }

  private async restoreResumeSnapshotSafely(
    payload: ExecuteRunPayload,
    ref: ResumeWorkspaceSnapshotRef,
    baseSnapshot: WorkspaceSnapshot,
    checkout: TaskCheckout,
    workspaceScope: SecureExecutionWorkspaceScope,
    executionSession: SecureExecutionSessionPort,
  ): Promise<void> {
    try {
      await this.restoreResumeSnapshot(
        payload,
        ref,
        baseSnapshot,
        checkout,
        workspaceScope,
        executionSession,
      );
    } catch (error) {
      await withBrainPersistenceRepository(
        this.env,
        this.repositoryOverride ?? this.env.AUTH_TASK_WORKSPACE_REPOSITORY,
        (client) => new PostgresTaskWorkspaceRepository(client),
        async (taskWorkspaces) =>
          await taskWorkspaces.settle({
            checkoutId: checkout.checkoutId,
            status: "failed",
            settledAt: new Date().toISOString(),
            failureCode: "RESUME_WORKSPACE_RESTORE_FAILED",
          }),
      );
      try {
        await executionSession.release();
      } catch {
        throw new DomainError(
          "TASK_CHECKOUT_COMPENSATION_FAILED",
          "Workspace restoration failed and the secure checkout could not be safely released.",
          503,
          true,
          payload.correlationId,
          { checkoutId: checkout.checkoutId },
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
    resumeSnapshot?: ResumeWorkspaceSnapshotRef,
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
    const issued: IssuedTaskCheckout = {
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
    if (resumeSnapshot) {
      return {
        ...issued,
        restoreWorkspaceProgress: () =>
          this.restoreResumeSnapshotSafely(
            payload,
            resumeSnapshot,
            snapshot,
            resumedCheckout,
            workspaceScope,
            issued.executionSession,
          ),
      };
    }
    return issued;
  }
}
