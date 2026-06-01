/**
 * Run Status - Canonical status vocabulary for Shadowbox runs
 * Used across web, brain, and muscle layers
 */

export const RUN_STATUSES = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting",
  PAUSED: "paused",
  FAILED: "failed",
  COMPLETE: "complete",
} as const;

export type RunStatus = (typeof RUN_STATUSES)[keyof typeof RUN_STATUSES];

/**
 * Check if a given value is a valid RunStatus
 */
export function isRunStatus(value: unknown): value is RunStatus {
  return (
    typeof value === "string" &&
    Object.values(RUN_STATUSES).includes(value as RunStatus)
  );
}
