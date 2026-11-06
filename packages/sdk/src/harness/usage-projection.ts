import {
  HarnessUsageObservationSchema,
  type HarnessUsageObservation,
} from "@repo/platform-protocol";
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

/**
 * Recorded wall-clock interval, including waits, for one settled attempt.
 * This is neither metered compute nor process-quiescence/lease evidence.
 * Incomplete, conflicting, or backwards records cannot establish an interval.
 */
export function projectHarnessAttemptElapsedMs(
  scope: HarnessUsageScope,
  events: readonly LifecycleEvent[],
): number | null {
  type Endpoint = Pick<
    LifecycleEvent,
    "eventId" | "type" | "sequence" | "createdAt"
  >;
  let started: Endpoint | null = null;
  let settled: Endpoint | null = null;
  let startKey: string | null = null;
  let settlementKey: string | null = null;
  for (const event of events) {
    if (
      event.threadId !== scope.threadId ||
      event.turnId !== scope.turnId ||
      event.runAttemptId !== scope.runAttemptId
    )
      continue;
    const isStart = event.type === "run_attempt.started";
    const isSettlement =
      event.type === "run_attempt.succeeded" ||
      event.type === "run_attempt.failed" ||
      event.type === "run_attempt.interrupted";
    if (!isStart && !isSettlement) continue;
    const key = JSON.stringify([
      event.eventId,
      event.type,
      event.sequence,
      event.createdAt,
    ]);
    if (isStart) {
      if (startKey !== null && startKey !== key) return null;
      startKey = key;
      started = event;
    } else {
      if (settlementKey !== null && settlementKey !== key) return null;
      settlementKey = key;
      settled = event;
    }
  }
  if (!started || !settled || settled.sequence <= started.sequence) return null;
  const startMs = Date.parse(started.createdAt);
  const endMs = Date.parse(settled.createdAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return null;
  return endMs - startMs;
}

/** Validate the public read payload and deduplicate exact measurement identities.
 * Conflicting duplicates are excluded, never selected by arrival order or summed. */
export function projectHarnessAccountUsage(
  observation: HarnessUsageObservation,
) {
  const parsed = HarnessUsageObservationSchema.parse(observation);
  const measurements = new Map<
    string,
    HarnessUsageObservation["activity"][number]
  >();
  const conflicts = new Set<string>();
  for (const measurement of parsed.activity) {
    const key = JSON.stringify([
      parsed.connectionId,
      parsed.accountId,
      parsed.environmentId,
      parsed.authOwnerGeneration,
      measurement.threadId,
      measurement.turnId,
      measurement.runAttemptId,
      measurement.instanceId,
      measurement.externalSessionId,
      measurement.processGeneration,
      measurement.source,
      measurement.sequence,
      measurement.measurementId,
    ]);
    if (conflicts.has(key)) continue;
    const previous = measurements.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(measurement)) {
      measurements.delete(key);
      conflicts.add(key);
    } else measurements.set(key, measurement);
  }
  const limits = new Map<
    string,
    HarnessUsageObservation["providerLimits"][number]
  >();
  const limitConflicts = new Set<string>();
  for (const notification of parsed.providerLimits) {
    const key = JSON.stringify([
      notification.threadId,
      notification.turnId,
      notification.runAttemptId,
      notification.instanceId,
      notification.externalSessionId,
      notification.processGeneration,
      notification.source,
      notification.sequence,
      notification.notificationId,
    ]);
    if (limitConflicts.has(key)) continue;
    const previous = limits.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(notification)) {
      limits.delete(key);
      limitConflicts.add(key);
    } else limits.set(key, notification);
  }
  return {
    ...parsed,
    activity: [...measurements.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value),
    conflictingMeasurementCount: conflicts.size,
    providerLimits: [...limits.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value),
    conflictingLimitNotificationCount: limitConflicts.size,
  };
}
