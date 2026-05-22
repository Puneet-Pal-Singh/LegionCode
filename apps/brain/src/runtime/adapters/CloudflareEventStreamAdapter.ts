/**
 * CloudflareEventStreamAdapter - Cloudflare implementation of RealtimeEventPort.
 *
 * Manages streaming events to clients via NDJSON format.
 * Bridges Cloudflare Workers streaming to port contracts.
 */

import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { StreamEvent, RealtimeEventPort } from "../ports";

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
  private subscribers = new Map<
    string,
    Set<{
      controller: ReadableStreamDefaultController<Uint8Array>;
      nextEventIndex: number;
    }>
  >();
  private completed: Set<string> = new Set();

  emit(event: StreamEvent): void {
    if (this.completed.has(event.runId)) {
      // Runs can be recycled across turns, so a new event means a new lifecycle.
      this.completed.delete(event.runId);
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
        subscriber.controller.close();
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
    let activeSubscriber:
      | {
          controller: ReadableStreamDefaultController<Uint8Array>;
          nextEventIndex: number;
        }
      | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
        const subscriber = {
          controller,
          nextEventIndex: 0,
        };
        activeSubscriber = subscriber;
        this.completed.delete(runId);
        const subscribers = this.subscribers.get(runId) ?? new Set();
        subscribers.add(subscriber);
        this.subscribers.set(runId, subscribers);
        // Flush any pending events
        this.flushToSubscriber(runId, subscriber);
      },
      cancel: () => {
        // Clean up on cancel
        if (!activeSubscriber) {
          return;
        }
        const subscribers = this.subscribers.get(runId);
        if (!subscribers) {
          return;
        }
        subscribers.delete(activeSubscriber);
        if (subscribers.size === 0) {
          this.subscribers.delete(runId);
        }
      },
    });
  }

  private flushToStream(runId: string): void {
    const subscribers = this.subscribers.get(runId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const subscriber of subscribers) {
      this.flushToSubscriber(runId, subscriber);
    }
  }

  private flushToSubscriber(
    runId: string,
    subscriber: {
      controller: ReadableStreamDefaultController<Uint8Array>;
      nextEventIndex: number;
    },
  ): void {
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
        break; // Stop flushing on error
      }
    }
  }
}
