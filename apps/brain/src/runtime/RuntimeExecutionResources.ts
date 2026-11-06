import type {
  IAgent,
  RunEngineDependencies,
  RuntimeKernelNativeRunnerInput,
} from "@legioncode/execution-engine/runtime";
import {
  userIdFromExternalId,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type { Env } from "../types/ai";
import { DomainError } from "../domain/errors";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import { createEditArtifactCoordinator } from "../services/edit-artifacts/EditArtifactCaptureService";
import { SecureGitArtifactClient } from "../services/edit-artifacts/SecureGitArtifactClient";
import { SecureRuntimeGitSnapshotPort } from "../services/edit-artifacts/SecureRuntimeGitSnapshotPort";
import { BrainApprovalGrantReader } from "../services/lifecycle/BrainApprovalGrantReader";
import { ProductionHookOrchestrator } from "../services/hooks/ProductionHookOrchestrator";
import { buildRuntimeDependencies } from "./factories/ExecutionGatewayFactory";
import type { ExecuteRunPayload } from "./parsing/ExecuteRunPayloadSchema";
import { TaskCheckoutIssuer } from "./task-workspaces/TaskCheckoutIssuer";
import { TaskCheckoutExecutionOrchestrator } from "./task-workspaces/TaskCheckoutExecutionOrchestrator";
import { TaskCheckoutRunLifecycle } from "./task-workspaces/TaskCheckoutRunLifecycle";

interface RuntimeExecutionResources {
  readonly agent: IAgent | undefined;
  readonly runEngineDeps: RunEngineDependencies;
  readonly workspace: RuntimeKernelNativeRunnerInput["workspace"];
  readonly artifacts?: ReturnType<typeof createEditArtifactCoordinator>;
  readonly checkoutLifecycle?: TaskCheckoutRunLifecycle;
  readonly checkoutId?: string;
  readonly hooks?: ProductionHookOrchestrator;
}

/** Resource capability comes from the owned saved chat, never the mutable global repository. */
export async function prepareRuntimeExecutionResources(
  ctx: unknown,
  env: Env,
  payload: ExecuteRunPayload,
): Promise<RuntimeExecutionResources> {
  const { identity, userId, workspaceId, sessionId, runId } = payload;
  if (!identity || !userId || !workspaceId)
    throw new DomainError(
      "RUN_SCOPE_MISMATCH",
      "Authenticated turn scope is required.",
      409,
      false,
      payload.correlationId,
    );
  const session = await withTranscriptRepository(
    env,
    async (repository) =>
      (await repository.listSessions(userId)).sessions.find(
        (candidate) => candidate.id === sessionId,
      ) ?? null,
  );
  if (
    !session ||
    (session.workspaceId !== null && session.workspaceId !== workspaceId)
  ) {
    throw new DomainError(
      "RUN_SCOPE_MISMATCH",
      "The conversation does not belong to this execution scope.",
      409,
      false,
      payload.correlationId,
    );
  }
  const selected = payload.input.repositoryContext;
  if (session.repository === null) {
    if (selected || payload.resumeSnapshotRef)
      throw new DomainError(
        "RUN_SCOPE_MISMATCH",
        "A projectless conversation cannot acquire repository resources.",
        409,
        false,
        payload.correlationId,
      );
    return {
      ...buildRuntimeDependencies(ctx, env, payload, {
        strict: true,
        issuedTaskCheckout: null,
      }),
      workspace: null,
    };
  }
  if (
    !selected?.owner ||
    !selected.repo ||
    `${selected.owner}/${selected.repo}`.toLowerCase() !==
      session.repository.toLowerCase()
  ) {
    throw new DomainError(
      "RUN_SCOPE_MISMATCH",
      "Select the repository belonging to this conversation.",
      409,
      false,
      payload.correlationId,
    );
  }
  const orchestrator = new TaskCheckoutExecutionOrchestrator(env);
  const issued = await new TaskCheckoutIssuer(env).issue(payload, {
    resumeSnapshot: payload.resumeSnapshotRef,
  });
  let checkout;
  try {
    checkout = await orchestrator.claimForExecution(
      {
        workspaceId: identity.workspaceId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
      },
      payload.correlationId,
    );
  } catch (error) {
    await issued.executionSession.release();
    throw error;
  }
  const checkoutLifecycle = new TaskCheckoutRunLifecycle(
    checkout.checkoutId,
    orchestrator,
    issued.executionSession,
  );
  try {
    const dependencies = buildRuntimeDependencies(ctx, env, payload, {
      strict: true,
      issuedTaskCheckout: { ...issued, checkout },
    });
    const artifacts = createEditArtifactCoordinator({
      env,
      userId,
      workspaceId,
      identity,
      runId,
      sessionId,
      repositoryContext: selected,
      workspaceScope: issued.workspaceScope,
      executionSession: issued.executionSession,
    });
    const gitSnapshots = new SecureRuntimeGitSnapshotPort(
      new SecureGitArtifactClient(
        env,
        sessionId,
        runId,
        issued.workspaceScope,
        issued.executionSession,
      ),
      {
        bucket: env.EDIT_ARTIFACTS!,
        userId: userIdFromExternalId(userId),
        workspaceId: workspaceIdFromExternalId(workspaceId),
        threadId: identity.threadId,
        sourceRunId: runId,
        sourceTurnId: identity.turnId,
        sourceRunAttemptId: identity.runAttemptId,
        baseSnapshotId: issued.checkout.snapshotId,
        baseCommitSha: issued.authorizedCommitId,
      },
    );
    return {
      agent: dependencies.agent,
      runEngineDeps: {
        ...dependencies.runEngineDeps,
        approvalGrants: new BrainApprovalGrantReader(env),
        gitSnapshots,
        prepareMutationCapture: async () => {
          await issued.restoreWorkspaceProgress?.();
          await artifacts.prepare();
        },
        runEventListener: (event) => {
          artifacts.handleEvent(event);
        },
      },
      workspace: {
        filesystemRoot: checkout.filesystemRoot,
        workingBranch: checkout.workingBranch,
        startTreeId: checkout.startTreeId,
        artifactNamespace: `task-checkouts/${checkout.checkoutId}`,
      },
      artifacts,
      checkoutLifecycle,
      checkoutId: checkout.checkoutId,
      hooks: new ProductionHookOrchestrator(env, {
        userId,
        workspaceId,
        runId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
        workspaceRoot: checkout.filesystemRoot,
        prompt: payload.input.prompt,
        selectedMode: payload.input.mode === "plan" ? "plan" : "auto_edit",
        backendId: payload.input.executionBackend,
      }),
    };
  } catch (error) {
    try {
      await checkoutLifecycle.settle({
        status: "failed",
        failureCode: "RUN_PIPELINE_FAILED",
      });
    } finally {
      await checkoutLifecycle.release();
    }
    throw error;
  }
}
