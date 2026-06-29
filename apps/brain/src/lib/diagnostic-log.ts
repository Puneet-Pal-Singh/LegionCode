type DiagnosticLogContext = Readonly<Record<string, unknown>>;

export function formatDiagnosticLogLine(
  domain: string,
  operation: string,
  context: DiagnosticLogContext,
): string {
  return `[${domain}/${operation}] ${formatLogFields(compactContext(context))}`;
}

function compactContext(context: DiagnosticLogContext): DiagnosticLogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

function formatLogFields(context: DiagnosticLogContext): string {
  return flattenLogContext(context)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
}

function flattenLogContext(
  context: DiagnosticLogContext,
): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  const seen = new WeakSet<object>();

  for (const [key, value] of Object.entries(context)) {
    appendFlattenedField(fields, sanitizeLogKey(key), value, seen);
  }

  return fields;
}

function appendFlattenedField(
  fields: Array<[string, string]>,
  key: string,
  value: unknown,
  seen: WeakSet<object>,
): void {
  if (value === undefined) return;
  if (value instanceof Error) {
    fields.push([`${key}.name`, value.name]);
    fields.push([`${key}.message`, value.message]);
    return;
  }
  if (value === null || typeof value !== "object") {
    fields.push([key, formatPrimitiveLogValue(value)]);
    return;
  }
  if (seen.has(value)) {
    fields.push([key, "[Circular]"]);
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    fields.push([key, stringifyDiagnosticValue(value)]);
    return;
  }

  const nestedEntries = Object.entries(value as Record<string, unknown>);
  if (nestedEntries.length === 0) {
    fields.push([key, "{}"]);
    return;
  }

  for (const [nestedKey, nestedValue] of nestedEntries) {
    appendFlattenedField(
      fields,
      `${key}.${sanitizeLogKey(nestedKey)}`,
      nestedValue,
      seen,
    );
  }
}

function sanitizeLogKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function formatLogValue(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatPrimitiveLogValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return stringifyDiagnosticValue(value);
  return String(value);
}

function stringifyDiagnosticValue(value: object): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
        };
      }
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) {
          return "[Circular]";
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}
