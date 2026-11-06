import { SecureHarnessExecutionPort } from "./SecureHarnessExecutionPort";
import { readRunHarnessAdmission } from "./RunHarnessAdmission";
import {
  HarnessSelectionSchema,
  ProductModeSchema,
  RunSchema,
  TurnSchema,
  WorkerIdSchema,
  userIdFromExternalId,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type { DelegatedRunPreparationPort } from "./DelegatedRunExecution";
import type { Env } from "../types/ai";
import { DomainError } from "../domain/errors";
import { withTranscriptRepository } from "../services/sessions/TranscriptPersistenceFactory";
import { withRunRepository } from "../services/runs/RunPersistenceFactory";
import { withTurnAdmissionRepository } from "../services/turn-admissions/TurnAdmissionPersistenceFactory";
import { TaskCheckoutIssuer } from "./task-workspaces/TaskCheckoutIssuer";
import { TaskCheckoutExecutionOrchestrator } from "./task-workspaces/TaskCheckoutExecutionOrchestrator";
import { TaskCheckoutRunLifecycle } from "./task-workspaces/TaskCheckoutRunLifecycle";
import { SecureGitArtifactClient } from "../services/edit-artifacts/SecureGitArtifactClient";
import { SecureRuntimeGitSnapshotPort } from "../services/edit-artifacts/SecureRuntimeGitSnapshotPort";
import { CanonicalRuntimeTurnArtifactPort } from "../services/edit-artifacts/CanonicalRuntimeTurnArtifactPort";
import { WorkspaceBootstrapService } from "./services/WorkspaceBootstrapService";
import { ExecutionService } from "../services/ExecutionService";
import type { HarnessAdmissionPrincipal } from "./CloudHarnessAdmissionPorts";

/** Concrete Worker composition. The account, binding and execution capabilities
 * remain with P12/P13, P11 and P09. This class owns no provider loop or store. */
export class CloudDelegatedRunPreparation implements DelegatedRunPreparationPort {
  constructor(private readonly env: Env) {}

  async prepare({
    payload,
    claimId,
  }: Parameters<DelegatedRunPreparationPort["prepare"]>[0]): ReturnType<
    DelegatedRunPreparationPort["prepare"]
  > {
    const clientCapture = payload.input.harnessSelection,
      identity = payload.identity;
    if (
      !clientCapture?.selection ||
      !identity ||
      !payload.userId ||
      !payload.workspaceId ||
      !payload.input.repositoryContext
    )
      throw failure(
        "HARNESS_SELECTION_REQUIRED",
        "Delegated execution requires an owned saved conversation and repository selection",
        payload.correlationId,
      );
    const principal: HarnessAdmissionPrincipal = {
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      runAttemptId: identity.runAttemptId,
      runId: payload.runId,
      environmentId: clientCapture.environmentId,
    };
    const runtime = new SecureHarnessExecutionPort(this.env, {
      userId: principal.userId,
      workspaceId: principal.workspaceId,
      sessionId: principal.sessionId,
      runId: principal.runId,
      threadId: principal.threadId,
      turnId: principal.turnId,
      runAttemptId: principal.runAttemptId,
    });
    const productMode = ProductModeSchema.parse(
      payload.input.metadata?.permissionPolicy?.productMode ?? "ask_always",
    );
    // This is the real confinement owner, before any selected provider secret read.
    const policy = assertHostCapability(
      await runtime.capability(productMode, clientCapture),
      productMode,
      payload.correlationId,
    );
    const session = await withTranscriptRepository(
      this.env,
      async (repository) =>
        (await repository.listSessions(principal.userId)).sessions.find(
          (value) => value.id === principal.sessionId,
        ),
    );
    if (
      !session ||
      session.userId !== principal.userId ||
      session.workspaceId !== principal.workspaceId ||
      session.threadId !== principal.threadId ||
      !session.repository
    )
      throw failure(
        "HARNESS_SCOPE_CONFLICT",
        "Saved conversation ownership or canonical thread identity does not match",
        payload.correlationId,
      );
    const accounts = this.env.HARNESS_ADMISSION_ACCOUNTS,
      bindings = this.env.AUTH_HARNESS_ADMISSION_BINDINGS;
    if (!accounts || !bindings)
      throw failure(
        "HARNESS_AUTHORITY_UNAVAILABLE",
        "Canonical harness account/binding authorities are unavailable",
        payload.correlationId,
      );
    const admission = await withTurnAdmissionRepository(
      this.env,
      (repository) => repository.getByTurnId(principal.turnId),
    );
    const savedRun = await withRunRepository(this.env, (repository) =>
      repository.getRun(principal.runId, principal.userId),
    );
    if (
      !admission ||
      admission.state !== "admitted" ||
      admission.userId !== principal.userId ||
      admission.workspaceId !== principal.workspaceId ||
      admission.sessionId !== principal.sessionId ||
      admission.threadId !== principal.threadId ||
      admission.runAttemptId !== principal.runAttemptId ||
      admission.runId !== principal.runId ||
      !savedRun
    )
      throw failure(
        "HARNESS_ADMISSION_CONFLICT",
        "Canonical prompt admission does not match harness execution",
        payload.correlationId,
      );
    if (!admission.requestFingerprint)
      throw failure(
        "HARNESS_ADMISSION_CONFLICT",
        "Canonical admission has no immutable request fingerprint",
        payload.correlationId,
      );
    const requested = await readRunHarnessAdmission(this.env, payload);
    if (!requested?.selection)
      throw failure(
        "HARNESS_ADMISSION_CONFLICT",
        "Durable admission is not delegated",
        payload.correlationId,
      );
    const existing = await bindings.lookupImmutable(
      principal,
      requested,
      admission.requestFingerprint,
    );
    if (existing)
      throw failure(
        "TURN_EXECUTION_RECOVERY_REQUIRED",
        "This exact admission already has an immutable binding; use its explicit recovery path",
        payload.correlationId,
      );
    const facts = await accounts.resolveForAdmission(principal, requested);
    if (
      facts.harness !== requested.selection.harness ||
      facts.instanceId !== requested.selection.instanceId ||
      facts.connectionId !== requested.selection.connectionId ||
      facts.modelId !== requested.selection.modelId
    )
      throw failure(
        "HARNESS_SELECTION_CONFLICT",
        "Selected account/model differs from the owned selection revision",
        payload.correlationId,
      );
    if (!this.env.EDIT_ARTIFACTS)
      throw failure(
        "RUNTIME_ARTIFACT_STORE_UNAVAILABLE",
        "Immutable artifact storage is unavailable",
        payload.correlationId,
      );
    const issued = await new TaskCheckoutIssuer(this.env).issue(payload, {
      resumeSnapshot: payload.resumeSnapshotRef,
    });
    runtime.bindExecutionSession(issued.executionSession);
    const checkouts = new TaskCheckoutExecutionOrchestrator(this.env);
    const checkout = issued.checkout;
    const lifecycle = new TaskCheckoutRunLifecycle(
      checkout.checkoutId,
      checkouts,
      issued.executionSession,
    );
    let claimOwned = false;
    try {
      assertHostCapability(
        await runtime.capability(productMode, requested),
        productMode,
        payload.correlationId,
      );
      const {
        providerId: accountProviderId,
        capabilities,
        ...bindingFacts
      } = facts;
      const selection = HarnessSelectionSchema.parse({
        ...bindingFacts,
        userId: userIdFromExternalId(principal.userId),
        workspaceId: workspaceIdFromExternalId(principal.workspaceId),
        environmentId: principal.environmentId,
        selectionRevision: requested.selectionRevision,
        workspaceGrantId: checkout.snapshotId,
        threadId: principal.threadId,
        runId: principal.runId,
        turnId: principal.turnId,
        runAttemptId: principal.runAttemptId,
        policyId: policy.policyId,
        policyRevision: policy.policyRevision,
      });
      const claimed = await bindings.freezeAndClaim({
        principal,
        selection,
        claimId,
        expectedSelection: requested,
        admissionFingerprint: admission.requestFingerprint,
      });
      if (claimed !== "claimed")
        throw failure(
          "TURN_EXECUTION_RECOVERY_REQUIRED",
          "The admitted attempt already has an execution claim; no prompt will be resent",
          payload.correlationId,
        );
      claimOwned = true;
      const active = await checkouts.claimForExecution(
        {
          workspaceId: principal.workspaceId,
          threadId: principal.threadId,
          turnId: principal.turnId,
          runAttemptId: principal.runAttemptId,
        },
        payload.correlationId,
      );
      if (
        active.checkoutId !== checkout.checkoutId ||
        active.leaseId !== checkout.leaseId ||
        active.generation !== checkout.generation
      )
        throw failure(
          "HARNESS_CHECKOUT_CHANGED",
          "Canonical checkout changed during claim",
          payload.correlationId,
        );
      const assertActive = async () => {
        await accounts.assertForAttempt(principal, selection);
        await bindings.assertActive(principal, selection);
        const current = await checkouts.resolveActiveCheckout(
          {
            workspaceId: principal.workspaceId,
            threadId: principal.threadId,
            turnId: principal.turnId,
            runAttemptId: principal.runAttemptId,
          },
          payload.correlationId,
        );
        const lease = await issued.executionSession.acquire();
        if (
          current.checkoutId !== checkout.checkoutId ||
          current.leaseId !== checkout.leaseId ||
          current.generation !== checkout.generation ||
          lease.lease.leaseId !== checkout.leaseId ||
          lease.lease.generation !== checkout.generation ||
          lease.lease.sandboxId !== checkout.sandboxId
        )
          throw failure(
            "HARNESS_LEASE_CHANGED",
            "Frozen checkout lease/generation changed",
            payload.correlationId,
          );
      };
      await assertActive();
      lifecycle.beginRuntimeExecution({
        turnId: principal.turnId,
        runAttemptId: principal.runAttemptId,
      });
      const bootstrap = WorkspaceBootstrapService.fromEnv(
        this.env,
        principal.sessionId,
        principal.runId,
        principal.userId,
        issued.workspaceScope,
        new ExecutionService(
          this.env,
          principal.sessionId,
          principal.runId,
          principal.userId,
          issued.workspaceScope,
          issued.executionSession,
        ),
        {
          authorizedCommitId: issued.authorizedCommitId,
          workingBranch: checkout.workingBranch,
        },
      );
      const bootstrapped = await bootstrap.bootstrap({
        runId: principal.runId,
        repositoryContext: payload.input.repositoryContext,
        mode: payload.input.mode === "plan" ? "read_only" : "mutation",
      });
      if (bootstrapped.status !== "ready")
        throw failure(
          "HARNESS_WORKSPACE_BOOTSTRAP_FAILED",
          "Canonical pinned workspace bootstrap did not complete",
          payload.correlationId,
        );
      await issued.restoreWorkspaceProgress?.();
      const now = savedRun.createdAt;
      const workerId = WorkerIdSchema.parse(
        `worker_${(await digest(checkout.sandboxId)).slice(0, 48)}`,
      );
      const run = RunSchema.parse({
        id: principal.runId,
        threadId: principal.threadId,
        userId: selection.userId,
        workspaceId: selection.workspaceId,
        status: "running",
        mode: payload.input.mode === "plan" ? "plan" : "auto_edit",
        providerId: accountProviderId,
        modelId: selection.modelId,
        workerId,
        permissionProfileId: policy.policyId,
        harnessSelection: requested,
        executionCapability: "repository",
        startedAt: savedRun.startedAt ?? now,
        completedAt: null,
        createdAt: now,
        updatedAt: savedRun.updatedAt,
        lastEventSequence: 0,
      });
      const turn = TurnSchema.parse({
        id: principal.turnId,
        threadId: principal.threadId,
        runId: principal.runId,
        parentTurnId: identity.revisionOfTurnId ?? null,
        status: "queued",
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        lastEventSequence: 0,
      });
      const git = new SecureRuntimeGitSnapshotPort(
        new SecureGitArtifactClient(
          this.env,
          principal.sessionId,
          principal.runId,
          issued.workspaceScope,
          issued.executionSession,
        ),
        {
          bucket: this.env.EDIT_ARTIFACTS,
          userId: run.userId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          sourceRunId: run.id,
          sourceTurnId: turn.id,
          sourceRunAttemptId: principal.runAttemptId,
          baseSnapshotId: checkout.snapshotId,
          baseCommitSha: issued.authorizedCommitId,
        },
      );
      const base =
        payload.input.repositoryContext.baseUrl ?? "https://github.com";
      const manifest = {
        runId: run.id,
        workspaceId: run.workspaceId,
        repoOwner: payload.input.repositoryContext.owner!,
        repoName: payload.input.repositoryContext.repo!,
        repoUrl: `${base}/${payload.input.repositoryContext.owner}/${payload.input.repositoryContext.repo}`,
        baseBranch: payload.input.repositoryContext.branch ?? "dev",
        workingBranch: checkout.workingBranch,
        baseSha: issued.authorizedCommitId,
        headSha: issued.authorizedCommitId,
        executionLocation: "cloud_sandbox" as const,
        workerId,
        filesystemRoot: checkout.filesystemRoot,
        artifactNamespace: `task-checkouts/${checkout.checkoutId}`,
        permissionProfileId: policy.policyId,
        state: "ready" as const,
        lastError: null,
        createdAt: checkout.createdAt,
        updatedAt: checkout.createdAt,
      };
      const port = runtime;
      const open = port.open.bind(port);
      const harness = {
        open: async (input: Parameters<typeof open>[0]) => {
          await assertActive();
          const attached = await open(input);
          await bindings.attach({ principal, selection, session: attached });
          return attached;
        },
        execute: port.execute.bind(port),
        observeExisting: port.observeExisting.bind(port),
        control: port.control.bind(port),
        awaitQuiescence: port.awaitQuiescence.bind(port),
      };
      return {
        start: {
          run,
          turn,
          runAttemptId: principal.runAttemptId,
          continuationOfTurnId: identity.continuationOfTurnId,
          originalPromptId: identity.originalPromptId,
          execution: {
            kind: "delegated" as const,
            selection,
            leaseId: checkout.leaseId,
            prompt: payload.input.prompt,
            resumeSession: null,
          },
        },
        dependencies: {
          gitSnapshots: git,
          turnArtifacts: new CanonicalRuntimeTurnArtifactPort(this.env, {
            run,
            turnId: turn.id,
            runAttemptId: principal.runAttemptId,
            userId: principal.userId,
            workspaceId: principal.workspaceId,
            sessionId: principal.sessionId,
            issued,
            repoOwner: manifest.repoOwner,
            repoName: manifest.repoName,
            repoUrl: manifest.repoUrl,
          }),
          workspaceManifests: {
            getLatestByRunId: async (runId: typeof run.id) => {
              if (runId !== run.id) return null;
              await assertActive();
              return manifest;
            },
          },
          delegated: {
            harness,
            observations: bindings.observationsForAttempt(principal, selection),
            capabilities,
            assertActive,
          },
        },
        checkoutLifecycle: lifecycle,
      };
    } catch (error) {
      if (!claimOwned) throw error;
      try {
        await lifecycle.settle({
          status: "failed",
          failureCode: "HARNESS_PREPARATION_FAILED",
        });
      } finally {
        await lifecycle.release();
      }
      throw error;
    }
  }
}

function failure(
  code: string,
  message: string,
  correlationId: string,
): DomainError {
  return new DomainError(code, message, 409, false, correlationId);
}
async function digest(text: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function assertHostCapability(
  status: import("@repo/worker-protocol").HarnessServiceCapability,
  mode: import("@repo/platform-protocol").ProductMode,
  correlationId: string,
) {
  if (!status.available)
    throw failure(
      status.code ?? "cloud_harness_confinement_unavailable",
      "The cloud harness capability owner reports execution unavailable",
      correlationId,
    );
  if (
    !status.productModes?.includes(mode) ||
    !status.policyId ||
    !status.policyRevision
  )
    throw failure(
      "cloud_harness_policy_unavailable",
      "The cloud harness does not advertise an enforcing policy for this mode",
      correlationId,
    );
  return { policyId: status.policyId, policyRevision: status.policyRevision };
}
