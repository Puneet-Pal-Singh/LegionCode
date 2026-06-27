import type { TurnId } from "@repo/platform-protocol";
import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";

export interface ReplayLifecycleEventsInput {
  readonly turnId: TurnId;
  readonly afterSequence: number | null;
  readonly limit: number;
}

export interface ReplayLifecycleEventsResult {
  readonly events: readonly LifecycleEvent[];
  readonly nextSequence: number | null;
}

export interface LifecycleEventStore {
  append(event: LifecycleEvent): Promise<LifecycleEvent>;
  appendBatch(events: readonly LifecycleEvent[]): Promise<readonly LifecycleEvent[]>;
  replay(input: ReplayLifecycleEventsInput): Promise<ReplayLifecycleEventsResult>;
}
