export interface LLMFailureDiagnostic {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode: number | null;
  readonly retryable: boolean | null;
}

export function describeLLMFailure(error: unknown): LLMFailureDiagnostic {
  if (!(error instanceof Error)) {
    return {
      errorName: "UnknownError",
      errorMessage: "Unknown model gateway failure",
      statusCode: null,
      retryable: null,
    };
  }

  const record = error as Error & {
    statusCode?: unknown;
    retryable?: unknown;
  };
  return {
    errorName: error.name || "Error",
    errorMessage: sanitizeErrorMessage(error.message),
    statusCode:
      typeof record.statusCode === "number" ? record.statusCode : null,
    retryable:
      typeof record.retryable === "boolean" ? record.retryable : null,
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .slice(0, 300);
}
