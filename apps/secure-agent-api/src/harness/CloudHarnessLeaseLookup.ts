import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";
/** Same existing durable lease owner; no new lease/session store or admission.
 * The alarm is eventual cleanup, not an extension of bearer authority. */
export function findCloudHarnessLease<
  T extends { lease: SandboxExecutionLease; cleanupInProgress?: boolean },
>(
  records: ReadonlyArray<readonly [string, T]>,
  expected: Pick<SandboxExecutionLease, "leaseId" | "sandboxId" | "generation">,
): T | null {
  const now = Date.now();
  const matches = records.filter(
    ([, value]) =>
      value.lease.leaseId === expected.leaseId &&
      value.lease.sandboxId === expected.sandboxId &&
      value.lease.generation === expected.generation,
  );
  if (matches.length !== 1) return null;
  const record = matches[0]![1];
  return !record.cleanupInProgress &&
    Number.isFinite(record.lease.expiresAt) &&
    record.lease.expiresAt > now
    ? record
    : null;
}
