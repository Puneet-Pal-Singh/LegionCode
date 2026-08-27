const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const DEFAULT_TRANSIENT_DELAY_MS = 1_000;
const MAX_RATE_LIMIT_DELAY_MS = 60_000;

export interface ProviderRequestRecoveryResult<T> {
  readonly value: T;
  readonly retryCount: number;
}

export type ProviderRecoveryReason = "rate_limit" | "transient";

export async function runWithProviderRequestRecovery<T>(
  operation: (retryCount: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    maxRetries?: number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    onRetry?: (
      delayMs: number,
      retryCount: number,
      reason: ProviderRecoveryReason,
    ) => Promise<void> | void;
  } = {},
): Promise<ProviderRequestRecoveryResult<T>> {
  const maxRetries = options.maxRetries ?? 1;
  const sleep = options.sleep ?? waitForRetryWindow;
  let retryCount = 0;

  while (true) {
    try {
      return { value: await operation(retryCount), retryCount };
    } catch (error) {
      if (retryCount >= maxRetries || !isProviderRecoveryError(error)) {
        throw error;
      }
      retryCount += 1;
      const delayMs = resolveProviderRetryDelayMs(error);
      await options.onRetry?.(
        delayMs,
        retryCount,
        isProviderRateLimitError(error) ? "rate_limit" : "transient",
      );
      await sleep(delayMs, options.signal);
    }
  }
}

export function isProviderRateLimitError(error: unknown): boolean {
  return errorChain(error).some((candidate) => {
    const statusCode = readNumericProperty(candidate, "statusCode");
    if (statusCode === 429) return true;
    const message = readErrorMessage(candidate).toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("quota exceeded") ||
      message.includes("resource_exhausted") ||
      message.includes("too many requests") ||
      /\bstatus(?: code)?[=: ]+429\b/u.test(message)
    );
  });
}

/**
 * Provider failures are recoverable only when the adapter explicitly marks
 * them retryable or the transport gives us a transient HTTP/network signal.
 * Deterministic 4xx responses (bad auth, invalid model, malformed request)
 * must settle the run immediately instead of multiplying provider calls.
 */
export function isProviderRecoveryError(error: unknown): boolean {
  return errorChain(error).some((candidate) => {
    const statusCode = readNumericProperty(candidate, "statusCode");
    if (readBooleanProperty(candidate, "retryable") === true) return true;
    if (
      statusCode === 408 ||
      statusCode === 429 ||
      (statusCode !== null && statusCode >= 500 && statusCode < 600)
    ) {
      return true;
    }
    const message = readErrorMessage(candidate).toLowerCase();
    return (
      message.includes("failed to fetch") ||
      message.includes("network error") ||
      message.includes("network request failed") ||
      message.includes("connection reset") ||
      message.includes("socket hang up") ||
      message.includes("timed out")
    );
  });
}

export function resolveProviderRetryDelayMs(error: unknown): number {
  for (const candidate of errorChain(error)) {
    const retryAfterHeader = readRetryAfterHeader(candidate);
    if (retryAfterHeader !== null) {
      return clampRetryDelay(retryAfterHeader);
    }
    const retryAfter = readNumericProperty(candidate, "retryAfterSeconds");
    if (retryAfter !== null) {
      return clampRetryDelay(retryAfter * 1_000);
    }
    const message = readErrorMessage(candidate);
    const match = message.match(
      /(?:please\s+)?retry\s+(?:after|in)\s+([0-9]+(?:\.[0-9]+)?)\s*s(?:econds?)?/iu,
    );
    if (match?.[1]) {
      return clampRetryDelay(Number(match[1]) * 1_000);
    }
  }
  return isProviderRateLimitError(error)
    ? DEFAULT_RATE_LIMIT_DELAY_MS
    : DEFAULT_TRANSIENT_DELAY_MS;
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && values.length < 8 && !visited.has(current)) {
    visited.add(current);
    values.push(current);
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    current =
      record.causeError ?? record.cause ?? record.lastError ?? record.error;
  }
  return values;
}

function readNumericProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function readBooleanProperty(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function readRetryAfterHeader(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record.retryAfter;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct * 1_000;
  }
  const headers = record.headers;
  if (!headers || typeof headers !== "object") return null;
  const headerRecord = headers as Record<string, unknown>;
  const raw = headerRecord["retry-after"] ?? headerRecord["Retry-After"];
  if (typeof raw !== "string") return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function readErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function clampRetryDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return DEFAULT_RATE_LIMIT_DELAY_MS;
  }
  return Math.min(
    MAX_RATE_LIMIT_DELAY_MS,
    Math.max(1_000, Math.ceil(delayMs)),
  );
}

function waitForRetryWindow(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
