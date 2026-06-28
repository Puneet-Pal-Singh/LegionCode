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
const CLIENT_LOG_DEV_ENDPOINT = "/__legioncode/client-log";
const CLIENT_LOG_MAX_BYTES = 8_000;
const CLIENT_INSTANCE_STORAGE_KEY = "legioncode.clientLogInstanceId";
const clientLogInstanceId = createClientLogInstanceId();

export function logClientEvent(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  const line = formatClientLogLine(domain, operation, context);
  console.log(line);
  forwardClientLogLine(line);
}

export function logClientWarning(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  const line = formatClientLogLine(domain, operation, context);
  console.warn(line);
  forwardClientLogLine(line);
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
    clientInstanceId: clientLogInstanceId,
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

function forwardClientLogLine(line: string): void {
  if (typeof window === "undefined") return;

  const body = boundLogLine(line);
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(CLIENT_LOG_DEV_ENDPOINT, body);
      return;
    }
    void fetch(CLIENT_LOG_DEV_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
      keepalive: true,
    });
  } catch {
    // Console logging above is the primary sink; dev-server forwarding is best effort.
  }
}

function boundLogLine(line: string): string {
  if (line.length <= CLIENT_LOG_MAX_BYTES) {
    return line;
  }
  return `${line.slice(0, CLIENT_LOG_MAX_BYTES)} [client-log-truncated]`;
}

function createClientLogInstanceId(): string {
  if (typeof window === "undefined") {
    return "server";
  }

  const existing = readStoredClientInstanceId();
  if (existing) {
    return existing;
  }

  const created = `tab_${createRandomLogId()}`;
  storeClientInstanceId(created);
  return created;
}

function readStoredClientInstanceId(): string | null {
  try {
    return window.sessionStorage.getItem(CLIENT_INSTANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeClientInstanceId(clientInstanceId: string): void {
  try {
    window.sessionStorage.setItem(
      CLIENT_INSTANCE_STORAGE_KEY,
      clientInstanceId,
    );
  } catch {
    // The ID still appears in this page's logs even if sessionStorage is blocked.
  }
}

function createRandomLogId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
