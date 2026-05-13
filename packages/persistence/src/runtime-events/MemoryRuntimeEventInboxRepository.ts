import type { InternalRuntimeEventRequest } from "@repo/shared-types";
import type {
  RuntimeEventInboxAcceptResult,
  RuntimeEventInboxEntry,
  RuntimeEventInboxRepository,
} from "./types.js";

export class MemoryRuntimeEventInboxRepository
  implements RuntimeEventInboxRepository
{
  private readonly entries = new Map<string, RuntimeEventInboxEntry>();

  async accept(
    event: InternalRuntimeEventRequest,
  ): Promise<RuntimeEventInboxAcceptResult> {
    const key = buildMemoryKey(event);
    const existing = this.entries.get(key);
    if (existing) {
      return { entry: existing, inserted: false };
    }

    const entry = createEntry(event);
    this.entries.set(key, entry);
    return { entry, inserted: true };
  }
}

function buildMemoryKey(event: InternalRuntimeEventRequest): string {
  return `${event.source}:${event.idempotencyKey}`;
}

function createEntry(
  event: InternalRuntimeEventRequest,
): RuntimeEventInboxEntry {
  return {
    id: crypto.randomUUID(),
    source: event.source,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    payload: event.payload,
    payloadSchemaVersion: event.payloadSchemaVersion,
    status: "received",
    receivedAt: new Date().toISOString(),
  };
}
