import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/persistence";
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
      this.emitLifecycleEvent(event);
      if (isTerminalLifecycleEvent(event)) {
        this.completeLifecycleStream(event);
      }
    }
    return appended;
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    return await this.input.store.replay(input);
  }

  private emitLifecycleEvent(event: LifecycleEvent): void {
    try {
      this.input.stream.emit(event);
    } catch (error) {
      console.warn(
        `[runtime/lifecycle-live] emit failed runId=${this.input.runId} turnId=${event.turnId} sequence=${event.sequence} type=${event.type} correlationId=${this.input.correlationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private completeLifecycleStream(event: LifecycleEvent): void {
    try {
      this.input.stream.complete(event.turnId);
    } catch (error) {
      console.warn(
        `[runtime/lifecycle-live] complete failed runId=${this.input.runId} turnId=${event.turnId} sequence=${event.sequence} type=${event.type} correlationId=${this.input.correlationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function isTerminalLifecycleEvent(event: LifecycleEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.interrupted"
  );
}
