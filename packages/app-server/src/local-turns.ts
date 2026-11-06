import { ModelIdSchema } from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import type { TurnAdmission, Thread, ProviderId, ModelId, LocalWorkspaceGrant, TurnId, LifecycleEvent, SubmitLifecycleApprovalRequest, ReplayLifecycleEventsRequest } from "@repo/platform-protocol";
import type { LocalTurnStartParams, LocalThreadHistoryParams, LocalTurnInterruptParams } from "./protocol.js";
import type { LocalWorkspaceService, LocalWorkspaceExecutionBinding } from "./local-workspace.js";
import type { LocalThreadService } from "./local-threads.js";
import type { LocalProviderService } from "./local-providers.js";
import { AppServerOperationError } from "./server.js";
import { LocalApprovalService } from "./local-approvals.js";
import { LocalInterruptionService, LocalInterruptionAttemptNotActiveError } from "./local-interruption.js";

/** Runtime objects and ports only; this host never produces lifecycle events. */
export type LocalTurnExecutor = {
  execute(admission: TurnAdmission): Promise<unknown>;
  interrupt(turnId: TurnId, reason: string): Promise<void>;
  resolveApproval: ConstructorParameters<typeof LocalApprovalService>[0]["resolveApproval"];
};
export type LocalTurnServiceOptions = {
  persistence: Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents">;
  workspaces: LocalWorkspaceService;
  threads: LocalThreadService;
  providers: LocalProviderService;
  runtime?: {
  createAdmission(input: {
    workspace: LocalWorkspaceGrant;
    thread: Thread;
    prompt: string;
    clientRequestId: string;
    providerId: ProviderId;
    modelId: ModelId;
  }): TurnAdmission;
  createExecutor(binding: LocalWorkspaceExecutionBinding): LocalTurnExecutor;
  };
};

export class LocalTurnService {
  private readonly executors = new Map<TurnId, LocalTurnExecutor>();
  private readonly approvals: LocalApprovalService;
  private readonly interruption: LocalInterruptionService;

  constructor(private readonly options: LocalTurnServiceOptions) {
    this.approvals = new LocalApprovalService({
      lifecycleEvents: options.persistence.lifecycleEvents,
      threads: options.threads,
      resolveApproval: (turnId, approvalId, resolution) =>
        this.requireExecutor(turnId).resolveApproval(turnId, approvalId, resolution),
    });
    this.interruption = new LocalInterruptionService({
      turnAdmissions: options.persistence.turnAdmissions,
      executor: { interrupt: (turnId, reason) => this.requireExecutor(turnId).interrupt(turnId, reason) },
    });
  }

  async startTurn(params: LocalTurnStartParams): Promise<TurnAdmission> {
    const runtime = this.options.runtime;
    if (!runtime) throw new AppServerOperationError(503, "server_unavailable", "Local turn execution is not configured");
    const binding = await this.options.workspaces.bindForExecution(params.workspaceId);
    const thread = await this.options.threads.get(params.threadId);
    if (thread.workspaceId !== params.workspaceId || thread.status !== "active") {
      throw new AppServerOperationError(409, "conflict", "The local thread is not active in this workspace");
    }
    const selection = await this.options.providers.getSelection();
    if (!selection) throw new AppServerOperationError(409, "conflict", "Select a protected provider and model before starting a turn");
    binding.assertCurrent();
    const candidate = runtime.createAdmission({
      workspace: binding.workspace, thread, prompt: params.prompt,
      clientRequestId: params.clientRequestId,
      providerId: selection.providerId, modelId: ModelIdSchema.parse(selection.modelId),
    });
    // Construct ports before admission; providers execute only through execute().
    const executor = runtime.createExecutor(binding);
    binding.assertCurrent();
    const { admission, newlyAdmitted } = await this.options.persistence.turnAdmissions.admit(candidate);
    if (newlyAdmitted) {
      this.executors.set(admission.turn.id, executor);
      // Runtime owns preflight failure and terminal settlement. Never infer a terminal here.
      void executor.execute(admission).catch(() => {
        console.error("Local runtime execution did not return successfully; canonical replay remains authoritative");
      }).finally(() => {
        if (this.executors.get(admission.turn.id) === executor) this.executors.delete(admission.turn.id);
      });
    }
    return admission;
  }

  async getTurn(turnId: TurnId): Promise<TurnAdmission> {
    const admission = await this.options.persistence.turnAdmissions.getByTurn(turnId);
    if (!admission) throw new AppServerOperationError(404, "not_found", "Local turn was not found");
    const thread = await this.options.threads.get(admission.run.threadId);
    if (thread.workspaceId !== admission.run.workspaceId) {
      throw new AppServerOperationError(404, "not_found", "Local turn was not found in the granted workspace");
    }
    return admission;
  }

  async readHistory(params: LocalThreadHistoryParams) {
    const thread = await this.options.threads.get(params.threadId);
    if (thread.workspaceId !== params.workspaceId) {
      throw new AppServerOperationError(404, "not_found", "Local thread was not found in the granted workspace");
    }
    const page = await this.options.persistence.turnAdmissions.listByThread({
      threadId: thread.id, afterCursor: params.afterCursor ?? null, limit: params.limit ?? 50,
    });
    return { admissions: [...page.admissions], nextCursor: page.nextCursor };
  }

  async replayLifecycleEvents(params: ReplayLifecycleEventsRequest) {
    if (params.backend !== undefined) throw new AppServerOperationError(400, "invalid_request", "Local replay does not accept a hosted backend");
    await this.getTurn(params.turnId);
    return this.options.persistence.lifecycleEvents.replay({
      turnId: params.turnId, afterSequence: params.afterSequence ?? null, limit: params.limit ?? 1_000,
    });
  }

  async interruptTurn(params: LocalTurnInterruptParams) {
    await this.getTurn(params.turnId);
    try { return await this.interruption.interruptTurn(params); } catch (error) {
      if (error instanceof LocalInterruptionAttemptNotActiveError) {
        throw new AppServerOperationError(409, "conflict", error.message);
      }
      throw error;
    }
  }

  submitLifecycleApproval(params: SubmitLifecycleApprovalRequest): Promise<LifecycleEvent> {
    return this.approvals.submitLifecycleApproval(params);
  }

  private requireExecutor(turnId: TurnId): LocalTurnExecutor {
    const executor = this.executors.get(turnId);
    if (!executor) throw new LocalInterruptionAttemptNotActiveError();
    return executor;
  }
}
