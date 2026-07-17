export const DEFAULT_SANDBOX_LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_SANDBOX_LEASE_TTL_MS = 60 * 60 * 1000;

export interface WorkspaceScope {
  runId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

export type SandboxMutationMode = "serialized" | "read_only";

export interface SandboxExecutionLease {
  leaseId: string;
  sandboxId: string;
  workspaceScope: WorkspaceScope;
  owner: string;
  correlationId: string;
  expiresAt: number;
  generation: number;
  mutationMode: SandboxMutationMode;
}

export interface SandboxExecutionLeaseRequest {
  workspaceScope: WorkspaceScope;
  owner: string;
  correlationId: string;
  generation?: number;
  mutationMode?: SandboxMutationMode;
  ttlMs?: number;
}

export function workspaceLeaseKey(
  lease: Pick<SandboxExecutionLease, "workspaceScope"> | SandboxExecutionLeaseRequest,
): string {
  return [
    lease.workspaceScope.workspaceId,
    lease.workspaceScope.runAttemptId,
  ].join(":");
}

export function createSandboxLease(
  input: SandboxExecutionLeaseRequest & { now?: number },
): SandboxExecutionLease {
  const now = input.now ?? Date.now();
  const ttlMs = Math.min(
    Math.max(input.ttlMs ?? DEFAULT_SANDBOX_LEASE_TTL_MS, 1_000),
    MAX_SANDBOX_LEASE_TTL_MS,
  );
  const { workspaceId, runAttemptId } = input.workspaceScope;
  return {
    leaseId: `lease_${crypto.randomUUID()}`,
    sandboxId: `workspace:${workspaceId}:attempt:${runAttemptId}`,
    workspaceScope: input.workspaceScope,
    owner: input.owner,
    correlationId: input.correlationId,
    expiresAt: now + ttlMs,
    generation: input.generation ?? 0,
    mutationMode: input.mutationMode ?? "serialized",
  };
}

export function isLeaseExpired(
  lease: SandboxExecutionLease,
  now = Date.now(),
): boolean {
  return lease.expiresAt <= now;
}
