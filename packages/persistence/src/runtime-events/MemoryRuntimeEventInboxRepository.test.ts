import { describe, expect, it } from "vitest";
import { MemoryRuntimeEventInboxRepository } from "./MemoryRuntimeEventInboxRepository.js";

describe("MemoryRuntimeEventInboxRepository", () => {
  it("dedupes by source and idempotency key", async () => {
    const receivedAt = new Date("2026-05-14T00:00:00.000Z");
    const repository = new MemoryRuntimeEventInboxRepository(() => receivedAt);
    const event = {
      source: "secure-agent-api" as const,
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    };

    const first = await repository.accept(event);
    const second = await repository.accept(event);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(first.entry.receivedAt).toBe(receivedAt.toISOString());
  });

  it("does not dedupe different idempotency keys", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const first = await repository.accept({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    });
    const second = await repository.accept({
      source: "secure-agent-api",
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-2:completed",
      payloadSchemaVersion: 1,
      payload: { runId: "run-1" },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.entry.id).not.toBe(first.entry.id);
  });

  it("clones the payload to prevent mutations", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
    const payload = { nested: { value: 1 } };
    const event = {
      source: "secure-agent-api" as const,
      eventType: "tool.completed",
      idempotencyKey: "run-1:tool-1:completed",
      payloadSchemaVersion: 1,
      payload,
    };

    const { entry } = await repository.accept(event);

    // Mutate original payload
    payload.nested.value = 2;

    expect((entry.payload as typeof payload).nested.value).toBe(1);
  });
});
