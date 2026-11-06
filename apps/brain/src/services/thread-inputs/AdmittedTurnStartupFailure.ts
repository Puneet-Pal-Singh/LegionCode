import type { RunRecord } from "@repo/persistence";
import { workspaceIdFromExternalId, type ProtocolError, type TurnScopeBootstrap } from "@repo/platform-protocol";
import type { Env } from "../../types/ai";
import { withTurnAdmissionRepository } from "../turn-admissions/TurnAdmissionPersistenceFactory";
import { BrainLifecycleEventStore } from "../lifecycle/BrainLifecycleEventStore";
import { settleOwnedStartupFailure } from "../../runtime/RuntimeLifecycleSettlement";
import { sanitizeUnknownError } from "../../core/security/LogSanitizer";

export async function settleUnclaimedStartupFailure(input: {
  readonly env: Env;
  readonly userId: string;
  readonly sessionId: string;
  readonly run: RunRecord;
  readonly workspaceId: string;
  readonly identity: TurnScopeBootstrap;
  readonly correlationId: string;
  readonly error: unknown;
}): Promise<boolean> {
  const claimId = crypto.randomUUID();
  let claim;
  try {
    claim = await withTurnAdmissionRepository(input.env, (repository) =>
      repository.claimExecution({
        turnId: input.identity.turnId,
        runAttemptId: input.identity.runAttemptId,
        runId: input.run.id,
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.identity.threadId,
        claimId,
      }),
    );
  } catch (error) {
    console.error(
      "[thread-input/startup] could not claim pre-dispatch failure",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        error: sanitizeUnknownError(error),
      },
    );
    return false;
  }
  if (claim.status !== "claimed") {
    console.warn(
      "[thread-input/startup] pre-dispatch failure could not claim admitted turn",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        claimStatus: claim.status,
      },
    );
    return false;
  }

  const failure: ProtocolError = {
    code: "workspace_prepare_failed",
    message: sanitizeStartupFailure(input.error),
    retryable: true,
    correlationId: input.correlationId || null,
    details: null,
  };
  let result;
  try {
    result = await settleOwnedStartupFailure({
      store: new BrainLifecycleEventStore(input.env),
      claim: { turnId: input.identity.turnId, claimId },
      identity: {
        turnId: input.identity.turnId,
        runAttemptId: input.identity.runAttemptId,
        threadId: input.identity.threadId,
        workspaceId: workspaceIdFromExternalId(input.workspaceId),
        admittedWorkspaceId: input.workspaceId,
        userId: input.userId,
        sessionId: input.sessionId,
        runId: input.run.id,
        correlationId: input.correlationId,
        ...(input.identity.revisionOfTurnId
          ? { revisionOfTurnId: input.identity.revisionOfTurnId }
          : {}),
        ...(input.identity.continuationOfTurnId
          ? { continuationOfTurnId: input.identity.continuationOfTurnId }
          : {}),
        ...(input.identity.originalPromptId
          ? { originalPromptId: input.identity.originalPromptId }
          : {}),
      },
      markRecoveryRequired: (executionClaim) =>
        withTurnAdmissionRepository(input.env, (repository) =>
          repository.markRecoveryRequired(executionClaim),
        ),
      readAdmission: () =>
        withTurnAdmissionRepository(input.env, (repository) =>
          repository.getByTurnId(input.identity.turnId),
        ),
      interruptReason: null,
      failure,
    });
  } catch (error) {
    console.error("[thread-input/startup] admitted turn settlement failed", {
      correlationId: input.correlationId,
      turnId: input.identity.turnId,
      error: sanitizeUnknownError(error),
    });
    return false;
  }
  if (result.status !== "settled" && result.status !== "terminal_exists") {
    console.error(
      "[thread-input/startup] admitted turn settlement requires recovery",
      {
        correlationId: input.correlationId,
        turnId: input.identity.turnId,
        settlementStatus: result.status,
      },
    );
    return false;
  }
  return true;
}

function sanitizeStartupFailure(error: unknown): string {
  return (
    sanitizeUnknownError(error).slice(0, 10_000) ||
    "Runtime setup failed before execution began."
  );
}

