/**
 * Adapter Integration Tests
 *
 * Verifies that Cloudflare adapters implement port contracts correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import { CloudflareEventStreamAdapter } from "./CloudflareEventStreamAdapter";
import type { StreamEvent } from "../ports";

describe("Runtime Adapters", () => {
  describe("CloudflareEventStreamAdapter", () => {
    let adapter: CloudflareEventStreamAdapter;

    beforeEach(() => {
      adapter = new CloudflareEventStreamAdapter();
    });

    it("should implement RealtimeEventPort interface", () => {
      expect(adapter.emit).toBeDefined();
      expect(adapter.emitBatch).toBeDefined();
      expect(adapter.complete).toBeDefined();
      expect(adapter.error).toBeDefined();
      expect(adapter.getStream).toBeDefined();
    });

    it("should emit single events", () => {
      const event: StreamEvent = {
        version: 1,
        eventId: "evt-1",
        runId: "test-run",
        timestamp: new Date().toISOString(),
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: {
          content: "hello",
          role: "assistant",
        },
      };

      expect(() => adapter.emit(event)).not.toThrow();
    });

    it("should emit batches of events", () => {
      const events: StreamEvent[] = [
        {
          version: 1,
          eventId: "evt-1",
          runId: "test-run",
          timestamp: new Date().toISOString(),
          source: "brain",
          type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
          payload: { content: "hello", role: "assistant" },
        },
        {
          version: 1,
          eventId: "evt-2",
          runId: "test-run",
          timestamp: new Date().toISOString(),
          source: "brain",
          type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
          payload: { content: " world", role: "assistant" },
        },
      ];

      expect(() => adapter.emitBatch(events)).not.toThrow();
    });

    it("should complete streams", () => {
      expect(() => adapter.complete("test-run")).not.toThrow();
    });

    it("should emit errors and complete", () => {
      expect(() => {
        adapter.error("test-run", {
          code: "TEST_ERROR",
          message: "Test error message",
        });
      }).not.toThrow();
    });

    it("should get stream for run", () => {
      const stream = adapter.getStream("test-run");
      expect(stream).toBeDefined();
      expect(stream instanceof ReadableStream).toBe(true);
    });

    it("should keep completed run lifecycles closed", async () => {
      const event: StreamEvent = {
        version: 1,
        eventId: "evt-1",
        runId: "test-run",
        timestamp: new Date().toISOString(),
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "hello", role: "assistant" },
      };

      adapter.complete("test-run");
      const stream = adapter.getStream("test-run");
      adapter.emit(event);

      const events = await readStreamEvents(stream);

      expect(events).toHaveLength(0);
    });

    it("should stream NDJSON envelopes in emitted order", async () => {
      const runId = "test-run-stream-order";
      const stream = adapter.getStream(runId);

      adapter.emit({
        version: 1,
        eventId: "evt-1",
        runId,
        timestamp: "2026-03-23T00:00:00.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "hello", role: "assistant" },
      });
      adapter.emit({
        version: 1,
        eventId: "evt-2",
        runId,
        timestamp: "2026-03-23T00:00:01.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.TOOL_REQUESTED,
        payload: {
          toolId: "tool-1",
          toolName: "read_file",
          arguments: { path: "README.md" },
        },
      });
      adapter.complete(runId);

      const events = await readStreamEvents(stream);
      expect(events.map((event) => event.type)).toEqual([
        RUN_EVENT_TYPES.MESSAGE_EMITTED,
        RUN_EVENT_TYPES.TOOL_REQUESTED,
      ]);
      expect(events.every((event) => event.runId === runId)).toBe(true);
    });

    it("should keep streams isolated per runId", async () => {
      const streamA = adapter.getStream("run-a");
      const streamB = adapter.getStream("run-b");

      adapter.emit({
        version: 1,
        eventId: "evt-a",
        runId: "run-a",
        timestamp: "2026-03-23T00:00:00.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "A", role: "assistant" },
      });
      adapter.emit({
        version: 1,
        eventId: "evt-b",
        runId: "run-b",
        timestamp: "2026-03-23T00:00:01.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "B", role: "assistant" },
      });
      adapter.complete("run-a");
      adapter.complete("run-b");

      const [eventsA, eventsB] = await Promise.all([
        readStreamEvents(streamA),
        readStreamEvents(streamB),
      ]);
      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(1);
      expect(eventsA[0]?.runId).toBe("run-a");
      expect(eventsB[0]?.runId).toBe("run-b");
    });

    it("should fan out events to multiple subscribers for the same run", async () => {
      const runId = "run-fanout";
      const streamA = adapter.getStream(runId);
      const streamB = adapter.getStream(runId);

      adapter.emit({
        version: 1,
        eventId: "evt-1",
        runId,
        timestamp: "2026-03-25T00:00:00.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "hello", role: "assistant" },
      });
      adapter.complete(runId);

      const [eventsA, eventsB] = await Promise.all([
        readStreamEvents(streamA),
        readStreamEvents(streamB),
      ]);

      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(1);
      expect(eventsA[0]?.eventId).toBe("evt-1");
      expect(eventsB[0]?.eventId).toBe("evt-1");
    });
  });

  describe("Adapter Substitutability", () => {
    it("should allow adapter implementations to be swapped", () => {
      const adapter1 = new CloudflareEventStreamAdapter();
      const adapter2 = new CloudflareEventStreamAdapter();

      // Both should satisfy the same interface
      const event: StreamEvent = {
        version: 1,
        eventId: "evt-shared",
        runId: "test",
        timestamp: new Date().toISOString(),
        source: "brain",
        type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
        payload: { content: "shared", role: "assistant" },
      };

      adapter1.emit(event);
      adapter2.emit(event);

      expect(adapter1.getStream("test")).toBeDefined();
      expect(adapter2.getStream("test")).toBeDefined();
    });
  });
});

async function readStreamEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<StreamEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  return buffer
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamEvent);
}
