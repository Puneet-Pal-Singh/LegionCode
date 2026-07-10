import type { LogContext } from "./logger.js";

export interface ActionableErrorAttributes extends LogContext {
  errorCode: string;
  errorName: string;
  retryable: boolean;
  status?: number;
  causes: ReadonlyArray<{ name: string; message: string }>;
}

interface ErrorWithOperationalContext extends Error {
  code?: unknown;
  retryable?: unknown;
  status?: unknown;
  cause?: unknown;
}

const MAX_CAUSE_DEPTH = 3;

/**
 * Turns arbitrary failures into a stable groupable shape. The source error is
 * still supplied separately to Logger.captureException for stack information.
 */
export function toActionableErrorAttributes(
  error: unknown,
): ActionableErrorAttributes {
  const operational = isErrorWithOperationalContext(error) ? error : null;

  return {
    errorCode:
      typeof operational?.code === "string" && operational.code.length > 0
        ? operational.code
        : "UNHANDLED_EXCEPTION",
    errorName: operational?.name ?? "UnknownError",
    retryable: operational?.retryable === true,
    ...(typeof operational?.status === "number"
      ? { status: operational.status }
      : {}),
    causes: collectCauses(error),
  };
}

function collectCauses(
  error: unknown,
): ReadonlyArray<{ name: string; message: string }> {
  const causes: Array<{ name: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    isErrorWithOperationalContext(current) &&
    causes.length < MAX_CAUSE_DEPTH
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    causes.push({ name: current.name, message: current.message });
    current = current.cause;
  }

  if (causes.length === 0) {
    causes.push({ name: "UnknownError", message: "Unknown failure" });
  }

  return causes;
}

function isErrorWithOperationalContext(
  value: unknown,
): value is ErrorWithOperationalContext {
  return value instanceof Error;
}
