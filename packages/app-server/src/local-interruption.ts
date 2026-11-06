import type {
  InterruptTurnResponse,
  Run,
  Turn,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from "@repo/platform-protocol";

/** Canonical admission identity; deliberately excludes hosted session identity. */
export type LocalInterruptionIdentity = {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
};

export type LocalInterruptionRequest = LocalInterruptionIdentity & {
  readonly reason: string;
};

export type LocalInterruptionAdmission = {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: RunAttemptId;
};

export type LocalInterruptionServiceOptions = {
  turnAdmissions: {
    getByTurn(turnId: TurnId): Promise<LocalInterruptionAdmission | null>;
  };
  executor: {
    /** Reject inactive turns; never queue an interrupt for a later execution. */
    interrupt(turnId: TurnId, reason: string): Promise<void>;
  };
};

/** Command admission only. Runtime append/replay remains terminal truth. */
export class LocalInterruptionService {
  constructor(private readonly options: LocalInterruptionServiceOptions) {}

  async interruptTurn(request: LocalInterruptionRequest): Promise<InterruptTurnResponse> {
    // Capture the command before crossing the asynchronous admission lookup.
    const identity: LocalInterruptionIdentity = {
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      runId: request.runId,
      turnId: request.turnId,
      runAttemptId: request.runAttemptId,
    };
    const reason = request.reason;
    const admission = await this.options.turnAdmissions.getByTurn(identity.turnId);
    if (
      !admission ||
      admission.run.workspaceId !== identity.workspaceId ||
      admission.run.threadId !== identity.threadId ||
      admission.run.id !== identity.runId ||
      admission.turn.id !== identity.turnId ||
      admission.runAttemptId !== identity.runAttemptId ||
      admission.turn.threadId !== identity.threadId ||
      admission.turn.runId !== identity.runId
    ) {
      throw new LocalInterruptionAttemptNotActiveError();
    }
    await this.options.executor.interrupt(identity.turnId, reason);
    return { runId: identity.runId, accepted: true, status: "interrupt_requested" };
  }
}

export class LocalInterruptionAttemptNotActiveError extends Error {
  constructor() {
    super("The exact local run attempt is not active");
    this.name = "LocalInterruptionAttemptNotActiveError";
  }
}
