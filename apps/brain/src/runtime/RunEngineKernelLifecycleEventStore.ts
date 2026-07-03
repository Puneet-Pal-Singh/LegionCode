import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/event-store";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { LifecycleEventStreamPort } from "./ports";

interface LifecycleBridgeInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly store: LifecycleEventStore;
  readonly stream: LifecycleEventStreamPort;
}

export class RunEngineKernelLifecycleEventStore implements LifecycleEventStore {
  constructor(private readonly input: LifecycleBridgeInput) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const appended = await this.input.store.appendBatch(events);
    for (const event of appended) {
      this.input.stream.emit(event);
      if (isTerminalLifecycleEvent(event)) {
        this.input.stream.complete(event.turnId);
      }
    }
    return appended;
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    return await this.input.store.replay(input);
  }
}

function isTerminalLifecycleEvent(event: LifecycleEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.interrupted"
  );
}
