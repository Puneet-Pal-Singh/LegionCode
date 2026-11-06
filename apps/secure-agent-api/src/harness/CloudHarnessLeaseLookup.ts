import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";
/** Same existing durable lease owner; no new lease/session store or admission. */
export function findCloudHarnessLease<
  T extends { lease: SandboxExecutionLease; cleanupInProgress?: boolean },
>(
  records: ReadonlyArray<readonly [string, T]>,
  expected: Pick<SandboxExecutionLease, "leaseId" | "sandboxId" | "generation">,
): T | null {
  const matches = records.filter(
    ([, value]) =>
      !value.cleanupInProgress &&
      value.lease.leaseId === expected.leaseId &&
      value.lease.sandboxId === expected.sandboxId &&
      value.lease.generation === expected.generation,
  );
  return matches.length === 1 ? matches[0]![1] : null;
}
