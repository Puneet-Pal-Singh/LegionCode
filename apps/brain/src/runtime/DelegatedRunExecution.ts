import {
  RuntimeKernel,
  type RuntimeKernelDependencies,
  type StartTurnInput,
} from "@repo/runtime-kernel";
import type { LifecycleEventStore } from "@repo/persistence";
import type { LifecycleEvent, TurnId } from "@repo/platform-protocol";
import {
  workspaceIdFromExternalId,
  userIdFromExternalId,
} from "@repo/platform-protocol";
import { DomainError } from "../domain/errors";
import type { ExecuteRunPayload } from "./parsing/ExecuteRunPayloadSchema";
import type { RunInterruptRegistry } from "./RunInterruptRegistry";
import type { RunApprovalResolutionRegistry } from "./RunApprovalResolutionRegistry";
import type { RunThreadInputRegistry } from "./RunThreadInputRegistry";
import type { TaskCheckoutRunLifecycle } from "./task-workspaces/TaskCheckoutRunLifecycle";

type DelegatedInput = StartTurnInput & {
  execution: Extract<
    NonNullable<StartTurnInput["execution"]>,
    { kind: "delegated" }
  >;
};
/** Existing admission/credential/lease authorities compose this capability. It
 * resolves the persisted selection/revision and pinned host, never an API-key
 * provider or native agent. Preparation cannot start external work. */
export interface DelegatedRunPreparationPort {
  prepare(input: { readonly payload: ExecuteRunPayload }): Promise<{
    readonly start: DelegatedInput;
    readonly dependencies: Pick<
      RuntimeKernelDependencies,
      | "gitSnapshots"
      | "turnArtifacts"
      | "workspaceManifests"
      | "approvals"
      | "hooks"
      | "clock"
    > & {
      readonly delegated: NonNullable<RuntimeKernelDependencies["delegated"]>;
    };
    readonly checkoutLifecycle: TaskCheckoutRunLifecycle;
  }>;
}

/** The real Run Engine caller enters the same canonical kernel directly. Native
 * model/context/tool ports are unavailable and cannot resolve a different payer. */
export async function executeDelegatedRun(input: {
  readonly payload: ExecuteRunPayload;
  readonly preparation: DelegatedRunPreparationPort;
  readonly lifecycleEvents: LifecycleEventStore;
  readonly interrupts: RunInterruptRegistry;
  readonly approvals: RunApprovalResolutionRegistry;
  readonly threadInputs: RunThreadInputRegistry;
}): Promise<Response> {
  const { payload } = input;
  const requested = payload.input.harnessSelection;
  if (
    !requested?.selection ||
    !payload.identity ||
    !payload.userId ||
    !payload.workspaceId
  )
    throw new DomainError(
      "HARNESS_SELECTION_REQUIRED",
      "Delegated execution requires its frozen owned selection.",
      409,
      false,
      payload.correlationId,
    );
  const prepared = await input.preparation.prepare({ payload });
  const { start } = prepared;
  const selected = start.execution.selection;
  if (
    start.run.id !== payload.runId ||
    start.run.userId !== userIdFromExternalId(payload.userId) ||
    !start.run.harnessSelection ||
    start.execution.prompt !== payload.input.prompt ||
    start.turn.id !== payload.identity.turnId ||
    start.runAttemptId !== payload.identity.runAttemptId ||
    start.run.threadId !== payload.identity.threadId ||
    start.run.workspaceId !== workspaceIdFromExternalId(payload.workspaceId) ||
    selected.environmentId !== requested.environmentId ||
    selected.selectionRevision !== requested.selectionRevision ||
    selected.harness !== requested.selection.harness ||
    selected.instanceId !== requested.selection.instanceId ||
    selected.connectionId !== requested.selection.connectionId ||
    selected.modelId !== requested.selection.modelId
  ) {
    try {
      await prepared.checkoutLifecycle.settle({
        status: "failed",
        failureCode: "HARNESS_BINDING_CONFLICT",
      });
    } finally {
      await prepared.checkoutLifecycle.release();
    }
    throw new DomainError(
      "HARNESS_BINDING_CONFLICT",
      "Resolved harness binding differs from admitted ownership/selection.",
      409,
      false,
      payload.correlationId,
    );
  }
  const nativeUnavailable = async (): Promise<never> => {
    throw new DomainError(
      "NATIVE_PORT_UNAVAILABLE",
      "Native execution is unavailable in this delegated attempt.",
      409,
      false,
      payload.correlationId,
    );
  };
  const kernel = new RuntimeKernel({
    ...prepared.dependencies,
    lifecycleEvents: input.lifecycleEvents,
    producerId: "brain-delegated-run",
    contextAssembly: { assemble: nativeUnavailable },
    provider: { generateNext: nativeUnavailable },
    worker: { executeTool: nativeUnavailable },
    toolAuthorization: { authorize: nativeUnavailable },
  });
  const turnId = start.turn.id;
  const pending = input.interrupts.register(turnId, async (reason) => {
    if (kernel.isTurnReady(turnId)) await kernel.interruptTurn(turnId, reason);
    else kernel.requestInterruptBeforeStart(turnId, reason);
  });
  if (pending) kernel.requestInterruptBeforeStart(turnId, pending);
  input.approvals.register(turnId, (approvalId, resolution) =>
    kernel.resolveApproval(turnId, approvalId, resolution),
  );
  input.threadInputs.register(turnId, (threadInput) =>
    kernel.acceptThreadInput({
      turnId,
      accepted: { inputId: threadInput.inputId, message: threadInput.message },
      clientInputId: threadInput.clientInputId,
      transcriptMessageId: threadInput.transcriptMessageId,
    }),
  );
  prepared.checkoutLifecycle.beginRuntimeExecution({
    turnId,
    runAttemptId: start.runAttemptId,
  });
  try {
    await kernel.startTurn(start);
    const events = await readEvents(input.lifecycleEvents, turnId);
    prepared.checkoutLifecycle.observeRuntimeSettlement(events);
    const terminal = events.find((event) =>
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(
        event.type,
      ),
    );
    if (!terminal)
      throw new DomainError(
        "RUNTIME_TERMINAL_SETTLEMENT_MISSING",
        "Delegated runtime has no canonical terminal outcome.",
        502,
        false,
        payload.correlationId,
      );
    const completed = terminal.type === "turn.completed";
    await prepared.checkoutLifecycle.settle(
      completed
        ? { status: "settled" }
        : {
            status: "failed",
            failureCode:
              terminal.type === "turn.interrupted"
                ? "RUNTIME_TURN_INTERRUPTED"
                : "RUNTIME_TERMINAL_FAILURE",
          },
    );
    return Response.json({
      status: completed
        ? "completed"
        : terminal.type === "turn.interrupted"
          ? "interrupted"
          : "failed",
      runId: start.run.id,
      turnId,
      runAttemptId: start.runAttemptId,
    });
  } catch (error) {
    try {
      prepared.checkoutLifecycle.observeRuntimeSettlement(
        await readEvents(input.lifecycleEvents, turnId),
      );
      await prepared.checkoutLifecycle.settle({
        status: "failed",
        failureCode: "DELEGATED_RUNTIME_FAILED",
      });
    } catch {
      /* Unknown commit/worker state retains checkout ownership for recovery. */
    }
    throw error;
  } finally {
    input.interrupts.unregister(turnId);
    input.approvals.unregister(turnId);
    input.threadInputs.unregister(turnId);
    await prepared.checkoutLifecycle.release();
  }
}

async function readEvents(
  store: LifecycleEventStore,
  turnId: TurnId,
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  let afterSequence: number | null = null;
  for (;;) {
    const page = await store.replay({ turnId, afterSequence, limit: 1000 });
    events.push(...page.events);
    if (page.events.length < 1000 || page.nextSequence === null) return events;
    if (page.nextSequence === afterSequence)
      throw new Error("Delegated lifecycle replay cursor did not advance");
    afterSequence = page.nextSequence;
  }
}
