import {
  HookInvocationLifecycleAuditSchema,
  type HookInvocationLifecycleAudit,
} from "@repo/hook-protocol";
import {
  JsonRecordSchema,
  type JsonRecord,
  type RunId,
  type ThreadId,
} from "@repo/platform-protocol";
import type { HookAuditSink } from "./HookRuntimePorts";

export interface CanonicalHookAuditScope {
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

export interface CanonicalHookAuditAppender {
  appendHookAudit(
    eventType: HookInvocationLifecycleAudit["eventType"],
    payload: JsonRecord,
  ): Promise<void>;
}

/**
 * Authenticated adapter between HookRunner and the runtime lifecycle owner.
 * It cannot allocate event IDs/sequences, persist independently, or apply a
 * hook outcome. Those capabilities remain with the injected runtime appender.
 */
export class CanonicalHookAuditSink implements HookAuditSink {
  constructor(
    private readonly scope: CanonicalHookAuditScope,
    private readonly appender: CanonicalHookAuditAppender,
  ) {}

  async append(input: unknown): Promise<void> {
    const audit = HookInvocationLifecycleAuditSchema.parse(input);
    this.assertScope(audit);
    await this.appender.appendHookAudit(
      audit.eventType,
      JsonRecordSchema.parse(audit),
    );
  }

  private assertScope(audit: HookInvocationLifecycleAudit): void {
    if (
      audit.invocation.runId !== this.scope.runId ||
      audit.invocation.threadId !== this.scope.threadId
    ) {
      throw new HookAuditScopeError();
    }
  }
}

export class HookAuditScopeError extends Error {
  readonly code = "HOOK_AUDIT_SCOPE_MISMATCH";

  constructor() {
    super("Hook audit scope does not match the authenticated runtime.");
    this.name = "HookAuditScopeError";
  }
}
