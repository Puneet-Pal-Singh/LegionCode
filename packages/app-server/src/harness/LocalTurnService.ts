import { randomUUID } from "node:crypto";
import {
  ChatRequestBodySchema, HarnessSelectionSchema, RunSchema, TurnSchema, ThreadItemSchema, RunIdSchema, ItemIdSchema,
  createTurnId, createRunAttemptId,
  type ChatRequestBody, type HostedChatSubmissionResult, type HarnessNextSelection,
  type HarnessSelection, type Thread, type TurnId, type Run, type LeaseId,
  type SubmitLifecycleApprovalRequest, type LifecycleEvent, type InterruptTurnResponse,
  type GetTurnDiffRequest, type GetTurnDiffResponse, type TurnDiffPayload,
} from "@repo/platform-protocol";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol/conversation";
import type { LocalPersistence, StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import { RuntimeKernel, RuntimeKernelError, RuntimeLifecycleCoordinator,
  type RuntimeKernelDependencies, type DelegatedExecutionDependencies } from "@repo/runtime-kernel";
import type { CodexDriver } from "@repo/harness-codex/server";
import type { OpenCodeV2Driver } from "@repo/harness-opencode/server";
import type { HarnessExecutionPort, HarnessInstanceScope, createHarnessHost } from "@repo/harness-core/server";
import { LocalTurnStartParamsSchema, type LocalTurnStartParams, type LocalTurnInterruptParams, type LocalThreadHistoryParams, type LocalThreadHistoryResult } from "@legioncode/app-server/protocol";
import { z } from "zod";
import { AppServerOperationError } from "../server.js";
import type { LocalThreadService } from "../local-threads.js";
import type { LocalWorkspaceService } from "../local-workspace.js";
import type { LocalWorkspaceLease } from "./LocalWorkspaceLease.js";
import type { LocalHarnessOperations } from "./LocalHarnessOperations.js";
import type { HarnessOperations } from "./HarnessOperations.js";
import { reconcileLocalHarnessRestart } from "./LocalHarnessRestart.js";

type HostConfiguration = Omit<Parameters<typeof createHarnessHost>[0], "workspaceRoot">;
/** Private in-process composition over canonical ports. Never a renderer/HTTP/IPC payload. */
export interface LocalHarnessRuntimeBinding {
  readonly scope: HarnessInstanceScope;
  readonly providerId: Run["providerId"];
  readonly workerId: Run["workerId"];
  readonly permissionProfileId: Run["permissionProfileId"];
  readonly mode: Run["mode"];
  readonly policyRevision: HarnessSelection["policyRevision"];
  readonly billingSource: HarnessSelection["billingSource"];
  readonly codexExecutable?: string;
  readonly codexOptions?: NonNullable<ConstructorParameters<typeof CodexDriver>[1]>;
  readonly openCodeOptions?: ConstructorParameters<typeof OpenCodeV2Driver>[0];
  readonly configureHost: (command: Parameters<import("@repo/harness-core/server").HarnessInstance["createHost"]>[0]) => Promise<HostConfiguration>;
  /** Uses the already frozen selection/claim and held local lease. Supplies the
   * canonical workspace/custody adapters and enforcing host policy. Local
   * composition owns observation commits, Git snapshots and immutable artifacts.
   * Preparation must not start a provider.
   */
  prepare(input: { readonly admission: TurnAdmission; readonly selection: HarnessSelection;
    readonly grant: StoredLocalWorkspaceGrant; readonly leaseId: LeaseId; readonly signal: AbortSignal }): Promise<{
      readonly leaseId: LeaseId;
      readonly dependencies: Omit<RuntimeKernelDependencies, "lifecycleEvents" | "delegated">;
      readonly execution: Omit<DelegatedExecutionDependencies, "harness" | "observations">;
      /** Existing binding/lease authority prepares the protected old-generation
       * host, committed observation delivery and durable fence. No provider restart.
       * Local composition always supplies the canonical integrity resolver itself.
       */
      readonly prepareRecovery?: () => Promise<Omit<Parameters<HarnessExecutionPort["reconcilePriorGeneration"]>[0], "resolveObservationIntegrity"> | null>;
    }>;
}
export interface LocalHarnessRuntimeServices {
  /** Optional supported catalog and verified local health readers only.
   * Setup/selection and durable identities belong to the constructor's actual
   * same-writer control-plane module, independently of credential bootstrap.
   */
  readonly operations: Partial<Pick<HarnessOperations, "models" | "status">>;
  /** Existing main/vault or provider-owned local reference authority. Safe metadata reads only. */
  resolveBinding(input: { readonly selection: HarnessNextSelection; readonly thread: Thread;
    readonly grant: StoredLocalWorkspaceGrant }): Promise<LocalHarnessRuntimeBinding>;
}
interface ActiveExecution {
  readonly admission: TurnAdmission;
  readonly controller: AbortController;
  runtime?: RuntimeKernel;
  task?: Promise<void>;
}

/** Local admission and task composition; the kernel is the sole lifecycle/approval/artifact owner. */
export class LocalTurnService {
  private readonly active = new Map<TurnId, ActiveExecution>();
  private startup: Promise<void> | undefined;
  constructor(private readonly options: {
    readonly persistence: LocalPersistence;
    readonly threads: LocalThreadService;
    readonly workspace: LocalWorkspaceService;
    readonly leases: LocalWorkspaceLease;
    readonly harnessOperations: LocalHarnessOperations;
    readonly settleExecution: (admission: TurnAdmission) => Promise<void>;
    readonly resolveBinding: LocalHarnessRuntimeServices["resolveBinding"];
    readonly readDiff: (turnId: TurnId) => Promise<TurnDiffPayload | null>;
    readonly recoverExecution: (runtime: RuntimeKernel, input: Omit<Parameters<HarnessExecutionPort["reconcilePriorGeneration"]>[0], "resolveObservationIntegrity">) => Promise<unknown>;
    readonly composeRuntime: (binding: LocalHarnessRuntimeBinding,
      prepared: Awaited<ReturnType<LocalHarnessRuntimeBinding["prepare"]>>,
      selection: HarnessSelection) => RuntimeKernel;
  }) {}

  initialize(): Promise<void> {
    return this.startup ??= reconcileLocalHarnessRestart(this.options.persistence);
  }

  async startTurn(params: LocalTurnStartParams, captured?: NonNullable<ChatRequestBody["harnessSelection"]>): Promise<TurnAdmission> {
    await this.initialize();
    params = LocalTurnStartParamsSchema.parse(params);
    const thread = await this.authorizeThread(params.threadId, params.workspaceId);
    if (thread.status !== "active") throw new AppServerOperationError(409, "invalid_request", "Local thread is archived");
    const previous = await this.options.persistence.turnAdmissions.findByRequest(thread.id, params.clientRequestId);
    if (previous) {
      if (previous.userMessage.type !== "user_message" || previous.userMessage.content.text !== params.prompt) {
        throw new AppServerOperationError(409, "invalid_request", "Local submission identity already has different content");
      }
      if (captured && JSON.stringify(ChatRequestBodySchema.parse({ harnessSelection: previous.userMessage.content.harnessSelection }).harnessSelection) !== JSON.stringify(captured)) {
        throw new AppServerOperationError(409, "invalid_request", "Local submission identity already has a different captured harness selection");
      }
      return previous; // Never restart an admitted or ambiguously delivered prompt.
    }
    return this.options.harnessOperations.withSelection({
      environmentId: this.options.persistence.environmentId, workspaceId: thread.workspaceId,
      threadId: thread.id, sessionId: thread.id,
    }, async (saved) => {
      if (captured && (captured.environmentId !== this.options.persistence.environmentId ||
          captured.selectionRevision !== saved.revision || JSON.stringify(captured.selection) !== JSON.stringify(saved.selection))) {
        throw new AppServerOperationError(409, "invalid_request", "Local harness selection changed before admission");
      }
      if (!saved.selection) throw new AppServerOperationError(503, "server_unavailable", "Select a configured local harness before starting a delegated turn");
      const grant = await this.options.workspace.requireExecutionGrant(thread.workspaceId);
      const binding = await this.options.resolveBinding({ selection: saved.selection, thread, grant });
      const scope = binding.scope;
      if (scope.userId !== thread.userId || scope.workspaceId !== thread.workspaceId ||
          scope.environmentId !== this.options.persistence.environmentId || scope.harness !== saved.selection.harness ||
          scope.instanceId !== saved.selection.instanceId || scope.connectionId !== saved.selection.connectionId) {
        throw new AppServerOperationError(403, "unauthorized", "Local runtime binding does not match the selected account and workspace");
      }
      if (scope.harness === "codex" && (binding.billingSource === "api_key" || !binding.codexOptions?.accountBinding)) {
        throw new AppServerOperationError(503, "server_unavailable", "The selected Codex account identity is not verifiable for this authentication route", "LOCAL_CODEX_ACCOUNT_UNVERIFIED", false);
      }
      const admission = this.createAdmission(params, thread, binding, saved.selection, {
        environmentId: this.options.persistence.environmentId, selectionRevision: saved.revision, selection: saved.selection,
      });
      const selection = HarnessSelectionSchema.parse({ ...scope, selectionRevision: saved.revision, threadId: thread.id, runId: admission.run.id,
        turnId: admission.turn.id, runAttemptId: admission.runAttemptId, modelId: admission.run.modelId,
        policyId: binding.permissionProfileId, policyRevision: binding.policyRevision, billingSource: binding.billingSource });
      // Revalidate after protected metadata resolution; writer independently validates Thread ownership.
      await this.authorizeThread(thread.id, thread.workspaceId);
      const stored = await this.options.leases.admit(admission);
      if (!stored.newlyAdmitted) return stored.admission;
      const execution: ActiveExecution = { admission: stored.admission, controller: new AbortController() };
      this.active.set(admission.turn.id, execution); // Immediate Stop owns this before preparation yields.
      execution.task = this.run(execution, binding, selection, grant);
      void execution.task.catch(() => undefined); // Failures are canonical events/recovery, never raw secret-bearing logs.
      return stored.admission;
    });
  }

  /** Adapter for the existing placement-neutral submission envelope; no hosted principal/cookie. */
  async execute(params: ChatRequestBody): Promise<HostedChatSubmissionResult> {
    if (params.identity || params.runId || params.orchestratorBackend || params.executionBackend || params.tools ||
        params.providerId || params.modelId || params.agentId || params.authMode || params.harnessId ||
        (params.harnessMode !== undefined && params.harnessMode !== "delegated")) {
      throw new AppServerOperationError(400, "invalid_request", "Local submission uses its local Thread and saved harness selection");
    }
    const message = z.array(z.object({ role: z.literal("user"), content: z.string(), id: z.string().optional() }).strict()).length(1).parse(params.messages);
    const workspace = await this.options.workspace.getCurrent();
    if (!workspace || !params.sessionId || !params.clientMessageId) {
      throw new AppServerOperationError(400, "invalid_request", "Local submission requires its Thread and client message identity");
    }
    const admission = await this.startTurn({ workspaceId: workspace.workspaceId,
      threadId: (await this.options.threads.get(params.sessionId)).id,
      clientRequestId: params.clientMessageId, prompt: message[0]!.content }, params.harnessSelection);
    return { runtimeStatus: 202, runId: admission.run.id, threadId: admission.run.threadId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId };
  }

  async getTurn(turnId: TurnId): Promise<TurnAdmission> {
    const admission = await this.options.persistence.turnAdmissions.getByTurn(turnId);
    if (!admission) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
    await this.authorizeThread(admission.run.threadId, admission.run.workspaceId);
    return admission;
  }
  async getTurnDiff(params: GetTurnDiffRequest): Promise<GetTurnDiffResponse> {
    if (params.backend && params.backend !== "execution-engine-v1") throw new AppServerOperationError(400, "invalid_request", "Hosted execution backends are unavailable locally");
    await this.getTurn(params.turnId);
    return { diff: await this.options.readDiff(params.turnId) };
  }
  async readHistory(params: LocalThreadHistoryParams): Promise<LocalThreadHistoryResult> {
    await this.authorizeThread(params.threadId, params.workspaceId);
    const page = await this.options.persistence.turnAdmissions.listByThread({
      threadId: params.threadId, afterCursor: params.afterCursor ?? null, limit: params.limit ?? 100,
    });
    return { admissions: [...page.admissions], nextCursor: page.nextCursor };
  }
  async interruptTurn(params: LocalTurnInterruptParams): Promise<InterruptTurnResponse> {
    const admission = await this.getTurn(params.turnId);
    if (admission.run.id !== params.runId || admission.run.threadId !== params.threadId ||
        admission.run.workspaceId !== params.workspaceId || admission.runAttemptId !== params.runAttemptId) {
      throw new AppServerOperationError(403, "unauthorized", "Local Stop identity does not match admission");
    }
    const execution = this.active.get(params.turnId);
    if (!execution) throw new AppServerOperationError(409, "server_unavailable", "Local turn has no live owner; reconcile canonical replay", "LOCAL_RUNTIME_RECOVERY_REQUIRED", false);
    execution.controller.abort(new DOMException(params.reason, "AbortError"));
    if (execution.runtime) {
      execution.runtime.requestInterruptBeforeStart(params.turnId, params.reason);
      try { await execution.runtime.interruptTurn(params.turnId, params.reason); }
      catch (error) { if (!(error instanceof RuntimeKernelError) || error.code !== "turn_not_active") throw error; }
    }
    return { runId: params.runId, accepted: true, status: "interrupt_requested" };
  }
  async submitLifecycleApproval(params: SubmitLifecycleApprovalRequest): Promise<LifecycleEvent> {
    if (params.backend && params.backend !== "execution-engine-v1") throw new AppServerOperationError(400, "invalid_request", "Hosted execution backends are unavailable locally");
    const admission = await this.getTurn(params.turnId);
    if (params.decidedBy !== null && params.decidedBy !== admission.run.userId) throw new AppServerOperationError(403, "unauthorized", "Approval actor does not own the local turn");
    const runtime = this.active.get(params.turnId)?.runtime;
    if (!runtime) throw new AppServerOperationError(409, "server_unavailable", "Local approval has no live runtime owner");
    await runtime.resolveApproval(params.turnId, params.approvalId, {
      decision: params.decision, decidedBy: admission.run.userId, reason: params.reason, grantScope: params.grantScope === "matching_in_chat" ? params.grantScope : undefined,
    });
    let afterSequence: number | null = null;
    for (let page = 0; page < 100; page += 1) {
      const replay = await this.options.persistence.lifecycleEvents.replay({ turnId: params.turnId, afterSequence, limit: 1000 });
      const event = replay.events.find((value) => value.type === "approval.decided" && value.approvalId === params.approvalId);
      if (event) return event;
      if (replay.nextSequence === null || replay.nextSequence === afterSequence) break;
      afterSequence = replay.nextSequence;
    }
    throw new AppServerOperationError(503, "server_unavailable", "Canonical approval decision could not be read");
  }
  get hasActiveExecutions(): boolean { return this.active.size > 0; }
  hasExecutionOwner(turnId: TurnId): boolean { return this.active.has(turnId); }
  async shutdown(): Promise<void> {
    for (const execution of this.active.values()) execution.controller.abort();
    await Promise.all([...this.active.values()].map((execution) => execution.task));
  }

  private async run(execution: ActiveExecution, binding: LocalHarnessRuntimeBinding,
    selection: HarnessSelection, grant: StoredLocalWorkspaceGrant): Promise<void> {
    let prepared: Awaited<ReturnType<LocalHarnessRuntimeBinding["prepare"]>> | undefined;
    try {
      const frozen = await this.options.persistence.harnessBindings.freezeAndClaim({
        selection: { userId: selection.userId, sessionId: selection.threadId, runId: selection.runId,
          workspaceId: selection.workspaceId, threadId: selection.threadId, turnId: selection.turnId,
          runAttemptId: selection.runAttemptId, selectionJson: JSON.stringify(selection) },
        claimId: execution.admission.runAttemptId,
      });
      if (frozen.status !== "claimed") throw new AppServerOperationError(409, "server_unavailable",
        "Local harness execution was already claimed or requires recovery", "LOCAL_RUNTIME_RECOVERY_REQUIRED", false);
      const leaseId = this.options.leases.leaseId(execution.admission);
      prepared = await binding.prepare({ admission: execution.admission, selection, grant, leaseId, signal: execution.controller.signal });
      if (prepared.dependencies.producerId !== execution.admission.run.workerId) {
        throw new Error("Prepared local runtime producer does not match the admitted worker");
      }
      if (prepared.leaseId !== leaseId) throw new Error("Prepared runtime returned a different local checkout lease");
      if (execution.controller.signal.aborted) throw new DOMException("Local turn stopped before runtime start", "AbortError");
      const dependencies = { ...prepared.dependencies,
        signal: prepared.dependencies.signal ? AbortSignal.any([prepared.dependencies.signal, execution.controller.signal]) : execution.controller.signal };
      execution.runtime = this.options.composeRuntime(binding, { ...prepared, dependencies }, selection);
      const history = await this.options.persistence.lifecycleEvents.replay({
        turnId: execution.admission.turn.id, afterSequence: null, limit: 1,
      });
      if (history.events.length > 0) throw new AppServerOperationError(409, "server_unavailable",
        "Local attempt already has lifecycle history; explicit recovery is required", "LOCAL_RUNTIME_RECOVERY_REQUIRED", false);
      // The admission's platform stream sequence is not a lifecycle sequence.
      // Only a newly claimed attempt with an empty lifecycle may start at zero.
      await execution.runtime.startTurn({ run: execution.admission.run,
        turn: { ...execution.admission.turn, lastEventSequence: 0 },
        runAttemptId: execution.admission.runAttemptId,
        execution: { kind: "delegated", selection, leaseId: prepared.leaseId,
          prompt: this.prompt(execution.admission), resumeSession: null } });
    } catch (error) {
      if (execution.runtime && prepared?.prepareRecovery) {
        const recovery = await prepared.prepareRecovery();
        if (recovery) {
          if (JSON.stringify(recovery.command.selection) !== JSON.stringify(selection) ||
              recovery.command.leaseId !== this.options.leases.leaseId(execution.admission) ||
              recovery.command.filesystemRoot !== grant.path) throw new Error("Local recovery does not match admitted execution");
          await this.options.recoverExecution(execution.runtime, recovery);
        }
      }
      {
        const history = await this.options.persistence.lifecycleEvents.replay({ turnId: execution.admission.turn.id, afterSequence: null, limit: 1 });
        if (history.events.length === 0) {
          const lifecycle = new RuntimeLifecycleCoordinator({ threadId: execution.admission.run.threadId,
            workspaceId: execution.admission.run.workspaceId, turnId: execution.admission.turn.id,
            runAttemptId: execution.admission.runAttemptId, producerId: execution.admission.run.workerId,
            executionCapability: execution.admission.run.executionCapability,
            sink: this.options.persistence.lifecycleEvents, clock: { now: () => new Date().toISOString() } });
          await lifecycle.start();
          if (execution.controller.signal.aborted) await lifecycle.interrupt("Local turn stopped before external execution");
          else await lifecycle.fail({ code: "internal_error", message: "Local runtime preparation failed", retryable: false, correlationId: null, details: null });
        }
      }
      throw error;
    } finally {
      await this.options.settleExecution(execution.admission); // Unknown retains the live/durable owner.
      this.active.delete(execution.admission.turn.id);
    }
  }
  private async authorizeThread(threadId: Thread["id"], workspaceId: Thread["workspaceId"]): Promise<Thread> {
    const thread = await this.options.threads.get(threadId);
    if (thread.workspaceId !== workspaceId) throw new AppServerOperationError(403, "unauthorized", "Local turn workspace does not match its Thread");
    await this.options.workspace.requireExecutionGrant(workspaceId);
    return thread;
  }
  private prompt(admission: TurnAdmission): string {
    if (admission.userMessage.type !== "user_message" || typeof admission.userMessage.content.text !== "string") {
      throw new AppServerOperationError(409, "invalid_request", "Local admission has no canonical text prompt");
    }
    return admission.userMessage.content.text;
  }
  private createAdmission(params: LocalTurnStartParams, thread: Thread, binding: LocalHarnessRuntimeBinding,
    next: HarnessNextSelection, intent: NonNullable<ChatRequestBody["harnessSelection"]>): TurnAdmission {
    const now = new Date().toISOString();
    const runId = RunIdSchema.parse(`run_${randomUUID().replaceAll("-", "")}`);
    const turnId = createTurnId();
    return TurnAdmissionSchema.parse({ clientRequestId: params.clientRequestId, runAttemptId: createRunAttemptId(),
      run: RunSchema.parse({ id: runId, threadId: thread.id, userId: thread.userId, workspaceId: thread.workspaceId,
        status: "queued", harnessSelection: intent, mode: binding.mode, providerId: binding.providerId, modelId: next.modelId,
        workerId: binding.workerId, permissionProfileId: binding.permissionProfileId, executionCapability: "repository",
        startedAt: null, completedAt: null, createdAt: now, updatedAt: now, lastEventSequence: 1 }),
      turn: TurnSchema.parse({ id: turnId, threadId: thread.id, runId, parentTurnId: null, status: "queued",
        startedAt: null, completedAt: null, createdAt: now, updatedAt: now, lastEventSequence: 1 }),
      userMessage: ThreadItemSchema.parse({ id: ItemIdSchema.parse(`itm_${randomUUID().replaceAll("-", "")}`),
        threadId: thread.id, runId, turnId, parentItemId: null, branchId: null, role: "user", type: "user_message",
        status: "completed", createdAt: now, completedAt: now, eventSequence: 1, content: { text: params.prompt, harnessSelection: intent } }),
    });
  }
}
