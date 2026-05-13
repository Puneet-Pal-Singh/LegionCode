import type { JsonValue, RuntimeEventSource } from "@repo/shared-types";
import type { SqlRow } from "../sql.js";
import type {
  RuntimeEventInboxEntry,
  RuntimeEventInboxStatus,
} from "./types.js";

const RUNTIME_EVENT_INBOX_STATUSES = new Set<string>([
  "received",
  "processing",
  "processed",
  "failed",
]);

export function mapRuntimeEventInboxRow(row: SqlRow): RuntimeEventInboxEntry {
  return {
    id: readString(row, "id"),
    source: readString(row, "source") as RuntimeEventSource,
    eventType: readString(row, "event_type"),
    idempotencyKey: readString(row, "idempotency_key"),
    payload: readPayload(row),
    payloadSchemaVersion: readNumber(row, "payload_schema_version"),
    status: readStatus(row),
    errorMessage: readOptionalString(row, "error_message"),
    receivedAt: readString(row, "received_at"),
    processedAt: readOptionalString(row, "processed_at"),
  };
}

function readPayload(row: SqlRow): JsonValue {
  const value = row.payload_json;
  if (typeof value === "string") {
    return JSON.parse(value) as JsonValue;
  }
  return value as JsonValue;
}

function readStatus(row: SqlRow): RuntimeEventInboxStatus {
  const status = readString(row, "status");
  if (!RUNTIME_EVENT_INBOX_STATUSES.has(status)) {
    throw new TypeError(`Unexpected runtime event inbox status: ${status}`);
  }
  return status as RuntimeEventInboxStatus;
}

function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new TypeError(`Expected ${key} to be a string`);
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new TypeError(`Expected ${key} to be a string when present`);
}

function readNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  throw new TypeError(`Expected ${key} to be a number`);
}
