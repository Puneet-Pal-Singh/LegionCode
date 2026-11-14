import type {
  EventId,
  EventIdempotencyKey,
  EventSequence,
  LifecycleEvent,
  NativeExecutionRecoveryProjection,
  ReplayLifecycleEventsResponse,
  TurnId,
} from "@repo/platform-protocol";
import { sameLifecycleAttempt, type LifecycleAttemptIdentity } from "../workflow/lifecycle-attempt.js";

export type LifecycleContinuationErrorCode =
  | "lifecycle_turn_mismatch"
  | "lifecycle_attempt_mismatch"
  | "lifecycle_sequence_gap"
  | "lifecycle_sequence_regression";

export class LifecycleContinuationError extends Error {
  constructor(
    readonly code: LifecycleContinuationErrorCode,
    message: string,
    readonly expectedSequence: EventSequence | null,
    readonly receivedSequence: EventSequence | null,
  ) {
    super(message);
    this.name = "LifecycleContinuationError";
  }
}

export interface LifecycleOrderingState {
  readonly lastSequence: EventSequence;
  readonly runtimeAttempt: LifecycleAttemptIdentity | undefined;
  acceptRecovery(recovery: NativeExecutionRecoveryProjection): void;
  accept(event: LifecycleEvent): boolean;
}

export function createLifecycleOrderingState(
  turnId: TurnId,
  afterSequence: EventSequence | null,
  expectedAttempt?: LifecycleAttemptIdentity,
): LifecycleOrderingState {
  return new DefaultLifecycleOrderingState(turnId, afterSequence ?? 0, expectedAttempt);
}

/** A page cursor names its last accepted event, never an unseen later event.
 * Page counts are not exhaustion evidence when transport pages have byte bounds.
 */
export function acceptLifecycleReplayPage(
  page: ReplayLifecycleEventsResponse,
  state: LifecycleOrderingState,
): ReplayLifecycleEventsResponse {
  if (page.recovery) state.acceptRecovery(page.recovery);
  const previousSequence = state.lastSequence;
  const events = page.events.filter((event) => state.accept(event));
  const lastSequence = state.lastSequence;
  if (page.events.length === 0 && page.nextSequence === null) {
    return { events, nextSequence: null, ...(page.recovery ? { recovery: page.recovery } : {}) };
  }
  if (
    page.events.length === 0 ||
    lastSequence <= previousSequence ||
    (page.nextSequence !== null &&
      (!Number.isSafeInteger(page.nextSequence) || page.nextSequence !== lastSequence))
  ) {
    throw new LifecycleContinuationError(
      page.nextSequence !== null && page.nextSequence > lastSequence
        ? "lifecycle_sequence_gap"
        : "lifecycle_sequence_regression",
      "Lifecycle replay page did not preserve its accepted sequence cursor",
      lastSequence > previousSequence ? lastSequence : previousSequence + 1,
      page.nextSequence,
    );
  }
  return { events, nextSequence: page.nextSequence, ...(page.recovery ? { recovery: page.recovery } : {}) };
}

class DefaultLifecycleOrderingState implements LifecycleOrderingState {
  private readonly eventIds = new Set<EventId>();
  private readonly idempotencyKeys = new Set<EventIdempotencyKey>();
  private attempt: LifecycleAttemptIdentity | undefined;

  constructor(
    private readonly turnId: TurnId,
    private currentSequence: EventSequence,
    expectedAttempt?: LifecycleAttemptIdentity,
  ) {
    if (expectedAttempt) this.pinAttempt(expectedAttempt);
  }

  get lastSequence(): EventSequence {
    return this.currentSequence;
  }

  get runtimeAttempt(): LifecycleAttemptIdentity | undefined {
    return this.attempt;
  }

  acceptRecovery(recovery: NativeExecutionRecoveryProjection): void {
    if (recovery.turnId !== this.turnId) {
      throw new LifecycleContinuationError(
        "lifecycle_turn_mismatch",
        `Received lifecycle recovery for ${recovery.turnId}; expected ${this.turnId}`,
        null,
        null,
      );
    }
    this.assertAttempt(recovery, null);
    if (!this.attempt) this.pinAttempt(recovery);
  }

  accept(event: LifecycleEvent): boolean {
    this.assertTurn(event);
    this.assertAttempt(event, event.sequence);
    if (event.sequence <= this.currentSequence) {
      return this.acceptDuplicateOrThrow(event);
    }
    this.assertNext(event);
    if (!this.attempt) this.pinAttempt(event);
    this.remember(event);
    this.currentSequence = event.sequence;
    return true;
  }

  private pinAttempt(attempt: LifecycleAttemptIdentity): void {
    this.attempt = Object.freeze({ threadId: attempt.threadId, runAttemptId: attempt.runAttemptId });
  }

  private assertAttempt(attempt: LifecycleAttemptIdentity, sequence: EventSequence | null): void {
    if (this.attempt && !sameLifecycleAttempt(attempt, this.attempt)) {
      throw new LifecycleContinuationError(
        "lifecycle_attempt_mismatch",
        "Lifecycle continuation does not match its captured thread and run attempt",
        null,
        sequence,
      );
    }
  }

  private assertTurn(event: LifecycleEvent): void {
    if (event.turnId !== this.turnId) {
      throw new LifecycleContinuationError(
        "lifecycle_turn_mismatch",
        `Received lifecycle event for ${event.turnId}; expected ${this.turnId}`,
        null,
        event.sequence,
      );
    }
  }

  private acceptDuplicateOrThrow(event: LifecycleEvent): boolean {
    if (
      this.eventIds.has(event.eventId) ||
      this.idempotencyKeys.has(event.idempotencyKey)
    ) {
      return false;
    }
    throw new LifecycleContinuationError(
      "lifecycle_sequence_regression",
      `Received unknown lifecycle event at sequence ${event.sequence}`,
      this.currentSequence + 1,
      event.sequence,
    );
  }

  private assertNext(event: LifecycleEvent): void {
    const expected = this.currentSequence + 1;
    if (event.sequence !== expected) {
      throw new LifecycleContinuationError(
        "lifecycle_sequence_gap",
        `Expected lifecycle sequence ${expected}; received ${event.sequence}`,
        expected,
        event.sequence,
      );
    }
  }

  private remember(event: LifecycleEvent): void {
    this.eventIds.add(event.eventId);
    this.idempotencyKeys.add(event.idempotencyKey);
  }
}
