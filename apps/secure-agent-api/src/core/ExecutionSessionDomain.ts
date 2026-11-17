import {
  executionDomainDigest,
  sameExecutionDomain,
  snapshotExecutionDomain,
  type ServerExecutionDomainBinding,
} from "@repo/worker-protocol/private/execution-domain";
import {
  sameSandboxExecutionLease,
  sameWorkspaceScope,
  type SandboxExecutionLease,
  type WorkspaceScope,
} from "../ports/SandboxExecutionLease";

export interface ExecutionDomainSessionFields {
  executionDomain?: ServerExecutionDomainBinding;
}
export interface DomainSession extends ExecutionDomainSessionFields {
  workspaceScope: WorkspaceScope;
  lease: SandboxExecutionLease;
  cleanupInProgress?: boolean;
}
export function matchesDomainWorkspace(
  binding: ServerExecutionDomainBinding,
  workspace: WorkspaceScope,
): boolean {
  const scope = binding.scope;
  return (
    scope.workspaceId === workspace.workspaceId &&
    scope.runId === workspace.runId &&
    scope.threadId === workspace.threadId &&
    scope.turnId === workspace.turnId &&
    scope.runAttemptId === workspace.runAttemptId
  );
}
export function hasExecutionDomain(session: DomainSession): boolean {
  return (
    session.executionDomain !== undefined ||
    session.lease.executionDomainDigest !== undefined
  );
}
export async function validExecutionDomain(
  session: DomainSession,
): Promise<ServerExecutionDomainBinding | null> {
  if (!session.executionDomain) return null;
  try {
    const binding = snapshotExecutionDomain(session.executionDomain);
    return sameWorkspaceScope(
      session.workspaceScope,
      session.lease.workspaceScope,
    ) &&
      matchesDomainWorkspace(binding, session.workspaceScope) &&
      (await executionDomainDigest(binding)) ===
        session.lease.executionDomainDigest
      ? binding
      : null;
  } catch {
    return null;
  }
}
/** Existing session rows, including sealed/expired rows, are permanent marked
 * attempt fences. Missing state never authorizes replacement or proves cleanup. */
export async function assertExecutionDomainAdmission(
  records: Array<[string, DomainSession]>,
  key: string,
  incoming: DomainSession,
): Promise<void> {
  const binding = incoming.executionDomain
    ? snapshotExecutionDomain(incoming.executionDomain)
    : undefined;
  if (
    hasExecutionDomain(incoming) &&
    (!binding || !(await validExecutionDomain(incoming)))
  )
    throw denied();
  for (const [existingKey, stored] of records) {
    const sameAttempt =
      stored.workspaceScope.workspaceId ===
        incoming.workspaceScope.workspaceId &&
      stored.workspaceScope.runAttemptId ===
        incoming.workspaceScope.runAttemptId;
    if (existingKey !== key && !sameAttempt) continue;
    if (!hasExecutionDomain(stored) && !binding) continue; // Legacy remains legacy.
    if (
      existingKey !== key ||
      stored.cleanupInProgress ||
      !binding ||
      !(await validExecutionDomain(stored)) ||
      !stored.executionDomain ||
      !sameExecutionDomain(stored.executionDomain, binding) ||
      !sameSandboxExecutionLease(stored.lease, incoming.lease)
    )
      throw denied();
  }
}
function denied(): Error {
  return new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
}
