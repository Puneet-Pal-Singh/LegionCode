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

  constructor(private readonly now: () => Date = () => new Date()) {}

  async accept(
    event: InternalRuntimeEventRequest,
  ): Promise<RuntimeEventInboxAcceptResult> {
    const key = buildMemoryKey(event);
    const existing = this.entries.get(key);
    if (existing) {
      return { entry: existing, inserted: false };
    }

    const entry = createEntry(event, this.now());
    this.entries.set(key, entry);
    return { entry, inserted: true };
  }

  async markProcessed(
    entryId: string,
    processedAt: string,
  ): Promise<RuntimeEventInboxEntry> {
    const entry = this.readEntry(entryId);
    const updated = {
      ...entry,
      status: "processed",
      errorMessage: undefined,
      processedAt,
    } satisfies RuntimeEventInboxEntry;
    this.entries.set(buildEntryKey(updated), updated);
    return updated;
  }

  async markFailed(
    entryId: string,
    errorMessage: string,
  ): Promise<RuntimeEventInboxEntry> {
    const entry = this.readEntry(entryId);
    const updated = {
      ...entry,
      status: "failed",
      errorMessage,
      processedAt: undefined,
    } satisfies RuntimeEventInboxEntry;
    this.entries.set(buildEntryKey(updated), updated);
    return updated;
  }

  private readEntry(entryId: string): RuntimeEventInboxEntry {
    for (const entry of this.entries.values()) {
      if (entry.id === entryId) {
        return entry;
      }
    }
    throw new Error(`Runtime event inbox entry not found: ${entryId}`);
  }
}

function buildMemoryKey(event: InternalRuntimeEventRequest): string {
  return `${event.source}:${event.idempotencyKey}`;
}

function buildEntryKey(entry: RuntimeEventInboxEntry): string {
  return `${entry.source}:${entry.idempotencyKey}`;
}

function createEntry(
  event: InternalRuntimeEventRequest,
  receivedAt: Date,
): RuntimeEventInboxEntry {
  return {
    id: crypto.randomUUID(),
    source: event.source,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    payload: structuredClone(event.payload),
    payloadSchemaVersion: event.payloadSchemaVersion,
    status: "received",
    receivedAt: receivedAt.toISOString(),
  };
}
