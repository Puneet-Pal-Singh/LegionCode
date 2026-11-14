import { randomUUID } from "node:crypto";
import {
  ChatRequestBodySchema, HarnessSelectionSchema, RunSchema, TurnSchema, ThreadItemSchema, RunIdSchema, ItemIdSchema,
  createTurnId, createRunAttemptId, normalizeUserInputResponse, SubmitUserInputResponseRequestSchema,
  type SubmitUserInputResponseRequest,
  type ChatRequestBody, type HostedChatSubmissionResult, type HarnessNextSelection,
  type HarnessSelection, type Thread, type TurnId, type Run, type LeaseId,
  type SubmitLifecycleApprovalRequest, type LifecycleEvent, type InterruptTurnResponse,
  type GetTurnDiffRequest, type GetTurnDiffResponse, type TurnDiffPayload,
} from "@repo/platform-protocol";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol/conversation";
import type { LocalPersistence, StoredLocalWorkspaceGrant } from "@repo/event-store/local";
import { RuntimeKernel, RuntimeKernelError,
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
import type { LocalPhysicalAdmissionCandidate, LocalPhysicalAdmissionCandidates, LocalPhysicalAdmissionPublication, LocalPhysicalAdmissionRecovery } from "../local-physical-admission-candidates.js";
import type { StoredHarnessPreparation } from "@repo/event-store";
import type { StoredHarnessBinding } from "@repo/event-store";
import { settleLocalHarnessBeforeDispatch } from "./LocalHarnessPreOpeningSettlement.js";
import type { LocalHarnessOperations } from "./LocalHarnessOperations.js";
import type { HarnessOperations } from "./HarnessOperations.js";
import { reconcileLocalHarnessRestart, localAdmissionBackend, type LocalHarnessInitializationResult, type LocalHarnessBackend } from "./LocalHarnessRestart.js";

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
  /** No effects during construction. The caller retains this operation before
   * begin CAS and schedules start only after its original promise is registered. */
  prepare(input: { readonly admission: TurnAdmission; readonly selection: HarnessSelection;
    readonly grant: StoredLocalWorkspaceGrant; readonly leaseId: LeaseId; readonly signal: AbortSignal;
    readonly physical: Extract<LocalPhysicalAdmissionPublication, { disposition: "execution" }> }): LocalHarnessPreparation;
}
export interface LocalHarnessPreparedRuntime {
  readonly leaseId: LeaseId;
  readonly dependencies: Omit<RuntimeKernelDependencies, "lifecycleEvents" | "delegated">;
  readonly execution: Omit<DelegatedExecutionDependencies, "harness" | "observations">;
  readonly prepareRecovery?: () => Promise<Omit<Parameters<HarnessExecutionPort["reconcilePriorGeneration"]>[0], "resolveObservationIntegrity"> | null>;
}
export interface LocalHarnessPreparation {
  start(): Promise<LocalHarnessPreparedRuntime>;
  /** Fence the original preparation resources; Stop acceptance is not closure. */
  requestStop(): void;
  /** Fence/drain original preparation, settle a preparation failure through the
   * existing runtime/Git/artifact ports under the held lease, invoke canonical
   * attachment settlement, THEN release the original physical binding/lease.
   * A missing artifact or unknown physical result is never success. */
  settle(input: {
    readonly preparationFailure: "failed" | "interrupted" | null;
    readonly settleCanonical: () => Promise<void>;
  }): Promise<boolean>;

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
export interface LocalHarnessShutdownResult {
  readonly status: "settled";
  readonly retainedTurnIds: readonly TurnId[];
}
export class LocalHarnessRecoveryError extends Error {
  readonly result: LocalHarnessInitializationResult;
  constructor(retainedTurnIds: readonly TurnId[]) {
    super("Local harness retains unresolved physical or durable ownership");
    this.name = "LocalHarnessRecoveryError";
    this.result = { status: "recovery_required", retainedTurnIds };
  }
}

interface ActiveExecution {
  readonly admission: TurnAdmission;
  readonly controller: AbortController;
  runtime?: RuntimeKernel;
  interruptRequested?: boolean;
  preparationFailure?: "failed" | "interrupted";
  candidate?: LocalPhysicalAdmissionCandidate;
  publication?: Promise<LocalPhysicalAdmissionPublication>;
  recovery?: LocalPhysicalAdmissionRecovery;
  preparation?: LocalHarnessPreparation;
  preparationResult?: Promise<LocalHarnessPreparedRuntime>;
  preparationBegun?: boolean;
  settlement?: Promise<boolean>;
  canonicalSettlement?: Promise<void>;
  preOpeningSettlement?: Promise<boolean>;
  task?: Promise<void>;
}

/** Local admission and task composition; the kernel is the sole lifecycle/approval/artifact owner. */
export class LocalTurnService {
  private readonly active = new Map<TurnId, ActiveExecution>();
  private startup: Promise<LocalHarnessInitializationResult> | undefined;
  private stopping = false;
  private readonly admissions = new Set<Promise<TurnAdmission>>();
  constructor(private readonly options: {
    readonly persistence: LocalPersistence;
    readonly threads: LocalThreadService;
    readonly workspace: LocalWorkspaceService;
    readonly leases: LocalWorkspaceLease;
    readonly harnessOperations: LocalHarnessOperations;
    readonly physicalCandidates?: LocalPhysicalAdmissionCandidates;
    readonly settleExecution: (admission: TurnAdmission) => Promise<void>;
    readonly resolveBinding: LocalHarnessRuntimeServices["resolveBinding"];
    readonly readDiff: (turnId: TurnId) => Promise<TurnDiffPayload | null>;
    readonly recoverExecution: (runtime: RuntimeKernel, input: Omit<Parameters<HarnessExecutionPort["reconcilePriorGeneration"]>[0], "resolveObservationIntegrity">) => Promise<unknown>;
    readonly composeRuntime: (binding: LocalHarnessRuntimeBinding,
      prepared: LocalHarnessPreparedRuntime,
      selection: HarnessSelection) => RuntimeKernel;
  }) {}

  initialize(): Promise<LocalHarnessInitializationResult> {
    if (this.startup) return this.startup;
    const original = reconcileLocalHarnessRestart(this.options.persistence, this.options.leases,
      (admission, binding, preparation) => this.recoverUnbegun(admission, binding, preparation));
    this.startup = original;
    void original.then((result) => {
      if (result.status === "recovery_required" && this.startup === original) this.startup = undefined;
    }, () => {
      // A later explicit read may retry durable evidence, never recreate an
      // active original acquisition or dispatch an ambiguously accepted prompt.
      if (this.startup === original) this.startup = undefined;
    });
    return original;
  }

  startTurn(params: LocalTurnStartParams, captured?: NonNullable<ChatRequestBody["harnessSelection"]>): Promise<TurnAdmission> {
    if (this.stopping) return Promise.reject(new AppServerOperationError(503, "server_unavailable", "Local harness is shutting down"));
    const admission = this.admitTurn(params, captured);
    this.admissions.add(admission);
    void admission.then(() => this.admissions.delete(admission), () => this.admissions.delete(admission));
    return admission;
  }

  private async admitTurn(params: LocalTurnStartParams, captured?: NonNullable<ChatRequestBody["harnessSelection"]>): Promise<TurnAdmission> {
    // Newer local Native envelopes may carry media/provider expectations. This
    // delegated text port must reject them explicitly, never drop their intent.
    if ("images" in params && params.images !== undefined &&
        (!Array.isArray(params.images) || params.images.length > 0)) {
      throw new AppServerOperationError(400, "invalid_request", "Local delegated harness input is text-only; images are unsupported");
    }
    if ("expectedSelection" in params && params.expectedSelection !== undefined) {
      throw new AppServerOperationError(400, "invalid_request", "Native provider expectations cannot configure a delegated harness");
    }
    params = LocalTurnStartParamsSchema.parse(params);
    this.assertSupportedConfiguration(params);
    const initialization = await this.initialize();
    const thread = await this.authorizeThread(params.threadId, params.workspaceId);
    if (thread.status !== "active") throw new AppServerOperationError(409, "invalid_request", "Local thread is archived");
    const previous = await this.options.persistence.turnAdmissions.findByRequest(thread.id, params.clientRequestId);
    if (previous) {
      if (previous.userMessage.type !== "user_message" || previous.userMessage.content.text !== params.prompt) {
        throw new AppServerOperationError(409, "invalid_request", "Local submission identity already has different content");
      }
      if (localAdmissionBackend(previous, this.options.persistence.environmentId) !== "delegated") {
        throw new AppServerOperationError(409, "invalid_request", "Local submission identity belongs to the native backend");
      }
      if (JSON.stringify(ChatRequestBodySchema.parse({ harnessSelection: previous.userMessage.content.harnessSelection }).harnessSelection) !== JSON.stringify(captured)) {
        throw new AppServerOperationError(409, "invalid_request", "Local submission identity already has a different captured harness selection");
      }
      return previous; // Never restart an admitted or ambiguously delivered prompt.
    }
    if (initialization.status === "recovery_required") throw new LocalHarnessRecoveryError(initialization.retainedTurnIds);
    if (!captured?.selection) throw new AppServerOperationError(409, "invalid_request", "Delegated admission requires an explicit captured harness selection");
    return this.options.harnessOperations.withSelection({
      environmentId: this.options.persistence.environmentId, workspaceId: thread.workspaceId,
      threadId: thread.id, sessionId: thread.id,
    }, async (saved) => {
      const retainedAdmissions = [...this.active.values()].filter((value) => !value.task).map((value) => value.admission.turn.id);
      if (retainedAdmissions.length) throw new LocalHarnessRecoveryError(retainedAdmissions);
      if (captured.environmentId !== this.options.persistence.environmentId ||
          captured.selectionRevision !== saved.revision || JSON.stringify(captured.selection) !== JSON.stringify(saved.selection)) {
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
      if (this.stopping) throw new AppServerOperationError(503, "server_unavailable", "Local harness is shutting down");
      const factory = this.options.physicalCandidates;
      if (!factory) throw new AppServerOperationError(503, "server_unavailable",
        "Local physical admission authority is unavailable", "LOCAL_HARNESS_CAPABILITY_UNAVAILABLE", false);
      const execution: ActiveExecution = { admission, controller: new AbortController() };
      // acquire defers effects. Retain the original before ready/publication.
      execution.candidate = factory.acquire({ candidate: admission, selection, signal: execution.controller.signal });
      this.active.set(admission.turn.id, execution);
      execution.publication = this.options.leases.admit(admission, execution.candidate);
      let stored: LocalPhysicalAdmissionPublication;
      try { stored = await execution.publication; }
      catch (error) {
        if (await execution.candidate.discardUnadmitted()) this.active.delete(admission.turn.id);
        throw error; // Unknown publication keeps the exact original owner.
      }
      if (!stored.newlyAdmitted) {
        if (!(await execution.candidate.discardUnadmitted())) throw new LocalHarnessRecoveryError([admission.turn.id]);
        this.active.delete(admission.turn.id);
        return stored.admission; // Duplicate receipt carries no execution authority.
      }
      if (this.stopping) this.stopExecution(execution);
      // Record the original run promise before begin/prepare/provider effects.
      execution.task = Promise.resolve().then(() => this.run(execution, binding, selection, grant, stored));
      void execution.task.catch(() => undefined);
      return stored.admission;
    });
  }

  /** Adapter for the existing placement-neutral submission envelope; no hosted principal/cookie. */
  async execute(params: ChatRequestBody): Promise<HostedChatSubmissionResult> {
    this.assertSupportedConfiguration(params);
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

  async savedTurnBackend(turnId: TurnId): Promise<LocalHarnessBackend> {
    const admission = await this.options.persistence.turnAdmissions.getByTurn(turnId);
    if (!admission) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
    // Metadata authorization is shared by Native and delegated routing. Do not
    // bind a delegated execution grant or consult today's harness picker here.
    const thread = await this.options.threads.get(admission.run.threadId);
    if (thread.workspaceId !== admission.run.workspaceId || thread.userId !== admission.run.userId ||
        thread.userId !== this.options.threads.actorUserId) {
      throw new AppServerOperationError(403, "unauthorized", "Local saved turn does not match its authorized Thread owner");
    }
    return localAdmissionBackend(admission, this.options.persistence.environmentId);
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
    this.stopExecution(execution, params.reason);
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
  /** Private local dispatcher port. Canonical replay is a fact receipt, never
   * proof that an ambiguous native dispatch succeeded or permission to retry it.
   */
  async submitUserInputResponse(params: SubmitUserInputResponseRequest): Promise<LifecycleEvent> {
    const command = SubmitUserInputResponseRequestSchema.parse(params);
    if (await this.savedTurnBackend(command.turnId) !== "delegated") {
      throw new AppServerOperationError(409, "invalid_request", "Question does not belong to a delegated local turn");
    }
    const admission = await this.getTurn(command.turnId);
    const actor = admission.run.userId;
    if (command.respondedBy !== null && command.respondedBy !== actor) {
      throw new AppServerOperationError(403, "unauthorized", "Question responder does not own the local turn");
    }
    const facts = await this.readUserInputFacts(admission, command.requestId);
    if (!facts.requested) throw new AppServerOperationError(409, "invalid_request", "Canonical question was not found");
    let response: ReturnType<typeof normalizeUserInputResponse>;
    try { response = normalizeUserInputResponse(facts.requested.payload, command.response); }
    catch { throw new AppServerOperationError(400, "invalid_request", "Question response does not match its descriptor"); }
    const descriptor = facts.requested.payload;
    const receipt = (event: NonNullable<typeof facts.responded>): LifecycleEvent => {
      let prior: ReturnType<typeof normalizeUserInputResponse>;
      try { prior = normalizeUserInputResponse(descriptor, event.payload.response); }
      catch { throw new AppServerOperationError(409, "invalid_request", "Canonical question response is inconsistent"); }
      if (event.payload.respondedBy !== actor || JSON.stringify(prior) !== JSON.stringify(response)) {
        throw new AppServerOperationError(409, "invalid_request", "Question was already answered differently");
      }
      return event;
    };
    if (facts.responded) return receipt(facts.responded);
    const runtime = this.active.get(command.turnId)?.runtime;
    if (facts.resolved || facts.settled || this.stopping || !runtime) {
      throw new AppServerOperationError(409, "server_unavailable", "Question has no active local runtime owner");
    }
    // Exactly one dispatch. Kernel owns normalization, durable reply claim,
    // native origin and Stop fences; an ambiguous dispatch is never retried.
    await runtime.respondUserInput({ turnId: command.turnId, requestId: command.requestId, response, respondedBy: actor });
    const committed = await this.readUserInputFacts(admission, command.requestId);
    if (!committed.responded) throw new AppServerOperationError(503, "server_unavailable", "Canonical question response could not be read");
    return receipt(committed.responded);
  }

  private async readUserInputFacts(admission: TurnAdmission, requestId: string) {
    type QuestionEvent = Extract<LifecycleEvent, { type: "user_input.requested" | "user_input.responded" | "request.resolved" }>;
    let requested: (QuestionEvent & { type: "user_input.requested" }) | null = null;
    let responded: (QuestionEvent & { type: "user_input.responded" }) | null = null;
    let resolved = false, settled = false, sequence = 0;
    let afterSequence: number | null = null;
    const unavailable = () => new AppServerOperationError(409, "invalid_request", "Canonical question replay is inconsistent or unavailable");
    for (let page = 0; page < 100; page += 1) {
      const replay = await this.options.persistence.lifecycleEvents.replay({ turnId: admission.turn.id, afterSequence, limit: 1000 });
      for (const event of replay.events) {
        if (event.turnId !== admission.turn.id || event.threadId !== admission.run.threadId ||
            event.runAttemptId !== admission.runAttemptId || event.producer.id !== admission.run.workerId ||
            event.sequence !== ++sequence) throw unavailable();
        if (event.type === "user_input.requested" && event.requestId === requestId) {
          if (requested || responded || resolved || settled) throw unavailable();
          requested = { ...event, type: "user_input.requested" };
        } else if (event.type === "user_input.responded" && event.requestId === requestId) {
          if (!requested || responded || resolved || settled || event.itemId !== requested.itemId) throw unavailable();
          responded = { ...event, type: "user_input.responded" };
        } else if (event.type === "request.resolved" && event.requestId === requestId) {
          if (!requested || responded || resolved || event.itemId !== requested.itemId) throw unavailable();
          resolved = true;
        } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type) ||
            (requested && "itemId" in event && event.itemId === requested.itemId &&
             ["item.completed", "item.failed", "item.interrupted", "item.declined"].includes(event.type))) settled = true;
      }
      if (replay.nextSequence === null) return { requested, responded, resolved, settled };
      if (!replay.events.length || replay.nextSequence <= (afterSequence ?? 0)) throw unavailable();
      afterSequence = replay.nextSequence;
    }
    throw unavailable();
  }

  get hasActiveExecutions(): boolean { return this.active.size > 0; }
  hasExecutionOwner(turnId: TurnId): boolean { return this.active.has(turnId); }
  async shutdown(): Promise<LocalHarnessShutdownResult> {
    this.stopping = true;
    for (const execution of this.active.values()) this.stopExecution(execution);
    await Promise.allSettled([...this.admissions]);
    for (const execution of this.active.values()) this.stopExecution(execution);
    await Promise.allSettled([...this.active.values()].map((execution) => execution.task));
    for (const execution of this.active.values()) {
      try {
        // A retirement transaction may have committed despite a lost receipt.
        // This retries settlement proof/cleanup only, never prompt/native dispatch.
        await this.settleOwner(execution);
      } catch { /* Unknown ownership remains live and durable below. */ }
    }
    this.startup = undefined;
    const retained = new Set((await this.initialize()).retainedTurnIds);
    const events = await this.options.persistence.events.listAll();
    for (const event of events) {
      if (event.type !== "turn.started") continue;
      const admission = await this.options.persistence.turnAdmissions.getByTurn(event.payload.turn.id);
      if (!admission) { retained.add(event.payload.turn.id); continue; }
      try {
        if (localAdmissionBackend(admission, this.options.persistence.environmentId) === "native") continue;
        if (retained.has(admission.turn.id) || this.active.has(admission.turn.id))
          throw new LocalHarnessRecoveryError([admission.turn.id]);
        const proof = await this.options.persistence.readHarnessPreOpeningSettlement({ admission });
        if (proof.status !== "verified_pre_opening_settlement") await this.options.leases.assertSettled(admission);
        retained.delete(admission.turn.id);
      } catch { retained.add(admission.turn.id); }
    }
    for (const turnId of this.active.keys()) retained.add(turnId);
    if (retained.size) throw new LocalHarnessRecoveryError([...retained]);
    return { status: "settled", retainedTurnIds: [] };
  }

  private async run(execution: ActiveExecution, binding: LocalHarnessRuntimeBinding,
    selection: HarnessSelection, grant: StoredLocalWorkspaceGrant,
    publication: Exclude<LocalPhysicalAdmissionPublication, { newlyAdmitted: false }>): Promise<void> {
    let prepared: LocalHarnessPreparedRuntime | undefined;
    try {
      if (publication.disposition === "settlement_required") {
        this.stopExecution(execution);
        return;
      }
      const leaseId = this.options.leases.leaseId(execution.admission);
      // Synchronous no-effect construction exposes cleanup BEFORE begin/claim.
      execution.preparation = binding.prepare({ admission: execution.admission, selection, grant, leaseId,
        signal: execution.controller.signal, physical: publication });
      if (execution.controller.signal.aborted) execution.preparation.requestStop();
      execution.preparationResult = Promise.resolve().then(async () => {
        if (execution.controller.signal.aborted) throw new DOMException("Local preparation stopped", "AbortError");
        if (await this.options.persistence.beginHarnessPreparation(publication.preparation) !== "begun") {
          throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
        }
        execution.preparationBegun = true;
        const frozen = await this.options.persistence.harnessBindings.freezeAndClaim({
          selection: publication.preparation.selection, claimId: execution.admission.runAttemptId,
        });
        if (frozen.status !== "claimed") throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
        if (execution.controller.signal.aborted) throw new DOMException("Local preparation stopped", "AbortError");
        return execution.preparation!.start();
      });
      prepared = await execution.preparationResult;
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
      execution.preparationFailure = execution.interruptRequested ? "interrupted" : "failed";
      this.stopExecution(execution, "Local preparation cleanup", false);
      await execution.preOpeningSettlement?.catch(() => false);
      if (execution.runtime && prepared?.prepareRecovery) {
        const recovery = await prepared.prepareRecovery();
        if (recovery) {
          if (JSON.stringify(recovery.command.selection) !== JSON.stringify(selection) ||
              recovery.command.leaseId !== this.options.leases.leaseId(execution.admission) ||
              recovery.command.filesystemRoot !== grant.path) throw new Error("Local recovery does not match admitted execution");
          await this.options.recoverExecution(execution.runtime, recovery);
        }
      }
      // The original preparation owner settles quiescence and immutable failure
      // evidence through canonical runtime ports; never append a bare terminal
      // here before capture or use absence of an attachment as release proof.
      throw error;
    } finally {
      await this.settleOwner(execution); // Unknown retains the original live/durable owner.
    }
  }
  private stopExecution(execution: ActiveExecution, reason = "Local execution is stopping", requested = true): void {
    // Historical recovery has no dispatch capability. Aborting its original
    // acquisition could destroy the only cleanup path before it obtains a lease.
    if (execution.recovery) return;
    if (requested) execution.interruptRequested = true;
    const outcome = execution.interruptRequested ? "interrupted" : "failed";
    execution.controller.abort(new DOMException(reason, "AbortError"));
    try { execution.preparation?.requestStop(); }
    catch { /* Closure remains owned and must be proved by settle(), not Stop. */ }
    // A pending start may need original cleanup to resolve. Initiate that
    // cleanup now, without dropping this run owner or racing an active kernel.
    if (execution.preparation && execution.preparationBegun && !execution.runtime) {
      void this.startPreparationSettlement(execution).catch(() => undefined);
    }
    if (execution.candidate && !execution.preparationBegun) {
      execution.preOpeningSettlement ??= execution.candidate.settleBeforeDispatch({
        settleCanonical: (admission) => settleLocalHarnessBeforeDispatch(this.options.persistence, admission, outcome),
      });
      void execution.preOpeningSettlement.catch(() => undefined);
    }
  }

  private async settleOwner(execution: ActiveExecution): Promise<void> {
    const early = await execution.preOpeningSettlement?.catch(() => false);
    if (early === true) {
      // A positive reserved-only cleanup cannot erase a pending original promise.
      await execution.preparationResult?.catch(() => undefined);
      this.active.delete(execution.admission.turn.id);
      return;
    }
    if (!execution.preparation && execution.candidate && !execution.task) {
      if (!(await execution.candidate.discardUnadmitted())) throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
    } else if (execution.recovery) {
      const settled = await execution.recovery.settleBeforeDispatch({
        settleCanonical: (admission) => settleLocalHarnessBeforeDispatch(this.options.persistence, admission),
      });
      if (!settled) throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
    } else {
      if (!execution.preparation) throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
      // Retain settlement BEFORE invoking it: cleanup may be needed to resolve
      // start(). Drain both originals, including a rejected start, before release.
      this.startPreparationSettlement(execution);
      const [preparation, settlement] = await Promise.allSettled([
        execution.preparationResult, execution.settlement,
      ]);
      void preparation; // Rejection is failure evidence, not permission to skip cleanup.
      if (settlement.status !== "fulfilled" || !settlement.value || !execution.canonicalSettlement) {
        throw new LocalHarnessRecoveryError([execution.admission.turn.id]);
      }
      await execution.canonicalSettlement;
      await this.options.leases.assertSettled(execution.admission);
    }
    this.active.delete(execution.admission.turn.id);
  }

  private startPreparationSettlement(execution: ActiveExecution): Promise<boolean> {
    return execution.settlement ??= Promise.resolve().then(() => execution.preparation!.settle({
      preparationFailure: execution.preparationFailure ?? (execution.interruptRequested ? "interrupted" : null),
      settleCanonical: () => execution.canonicalSettlement ??= Promise.resolve().then(async () => {
        await execution.preparationResult?.catch(() => undefined);
        await this.options.settleExecution(execution.admission);
      }),
    }));
  }

  private async recoverUnbegun(admission: TurnAdmission, binding: StoredHarnessBinding,
    preparation: StoredHarnessPreparation): Promise<boolean> {
    let execution = this.active.get(admission.turn.id);
    if (execution && !execution.recovery) return false;
    if (!execution) {
      if (!this.options.physicalCandidates) return false;
      execution = { admission, controller: new AbortController() };
      execution.recovery = this.options.physicalCandidates.recover({ admission,
        selection: HarnessSelectionSchema.parse(JSON.parse(binding.selection.selectionJson)),
        preparationId: preparation.preparationId, signal: execution.controller.signal });
      this.active.set(admission.turn.id, execution);
      const original = execution;
      execution.task = Promise.resolve().then(async () => {
        await original.recovery!.ready();
        await this.settleOwner(original);
      });
      void execution.task.catch(() => undefined);
    }
    try { await execution.task; return !this.active.has(admission.turn.id); }
    catch { return false; }
  }

  private assertSupportedConfiguration(input: {
    readonly mode?: LocalTurnStartParams["mode"];
    readonly productMode?: LocalTurnStartParams["productMode"];
  }): void {
    if (input.mode !== undefined || input.productMode !== undefined) {
      // Binding.mode records a Run mode but is not proof of an enforced native
      // policy mapping. Until that authority exists, accepting an override would
      // silently replace caller intent with the bootstrap's current policy.
      throw new AppServerOperationError(503, "server_unavailable",
        "Local delegated mode and product mode require a verified harness policy mapping",
        "LOCAL_HARNESS_CAPABILITY_UNAVAILABLE", false);
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
      turn: TurnSchema.parse({ id: turnId, threadId: thread.id, runId, parentTurnId: thread.lastTerminalTurnId, status: "queued",
        startedAt: null, completedAt: null, createdAt: now, updatedAt: now, lastEventSequence: 1 }),
      userMessage: ThreadItemSchema.parse({ id: ItemIdSchema.parse(`itm_${randomUUID().replaceAll("-", "")}`),
        threadId: thread.id, runId, turnId, parentItemId: thread.activeLeafItemId, branchId: null, role: "user", type: "user_message",
        status: "completed", createdAt: now, completedAt: now, eventSequence: 1, content: { text: params.prompt, harnessSelection: intent } }),
    });
  }
}
