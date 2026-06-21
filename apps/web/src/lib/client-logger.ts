type ClientLogValue = boolean | number | string | null | undefined;

export type ClientLogContext = Readonly<Record<string, ClientLogValue>>;

let clientLogSequence = 0;
const clientLogStartedAt = Date.now();

export function logClientEvent(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.log(`[${domain}/${operation}]`, buildLogContext(context));
}

export function logClientWarning(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.warn(`[${domain}/${operation}]`, buildLogContext(context));
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
