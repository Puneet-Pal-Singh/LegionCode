import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
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
export class LocalReadOnlyTurnExecutor<
  TBinding extends LocalReadOnlyWorkspaceBinding =
    LocalReadOnlyWorkspaceBinding,
> {
  private readonly turns = new Map<
    string,
    {
      readonly kernel: Promise<RuntimeKernel>;
      readonly result: Promise<StartTurnResult>;
      readonly identity: LocalTurnAttemptIdentity;
      finished: boolean;
      readonly isTerminal: () => boolean;
      readonly terminalStatus: () => ReturnType<
        RuntimeKernel["getTurnTerminalStatus"]
      >;
      readonly controller: AbortController;
    }
  >();

  constructor(
    private readonly options: {
      readonly bindWorkspace: (
        admission: TurnAdmission,
        signal: AbortSignal,
      ) => Promise<TBinding>;
      readonly lifecycleEvents: RuntimeKernelDependencies["lifecycleEvents"];
      readonly producerId: string;
      readonly createKernelPorts: (
        admission: TurnAdmission,
        binding: TBinding,
        signal: AbortSignal,
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
    const controller = new AbortController();
    let workspaceBinding: TBinding | undefined;
    let kernelOwner: RuntimeKernel | undefined;
    let preflightStatus: ReturnType<RuntimeKernel["getTurnTerminalStatus"]> =
      null;
    const kernel = Promise.resolve()
      .then(async () => {
        const binding = await this.options.bindWorkspace(
          admission,
          controller.signal,
        );
        workspaceBinding = binding;
        await binding.assertCurrent();
        if (binding.workspace.workspaceId !== admission.run.workspaceId) {
          throw new RuntimeKernelError(
            "invalid_turn_identity",
            "Grant does not match the admitted workspace",
          );
        }
        const signal = AbortSignal.any([controller.signal, binding.signal]);
        signal.throwIfAborted();
        const ports = await this.options.createKernelPorts(
          admission,
          binding,
          signal,
        );
        kernelOwner = new RuntimeKernel({
          ...ports,
          lifecycleEvents: this.options.lifecycleEvents,
          producerId: this.options.producerId,
          artifactCapture: "omitted_read_only",
          signal: ports.signal
            ? AbortSignal.any([signal, ports.signal])
            : signal,
          worker: new LocalReadOnlyToolWorker(
            new LocalReadOnlyExecutionService({ binding }),
            admission.run.threadId,
          ),
        });
        return kernelOwner;
      })
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
        const stopped = controller.signal.aborted
          ? controller.signal
          : workspaceBinding?.signal;
        if (stopped?.aborted) {
          const reason =
            stopped.reason instanceof Error
              ? stopped.reason.message
              : "Local execution interrupted";
          await lifecycle.interrupt(reason);
        } else {
          await lifecycle.fail(toProtocolError(error));
        }
        preflightStatus = lifecycle.terminalStatus;
        throw error;
      });
    const result = kernel
      .then((owner) => owner.startTurn(admission))
      .finally(() => {
        const owned = this.turns.get(admission.turn.id);
        if (owned) owned.finished = true;
      });
    this.turns.set(admission.turn.id, {
      kernel,
      result,
      finished: false,
      controller,
      isTerminal: () =>
        (kernelOwner?.getTurnTerminalStatus(admission.turn.id) ??
          preflightStatus) !== null,
      terminalStatus: () =>
        kernelOwner?.getTurnTerminalStatus(admission.turn.id) ??
        preflightStatus,
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
    if (owned.isTerminal()) return "already_settled";
    if (owned.finished)
      throw new RuntimeKernelError(
        "turn_not_active",
        "Execution stopped without durable terminal settlement",
      );
    owned.controller.abort(new DOMException(reason, "AbortError"));
    let kernel: RuntimeKernel;
    try {
      kernel = await owned.kernel;
    } catch (error) {
      if (owned.isTerminal())
        return owned.terminalStatus() === "interrupted"
          ? "interrupted"
          : "already_settled";
      throw error;
    }
    if (owned.isTerminal()) return "already_settled";
    if (owned.finished)
      throw new RuntimeKernelError(
        "turn_not_active",
        "Execution stopped without durable terminal settlement",
      );
    if (kernel.isTurnReady(identity.turnId)) {
      await kernel.interruptTurn(identity.turnId, reason);
    } else {
      kernel.requestInterruptBeforeStart(identity.turnId, reason);
      try {
        await owned.result;
      } catch (error) {
        // Execution errors remain on execute(); persistence/settlement loss must reach Stop too.
        if (
          error instanceof RuntimeLifecycleSettlementError ||
          !owned.isTerminal()
        )
          throw error;
      }
    }
    if (!owned.isTerminal())
      throw new RuntimeKernelError(
        "turn_not_active",
        "Stop has no durable terminal settlement",
      );
    return owned.terminalStatus() === "interrupted"
      ? "interrupted"
      : "already_settled";
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
