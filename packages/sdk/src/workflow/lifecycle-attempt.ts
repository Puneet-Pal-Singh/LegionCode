import type { LifecycleEvent } from "@repo/platform-protocol";

export type LifecycleAttemptIdentity = Readonly<
  Pick<LifecycleEvent, "threadId" | "runAttemptId">
>;

export function sameLifecycleAttempt(
  actual: LifecycleAttemptIdentity,
  expected: LifecycleAttemptIdentity,
): boolean {
  return actual.threadId === expected.threadId && actual.runAttemptId === expected.runAttemptId;
}
