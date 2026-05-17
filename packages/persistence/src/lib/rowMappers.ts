import type { JsonValue } from "@repo/shared-types";
import type { SqlRow } from "../sql.js";

export function parseJsonField(
  value: JsonValue | string | null | undefined,
  columnName = "json column",
): JsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`Failed to parse ${columnName}`, { cause: error });
  }
}

export function toJsonParam(value: JsonValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Expected ${columnName} to be a string`);
}

export function toIsoString(value: string | Date | undefined): string {
  if (!value) throw new Error("Missing timestamp column");
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid timestamp column");
  }
  return parsed.toISOString();
}

export function requireRow<Row extends SqlRow>(
  row: Row | undefined,
  table: string,
): Row {
  if (!row) throw new Error(`${table} statement returned no row`);
  return row;
}
