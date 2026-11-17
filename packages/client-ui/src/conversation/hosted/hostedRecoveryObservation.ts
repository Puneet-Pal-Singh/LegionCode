import type { ConversationScope, LifecycleProjection } from "@legioncode/sdk";
import {
  userIdFromExternalId,
  workspaceIdFromExternalId,
  type ReplayLifecycleEventsResponse,
} from "@repo/platform-protocol";
import type { HostedConversationIdentity } from "./hostedNativeConversation.js";

type HostedRecovery = NonNullable<LifecycleProjection["recovery"]>;

function recoveryScopeKey(identity: HostedConversationIdentity, scope: ConversationScope): string {
  return JSON.stringify([identity.key, scope.sessionId, scope.runId, workspaceIdFromExternalId(scope.workspaceId),
    scope.threadId, scope.turnId, scope.runAttemptId]);
}

function matchesRecoveryScope(identity: HostedConversationIdentity, value: HostedRecovery, scope: ConversationScope): boolean {
  return value.userId === userIdFromExternalId(identity.accountId) && value.sessionId === scope.sessionId &&
    value.runId === scope.runId && value.workspaceId === workspaceIdFromExternalId(scope.workspaceId) &&
    value.threadId === scope.threadId && value.turnId === scope.turnId && value.runAttemptId === scope.runAttemptId;
}

/** Authenticated recovery observation only. Submission and original ACK custody
 * remain with the conversation controller; missing reads never release recovery. */
export class HostedRecoveryObservation {
  private identity: HostedConversationIdentity | null = null;
  private selected: ConversationScope | null = null;
  private scopeMemo: { key: string; scope: ConversationScope } | null = null;
  private known: { identity: HostedConversationIdentity; key: string; recovery: HostedRecovery } | null = null;
  private terminal: { identity: HostedConversationIdentity; key: string; scope: ConversationScope } | null = null;

  setIdentity(identity: HostedConversationIdentity): void {
    if (this.identity !== identity) {
      this.selected = null;
      this.scopeMemo = null;
      this.known = null;
      this.terminal = null;
    }
    this.identity = identity;
  }
  get selectedScope(): ConversationScope | null { return this.selected; }
  get recovery(): HostedRecovery | null { return this.known?.recovery ?? null; }

  /** Stable tuples retain their live observer across equivalent history reads. */
  selectScope(identity: HostedConversationIdentity, candidate: ConversationScope | null): ConversationScope | null {
    if (candidate && this.terminal && (this.terminal.identity !== identity ||
        this.terminal.key !== recoveryScopeKey(identity, candidate))) this.terminal = null;
    const key = candidate ? JSON.stringify([recoveryScopeKey(identity, candidate),
      candidate.revisionOfTurnId ?? null, candidate.continuationOfTurnId ?? null, candidate.originalPromptId ?? null]) : null;
    if (candidate && key && this.scopeMemo?.key !== key)
      this.scopeMemo = { key, scope: Object.freeze({ ...candidate }) };
    this.selected = candidate ? this.scopeMemo!.scope : null;
    return this.selected;
  }

  /** Reservation becomes selected synchronously, before its React update commits. */
  selectReservedScope(scope: ConversationScope): void {
    if (this.identity) this.selectScope(this.identity, scope);
  }

  private hasObservedTerminal(identity: HostedConversationIdentity, scope: ConversationScope): boolean {
    return this.terminal?.identity === identity && this.terminal.key === recoveryScopeKey(identity, scope);
  }

  private retainTerminal(identity: HostedConversationIdentity, scope: ConversationScope): void {
    this.terminal = { identity, key: recoveryScopeKey(identity, scope), scope: Object.freeze({ ...scope }) };
    if (this.known?.identity === identity && this.known.key === this.terminal.key) this.known = null;
  }

  /** Called by the authenticated replay adapter before React sees the page. */
  observeReplay(identity: HostedConversationIdentity, page: ReplayLifecycleEventsResponse): void {
    if (this.identity !== identity) return;
    // A temporarily missing history scope does not discard the last actual
    // selected tuple. Recovery metadata itself never fabricates that scope.
    const selected = this.selected ?? this.scopeMemo?.scope;
    if (selected && page.events.some(event => event.turnId === selected.turnId &&
        event.threadId === selected.threadId && event.runAttemptId === selected.runAttemptId &&
        (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted")))
      this.retainTerminal(identity, selected);
    const value = page.recovery;
    if (selected && value && !this.hasObservedTerminal(identity, selected) && matchesRecoveryScope(identity, value, selected))
      this.known = { identity, key: recoveryScopeKey(identity, selected), recovery: value };
  }

  observeProjections(identity: HostedConversationIdentity, historical: Readonly<Record<string, LifecycleProjection>>,
    live: LifecycleProjection | null | undefined): void {
    if (this.identity !== identity) return;
    const scope = this.selected;
    const key = scope ? recoveryScopeKey(identity, scope) : null;
    if (this.known?.identity !== identity || (key !== null && this.known?.key !== key)) this.known = null;
    const selected = scope ?? this.scopeMemo?.scope;
    const turnId = selected?.turnId;
    const candidates = [turnId ? historical[turnId] : undefined, live];
    if (selected && candidates.some(candidate => candidate?.terminal && candidate.turnId === selected.turnId &&
        candidate.runtimeAttempt?.threadId === selected.threadId && candidate.runtimeAttempt.runAttemptId === selected.runAttemptId))
      this.retainTerminal(identity, selected);
    for (const candidate of candidates) {
      const value = candidate?.recovery;
      if (scope && key && value && !this.hasObservedTerminal(identity, scope) && matchesRecoveryScope(identity, value, scope))
        this.known = { identity, key, recovery: value };
    }
  }

  private requiresReview(identity: HostedConversationIdentity, target?: ConversationScope | null): boolean {
    const known = this.known;
    if (!known || known.identity !== this.identity || identity !== this.identity) return false;
    return !this.selected || matchesRecoveryScope(identity, known.recovery, this.selected) ||
      Boolean(target && matchesRecoveryScope(identity, known.recovery, target));
  }

  isMutationAllowed(identity: HostedConversationIdentity, target?: ConversationScope | null): boolean {
    return identity === this.identity && identity.enabled && !this.requiresReview(identity, target);
  }

  assertMutationAllowed(identity: HostedConversationIdentity, target?: ConversationScope | null): void {
    if (identity !== this.identity || !identity.enabled)
      throw new Error("The hosted task changed before command dispatch.");
    if (this.requiresReview(identity, target))
      throw new Error("This task needs recovery review before its execution can be changed.");
  }
}
