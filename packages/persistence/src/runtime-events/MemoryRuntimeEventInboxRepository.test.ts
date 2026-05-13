import { describe, expect, it } from "vitest";
import { MemoryRuntimeEventInboxRepository } from "./MemoryRuntimeEventInboxRepository.js";

describe("MemoryRuntimeEventInboxRepository", () => {
  it("dedupes by source and idempotency key", async () => {
    const repository = new MemoryRuntimeEventInboxRepository();
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
  });
});
