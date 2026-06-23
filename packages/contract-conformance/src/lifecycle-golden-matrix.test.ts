import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import { registerLifecycleGoldenMatrixConformance } from "./lifecycle-golden-matrix.js";
import type { LifecycleEventLogContract } from "./lifecycle.js";

class MemoryGoldenLifecycleEventLog implements LifecycleEventLogContract {
  private events: LifecycleEvent[] = [];

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const parsed = events.map(parseLifecycleEvent);
    this.events.push(...parsed);
    return cloneEvents(parsed);
  }

  async replay(input: {
    afterSequence: number | null;
    limit: number;
  }): Promise<{ events: readonly LifecycleEvent[]; nextSequence: number | null }> {
    const events = this.events
      .filter((event) => input.afterSequence === null || event.sequence > input.afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, input.limit);
    return {
      events: cloneEvents(events),
      nextSequence: events.at(-1)?.sequence ?? null,
    };
  }
}

registerLifecycleGoldenMatrixConformance(
  "MemoryGoldenLifecycleEventLog",
  () => new MemoryGoldenLifecycleEventLog(),
);

function parseLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  return LifecycleEventSchema.parse(event);
}

function cloneEvents(events: readonly LifecycleEvent[]): readonly LifecycleEvent[] {
  return structuredClone(events);
}
