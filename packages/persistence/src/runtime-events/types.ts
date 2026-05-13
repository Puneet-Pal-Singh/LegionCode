import type {
  InternalRuntimeEventRequest,
  JsonValue,
  RuntimeEventSource,
} from "@repo/shared-types";

export type RuntimeEventInboxStatus =
  | "received"
  | "processing"
  | "processed"
  | "failed";

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
}
