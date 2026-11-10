import {
  LifecycleEventSchema,
  LocalTurnConfigurationSchema,
  TurnAdmissionSchema,
  WorkerIdSchema,
  PermissionProfileIdSchema,
  type PermissionProfileId,
  type LifecycleEvent,
  type TurnAdmission,
  type WorkerId,
} from "@repo/platform-protocol";
import {
  RuntimeLifecycleCoordinator,
  type RuntimeKernelClock,
  type RuntimeLifecycleEventStore,
} from "@repo/runtime-kernel";
import { LOCAL_READ_ONLY_TOOL_IDS } from "./LocalReadOnlyExecutionService.js";

type RecoveryStore = Pick<RuntimeLifecycleEventStore, "replay" | "appendBatch">;
type TerminalEvent = Extract<
  LifecycleEvent,
  { type: "turn.completed" | "turn.failed" | "turn.interrupted" }
>;
const MAX_RESTORED_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_RESTORED_HISTORY_EVENTS = 10_000;
const encoder = new TextEncoder();
const readOnlyTools: ReadonlySet<string> = new Set(LOCAL_READ_ONLY_TOOL_IDS);

export class LocalNativePlanRecoveryError extends Error {
  readonly code = "local_native_plan_recovery_failed";
  constructor(
    readonly reason:
      | "invalid_history"
      | "history_too_large"
      | "settlement_unconfirmed",
  ) {
    super("Lost Native Plan execution could not be reconciled safely");
    this.name = "LocalNativePlanRecoveryError";
  }
}

/** Startup only, after acquiring the existing SQLite owner's exclusive lock and
 * before accepting commands. This closes lost Native Plan work; it never opens
 * a workspace, resolves credentials, starts a provider/tool or releases a fence.
 * Captured Build and independently owned attempts retain their original owner.
 */
export async function reconcileLocalNativePlanTurn(input: {
  readonly admission: TurnAdmission;
  readonly lifecycleEvents: RecoveryStore;
  readonly workerId: WorkerId;
  readonly permissionProfileId: PermissionProfileId;
  readonly producerId: string;
  readonly clock: RuntimeKernelClock;
}): Promise<"settled" | "already_terminal" | "unsupported"> {
  // Delegated owners retain their opaque immutable selection, even when they
  // share a local worker/profile. Native admission never emits either tag.
  const source = input.admission;
  if (("harnessSelection" in source.run && source.run.harnessSelection !== undefined) ||
      (source.userMessage.type === "user_message" && source.userMessage.content.harnessSelection !== undefined)) {
    return "unsupported";
  }
  const admission = TurnAdmissionSchema.parse(source);
  if (
    admission.run.workerId !== WorkerIdSchema.parse(input.workerId) ||
    admission.run.mode !== "plan" ||
    admission.run.executionCapability !== "repository"
  )
    return "unsupported";
  const before = await readHistory(
    input.lifecycleEvents,
    admission,
    input.producerId,
  );
  if (before.terminal) return "already_terminal";
  if (admission.userMessage.type !== "user_message")
    throw new LocalNativePlanRecoveryError("invalid_history");
  const configuration = LocalTurnConfigurationSchema.safeParse(
    admission.userMessage.content.configuration,
  );
  if (!configuration.success || configuration.data.mode !== "plan")
    throw new LocalNativePlanRecoveryError("invalid_history");

  const permissionProfileId = PermissionProfileIdSchema.parse(
    `${PermissionProfileIdSchema.parse(input.permissionProfileId)}_${configuration.data.productMode}`,
  );
  if (admission.run.permissionProfileId !== permissionProfileId)
    return "unsupported";

  if (before.oversized)
    throw new LocalNativePlanRecoveryError("history_too_large");
  for (const event of before.events) {
    if (
      event.type === "tool_call.started" &&
      (typeof event.payload.toolName !== "string" ||
        !readOnlyTools.has(event.payload.toolName))
    ) {
      throw new LocalNativePlanRecoveryError("invalid_history");
    }
  }

  const constructed: LifecycleEvent[] = [];
  const options = {
    sink: {
      appendBatch: async (events: readonly LifecycleEvent[]) => {
        constructed.push(...events);
        return events;
      },
    },
    producerId: input.producerId,
    clock: input.clock,
    threadId: admission.run.threadId,
    workspaceId: admission.run.workspaceId,
    turnId: admission.turn.id,
    runAttemptId: admission.runAttemptId,
    executionCapability: admission.run.executionCapability,
  };
  const failure = {
    code: "worker_unavailable" as const,
    message: "Local runtime stopped before this Plan Turn finished",
    retryable: false,
    correlationId: null,
    details: { reason: "local_runtime_process_lost" },
  };
  try {
    if (before.events.length === 0) {
      const coordinator = new RuntimeLifecycleCoordinator(options);
      await coordinator.start();
      await coordinator.fail(failure);
    } else {
      const coordinator = RuntimeLifecycleCoordinator.restoreForProcessLoss(
        options,
        before.events,
      );
      await coordinator.failAfterProcessLoss(failure);
    }
  } catch {
    // Validation or construction failure has not touched durable history.
    throw new LocalNativePlanRecoveryError("invalid_history");
  }

  try {
    // Atomic append includes every pending receipt, open item, attempt and Turn.
    await input.lifecycleEvents.appendBatch(constructed);
  } catch {
    const after = await readHistory(
      input.lifecycleEvents,
      admission,
      input.producerId,
    );
    if (after.terminal) return "already_terminal";
    throw new LocalNativePlanRecoveryError("settlement_unconfirmed");
  }
  const after = await readHistory(
    input.lifecycleEvents,
    admission,
    input.producerId,
  );
  if (!after.terminal)
    throw new LocalNativePlanRecoveryError("settlement_unconfirmed");
  return "settled";
}

/** Page memory is bounded even for already-terminal large Turns. Oversized live
 * history is never truncated or reconstructed from a partial lifecycle prefix. */
async function readHistory(
  store: RecoveryStore,
  admission: TurnAdmission,
  producerId: string,
): Promise<{
  events: readonly LifecycleEvent[];
  terminal: TerminalEvent | null;
  oversized: boolean;
}> {
  let afterSequence: number | null = null;
  let sequence = 0;
  let bytes = 0;
  let count = 0;
  let oversized = false;
  let terminal: TerminalEvent | null = null;
  const events: LifecycleEvent[] = [];
  for (;;) {
    const page = await store.replay({
      turnId: admission.turn.id,
      afterSequence,
      limit: 128,
    });
    for (const value of page.events) {
      const event = LifecycleEventSchema.parse(value);
      if (
        event.threadId !== admission.run.threadId ||
        event.turnId !== admission.turn.id ||
        event.runAttemptId !== admission.runAttemptId ||
        event.producer.kind !== "runtime_kernel" ||
        event.producer.id !== producerId ||
        event.sequence !== sequence + 1 ||
        terminal
      ) {
        throw new LocalNativePlanRecoveryError("invalid_history");
      }
      if (
        event.type === "run_attempt.started" &&
        event.payload.executionCapability !== admission.run.executionCapability
      ) {
        throw new LocalNativePlanRecoveryError("invalid_history");
      }
      sequence = event.sequence;
      count += 1;
      bytes += encoder.encode(JSON.stringify(event)).byteLength;
      if (
        count > MAX_RESTORED_HISTORY_EVENTS ||
        bytes > MAX_RESTORED_HISTORY_BYTES
      ) {
        oversized = true;
        events.length = 0;
      }
      if (!oversized) events.push(event);
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      )
        terminal = event;
    }
    if (page.nextSequence === null) return { events, terminal, oversized };
    if (
      !page.events.length ||
      page.nextSequence !== sequence ||
      page.nextSequence <= (afterSequence ?? 0)
    )
      throw new LocalNativePlanRecoveryError("invalid_history");
    afterSequence = page.nextSequence;
  }
}
