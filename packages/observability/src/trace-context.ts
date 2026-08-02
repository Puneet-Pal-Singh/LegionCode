export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: "00" | "01";
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/;

export function createTraceContext(): TraceContext {
  return {
    traceId: createHexId(32),
    spanId: createHexId(16),
    traceFlags: "01",
  };
}

export function formatTraceparent(context: TraceContext): string {
  if (
    !TRACE_ID_PATTERN.test(context.traceId) ||
    !SPAN_ID_PATTERN.test(context.spanId)
  ) {
    throw new Error("Trace context contains an invalid identifier.");
  }
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function parseTraceparent(value: string | null): TraceContext | null {
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
  if (!match) return null;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: match[3]! as "00" | "01",
  };
}

function createHexId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
