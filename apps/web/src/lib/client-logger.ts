type ClientLogValue = boolean | number | string | null | undefined;

export type ClientLogContext = Readonly<Record<string, ClientLogValue>>;

export function logClientEvent(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.log(`[${domain}/${operation}]`, compactContext(context));
}

export function logClientWarning(
  domain: string,
  operation: string,
  context: ClientLogContext = {},
): void {
  if (!shouldWriteClientLogs()) return;
  console.warn(`[${domain}/${operation}]`, compactContext(context));
}

function shouldWriteClientLogs(): boolean {
  return import.meta.env.MODE === "development";
}

function compactContext(context: ClientLogContext): ClientLogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}
