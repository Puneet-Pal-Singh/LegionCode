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
/** Same-row classification history only. This record is never a closure,
 * quiescence, release or Native qualification receipt. */
export interface RetiredExecutionSessionRecord extends DomainSession {
  kind: "retired_execution_binding";
  version: 1;
}
export function isRetiredExecutionSession(value: DomainSession | RetiredExecutionSessionRecord): value is RetiredExecutionSessionRecord {
  return "kind" in value && value.kind === "retired_execution_binding";
}
export function retiredExecutionBinding(session: DomainSession): RetiredExecutionSessionRecord {
  return Object.freeze({ kind: "retired_execution_binding", version: 1,
    workspaceScope: Object.freeze({ ...session.workspaceScope }),
    lease: Object.freeze({ ...session.lease, workspaceScope: Object.freeze({ ...session.lease.workspaceScope }) }),
    ...(session.executionDomain ? { executionDomain: snapshotExecutionDomain(session.executionDomain) } : {}) });
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
  records: Array<[string, DomainSession | RetiredExecutionSessionRecord]>,
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
    if (isRetiredExecutionSession(stored)) {
      // Legacy remains unmarked, including its established one-generation
      // recovery. History still rejects later marked reclassification under
      // either this key or another key for the same attempt.
      if (binding || hasExecutionDomain(stored)) throw denied();
      if (existingKey === key && (!sameWorkspaceScope(stored.workspaceScope, incoming.workspaceScope) ||
        stored.lease.owner !== incoming.lease.owner || incoming.lease.generation !== stored.lease.generation + 1 ||
        incoming.lease.generation > 1 || incoming.lease.leaseId === stored.lease.leaseId || incoming.lease.sandboxId === stored.lease.sandboxId)) throw denied();
      continue;
    }
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
