import { z } from "zod";

export const ProtocolTimestampSchema = z.string().datetime({
  offset: true,
});
export type ProtocolTimestamp = z.infer<typeof ProtocolTimestampSchema>;

export const EventSequenceSchema = z.number().int().safe().nonnegative();
export type EventSequence = z.infer<typeof EventSequenceSchema>;

export const BranchIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export type BranchId = z.infer<typeof BranchIdSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonRecord(value);
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  isJsonValue,
  "Value must be JSON-serializable",
);
export const JsonRecordSchema: z.ZodType<JsonRecord> = z.custom<JsonRecord>(
  isJsonRecord,
  "Value must be a JSON object",
);
