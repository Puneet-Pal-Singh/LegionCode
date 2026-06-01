const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "PAUSED",
  "FAILED",
  "CANCELLED",
]);

export function normalizeRunStatus(
  status: string | null | undefined,
): string | null {
  const normalized = status?.trim().toUpperCase();
  return normalized ? normalized : null;
}

export function isTerminalRunStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized ? TERMINAL_RUN_STATUSES.has(normalized) : false;
}

export function mapRunStatusToSessionStatus(
  status: string | null | undefined,
): "completed" | "paused" | "failed" | null {
  const normalized = normalizeRunStatus(status);
  if (normalized === "COMPLETED") {
    return "completed";
  }
  if (normalized === "PAUSED") {
    return "paused";
  }
  if (normalized === "FAILED" || normalized === "CANCELLED") {
    return "failed";
  }
  return null;
}
