import type { TraceContext } from "./trace-context.js";
import { toActionableErrorAttributes } from "./actionable-error.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  service: string;
  environment: string;
  release?: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  child(context: LogContext): Logger;
  debug(event: string, attributes?: LogContext): void;
  info(event: string, attributes?: LogContext): void;
  warn(event: string, attributes?: LogContext): void;
  error(event: string, attributes?: LogContext): void;
  captureException(
    event: string,
    error: unknown,
    attributes?: LogContext,
  ): void;
}

export interface CreateLoggerOptions {
  service: string;
  environment?: string;
  release?: string;
  trace?: TraceContext | null;
  context?: LogContext;
  sink?: LogSink;
  now?: () => Date;
}

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 2_048;
const MAX_COLLECTION_LENGTH = 50;
const MAX_DEPTH = 4;
const SENSITIVE_KEY_PATTERN =
  /(^messages$|message(?:content|body|text)$|token|password|secret|authorization|cookie|api[_-]?key|credential|prompt|content|output|tool.*(?:argument|result))/i;
const SECRET_VALUE_PATTERN =
  /\b(?:Bearer\s+|Basic\s+|gh[pousr]_|github_pat_|sk-|gsk_|AIza|xai-)[A-Za-z0-9_\-./+=]{8,}\b/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(token|password|secret|authorization|cookie|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi;

export function createLogger(options: CreateLoggerOptions): Logger {
  const baseContext = options.context ?? {};
  const sink = options.sink ?? consoleSink;
  const environment = options.environment ?? "unknown";
  const now = options.now ?? (() => new Date());

  const write = (
    level: LogLevel,
    event: string,
    attributes?: LogContext,
  ): void => {
    sink.write({
      timestamp: now().toISOString(),
      level,
      event: normalizeEvent(event),
      service: options.service,
      environment,
      ...(options.release ? { release: options.release } : {}),
      ...(options.trace
        ? { traceId: options.trace.traceId, spanId: options.trace.spanId }
        : {}),
      attributes: sanitizeContext({ ...baseContext, ...(attributes ?? {}) }),
    });
  };

  return {
    child(context) {
      return createLogger({
        ...options,
        context: { ...baseContext, ...context },
        sink,
        now,
      });
    },
    debug: (event, attributes) => write("debug", event, attributes),
    info: (event, attributes) => write("info", event, attributes),
    warn: (event, attributes) => write("warn", event, attributes),
    error: (event, attributes) => write("error", event, attributes),
    captureException: (event, error, attributes) => {
      write("error", event, {
        ...toActionableErrorAttributes(error),
        ...(attributes ?? {}),
        error,
      });
    },
  };
}

export function serializeLogRecord(record: LogRecord): string {
  return JSON.stringify(record);
}

const consoleSink: LogSink = {
  write(record) {
    const line = serializeLogRecord(record);
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else if (record.level === "debug") console.debug(line);
    else console.info(line);
  },
};

function sanitizeContext(context: LogContext): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeValue(key, value, 0, seen)]),
  );
}

function sanitizeValue(
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (depth >= MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      ...(value.stack ? { stack: sanitizeString(value.stack) } : {}),
    };
  }
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value
      .slice(0, MAX_COLLECTION_LENGTH)
      .map((item) => sanitizeValue(key, item, depth + 1, seen));
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_COLLECTION_LENGTH)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeValue(nestedKey, nestedValue, depth + 1, seen),
        ]),
    );
  }
  return value;
}

function sanitizeString(value: string): string {
  const redacted = value
    .replace(SECRET_VALUE_PATTERN, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]");
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
    : redacted;
}

function normalizeEvent(event: string): string {
  return event.trim().replaceAll("/", ".").replaceAll(" ", "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
