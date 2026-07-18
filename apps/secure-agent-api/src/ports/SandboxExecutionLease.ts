export const DEFAULT_SANDBOX_LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_SANDBOX_LEASE_TTL_MS = 60 * 60 * 1000;

const MAX_SANDBOX_ID_LENGTH = 63;
const SANDBOX_ID_DIGEST_LENGTH = MAX_SANDBOX_ID_LENGTH - "sb-".length;

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

export async function createSandboxLease(
  input: SandboxExecutionLeaseRequest & { now?: number },
): Promise<SandboxExecutionLease> {
  const now = input.now ?? Date.now();
  const ttlMs = Math.min(
    Math.max(input.ttlMs ?? DEFAULT_SANDBOX_LEASE_TTL_MS, 1_000),
    MAX_SANDBOX_LEASE_TTL_MS,
  );
  const { workspaceId, runAttemptId } = input.workspaceScope;
  return {
    leaseId: `lease_${crypto.randomUUID()}`,
    sandboxId: await createSandboxId(workspaceId, runAttemptId),
    workspaceScope: input.workspaceScope,
    owner: input.owner,
    correlationId: input.correlationId,
    expiresAt: now + ttlMs,
    generation: input.generation ?? 0,
    mutationMode: input.mutationMode ?? "serialized",
  };
}

/**
 * Returns the physical Cloudflare Sandbox identifier for a server-issued scope.
 * The full scope remains on the lease for authorization; this is only the
 * provider-constrained Durable Object name.
 */
export async function createSandboxId(
  workspaceId: string,
  runAttemptId: string,
): Promise<string> {
  const source = `${workspaceId}\u0000${runAttemptId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const encodedDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const sandboxId = `sb-${encodedDigest.slice(0, SANDBOX_ID_DIGEST_LENGTH)}`;

  if (sandboxId.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error("Sandbox ID exceeds the Cloudflare Sandbox length limit");
  }
  return sandboxId;
}

export function isLeaseExpired(
  lease: SandboxExecutionLease,
  now = Date.now(),
): boolean {
  return lease.expiresAt <= now;
}
