const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "PAUSED",
  "FAILED",
  "CANCELLED",
]);

const APPROVAL_REQUIRED_RUN_STATUSES = new Set([
  "APPROVAL_REQUIRED",
  "WAITING_FOR_APPROVAL",
]);

interface MapRunStatusToSessionStatusOptions {
  hasPendingApproval?: boolean;
}

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

export function isApprovalRequiredRunStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized ? APPROVAL_REQUIRED_RUN_STATUSES.has(normalized) : false;
}

export function mapRunStatusToSessionStatus(
  status: string | null | undefined,
  options: MapRunStatusToSessionStatusOptions = {},
): "completed" | "paused" | "failed" | "waiting_for_approval" | null {
  const normalized = normalizeRunStatus(status);
  if (
    options.hasPendingApproval ||
    isApprovalRequiredRunStatus(normalized)
  ) {
    return "waiting_for_approval";
  }
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
