import type {
  InterruptTurnResponse,
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

/** The runtime owns this handle and binds it permanently to one admitted attempt. */
export type LocalActiveAttempt = {
  readonly identity: LocalInterruptionIdentity;
  /** Must reject a retired handle, never redirect cancellation to another attempt. */
  interrupt(reason: string): Promise<void>;
};

export type LocalInterruptionServiceOptions = {
  getActiveAttempt(
    identity: LocalInterruptionIdentity,
  ): Promise<LocalActiveAttempt | null>;
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
    const attempt = await this.options.getActiveAttempt(identity);
    if (
      !attempt ||
      attempt.identity.workspaceId !== identity.workspaceId ||
      attempt.identity.threadId !== identity.threadId ||
      attempt.identity.runId !== identity.runId ||
      attempt.identity.turnId !== identity.turnId ||
      attempt.identity.runAttemptId !== identity.runAttemptId
    ) {
      throw new LocalInterruptionAttemptNotActiveError();
    }
    await attempt.interrupt(reason);
    return { runId: identity.runId, accepted: true, status: "interrupt_requested" };
  }
}

export class LocalInterruptionAttemptNotActiveError extends Error {
  constructor() {
    super("The exact local run attempt is not active");
    this.name = "LocalInterruptionAttemptNotActiveError";
  }
}
