const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 60_000;

export interface ProviderRateLimitRecoveryResult<T> {
  readonly value: T;
  readonly retryCount: number;
}

export async function runWithProviderRateLimitRecovery<T>(
  operation: (retryCount: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    maxRetries?: number;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    onRateLimit?: (delayMs: number, retryCount: number) => Promise<void> | void;
  } = {},
): Promise<ProviderRateLimitRecoveryResult<T>> {
  const maxRetries = options.maxRetries ?? 1;
  const sleep = options.sleep ?? waitForRetryWindow;
  let retryCount = 0;

  while (true) {
    try {
      return { value: await operation(retryCount), retryCount };
    } catch (error) {
      if (retryCount >= maxRetries || !isProviderRateLimitError(error)) {
        throw error;
      }
      retryCount += 1;
      const delayMs = resolveProviderRetryDelayMs(error);
      await options.onRateLimit?.(delayMs, retryCount);
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

export function resolveProviderRetryDelayMs(error: unknown): number {
  for (const candidate of errorChain(error)) {
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
  return DEFAULT_RATE_LIMIT_DELAY_MS;
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

function readErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function clampRetryDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return DEFAULT_RATE_LIMIT_DELAY_MS;
  }
  return Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(1_000, Math.ceil(delayMs)));
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
