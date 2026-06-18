import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import {
  registerLifecycleSettlementConformance,
  type LifecycleEventLogContract,
} from "./lifecycle.js";

class MemoryLifecycleEventLog implements LifecycleEventLogContract {
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
      .slice(0, input.limit);
    return {
      events: cloneEvents(events),
      nextSequence: events.at(-1)?.sequence ?? null,
    };
  }
}

class TransactionalLifecycleEventLog implements LifecycleEventLogContract {
  private events: LifecycleEvent[] = [];

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const draft = [...this.events];
    const parsed = events.map(parseLifecycleEvent);
    draft.push(...parsed);
    assertNoDuplicateSequence(draft);
    this.events = draft;
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

registerLifecycleSettlementConformance(
  "MemoryLifecycleEventLog",
  () => new MemoryLifecycleEventLog(),
);

registerLifecycleSettlementConformance(
  "TransactionalLifecycleEventLog",
  () => new TransactionalLifecycleEventLog(),
);

describe("lifecycle event log conformance adapters", () => {
  it("keeps appendBatch atomic when duplicate sequences are rejected", async () => {
    const log = new TransactionalLifecycleEventLog();
    const first = createEvent(1, "turn.queued");
    const duplicate = createEvent(1, "turn.started");

    await expect(log.appendBatch([first, duplicate])).rejects.toThrow(
      "Duplicate lifecycle sequence",
    );
    await expect(log.replay({ afterSequence: null, limit: 10 })).resolves.toEqual({
      events: [],
      nextSequence: null,
    });
  });
});

function parseLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  return LifecycleEventSchema.parse(event);
}

function cloneEvents(events: readonly LifecycleEvent[]): readonly LifecycleEvent[] {
  return structuredClone(events);
}

function assertNoDuplicateSequence(events: readonly LifecycleEvent[]): void {
  const sequences = new Set<number>();
  for (const event of events) {
    if (sequences.has(event.sequence)) {
      throw new Error(`Duplicate lifecycle sequence: ${event.sequence}`);
    }
    sequences.add(event.sequence);
  }
}

function createEvent(
  sequence: number,
  type: "turn.queued" | "turn.started",
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_adapter${String(sequence).padStart(3, "0")}`,
    threadId: "thr_adapter001",
    turnId: "trn_adapter001",
    runAttemptId: "attempt_adapter001",
    sequence,
    idempotencyKey: `adapter:${sequence}`,
    producer: { kind: "runtime_kernel", id: "conformance" },
    schemaVersion: 1,
    createdAt: "2026-06-17T00:00:00.000Z",
    type,
    payload: {},
  });
}

