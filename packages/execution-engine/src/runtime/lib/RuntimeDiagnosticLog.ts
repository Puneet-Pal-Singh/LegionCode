type DiagnosticLogValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly unknown[]
  | Record<string, unknown>;

export type DiagnosticLogContext = Readonly<Record<string, DiagnosticLogValue>>;

export function formatRuntimeDiagnosticLogLine(
  domain: string,
  operation: string,
  context: DiagnosticLogContext,
): string {
  return `[${domain}/${operation}] ${formatFields(context)}`;
}

function formatFields(context: DiagnosticLogContext): string {
  return Object.entries(context)
    .filter(
      (entry): entry is [string, Exclude<DiagnosticLogValue, undefined>] => {
        return entry[1] !== undefined;
      },
    )
    .map(([key, value]) => `${sanitizeKey(key)}=${formatValue(value)}`)
    .join(" ");
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function formatValue(value: Exclude<DiagnosticLogValue, undefined>): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoteIfNeeded(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return quoteIfNeeded(stringifyValue(value));
}

function quoteIfNeeded(value: string): string {
  if (/^[a-zA-Z0-9_./:@,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function stringifyValue(
  value: readonly unknown[] | Record<string, unknown>,
): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") return nestedValue.toString();
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
        };
      }
      return nestedValue;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}
