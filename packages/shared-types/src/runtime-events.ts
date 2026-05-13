import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "./json.js";

export const INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER =
  "X-Shadowbox-Runtime-Event-Signature";
export const INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER =
  "X-Shadowbox-Runtime-Event-Timestamp";

export const RUNTIME_EVENT_SIGNATURE_VERSION = "v1";

export const RuntimeEventSourceSchema = z.enum(["secure-agent-api"]);

export const RuntimeEventTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const RuntimeEventIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200);

export const InternalRuntimeEventRequestSchema = z
  .object({
    source: RuntimeEventSourceSchema,
    eventType: RuntimeEventTypeSchema,
    idempotencyKey: RuntimeEventIdempotencyKeySchema,
    payloadSchemaVersion: z.number().int().min(1).max(100),
    payload: JsonValueSchema,
  })
  .strict();

export type RuntimeEventSource = z.infer<typeof RuntimeEventSourceSchema>;
export type InternalRuntimeEventRequest = z.infer<
  typeof InternalRuntimeEventRequestSchema
>;

export interface SignedRuntimeEventHeaders {
  signature: string;
  timestamp: string;
}

export interface InternalRuntimeEventEnvelope {
  source: RuntimeEventSource;
  eventType: string;
  idempotencyKey: string;
  payloadSchemaVersion: number;
  payload: JsonValue;
}

export function buildRuntimeEventSignatureBase(
  timestamp: string,
  rawBody: string,
): string {
  return `${timestamp}.${rawBody}`;
}

export function formatRuntimeEventSignature(hexDigest: string): string {
  return `${RUNTIME_EVENT_SIGNATURE_VERSION}=${hexDigest}`;
}
