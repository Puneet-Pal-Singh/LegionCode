import type {
  InternalRuntimeEventRequest,
  JsonValue,
  RuntimeEventSource,
} from "@repo/shared-types";

export const RUNTIME_EVENT_INBOX_STATUSES = [
  "received",
  "processing",
  "processed",
  "failed",
] as const;

export const DEFAULT_RUNTIME_EVENT_INBOX_STATUS =
  RUNTIME_EVENT_INBOX_STATUSES[0];

export type RuntimeEventInboxStatus =
  (typeof RUNTIME_EVENT_INBOX_STATUSES)[number];

export interface RuntimeEventInboxEntry {
  id: string;
  source: RuntimeEventSource;
  eventType: string;
  idempotencyKey: string;
  payload: JsonValue;
  payloadSchemaVersion: number;
  status: RuntimeEventInboxStatus;
  errorMessage?: string;
  receivedAt: string;
  processedAt?: string;
}

export interface RuntimeEventInboxAcceptResult {
  entry: RuntimeEventInboxEntry;
  inserted: boolean;
}

export interface RuntimeEventInboxRepository {
  accept(
    event: InternalRuntimeEventRequest,
  ): Promise<RuntimeEventInboxAcceptResult>;
  markProcessed(entryId: string, processedAt: string): Promise<RuntimeEventInboxEntry>;
  markFailed(
    entryId: string,
    errorMessage: string,
  ): Promise<RuntimeEventInboxEntry>;
}

export function buildRuntimeEventInboxStatusSqlList(): string {
  return RUNTIME_EVENT_INBOX_STATUSES.map((status) => `'${status}'`).join(", ");
}
