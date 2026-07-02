import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { RunEvent } from "@repo/shared-types";
import type { CanonicalRunEventSink } from "./RunEngineRequestHandler";

interface RuntimeLifecycleEventStore {
  append(event: LifecycleEvent): Promise<LifecycleEvent>;
  appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]>;
  replay(input: {
    turnId: LifecycleEvent["turnId"];
    afterSequence: number | null;
    limit: number;
  }): Promise<{
    events: readonly LifecycleEvent[];
    nextSequence: number | null;
  }>;
}

interface LifecycleBridgeInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly sink: CanonicalRunEventSink;
  readonly onRunEvent?: (event: RunEvent) => void;
}

export class RunEngineKernelLifecycleEventStore implements RuntimeLifecycleEventStore {
  private readonly lifecycleEvents: LifecycleEvent[] = [];

  constructor(_input: LifecycleBridgeInput) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    this.lifecycleEvents.push(...events);
    return events;
  }

  async replay(input: {
    turnId: LifecycleEvent["turnId"];
    afterSequence: number | null;
    limit: number;
  }): Promise<{
    events: readonly LifecycleEvent[];
    nextSequence: number | null;
  }> {
    const afterSequence = input.afterSequence ?? 0;
    const events = this.lifecycleEvents
      .filter((event) => event.turnId === input.turnId)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, input.limit);
    return { events, nextSequence: events.at(-1)?.sequence ?? null };
  }
}
