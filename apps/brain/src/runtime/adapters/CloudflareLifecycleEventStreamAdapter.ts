import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { LifecycleEventStreamPort } from "../ports/LifecycleEventStreamPort";

interface LifecycleStreamSubscriber {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  nextEventIndex: number;
}

export class CloudflareLifecycleEventStreamAdapter implements LifecycleEventStreamPort {
  private readonly eventsByTurn = new Map<string, LifecycleEvent[]>();
  private readonly subscribersByTurn = new Map<
    string,
    Set<LifecycleStreamSubscriber>
  >();
  private readonly completedTurns = new Set<string>();

  start(turnId: string): void {
    this.completedTurns.delete(turnId);
    this.eventsByTurn.delete(turnId);
    for (const subscriber of this.subscribersByTurn.get(turnId) ?? []) {
      subscriber.nextEventIndex = 0;
    }
  }

  emit(event: LifecycleEvent): void {
    if (this.completedTurns.has(event.turnId)) {
      return;
    }

    const events = this.eventsByTurn.get(event.turnId) ?? [];
    events.push(event);
    this.eventsByTurn.set(event.turnId, events);
    this.flushTurn(event.turnId);
  }

  complete(turnId: string): void {
    this.completedTurns.add(turnId);
    for (const subscriber of this.subscribersByTurn.get(turnId) ?? []) {
      this.closeSubscriber(turnId, subscriber);
    }
    this.subscribersByTurn.delete(turnId);
    this.eventsByTurn.delete(turnId);
  }

  getStream(
    turnId: string,
    afterSequence: number | null,
  ): ReadableStream<Uint8Array> {
    let activeSubscriber: LifecycleStreamSubscriber | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.completedTurns.has(turnId)) {
          controller.close();
          return;
        }

        const events = this.eventsByTurn.get(turnId) ?? [];
        const subscriber = {
          controller,
          nextEventIndex: resolveNextEventIndex(events, afterSequence),
        };
        activeSubscriber = subscriber;
        const subscribers = this.subscribersByTurn.get(turnId) ?? new Set();
        subscribers.add(subscriber);
        this.subscribersByTurn.set(turnId, subscribers);
        this.flushSubscriber(turnId, subscriber);
      },
      cancel: () => {
        if (activeSubscriber) {
          this.removeSubscriber(turnId, activeSubscriber);
        }
      },
    });
  }

  private flushTurn(turnId: string): void {
    for (const subscriber of this.subscribersByTurn.get(turnId) ?? []) {
      if (!this.flushSubscriber(turnId, subscriber)) {
        this.removeSubscriber(turnId, subscriber);
      }
    }
  }

  private flushSubscriber(
    turnId: string,
    subscriber: LifecycleStreamSubscriber,
  ): boolean {
    const events = this.eventsByTurn.get(turnId) ?? [];
    while (subscriber.nextEventIndex < events.length) {
      const event = events[subscriber.nextEventIndex];
      if (!event) {
        return true;
      }
      try {
        subscriber.controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(event)}\n`),
        );
      } catch {
        return false;
      }
      subscriber.nextEventIndex += 1;
    }
    return true;
  }

  private closeSubscriber(
    turnId: string,
    subscriber: LifecycleStreamSubscriber,
  ): void {
    try {
      subscriber.controller.close();
    } catch {
      // Stream closure is best effort; durable lifecycle events remain canonical.
    }
    this.removeSubscriber(turnId, subscriber);
  }

  private removeSubscriber(
    turnId: string,
    subscriber: LifecycleStreamSubscriber,
  ): void {
    const subscribers = this.subscribersByTurn.get(turnId);
    if (!subscribers) {
      return;
    }
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.subscribersByTurn.delete(turnId);
    }
  }
}

function resolveNextEventIndex(
  events: readonly LifecycleEvent[],
  afterSequence: number | null,
): number {
  if (afterSequence === null) {
    return 0;
  }
  const index = events.findIndex((event) => event.sequence > afterSequence);
  return index === -1 ? events.length : index;
}
