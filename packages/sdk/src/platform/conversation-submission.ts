import type { ConversationScope } from "./conversation-scope.js";
import {
  acquireSubmissionAttempt,
  finishSubmissionAttempt,
  retainSubmissionReservation,
  type SubmissionAttempt,
  type SubmissionOutcome,
} from "./submission-attempt-registry.js";
import { hasCanonicalLifecycleEvidence } from "./submission-evidence.js";
import type { PlatformClient } from "./types.js";

/** The captured configuration and actual reservation handed to dispatch. */
export interface ConversationSubmissionDispatch<TConfig> {
  readonly config: TConfig;
  readonly scope: ConversationScope;
  readonly clientMessageId: string;
}

/**
 * Existing non-React submission seams. React state, DOM events, the request
 * builder, network dispatch and Stop observation stay with the host.
 */
export interface ConversationSubmissionBindings<TConfig> {
  readonly sessionId: string;
  readonly runId: string;
  readonly runScopeGeneration: number;
  readonly clientMessageId?: string;
  readonly intentKey: string;
  readonly intentFingerprint: string;
  readonly lifecycleClient: Pick<PlatformClient, "followTurnLifecycle">;
  /** Resolve and capture the selected provider/configuration once. */
  readonly resolveProviderConfig: () => Promise<TConfig | null>;
  /** Bind the one active submission, optimistic identity and Stop target. */
  readonly onAttemptAcquired: (attempt: SubmissionAttempt) => void;
  /** Reuse attempt.scope or reserve the original run/CID canonical scope. */
  readonly reserveScope: (
    attempt: SubmissionAttempt,
  ) => Promise<ConversationScope>;
  /** Present and bind the retained reservation synchronously before dispatch. */
  readonly onReserved: (scope: ConversationScope) => boolean;
  /** True while a Stop requested for this exact run scope still applies. */
  readonly isStopPending: () => boolean;
  /** True while the invoking conversation scope still owns this submission. */
  readonly isInvocationActive: () => boolean;
  /** Existing diagnostic for a scope lost after provider resolution. */
  readonly onInactiveScopeAfterProviderResolution: () => void;
  /** Build and dispatch with the captured configuration and actual scope. */
  readonly dispatch: (
    submission: ConversationSubmissionDispatch<TConfig>,
  ) => Promise<void>;
  /** Observe an accepted turn's Stop through the host's interrupt helper. */
  readonly interruptAcceptedTurn: (
    attempt: SubmissionAttempt,
    scope: ConversationScope,
  ) => Promise<void>;
  /**
   * Observe an unconfirmed admission's Stop through the host's interrupt
   * helper. Resolves true only when the exact terminal settlement was seen.
   */
  readonly interruptUnconfirmedTurn: (
    attempt: SubmissionAttempt,
    scope: ConversationScope,
  ) => Promise<boolean>;
  /** Clear the presented reservation after a pre-dispatch cancellation. */
  readonly onReservationCancelled: (
    attempt: SubmissionAttempt,
    scope: ConversationScope,
  ) => void;
}

/**
 * The existing submission sequence moved out of `useChatCore`. It keeps one
 * attempt per session/intent/client message/generation, the retained
 * reservation and frozen retry identity, and settles the registry once.
 */
export async function submitConversationMessage<TConfig>(
  input: ConversationSubmissionBindings<TConfig>,
): Promise<SubmissionOutcome> {
  const acquired = acquireSubmissionAttempt({
    sessionId: input.sessionId,
    runId: input.runId,
    runScopeGeneration: input.runScopeGeneration,
    clientMessageId: input.clientMessageId,
    intentKey: input.intentKey,
    intentFingerprint: input.intentFingerprint,
  });
  if (!acquired) {
    return {
      status: "unconfirmed",
      message:
        "This submission is already in flight or its client identity belongs to a different intent.",
    };
  }
  if (acquired.previousOutcome) return acquired.previousOutcome;
  const attempt = acquired.attempt;
  input.onAttemptAcquired(attempt);
  try {
    const providerConfig = await input.resolveProviderConfig();
    if (!providerConfig) {
      if (!input.isInvocationActive()) {
        finishSubmissionAttempt(attempt, { status: "inactive" });
        return { status: "inactive" };
      }
      throw new Error(
        "The selected provider configuration is unavailable. Reconnect the provider or choose another model, then try again.",
      );
    }
    if (input.isStopPending()) {
      const outcome = cancelledBeforeDispatch(attempt);
      finishSubmissionAttempt(attempt, outcome);
      return outcome;
    }
    if (!input.isInvocationActive()) {
      input.onInactiveScopeAfterProviderResolution();
      const outcome: SubmissionOutcome = { status: "inactive" };
      finishSubmissionAttempt(attempt, outcome);
      return outcome;
    }

    const requestScope = attempt.scope ?? (await input.reserveScope(attempt));
    retainSubmissionReservation(attempt, requestScope);
    if (
      !input.isInvocationActive() ||
      !input.onReserved(requestScope) ||
      !input.isInvocationActive()
    ) {
      const outcome: SubmissionOutcome = {
        status: "inactive",
        scope: requestScope,
      };
      finishSubmissionAttempt(attempt, outcome);
      return outcome;
    }
    if (attempt.stopRequested || input.isStopPending()) {
      const outcome = cancelledBeforeDispatch(attempt, requestScope);
      finishSubmissionAttempt(attempt, outcome);
      input.onReservationCancelled(attempt, requestScope);
      return outcome;
    }

    try {
      await input.dispatch({
        config: providerConfig,
        scope: requestScope,
        clientMessageId: attempt.clientMessageId,
      });
    } catch (transportError) {
      attempt.transportError ??=
        transportError instanceof Error
          ? transportError.message
          : String(transportError);
    }
    const positivelyAcknowledged =
      attempt.responseStatus !== null &&
      attempt.responseStatus >= 200 &&
      attempt.responseStatus < 300 &&
      attempt.responseTupleMatches;
    const canonicalTurnAccepted =
      positivelyAcknowledged ||
      (await hasCanonicalLifecycleEvidence(
        input.lifecycleClient,
        requestScope,
      ));
    if (attempt.stopRequested && canonicalTurnAccepted) {
      await input.interruptAcceptedTurn(attempt, requestScope);
      const outcome: SubmissionOutcome = {
        status: "cancelled",
        admission: "accepted",
        scope: requestScope,
      };
      finishSubmissionAttempt(attempt, outcome);
      return outcome;
    }
    if (!canonicalTurnAccepted) {
      const message =
        attempt.transportError ??
        (attempt.responseStatus === null
          ? "The chat request ended without a bound admission acknowledgement. Retry this same intent manually."
          : `Chat admission could not be confirmed (HTTP ${attempt.responseStatus}). Retry this same intent manually.`);
      if (attempt.stopRequested && attempt.dispatched) {
        const interrupted = await input.interruptUnconfirmedTurn(
          attempt,
          requestScope,
        );
        if (interrupted) {
          const outcome: SubmissionOutcome = {
            status: "cancelled",
            admission: "accepted",
            scope: requestScope,
          };
          finishSubmissionAttempt(attempt, outcome);
          return outcome;
        }
      }
      const outcome: SubmissionOutcome = attempt.stopRequested
        ? {
            status: "cancelled",
            admission: "unconfirmed",
            scope: requestScope,
          }
        : { status: "unconfirmed", scope: requestScope, message };
      finishSubmissionAttempt(attempt, outcome);
      return outcome;
    }
    const outcome: SubmissionOutcome = {
      status: "accepted",
      scope: requestScope,
    };
    finishSubmissionAttempt(attempt, outcome);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: SubmissionOutcome = {
      status: attempt.stopRequested ? "cancelled" : "unconfirmed",
      ...(attempt.stopRequested
        ? {
            admission:
              attempt.dispatched || attempt.hadPriorDispatch
                ? ("unconfirmed" as const)
                : ("not-dispatched" as const),
          }
        : {}),
      ...(attempt.scope ? { scope: attempt.scope } : {}),
      ...(attempt.stopRequested ? {} : { message }),
    } as SubmissionOutcome;
    finishSubmissionAttempt(attempt, outcome);
    return outcome;
  }
}

function cancelledBeforeDispatch(
  attempt: SubmissionAttempt,
  scope?: ConversationScope,
): SubmissionOutcome {
  return {
    status: "cancelled",
    admission: attempt.hadPriorDispatch ? "unconfirmed" : "not-dispatched",
    ...(scope ? { scope } : {}),
  };
}
