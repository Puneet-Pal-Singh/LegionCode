import { snapshotExecutionDomain } from "@repo/worker-protocol/private/execution-domain";
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
import { parseNativeProviderBindingForAdmission } from "@repo/persistence";
import type { NativeProviderCredentialContext } from "../services/providers/NativeProviderCredentialResolver";
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
import type { NativePreparationCleanupReceipt } from "./RetainedNativeAttempt";

interface RuntimeExecutionResources {
  readonly agent: IAgent | undefined;
  readonly runEngineDeps: RunEngineDependencies;
  readonly drainProviderRequests: () => Promise<void>;
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
  nativeCredentials?: NativeProviderCredentialContext,
  failureCleanup?: (receipt: NativePreparationCleanupReceipt) => void,
): Promise<RuntimeExecutionResources> {
  let exposurePossible = false;
  try {
    return await prepareOwnedRuntimeResources(ctx, env, payload, nativeCredentials, {
      expose: () => { exposurePossible = true; }, closed: receipt => failureCleanup?.(receipt),
    });
  } catch (error) {
    if (!exposurePossible) failureCleanup?.({ kind: "no_exposure" });
    throw error;
  }
}

async function prepareOwnedRuntimeResources(
  ctx: unknown, env: Env, payload: ExecuteRunPayload,
  nativeCredentials: NativeProviderCredentialContext | undefined,
  ownership: { expose(): void; closed(receipt: NativePreparationCleanupReceipt): void },
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
  if (workspaceIdFromExternalId(identity.workspaceId) !== workspaceIdFromExternalId(workspaceId)) {
    throw new DomainError("RUN_SCOPE_MISMATCH", "The turn workspace does not match its execution workspace.", 409, false, payload.correlationId);
  }
  if (!nativeCredentials) throw new Error("Native execution requires its claimed provider binding");
  const expectedScope = { userId, workspaceId, sessionId, runId,
    threadId: identity.threadId, turnId: identity.turnId, runAttemptId: identity.runAttemptId };
  // Validate the stored binding against the actual execution tuple, then ensure
  // its private context names that same tuple. Context echoes grant no authority.
  parseNativeProviderBindingForAdmission(nativeCredentials.binding, expectedScope);
  parseNativeProviderBindingForAdmission(nativeCredentials.binding, nativeCredentials.scope);
  const claimedExecutionScope = Object.freeze({ ...nativeCredentials.scope });
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
        nativeProviderCredentials: nativeCredentials,
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
  // Classification is not physical qualification. No trusted Native acquire
  // producer currently proves per-attempt bootstrap/provenance before Ready.
  // Keep this gate before issuance and paid dependencies until that owner joins.
  rejectUnavailableNativePhysicalPreparation(payload.correlationId);
  const orchestrator = new TaskCheckoutExecutionOrchestrator(env);
  ownership.expose();
  const issued = await new TaskCheckoutIssuer(env).issueAdmitted(payload, {
    resumeSnapshot: payload.resumeSnapshotRef,
    failureCleanup: ownership.closed,
    beforeSessionAcquire: async ({ snapshot, workspaceScope }) => {
      const claimed = claimedExecutionScope;
      if (
        snapshot.workspaceId !== workspaceScope.workspaceId ||
        workspaceScope.workspaceId !==
          workspaceIdFromExternalId(claimed.workspaceId) ||
        workspaceScope.threadId !== claimed.threadId ||
        workspaceScope.turnId !== claimed.turnId ||
        workspaceScope.runAttemptId !== claimed.runAttemptId
      ) {
        throw new DomainError(
          "RUN_SCOPE_MISMATCH",
          "The claimed Native execution does not own this checkout.",
          409,
          false,
          payload.correlationId,
        );
      }
      return snapshotExecutionDomain({
        version: 1,
        domain: "legioncode_native",
        scope: {
          userId: claimed.userId,
          brainSessionId: claimed.sessionId,
          workspaceId: workspaceScope.workspaceId,
          runId: claimed.runId,
          threadId: claimed.threadId,
          turnId: claimed.turnId,
          runAttemptId: claimed.runAttemptId,
        },
      });
    },
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
    // The claim response may have been lost after activation; without a
    // checkout settlement receipt this preparation remains unknown.
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
      nativeProviderCredentials: nativeCredentials,
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
      drainProviderRequests: dependencies.drainProviderRequests,
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
    // A void secure release can include a missing-session response. Without
    // an exact physical closure receipt, failed exposed preparation stays unknown.
    throw error;
  }
}

function rejectUnavailableNativePhysicalPreparation(correlationId: string): void {
  throw new DomainError(
    "NATIVE_PHYSICAL_PREPARATION_UNAVAILABLE",
    "Qualified Native cloud workspace preparation is unavailable.",
    503,
    false,
    correlationId,
  );
}
