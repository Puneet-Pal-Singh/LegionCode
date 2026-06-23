import type {
  EventId,
  EventIdempotencyKey,
  EventSequence,
  LifecycleEvent,
  TurnId,
} from "@repo/platform-protocol";

export type LifecycleContinuationErrorCode =
  | "lifecycle_turn_mismatch"
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
  accept(event: LifecycleEvent): boolean;
}

export function createLifecycleOrderingState(
  turnId: TurnId,
  afterSequence: EventSequence | null,
): LifecycleOrderingState {
  return new DefaultLifecycleOrderingState(turnId, afterSequence ?? 0);
}

class DefaultLifecycleOrderingState implements LifecycleOrderingState {
  private readonly eventIds = new Set<EventId>();
  private readonly idempotencyKeys = new Set<EventIdempotencyKey>();

  constructor(
    private readonly turnId: TurnId,
    private currentSequence: EventSequence,
  ) {}

  get lastSequence(): EventSequence {
    return this.currentSequence;
  }

  accept(event: LifecycleEvent): boolean {
    this.assertTurn(event);
    if (event.sequence <= this.currentSequence) {
      return this.acceptDuplicateOrThrow(event);
    }
    this.assertNext(event);
    this.remember(event);
    this.currentSequence = event.sequence;
    return true;
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
