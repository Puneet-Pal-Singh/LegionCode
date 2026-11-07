import type { LocalPersistence } from "@repo/event-store/local";
import {
  InterruptTurnResponseSchema,
  TurnAdmissionSchema,
  type InterruptTurnResponse,
  type LifecycleEvent,
  type TurnId,
} from "@repo/platform-protocol";
import {
  LocalTurnInterruptParamsSchema,
  type LocalTurnInterruptParams,
} from "./protocol.js";

/** Canonical local admission identity, without hosted session selectors. */
export type LocalInterruptionIdentity = Readonly<
  Pick<
    LocalTurnInterruptParams,
    "workspaceId" | "threadId" | "runId" | "turnId" | "runAttemptId"
  >
>;
export type LocalInterruptionRequest = LocalTurnInterruptParams;

export type LocalInterruptionServiceOptions = {
  turnAdmissions: Pick<LocalPersistence["turnAdmissions"], "getByTurn">;
  lifecycleEvents: Pick<LocalPersistence["lifecycleEvents"], "replay">;
  executor: {
    /** Reject an unowned attempt; never queue Stop for a future execution. */
    interrupt(turnId: TurnId, reason: string): Promise<void>;
  };
};

type TerminalEvent = Extract<
  LifecycleEvent,
  { type: "turn.completed" | "turn.failed" | "turn.interrupted" }
>;

/** Admit the command only. Runtime remains the sole interruption/terminal writer. */
export class LocalInterruptionService {
  constructor(private readonly options: LocalInterruptionServiceOptions) {}

  async interruptTurn(input: unknown): Promise<InterruptTurnResponse> {
    // Parse/copy before asynchronous lookup so a caller cannot retarget Stop.
    const request = LocalTurnInterruptParamsSchema.parse(input);
    const stored = await this.options.turnAdmissions.getByTurn(request.turnId);
    if (!stored) throw new LocalInterruptionAttemptNotActiveError();
    const admission = TurnAdmissionSchema.parse(stored);
    if (
      admission.run.workspaceId !== request.workspaceId ||
      admission.run.threadId !== request.threadId ||
      admission.run.id !== request.runId ||
      admission.turn.id !== request.turnId ||
      admission.runAttemptId !== request.runAttemptId ||
      admission.turn.threadId !== request.threadId ||
      admission.turn.runId !== request.runId
    ) {
      throw new LocalInterruptionAttemptNotActiveError();
    }
    const response = (
      terminalEvent: TerminalEvent | null,
    ): InterruptTurnResponse =>
      InterruptTurnResponseSchema.parse({
        runId: request.runId,
        accepted: true,
        status: terminalEvent ? "settled" : "interrupt_requested",
        ...(terminalEvent ? { terminalEvent } : {}),
      });
    // A duplicate Stop after restart must read durable truth, not require a live handle.
    const terminal = await this.readTerminal(request);
    if (terminal) return response(terminal);
    try {
      await this.options.executor.interrupt(request.turnId, request.reason);
    } catch (error) {
      // The runtime may have appended the terminal before its acknowledgement failed.
      const settled = await this.readTerminal(request);
      if (settled) return response(settled);
      // Process loss without terminal evidence is not an interrupted Turn.
      throw error;
    }
    return response(await this.readTerminal(request));
  }

  private async readTerminal(
    identity: LocalInterruptionIdentity,
  ): Promise<TerminalEvent | null> {
    let afterSequence: number | null = null;
    for (;;) {
      const page = await this.options.lifecycleEvents.replay({
        turnId: identity.turnId,
        afterSequence,
        limit: 1_000,
      });
      let terminal: TerminalEvent | null = null;
      for (const event of page.events) {
        if (
          event.turnId !== identity.turnId ||
          event.threadId !== identity.threadId ||
          event.runAttemptId !== identity.runAttemptId ||
          terminal !== null
        ) {
          throw new LocalInterruptionAttemptNotActiveError();
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted"
        )
          terminal = event;
      }
      if (terminal) return terminal;
      if (page.events.length < 1_000 || page.nextSequence === null) return null;
      if (page.nextSequence <= (afterSequence ?? 0)) {
        throw new LocalInterruptionAttemptNotActiveError();
      }
      afterSequence = page.nextSequence;
    }
  }
}

export class LocalInterruptionAttemptNotActiveError extends Error {
  constructor() {
    super("The exact local run attempt is not active");
    this.name = "LocalInterruptionAttemptNotActiveError";
  }
}
