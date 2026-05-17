import type { JsonValue } from "@repo/shared-types";

export interface MemoryEventRecord {
  id: string;
  userId: string;
  sessionId: string;
  runId: string | null;
  eventType: string;
  payload: JsonValue | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AppendMemoryEventInput {
  userId: string;
  sessionId: string;
  runId?: string | null;
  eventType: string;
  payload?: JsonValue | null;
  idempotencyKey?: string | null;
}

export interface AppendMemoryEventResult {
  record: MemoryEventRecord;
  inserted: boolean;
}

export interface MemoryEventRepository {
  appendEvent(input: AppendMemoryEventInput): Promise<MemoryEventRecord>;
  appendEventIfAbsent(
    input: AppendMemoryEventInput,
  ): Promise<AppendMemoryEventResult>;
  listEventsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<MemoryEventRecord[]>;
  transaction<T>(
    callback: (repository: MemoryEventRepository) => Promise<T>,
  ): Promise<T>;
}
