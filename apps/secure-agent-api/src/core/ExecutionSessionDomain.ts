import {
  executionDomainDigest, sameExecutionDomain, snapshotExecutionDomain,
  type ServerExecutionDomainBinding,
} from "@repo/worker-protocol/private/execution-domain";
import type { SandboxExecutionLease, WorkspaceScope } from "../ports/SandboxExecutionLease";

export interface ExecutionDomainSessionFields { executionDomain?: ServerExecutionDomainBinding }
export interface DomainSession extends ExecutionDomainSessionFields {
  workspaceScope: WorkspaceScope;
  lease: SandboxExecutionLease;
  cleanupInProgress?: boolean;
}
/** Deny/reconciliation history in the original execution:session row, never a
 * new lease, permission to recreate, or assertion about unknown original loans. */
export interface RetiredExecutionSessionRecord {
  kind: "retired_execution_binding";
  version: 1;
  physicalAttempt: { workspaceId: string; runAttemptId: string };
  executionDomain: ServerExecutionDomainBinding | null;
  executionDomainDigest: string | null;
}
export function isRetiredExecutionSession(value: DomainSession | RetiredExecutionSessionRecord): value is RetiredExecutionSessionRecord {
  return "kind" in value && value.kind === "retired_execution_binding";
}
export function matchesDomainWorkspace(binding: ServerExecutionDomainBinding, workspace: WorkspaceScope): boolean {
  const scope = binding.scope;
  return scope.workspaceId === workspace.workspaceId && scope.runId === workspace.runId &&
    scope.threadId === workspace.threadId && scope.turnId === workspace.turnId && scope.runAttemptId === workspace.runAttemptId;
}
export async function validExecutionDomain(session: DomainSession): Promise<ServerExecutionDomainBinding | null> {
  if (!session.executionDomain) return null;
  try {
    const binding = snapshotExecutionDomain(session.executionDomain);
    return matchesDomainWorkspace(binding, session.workspaceScope) && matchesDomainWorkspace(binding, session.lease.workspaceScope) &&
      await executionDomainDigest(binding) === session.lease.executionDomainDigest ? binding : null;
  } catch { return null; }
}
export async function assertExecutionDomainAdmission(
  records: Array<[string, DomainSession | RetiredExecutionSessionRecord]>, key: string, incoming: DomainSession,
): Promise<void> {
  // Snapshot the caller-owned object before the first async fingerprint operation.
  const binding = incoming.executionDomain ? snapshotExecutionDomain(incoming.executionDomain) : undefined;
  if (binding && !await validExecutionDomain({ ...incoming, executionDomain: binding })) throw denied();
  if (!binding && incoming.lease.executionDomainDigest !== undefined) throw denied();
  for (const [existingKey, value] of records) {
    const attempt = isRetiredExecutionSession(value) ? value.physicalAttempt : value.workspaceScope;
    if (attempt.workspaceId !== incoming.workspaceScope.workspaceId || attempt.runAttemptId !== incoming.workspaceScope.runAttemptId) continue;
    if (isRetiredExecutionSession(value) || existingKey !== key || value.cleanupInProgress) throw denied();
    if (binding && (value.lease.leaseId !== incoming.lease.leaseId || value.lease.sandboxId !== incoming.lease.sandboxId ||
      value.lease.generation !== incoming.lease.generation || value.lease.owner !== incoming.lease.owner)) throw denied();
    if (!value.executionDomain && !binding) continue; // Legacy stays legacy, granting no Native capability.
    if (!value.executionDomain || !binding || !await validExecutionDomain(value) ||
      !sameExecutionDomain(value.executionDomain, binding)) throw denied();
  }
}
export function retiredExecutionBinding(session: DomainSession): RetiredExecutionSessionRecord {
  return {
    kind: "retired_execution_binding", version: 1,
    physicalAttempt: { workspaceId: session.workspaceScope.workspaceId, runAttemptId: session.workspaceScope.runAttemptId },
    executionDomain: session.executionDomain ? snapshotExecutionDomain(session.executionDomain) : null,
    executionDomainDigest: session.lease.executionDomainDigest ?? null,
  };
}
function denied(): Error { return new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE"); }
