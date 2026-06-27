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
    ...compactContext(context),
    sequence: ++clientLogSequence,
    elapsedMs: Date.now() - clientLogStartedAt,
  };
}

function formatClientLogLine(
  domain: string,
  operation: string,
  context: ClientLogContext,
): string {
  const formattedContext = Object.entries(buildLogContext(context))
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  return formattedContext
    ? `[${domain}/${operation}] ${formattedContext}`
    : `[${domain}/${operation}]`;
}

function formatLogValue(value: ClientLogValue): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
