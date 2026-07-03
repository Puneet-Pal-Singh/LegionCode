import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/event-store";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import { PostgresLifecycleEventStore } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";

export class BrainLifecycleEventStore implements LifecycleEventStore {
  constructor(private readonly env: Env) {}

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    return await this.withStore((store) => store.appendBatch(events));
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    return await this.withStore((store) => store.replay(input));
  }

  private async withStore<T>(
    callback: (store: LifecycleEventStore) => Promise<T>,
  ): Promise<T> {
    return await withBrainPersistenceRepository(
      this.env,
      this.env.AUTH_LIFECYCLE_EVENT_STORE,
      (client) => new PostgresLifecycleEventStore(client),
      callback,
    );
  }
}
