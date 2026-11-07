import {
  RuntimeKernelError,
  type WorkerProtocolPort,
} from "@repo/runtime-kernel";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";

type QuiescenceProof = NonNullable<WorkerProtocolPort["awaitQuiescence"]>;

/** A physical owner's positive acquisition-failure receipt, never a substitute worker. */
export class LocalTurnPreparationFailure extends RuntimeKernelError {
  readonly attempt: LocalTurnAttemptIdentity;
  private readonly proof: QuiescenceProof;

  constructor(
    options: {
      readonly attempt: LocalTurnAttemptIdentity;
      readonly awaitQuiescence: QuiescenceProof;
    },
    cause: unknown,
  ) {
    super(
      "workspace_not_executable",
      (cause instanceof Error && cause.message
        ? cause.message
        : "Captured execution preparation failed"
      ).slice(0, 500),
      cause,
    );
    this.name = "LocalTurnPreparationFailure";
    this.attempt = Object.freeze({
      workspaceId: options.attempt.workspaceId,
      threadId: options.attempt.threadId,
      runId: options.attempt.runId,
      turnId: options.attempt.turnId,
      runAttemptId: options.attempt.runAttemptId,
    });
    this.proof = options.awaitQuiescence;
  }

  matchesAttempt(attempt: LocalTurnAttemptIdentity): boolean {
    return (
      this.attempt.workspaceId === attempt.workspaceId &&
      this.attempt.threadId === attempt.threadId &&
      this.attempt.runId === attempt.runId &&
      this.attempt.turnId === attempt.turnId &&
      this.attempt.runAttemptId === attempt.runAttemptId
    );
  }

  async awaitQuiescence(
    input: Parameters<QuiescenceProof>[0],
  ): Promise<boolean> {
    if (
      input.turnId !== this.attempt.turnId ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs < 0
    )
      return false;
    try {
      return await this.proof(input);
    } catch {
      return false;
    }
  }
}
