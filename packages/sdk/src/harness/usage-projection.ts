import type { LifecycleEvent } from "@repo/platform-protocol";

/** The admitted attempt, never the account currently selected in a picker. */
export type HarnessUsageScope = Pick<
  LifecycleEvent,
  "threadId" | "turnId" | "runAttemptId"
>;

export type HarnessUsageSample = Extract<
  LifecycleEvent,
  { type: "usage.updated" }
>;

/**
 * Select the latest canonical sample for exactly one admitted attempt.
 *
 * usage.updated does not specify delta/cumulative or child coverage. Do not sum
 * these samples, infer account allowance, or attribute them to child sessions.
 * Event validation and persistence belong to the existing SDK/runtime boundary.
 */
export function projectHarnessUsage(
  scope: HarnessUsageScope,
  events: readonly LifecycleEvent[],
): HarnessUsageSample | null {
  let latest: HarnessUsageSample | null = null;
  for (const event of events) {
    if (
      event.type !== "usage.updated" ||
      event.threadId !== scope.threadId ||
      event.turnId !== scope.turnId ||
      event.runAttemptId !== scope.runAttemptId
    ) {
      continue;
    }
    if (latest === null || event.sequence > latest.sequence) {
      latest = event;
    }
  }
  return latest;
}
