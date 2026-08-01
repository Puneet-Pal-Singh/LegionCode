import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/persistence";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";

interface LifecycleBridgeInput {
  readonly store: LifecycleEventStore;
  readonly onAssistantMessageDelta?: (
    event: LifecycleEvent,
  ) => Promise<void>;
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
      if (event.type === "assistant_message.delta") {
        await this.input.onAssistantMessageDelta?.(event);
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
