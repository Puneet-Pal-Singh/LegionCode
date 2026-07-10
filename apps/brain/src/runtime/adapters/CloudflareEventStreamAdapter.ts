/**
 * CloudflareEventStreamAdapter - Cloudflare implementation of RealtimeEventPort.
 *
 * Manages streaming events to clients via NDJSON format.
 * Bridges Cloudflare Workers streaming to port contracts.
 */

import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { StreamEvent, RealtimeEventPort } from "../ports";

interface StreamSubscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  nextEventIndex: number;
}

/**
 * Cloudflare Workers-backed implementation of event streaming.
 *
 * Owns:
 * - Event serialization and buffering
 * - NDJSON format generation
 * - Stream lifecycle and backpressure handling
 */
export class CloudflareEventStreamAdapter implements RealtimeEventPort {
  private events: Map<string, StreamEvent[]> = new Map();
  private subscribers = new Map<string, Set<StreamSubscriber>>();
  private completed: Set<string> = new Set();

  start(runId: string): void {
    this.completed.delete(runId);
    this.events.delete(runId);
    for (const subscriber of this.subscribers.get(runId) ?? []) {
      subscriber.nextEventIndex = 0;
    }
  }

  emit(event: StreamEvent): void {
    if (this.completed.has(event.runId)) {
      return;
    }

    const key = event.runId;
    if (!this.events.has(key)) {
      this.events.set(key, []);
    }

    this.events.get(key)!.push(event);
    this.flushToStream(key);
  }

  emitBatch(events: StreamEvent[]): void {
    for (const event of events) {
      this.emit(event);
    }
  }

  complete(runId: string): void {
    this.completed.add(runId);
    const subscribers = this.subscribers.get(runId);
    if (subscribers) {
      for (const subscriber of subscribers) {
        this.closeSubscriber(runId, subscriber);
      }
    }
    // Clean up per-run state to prevent memory accumulation in long-lived workers
    this.subscribers.delete(runId);
    this.events.delete(runId);
  }

  error(
    runId: string,
    error: {
      code: string;
      message: string;
      details?: unknown;
    },
  ): void {
    const errorEvent: StreamEvent = {
      version: 1,
      eventId: crypto.randomUUID(),
      runId,
      timestamp: new Date().toISOString(),
      source: "brain",
      type: RUN_EVENT_TYPES.RUN_FAILED,
      payload: {
        status: "failed",
        error: error.message,
        totalDurationMs: 0,
      },
    };

    this.emit(errorEvent);
    this.complete(runId);
  }

  getStream(runId: string): ReadableStream<Uint8Array> {
    let activeSubscriber: StreamSubscriber | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
        const subscriber = {
          controller,
          nextEventIndex: 0,
        };
        activeSubscriber = subscriber;
        const subscribers = this.subscribers.get(runId) ?? new Set();
        subscribers.add(subscriber);
        this.subscribers.set(runId, subscribers);
        // Flush any pending events
        this.flushToSubscriber(runId, subscriber);
      },
      cancel: () => {
        if (!activeSubscriber) {
          return;
        }
        this.removeSubscriber(runId, activeSubscriber);
      },
    });
  }

  private flushToStream(runId: string): void {
    const subscribers = this.subscribers.get(runId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const subscriber of Array.from(subscribers)) {
      const flushed = this.flushToSubscriber(runId, subscriber);
      if (!flushed) {
        this.removeSubscriber(runId, subscriber);
      }
    }
  }

  private flushToSubscriber(
    runId: string,
    subscriber: StreamSubscriber,
  ): boolean {
    const events = this.events.get(runId) || [];
    while (subscriber.nextEventIndex < events.length) {
      const event = events[subscriber.nextEventIndex]!;
      const serialized = JSON.stringify(event) + "\n";
      const uint8 = new TextEncoder().encode(serialized);

      try {
        subscriber.controller.enqueue(uint8);
        subscriber.nextEventIndex += 1;
      } catch (e) {
        console.error(
          `[event-stream] Failed to enqueue event for ${runId}:`,
          e,
        );
        return false;
      }
    }

    return true;
  }

  private closeSubscriber(runId: string, subscriber: StreamSubscriber): void {
    try {
      subscriber.controller.close();
    } catch (e) {
      console.warn(`[event-stream] Failed to close stream for ${runId}:`, e);
    }
    this.removeSubscriber(runId, subscriber);
  }

  private removeSubscriber(runId: string, subscriber: StreamSubscriber): void {
    const subscribers = this.subscribers.get(runId);
    if (!subscribers) {
      return;
    }
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.subscribers.delete(runId);
    }
  }
}
