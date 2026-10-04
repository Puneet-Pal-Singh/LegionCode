import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/persistence";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";

export class RunEngineKernelLifecycleEventStore implements LifecycleEventStore {
  constructor(private readonly input: { readonly store: LifecycleEventStore }) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    return await this.input.store.appendBatch(events);
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    return await this.input.store.replay(input);
  }

}
