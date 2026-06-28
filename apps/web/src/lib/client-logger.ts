type ClientLogValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly unknown[]
  | Record<string, unknown>;

export type ClientLogContext = Readonly<Record<string, ClientLogValue>>;

let clientLogSequence = 0;
const clientLogStartedAt = Date.now();
const CLIENT_LOG_FORMAT_VERSION = "json-v2";

export function logClientEvent(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.log(formatClientLogLine(domain, operation, context));
}

export function logClientWarning(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.warn(formatClientLogLine(domain, operation, context));
}

function shouldWriteClientLogs(): boolean {
  return import.meta.env.MODE === "development";
}

function compactContext(context: ClientLogContext): ClientLogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

function buildLogContext(context: ClientLogContext): ClientLogContext {
  return {
    format: CLIENT_LOG_FORMAT_VERSION,
    ...compactContext(context),
    sequence: ++clientLogSequence,
    elapsedMs: Date.now() - clientLogStartedAt,
  };
}

export function formatClientLogLine(
  domain: string,
  operation: string,
  context: ClientLogContext,
): string {
  return `[${domain}/${operation}] ${formatLogValue(buildLogContext(context))}`;
}

function formatLogValue(value: ClientLogValue): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return stringifyClientLogObject(value);
  return String(value);
}

function stringifyClientLogObject(value: object): string {
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
