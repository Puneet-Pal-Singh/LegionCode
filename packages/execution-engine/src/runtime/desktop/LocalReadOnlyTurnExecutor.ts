import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import {
  createLocalTurnAdmission,
  type LocalTurnAdmissionInput,
} from "./LocalTurnAdmission.js";
import {
  RuntimeKernel,
  RuntimeKernelError,
  RuntimeLifecycleCoordinator,
  RuntimeLifecycleSettlementError,
  toProtocolError,
  type RuntimeKernelDependencies,
  type StartTurnInput,
  type StartTurnResult,
} from "@repo/runtime-kernel";
import { LocalReadOnlyExecutionService } from "./LocalReadOnlyExecutionService.js";
import { LocalReadOnlyToolWorker } from "./LocalReadOnlyToolWorker.js";

export type LocalTurnAttemptIdentity = {
  readonly workspaceId: StartTurnInput["run"]["workspaceId"];
  readonly threadId: StartTurnInput["run"]["threadId"];
  readonly runId: StartTurnInput["run"]["id"];
  readonly turnId: StartTurnInput["turn"]["id"];
  readonly runAttemptId: StartTurnInput["runAttemptId"];
};

type KernelPorts = Omit<
  RuntimeKernelDependencies,
  "worker" | "artifactCapture" | "hooks" | "lifecycleEvents" | "producerId"
>;

/** One kernel handle per canonical admission; admission persistence stays with the host. */
export class LocalReadOnlyTurnExecutor {
  private readonly turns = new Map<
    string,
    {
      readonly kernel: Promise<RuntimeKernel>;
      readonly result: Promise<StartTurnResult>;
      readonly identity: LocalTurnAttemptIdentity;
      settled: boolean;
    }
  >();

  constructor(
    private readonly options: {
      readonly executionService: LocalReadOnlyExecutionService;
      readonly lifecycleEvents: RuntimeKernelDependencies["lifecycleEvents"];
      readonly producerId: string;
      readonly createKernelPorts: (
        admission: TurnAdmission,
      ) => Promise<KernelPorts>;
    },
  ) {}

  createAdmission(input: LocalTurnAdmissionInput): TurnAdmission {
    return createLocalTurnAdmission(input);
  }

  execute(admission: TurnAdmission): Promise<StartTurnResult> {
    const existing = this.turns.get(admission.turn.id);
    if (existing) {
      if (
        existing.identity.runId !== admission.run.id ||
        existing.identity.runAttemptId !== admission.runAttemptId ||
        existing.identity.threadId !== admission.run.threadId ||
        existing.identity.workspaceId !== admission.run.workspaceId
      ) {
        return Promise.reject(
          new RuntimeKernelError(
            "invalid_turn_identity",
            "Turn is owned by another attempt",
          ),
        );
      }
      return existing.result;
    }
    const kernel = Promise.resolve()
      .then(() => this.options.createKernelPorts(admission))
      .then(
        (ports) =>
          new RuntimeKernel({
            ...ports,
            lifecycleEvents: this.options.lifecycleEvents,
            producerId: this.options.producerId,
            artifactCapture: "omitted_read_only",
            worker: new LocalReadOnlyToolWorker(
              this.options.executionService,
              admission.run.threadId,
            ),
          }),
      )
      .catch(async (error: unknown) => {
        // Preflight is runtime work too. Reuse the canonical lifecycle owner, never a transport status write.
        const lifecycle = new RuntimeLifecycleCoordinator({
          sink: this.options.lifecycleEvents,
          producerId: this.options.producerId,
          clock: { now: () => new Date().toISOString() },
          threadId: admission.run.threadId,
          workspaceId: admission.run.workspaceId,
          turnId: admission.turn.id,
          runAttemptId: admission.runAttemptId,
          initialSequence: admission.turn.lastEventSequence,
          executionCapability: admission.run.executionCapability,
        });
        await lifecycle.start();
        await lifecycle.fail(toProtocolError(error));
        throw error;
      });
    const result = kernel
      .then((owner) => owner.startTurn(admission))
      .finally(() => {
        const owned = this.turns.get(admission.turn.id);
        if (owned) owned.settled = true;
      });
    this.turns.set(admission.turn.id, {
      kernel,
      result,
      settled: false,
      identity: {
        workspaceId: admission.run.workspaceId,
        threadId: admission.run.threadId,
        runId: admission.run.id,
        turnId: admission.turn.id,
        runAttemptId: admission.runAttemptId,
      },
    });
    return result;
  }

  async interrupt(
    turnId: StartTurnInput["turn"]["id"],
    reason: string,
  ): Promise<void> {
    const owned = this.turns.get(turnId);
    if (!owned)
      throw new RuntimeKernelError(
        "turn_not_active",
        "Turn is not owned by this executor",
      );
    await this.interruptAttempt(owned.identity, reason);
  }

  /** Synchronous tuple check precedes any wait or kernel command. Terminal retries queue nothing. */
  async interruptAttempt(
    identity: LocalTurnAttemptIdentity,
    reason: string,
  ): Promise<"interrupted" | "already_settled"> {
    const owned = this.turns.get(identity.turnId);
    if (
      !owned ||
      Object.keys(owned.identity).some(
        (key) =>
          owned.identity[key as keyof LocalTurnAttemptIdentity] !==
          identity[key as keyof LocalTurnAttemptIdentity],
      )
    ) {
      throw new RuntimeKernelError(
        "turn_not_active",
        "Attempt is not owned by this executor",
      );
    }
    if (owned.settled) return "already_settled";
    const kernel = await owned.kernel;
    if (owned.settled) return "already_settled";
    if (kernel.isTurnReady(identity.turnId)) {
      await kernel.interruptTurn(identity.turnId, reason);
    } else {
      kernel.requestInterruptBeforeStart(identity.turnId, reason);
      try {
        await owned.result;
      } catch (error) {
        // Execution errors remain on execute(); persistence/settlement loss must reach Stop too.
        if (error instanceof RuntimeLifecycleSettlementError) throw error;
      }
    }
    return "interrupted";
  }

  readonly resolveApproval: RuntimeKernel["resolveApproval"] = async (
    turnId,
    approvalId,
    resolution,
  ) => {
    const kernel = await this.requireKernel(turnId);
    await kernel.resolveApproval(turnId, approvalId, resolution);
  };

  private requireKernel(turnId: string): Promise<RuntimeKernel> {
    const owned = this.turns.get(turnId);
    if (!owned)
      throw new RuntimeKernelError(
        "turn_not_active",
        "Turn is not owned by this executor",
      );
    return owned.kernel;
  }
}
