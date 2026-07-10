import { createLogger, serializeLogRecord, type TraceContext } from "@repo/observability";

type DiagnosticLogContext = Readonly<Record<string, unknown>>;

/**
 * Compatibility adapter while callers migrate from console calls to Logger.
 * It emits one redacted JSON record, never user prompt or credential fields.
 */
export function formatDiagnosticLogLine(
  domain: string,
  operation: string,
  context: DiagnosticLogContext,
): string {
  let record: Parameters<typeof serializeLogRecord>[0] | null = null;
  const logger = createLogger({
    service: "brain",
    environment: "unknown",
    trace: readTraceContext(context),
    context,
    sink: { write: (entry) => { record = entry; } },
  });
  logger.info(`${domain}.${operation}`);
  if (!record) throw new Error("Diagnostic log record was not created.");
  return serializeLogRecord(record);
}

function readTraceContext(context: DiagnosticLogContext): TraceContext | null {
  const traceId = context.traceId;
  const spanId = context.spanId;
  if (typeof traceId !== "string" || typeof spanId !== "string") return null;
  return { traceId, spanId, traceFlags: "01" };
}
