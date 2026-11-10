import type {
  LocalTurnExecutionCapability,
  LocalCapturedExecutionPorts,
  LocalQuiescentWorker,
} from "./LocalTurnExecutionCapability.js";
import { prepareLocalCapturedExecution } from "./LocalCapturedExecution.js";
import { LocalTurnPreparationFailure } from "./LocalTurnPreparationFailure.js";
import type { RuntimeExecutionService } from "../types.js";
import type { NativeProviderToolTracker } from "../engine/KernelAgenticProvider.js";
import type { LocalReadOnlyWorkspaceBinding } from "./LocalReadOnlyWorkspaceBinding.js";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import {
  LifecycleEventSchema,
  TurnDiffPayloadSchema,
} from "@repo/platform-protocol";
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
  type WorkerProtocolPort,
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
> & { readonly toolTracker?: NativeProviderToolTracker };

/** One kernel handle per canonical admission; admission persistence stays with the host. */
export class LocalTurnExecutor<
  TBinding extends LocalReadOnlyWorkspaceBinding =
    LocalReadOnlyWorkspaceBinding,
> {
  private readonly capability: LocalTurnExecutionCapability<TBinding>;
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
      readonly awaitQuiescence: (timeoutMs: number) => Promise<boolean>;
      readonly hasPreparationResourceProof: () => boolean;
    }
  >();

  constructor(
    private readonly options: {
      readonly capability?: LocalTurnExecutionCapability<TBinding>;
      readonly bindWorkspace: (
        admission: TurnAdmission,
        signal: AbortSignal,
      ) => Promise<TBinding>;
      readonly createReadExecutionService?: (
        admission: TurnAdmission,
        binding: TBinding,
        signal: AbortSignal,
      ) => RuntimeExecutionService | Promise<RuntimeExecutionService>;
      /** Actual read-only factory proof for a settled preflight that never
       * returned kernel ports. Worker absence alone never permits release. */
      readonly awaitPreparationQuiescence?: (
        attempt: LocalTurnAttemptIdentity,
      ) => Promise<boolean>;
      readonly lifecycleEvents: RuntimeKernelDependencies["lifecycleEvents"];
      readonly producerId: string;
      readonly createKernelPorts: (
        admission: TurnAdmission,
        binding: TBinding,
        signal: AbortSignal,
        execution?: LocalCapturedExecutionPorts,
      ) => Promise<KernelPorts>;
    },
  ) {
    this.capability = options.capability
      ? Object.freeze({ ...options.capability })
      : { artifactCapture: "omitted_read_only" };
  }

  createAdmission(input: LocalTurnAdmissionInput): TurnAdmission {
    return createLocalTurnAdmission(
      input,
      this.capability.artifactCapture === "required" ? "auto_edit" : "ask",
    );
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
    let workerOwner: WorkerProtocolPort | undefined;
    let preparationFailure: LocalTurnPreparationFailure | undefined;
    let preflightSignal: AbortSignal = controller.signal;
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
        preflightSignal = signal;
        signal.throwIfAborted();
        const capability = this.capability;
        let capturedPorts: LocalCapturedExecutionPorts | undefined;
        if (capability.artifactCapture === "required") {
          try {
            capturedPorts = await capability.createExecutionPorts(
              admission,
              binding,
              signal,
            );
          } catch (error) {
            if (
              error instanceof LocalTurnPreparationFailure &&
              error.matchesAttempt({
                workspaceId: admission.run.workspaceId,
                threadId: admission.run.threadId,
                runId: admission.run.id,
                turnId: admission.turn.id,
                runAttemptId: admission.runAttemptId,
              })
            ) {
              preparationFailure = error;
            }
            throw error;
          }
        }
        const captured =
          capability.artifactCapture === "required"
            ? await prepareLocalCapturedExecution(
                admission,
                binding,
                capturedPorts!,
              )
            : undefined;
        if (captured) workerOwner = captured.worker;
        const executionSignal = captured
          ? AbortSignal.any([signal, captured.signal])
          : signal;
        preflightSignal = executionSignal;
        const executionService = captured
          ? undefined
          : this.options.createReadExecutionService
            ? await this.options.createReadExecutionService(
                admission,
                binding,
                executionSignal,
              )
            : new LocalReadOnlyExecutionService({ binding });
        const { toolTracker, ...ports } = await this.options.createKernelPorts(
          admission,
          binding,
          executionSignal,
          capturedPorts && captured
            ? { ...capturedPorts, tools: captured.tools }
            : undefined,
        );
        if (
          captured &&
          (!ports.toolAuthorization?.authorize ||
            !ports.approvals?.waitForDecision)
        ) {
          throw new RuntimeKernelError(
            "tool_policy_denied",
            "Captured execution requires canonical permission and approval ports",
          );
        }
        workerOwner = captured
          ? trackCapturedWorker(captured.worker, toolTracker)
          : new LocalReadOnlyToolWorker(
              executionService!,
              admission.run.threadId,
              toolTracker,
            );
        kernelOwner = new RuntimeKernel({
          ...ports,
          ...(captured
            ? {
                gitSnapshots: captured.gitSnapshots,
                turnArtifacts: captured.turnArtifacts,
              }
            : {}),
          lifecycleEvents: this.options.lifecycleEvents,
          producerId: this.options.producerId,
          artifactCapture: captured ? "required" : "omitted_read_only",
          signal: ports.signal
            ? AbortSignal.any([executionSignal, ports.signal])
            : executionSignal,
          worker: workerOwner,
        });
        return kernelOwner;
      })
      .catch(async (error: unknown) => {
        if (this.capability.artifactCapture === "required" && workerOwner) {
          if (!workerOwner.awaitQuiescence) throw new RuntimeKernelError("worker_failed", "Captured worker has no quiescence port");
          while (!(await workerOwner.awaitQuiescence({ turnId: admission.turn.id, timeoutMs: 500 }))) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
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
        const stopped = preflightSignal.aborted
          ? preflightSignal
          : controller.signal.aborted
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
      hasPreparationResourceProof: () => preparationFailure !== undefined,
      awaitQuiescence: (timeoutMs) =>
        workerOwner
          ? workerOwner.awaitQuiescence?.({
              turnId: admission.turn.id,
              timeoutMs,
            }) ?? Promise.resolve(false)
          : preparationFailure
            ? preparationFailure.awaitQuiescence({ turnId: admission.turn.id, timeoutMs })
            : this.capability.artifactCapture === "omitted_read_only" &&
                this.turns.get(admission.turn.id)?.finished === true &&
                this.options.awaitPreparationQuiescence
              ? this.options.awaitPreparationQuiescence({
                  workspaceId: admission.run.workspaceId,
                  threadId: admission.run.threadId,
                  runId: admission.run.id,
                  turnId: admission.turn.id,
                  runAttemptId: admission.runAttemptId,
                })
              : Promise.resolve(false),
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

  /** The host must retain the binding/lease resources until this confirms real worker closure. */
  async awaitQuiescence(
    turnId: StartTurnInput["turn"]["id"],
    timeoutMs: number,
  ): Promise<boolean> {
    const owned = this.turns.get(turnId);
    return owned ? owned.awaitQuiescence(timeoutMs) : false;
  }

  /**
   * Only a positive result permits the host to close this attempt's binding/fence.
   * False (including preflight without a known worker or owner receipt) requires
   * retaining the same executor and quarantining its binding, never a fresh lease.
   */
  async awaitResourceRelease(
    turnId: StartTurnInput["turn"]["id"],
  ): Promise<boolean> {
    const owned = this.turns.get(turnId);
    if (!owned) return false;
    try {
      // Execution can reject after a durable failed/interrupted terminal, or after
      // a terminal append committed but its acknowledgement was lost.
      await owned.result.catch(() => undefined);
      if (!owned.finished || !(await owned.awaitQuiescence(500))) return false;
      if (
        !(await this.hasDurableSettlement(
          owned.identity,
          !owned.hasPreparationResourceProof(),
        ))
      ) return false;
      return await owned.awaitQuiescence(500);
    } catch {
      // Unreadable settlement or unknown physical closure is not release proof.
      return false;
    }
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

  private async hasDurableSettlement(
    identity: LocalTurnAttemptIdentity,
    allowCompleted = true,
  ): Promise<boolean> {
    let afterSequence: number | null = null;
    let sequence = 0;
    let terminal: "completed" | "failed" | "interrupted" | null = null;
    let captured = this.capability.artifactCapture === "omitted_read_only";
    do {
      const page = await this.options.lifecycleEvents.replay({
        turnId: identity.turnId,
        afterSequence,
        limit: 1000,
      });
      for (const event of page.events) {
        if (
          terminal ||
          event.turnId !== identity.turnId ||
          event.threadId !== identity.threadId ||
          event.runAttemptId !== identity.runAttemptId ||
          event.producer.id !== this.options.producerId ||
          event.sequence !== sequence + 1
        ) {
          return false;
        }
        sequence = event.sequence;
        if (event.type === "turn.diff_updated") {
          // The canonical kernel emits this only after both immutable artifact
          // writes settle. Replay recovers that receipt without recapturing.
          const diff = TurnDiffPayloadSchema.safeParse(event.payload.diff);
          if (
            !diff.success ||
            diff.data.turnId !== identity.turnId ||
            diff.data.startSnapshot.phase !== "start" ||
            diff.data.terminalSnapshot.phase !== "terminal" ||
            diff.data.startSnapshot.snapshotKey !== identity.turnId ||
            diff.data.terminalSnapshot.snapshotKey !== identity.turnId
          ) {
            return false;
          }
          captured = true;
        }
        if (
          event.type === "workspace.snapshot_unavailable" &&
          this.capability.artifactCapture === "required"
        ) {
          captured = false;
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted"
        ) {
          if (!LifecycleEventSchema.safeParse(event).success) return false;
          terminal = event.payload.outcome.status;
        }
      }
      if (
        page.nextSequence !== null &&
        (page.events.length === 0 || page.nextSequence !== sequence)
      ) {
        return false;
      }
      afterSequence = page.nextSequence;
    } while (afterSequence !== null);
    // A failed/interrupted canonical terminal can truthfully retain unavailable
    // capture/error references. Completion alone requires successful capture.
    return (
      terminal !== null &&
      (terminal !== "completed" || (allowCompleted && captured))
    );
  }
}

/** Existing read-only consumers retain the same default capability and single executor implementation. */
export { LocalTurnExecutor as LocalReadOnlyTurnExecutor };

function trackCapturedWorker(
  worker: LocalQuiescentWorker,
  tracker?: NativeProviderToolTracker,
): LocalQuiescentWorker {
  if (!tracker) return worker;
  return {
    executionCapability: worker.executionCapability,
    awaitQuiescence: (input) => worker.awaitQuiescence(input),
    executeTool: async (input) => {
      tracker.recordToolStarted(input.toolCall);
      try {
        const result = await worker.executeTool(input);
        if (result.kind === "completed")
          tracker.recordToolCompleted(input.toolCall, {
            taskId: input.toolCall.toolCallId,
            status: "DONE",
            completedAt: new Date(),
            output: {
              content:
                typeof result.output.content === "string"
                  ? result.output.content
                  : JSON.stringify(result.output),
            },
          });
        else if (result.kind === "failed")
          tracker.recordToolFailed(
            input.toolCall,
            result.failure.message,
            result.disposition === "terminal",
          );
        return result;
      } catch (error) {
        tracker.recordToolFailed(
          input.toolCall,
          error instanceof Error ? error.message : "Captured tool failed",
          true,
        );
        throw error;
      }
    },
  };
}
