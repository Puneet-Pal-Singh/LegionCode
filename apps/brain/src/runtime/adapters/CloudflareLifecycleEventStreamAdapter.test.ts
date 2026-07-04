import { describe, expect, it } from "vitest";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { CloudflareLifecycleEventStreamAdapter } from "./CloudflareLifecycleEventStreamAdapter";

describe("CloudflareLifecycleEventStreamAdapter", () => {
  it("streams buffered lifecycle events after the requested sequence", async () => {
    const adapter = new CloudflareLifecycleEventStreamAdapter();
    adapter.start("trn_stream1");
    adapter.emit(createLifecycleEvent(1));
    adapter.emit(createLifecycleEvent(2));

    const reader = adapter.getStream("trn_stream1", 1).getReader();

    await expect(readNextEvent(reader)).resolves.toMatchObject({
      sequence: 2,
      type: "turn.completed",
    });
  });

  it("closes streams for already-completed turns", async () => {
    const adapter = new CloudflareLifecycleEventStreamAdapter();
    adapter.start("trn_stream1");
    adapter.emit(createLifecycleEvent(1));
    adapter.complete("trn_stream1");

    const reader = adapter.getStream("trn_stream1", 1).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

async function readNextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<LifecycleEvent> {
  const chunk = await reader.read();
  if (chunk.done) {
    throw new Error("expected lifecycle stream event");
  }
  const line = new TextDecoder().decode(chunk.value).trim();
  return LifecycleEventSchema.parse(JSON.parse(line));
}

function createLifecycleEvent(sequence: number): LifecycleEvent {
  const type = sequence === 1 ? "turn.started" : "turn.completed";
  return LifecycleEventSchema.parse({
    eventId: `evt_stream_${sequence}`,
    threadId: "thr_stream1",
    turnId: "trn_stream1",
    runAttemptId: "attempt_stream1",
    sequence,
    idempotencyKey: `trn_stream1:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "runtime-kernel-test" },
    schemaVersion: 1,
    createdAt: "2026-07-01T10:00:00.000Z",
    type,
    payload:
      type === "turn.completed" ? { outcome: { status: "completed" } } : {},
  });
}
