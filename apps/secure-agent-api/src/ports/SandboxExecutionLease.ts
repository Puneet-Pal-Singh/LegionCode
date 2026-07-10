export interface WorkspaceScope {
  runId: string;
  runAttemptId: string;
  workspaceId: string;
  root: string;
}

export interface SandboxExecutionLease {
  leaseId: string;
  sandboxId: string;
  workspaceId?: string;
  runAttemptId?: string;
  workspaceScope?: WorkspaceScope;
  owner: string;
  correlationId: string;
  expiresAt: number;
  mutationMode?: "serialized" | "read_only";
}

export interface SandboxExecutionLeaseRequest {
  workspaceId: string;
  runAttemptId: string;
  owner: string;
  correlationId: string;
  mutationMode?: "serialized" | "read_only";
  ttlMs?: number;
}

export function workspaceLeaseKey(
  lease: Pick<SandboxExecutionLease, "workspaceId" | "runAttemptId" | "workspaceScope"> | SandboxExecutionLeaseRequest,
): string {
  const scope = "workspaceScope" in lease ? lease.workspaceScope : undefined;
  return [lease.workspaceId ?? scope?.workspaceId, lease.runAttemptId ?? scope?.runAttemptId].join(":");
}

export function createSandboxLease(input: {
  workspaceId: string;
  runAttemptId: string;
  owner: string;
  correlationId: string;
  now?: number;
  ttlMs?: number;
  mutationMode?: "serialized" | "read_only";
}): SandboxExecutionLease {
  const now = input.now ?? Date.now();
  return {
    leaseId: `lease:${input.workspaceId}:${input.runAttemptId}`,
    sandboxId: `workspace:${input.workspaceId}:attempt:${input.runAttemptId}`,
    workspaceId: input.workspaceId,
    runAttemptId: input.runAttemptId,
    owner: input.owner,
    correlationId: input.correlationId,
    expiresAt: now + Math.min(Math.max(input.ttlMs ?? 300_000, 1_000), 3_600_000),
    mutationMode: input.mutationMode ?? "serialized",
  };
}

export function isLeaseExpired(lease: SandboxExecutionLease, now = Date.now()): boolean {
  return lease.expiresAt <= now;
}
