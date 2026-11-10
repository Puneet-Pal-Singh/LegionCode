import { appServerJsonByteLength, type LifecycleEvent } from "@repo/platform-protocol";
import { EventStoreError, LifecycleReplayEventTooLargeError } from "./errors.js";
import type { ReplayLifecycleEventsInput, ReplayLifecycleEventsResult } from "./lifecycle-types.js";

const MIN_PAGE_BYTES = appServerJsonByteLength({ events: [], nextSequence: null });

/** One exact encoded-result budget shared by persistent and in-memory replay.
 * A rejected event is never appended or consumed as the returned cursor. */
export class LifecycleReplayPage {
  private readonly events: LifecycleEvent[] = [];
  private eventBytes = 0;
  private readonly turnId: ReplayLifecycleEventsInput["turnId"];
  private readonly afterSequence: number;
  private readonly maxBytes: number | undefined;

  constructor(input: ReplayLifecycleEventsInput) {
    this.turnId = input.turnId;
    this.afterSequence = input.afterSequence ?? 0;
    this.maxBytes = input.maxBytes;
    if (this.maxBytes !== undefined && (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < MIN_PAGE_BYTES)) {
      throw new EventStoreError("invalid_replay_byte_budget", "Invalid lifecycle replay byte budget");
    }
  }

  get size(): number { return this.events.length; }

  append(event: LifecycleEvent): boolean {
    if (event.turnId !== this.turnId || event.sequence !== this.afterSequence + this.events.length + 1) {
      throw new EventStoreError("corrupt_event_stream", "Lifecycle replay contains an identity or sequence gap");
    }
    if (this.maxBytes !== undefined) {
      const encodedByteLength = appServerJsonByteLength(event);
      const frameBytes = appServerJsonByteLength({ events: [], nextSequence: event.sequence });
      const commaBytes = this.events.length > 0 ? 1 : 0;
      if (frameBytes + this.eventBytes + commaBytes + encodedByteLength > this.maxBytes) {
        if (this.events.length === 0) {
          throw new LifecycleReplayEventTooLargeError(event.turnId, event.eventId, event.sequence, encodedByteLength);
        }
        return false;
      }
      this.eventBytes += commaBytes + encodedByteLength;
    }
    this.events.push(event);
    return true;
  }

  result(): ReplayLifecycleEventsResult {
    return { events: this.events, nextSequence: this.events.at(-1)?.sequence ?? null };
  }
}
