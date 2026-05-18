// RECONSTRUCTABILITY: Permission approval state here is runtime-only:
// pending requests, run allowances, risky-attempt counters, and in-run rule
// matches. Approval requests and decisions are canonical in Postgres via
// PostgresPermissionRepository. Values in this store are pruned by
// withPrunedApprovals(); if DO storage is lost, the active run may require
// re-approval, but audit history remains reconstructable from Postgres.

import type { RuntimeDurableObjectState } from "../types.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ProposedPersistentRule,
  RiskyActionCategory,
} from "@repo/shared-types";
import { RISKY_ACTION_CATEGORIES } from "@repo/shared-types";

function cloneRunAllowances(
  allowances: ApprovalState["runAllowances"],
): ApprovalState["runAllowances"] {
  const cloned: ApprovalState["runAllowances"] = {};
  for (const [fingerprint, grant] of Object.entries(allowances)) {
    cloned[fingerprint] = { ...grant };
  }
  return cloned;
}

interface ApprovalState {
  crossRepo: Record<string, string>;
  destructiveExpiresAt?: string;
  pendingRequest?: ApprovalRequest;
  resolvedDecisions: Record<
    string,
    {
      decision: ApprovalDecision["kind"];
      status: "approved" | "denied" | "aborted";
      resolvedAt: string;
    }
  >;
  runAllowances: Record<
    string,
    {
      scope: "once" | "run";
      createdAt: string;
      consumedAt?: string;
    }
  >;
  persistentRules: StoredPersistentPermissionRule[];
  riskyAttempts: Record<
    string,
    {
      count: number;
      reason: string;
      updatedAt: string;
    }
  >;
  updatedAt: string;
}

const APPROVAL_KEY_PREFIX = "permission:approvals:";
const RISKY_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const RESOLVED_DECISION_WINDOW_MS = 10 * 60 * 1000;

interface StoredPersistentPermissionRule {
  ruleId: string;
  createdAt: string;
  createdByUserId: string;
  source: "approval";
  category: ProposedPersistentRule["category"];
  payload: ProposedPersistentRule;
}

export interface PermissionDecisionResult {
  request: ApprovalRequest;
  decision: ApprovalDecision["kind"];
  status: "approved" | "denied" | "aborted";
  persistentRuleId?: string;
}

const UNSAFE_SHELL_PREFIXES = new Set([
  "bash",
  "sh",
  "zsh",
  "python",
  "python3",
  "node",
  "deno",
  "perl",
  "ruby",
  "env",
  "sudo",
]);
const BROAD_SHELL_EXECUTABLES = new Set(["git", "npm", "pnpm", "yarn"]);

export class PermissionApprovalStore {
  constructor(
    private ctx: RuntimeDurableObjectState,
    private runId: string,
  ) {}

  async grantCrossRepo(repoRef: string, ttlMs: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const nextState = this.withPrunedApprovals(state, now);
      nextState.crossRepo[repoRef] = new Date(now + ttlMs).toISOString();
      nextState.updatedAt = new Date(now).toISOString();
      await this.ctx.storage.put(this.key(), nextState);
    });
  }

  async hasCrossRepo(repoRef: string): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const nextState = this.withPrunedApprovals(state, now);
      const expiresAt = nextState.crossRepo[repoRef];
      const allowed = Boolean(expiresAt && Date.parse(expiresAt) > now);
      await this.persistIfChanged(state, nextState);
      return allowed;
    });
  }

  async grantDestructive(ttlMs: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const nextState = this.withPrunedApprovals(state, now);
      nextState.destructiveExpiresAt = new Date(now + ttlMs).toISOString();
      nextState.updatedAt = new Date(now).toISOString();
      await this.ctx.storage.put(this.key(), nextState);
    });
  }

  async hasDestructive(): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const nextState = this.withPrunedApprovals(state, now);
      const expiresAt = nextState.destructiveExpiresAt;
      const allowed = Boolean(expiresAt && Date.parse(expiresAt) > now);
      await this.persistIfChanged(state, nextState);
      return allowed;
    });
  }

  async getPendingRequest(): Promise<ApprovalRequest | null> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const pending = state.pendingRequest;
      if (!pending) {
        return null;
      }
      if (pending.expiresAt && Date.parse(pending.expiresAt) <= Date.now()) {
        const next = this.withPrunedApprovals(state, Date.now());
        delete next.pendingRequest;
        await this.persistIfChanged(state, next);
        return null;
      }
      return pending;
    });
  }

  async setPendingRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const next = this.withPrunedApprovals(state, now);
      if (next.pendingRequest && !isExpired(next.pendingRequest, now)) {
        if (
          next.pendingRequest.actionFingerprint === request.actionFingerprint &&
          request.category === RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY &&
          next.pendingRequest.category !==
            RISKY_ACTION_CATEGORIES.DANGEROUS_RETRY
        ) {
          next.pendingRequest = request;
          next.updatedAt = new Date(now).toISOString();
          await this.ctx.storage.put(this.key(), next);
          return request;
        }
        return next.pendingRequest;
      }
      next.pendingRequest = request;
      next.updatedAt = new Date(now).toISOString();
      await this.ctx.storage.put(this.key(), next);
      return request;
    });
  }

  async clearPendingRequest(requestId?: string): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const pending = state.pendingRequest;
      if (!pending) {
        return false;
      }
      if (requestId && pending.requestId !== requestId) {
        return false;
      }
      const next = this.withPrunedApprovals(state, Date.now());
      delete next.pendingRequest;
      await this.persistIfChanged(state, next);
      return true;
    });
  }

  async resolveDecision(
    decision: ApprovalDecision,
    createdByUserId?: string,
  ): Promise<PermissionDecisionResult> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const next = this.withPrunedApprovals(state, now);
      const pending = this.validatePendingDecision(next, decision);
      const resolution = createPermissionDecisionResult(pending, decision.kind);

      this.applyDecisionOutcome(
        next,
        pending,
        resolution,
        createdByUserId,
        now,
      );
      this.finalizeResolvedDecision(
        next,
        pending,
        resolution.decision,
        resolution.status,
        now,
      );
      await this.ctx.storage.put(this.key(), next);
      return resolution;
    });
  }

  async isActionAllowed(actionFingerprint: string): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const next = this.withPrunedApprovals(state, now);
      const grant = next.runAllowances[actionFingerprint];
      if (!grant) {
        await this.persistIfChanged(state, next);
        return false;
      }

      if (grant.scope === "once") {
        if (grant.consumedAt) {
          delete next.runAllowances[actionFingerprint];
          await this.persistIfChanged(state, next);
          return false;
        }
        next.runAllowances[actionFingerprint] = {
          ...grant,
          consumedAt: new Date(now).toISOString(),
        };
        await this.persistIfChanged(state, next);
        return true;
      }

      await this.persistIfChanged(state, next);
      return true;
    });
  }

  async matchPersistentRule(input: {
    category: RiskyActionCategory;
    command?: string;
    gitAction?: "stage" | "commit";
    providerId?: string;
    providerOperation?: "validate" | "connect";
  }): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const next = this.withPrunedApprovals(state, Date.now());

      const matched = next.persistentRules.some((rule) =>
        matchesPersistentRule(rule, input),
      );
      await this.persistIfChanged(state, next);
      return matched;
    });
  }

  async registerRiskyAttempt(
    actionFingerprint: string,
    reason: string,
  ): Promise<number> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const now = Date.now();
      const next = this.withPrunedApprovals(state, now);
      const existing = next.riskyAttempts[actionFingerprint];
      if (!existing) {
        next.riskyAttempts[actionFingerprint] = {
          count: 1,
          reason,
          updatedAt: new Date(now).toISOString(),
        };
        await this.persistIfChanged(state, next);
        return 1;
      }

      const updatedAtMs = Date.parse(existing.updatedAt);
      const withinWindow =
        Number.isFinite(updatedAtMs) &&
        now - updatedAtMs <= RISKY_ATTEMPT_WINDOW_MS;

      next.riskyAttempts[actionFingerprint] = {
        count: withinWindow ? existing.count + 1 : 1,
        reason,
        updatedAt: new Date(now).toISOString(),
      };
      await this.persistIfChanged(state, next);
      return next.riskyAttempts[actionFingerprint]?.count ?? 1;
    });
  }

  async clearRiskyAttempt(actionFingerprint: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const next = this.withPrunedApprovals(state, Date.now());
      this.resetRiskyAttempt(next, actionFingerprint);
      await this.persistIfChanged(state, next);
    });
  }

  async getResolvedDecision(requestId: string): Promise<{
    decision: ApprovalDecision["kind"];
    status: "approved" | "denied" | "aborted";
    resolvedAt: string;
  } | null> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const next = this.withPrunedApprovals(state, Date.now());
      const resolved = next.resolvedDecisions[requestId] ?? null;
      await this.persistIfChanged(state, next);
      return resolved;
    });
  }

  private key(): string {
    return `${APPROVAL_KEY_PREFIX}${this.runId}`;
  }

  private async loadState(): Promise<ApprovalState> {
    const stored = await this.ctx.storage.get<ApprovalState>(this.key());
    if (stored) {
      return {
        crossRepo: { ...(stored.crossRepo ?? {}) },
        destructiveExpiresAt: stored.destructiveExpiresAt,
        pendingRequest: stored.pendingRequest,
        resolvedDecisions: { ...(stored.resolvedDecisions ?? {}) },
        runAllowances: { ...(stored.runAllowances ?? {}) },
        persistentRules: [...(stored.persistentRules ?? [])],
        riskyAttempts: { ...(stored.riskyAttempts ?? {}) },
        updatedAt: stored.updatedAt || new Date().toISOString(),
      };
    }
    return {
      crossRepo: {},
      resolvedDecisions: {},
      runAllowances: {},
      persistentRules: [],
      riskyAttempts: {},
      updatedAt: new Date().toISOString(),
    };
  }

  private withPrunedApprovals(
    state: ApprovalState,
    nowMs: number,
  ): ApprovalState {
    const nextState: ApprovalState = {
      crossRepo: {},
      updatedAt: state.updatedAt,
      destructiveExpiresAt: state.destructiveExpiresAt,
      pendingRequest: state.pendingRequest,
      resolvedDecisions: {},
      runAllowances: cloneRunAllowances(state.runAllowances ?? {}),
      persistentRules: [...(state.persistentRules ?? [])],
      riskyAttempts: {},
    };

    for (const [repoRef, expiresAt] of Object.entries(state.crossRepo)) {
      if (Date.parse(expiresAt) > nowMs) {
        nextState.crossRepo[repoRef] = expiresAt;
      }
    }

    if (
      nextState.destructiveExpiresAt &&
      Date.parse(nextState.destructiveExpiresAt) <= nowMs
    ) {
      delete nextState.destructiveExpiresAt;
    }

    if (
      nextState.pendingRequest &&
      isExpired(nextState.pendingRequest, nowMs)
    ) {
      delete nextState.pendingRequest;
    }

    for (const [requestId, resolvedDecision] of Object.entries(
      state.resolvedDecisions ?? {},
    )) {
      const resolvedAtMs = Date.parse(resolvedDecision.resolvedAt);
      if (
        Number.isFinite(resolvedAtMs) &&
        nowMs - resolvedAtMs <= RESOLVED_DECISION_WINDOW_MS
      ) {
        nextState.resolvedDecisions[requestId] = resolvedDecision;
      }
    }

    for (const [fingerprint, attempt] of Object.entries(
      state.riskyAttempts ?? {},
    )) {
      const updatedAtMs = Date.parse(attempt.updatedAt);
      if (
        Number.isFinite(updatedAtMs) &&
        nowMs - updatedAtMs <= RISKY_ATTEMPT_WINDOW_MS
      ) {
        nextState.riskyAttempts[fingerprint] = attempt;
      }
    }

    return nextState;
  }

  private async persistIfChanged(
    previousState: ApprovalState,
    nextState: ApprovalState,
  ): Promise<void> {
    if (isSameState(previousState, nextState)) {
      return;
    }
    nextState.updatedAt = new Date().toISOString();
    await this.ctx.storage.put(this.key(), nextState);
  }

  private resetRiskyAttempt(state: ApprovalState, actionFingerprint: string) {
    delete state.riskyAttempts[actionFingerprint];
  }

  private validatePendingDecision(
    state: ApprovalState,
    decision: ApprovalDecision,
  ): ApprovalRequest {
    const pending = state.pendingRequest;
    if (!pending) {
      throw new Error("No pending approval request found.");
    }
    if (pending.requestId !== decision.requestId) {
      throw new Error("Approval request id does not match pending request.");
    }
    if (!pending.availableDecisions.includes(decision.kind)) {
      throw new Error("Decision kind is not allowed for this request.");
    }
    return pending;
  }

  private applyDecisionOutcome(
    state: ApprovalState,
    pending: ApprovalRequest,
    resolution: PermissionDecisionResult,
    createdByUserId: string | undefined,
    now: number,
  ): void {
    if (resolution.decision === "allow_once") {
      this.grantRunAllowance(state, pending.actionFingerprint, "once", now);
      return;
    }
    if (resolution.decision === "allow_for_run") {
      this.grantRunAllowance(state, pending.actionFingerprint, "run", now);
      return;
    }
    if (resolution.decision === "allow_persistent_rule") {
      resolution.persistentRuleId = this.persistValidatedRule(
        state,
        pending,
        createdByUserId,
        now,
      );
    }
  }

  private grantRunAllowance(
    state: ApprovalState,
    actionFingerprint: string,
    scope: "once" | "run",
    now: number,
  ): void {
    state.runAllowances[actionFingerprint] = {
      scope,
      createdAt: new Date(now).toISOString(),
    };
  }

  private persistValidatedRule(
    state: ApprovalState,
    pending: ApprovalRequest,
    createdByUserId: string | undefined,
    now: number,
  ): string {
    const proposedRule = pending.proposedPersistentRule;
    if (!proposedRule) {
      throw new Error("No persistent rule is available for this request.");
    }
    if (!isValidProposedPersistentRule(proposedRule)) {
      throw new Error(
        "Persistent rule was rejected because it is too broad or unsafe.",
      );
    }
    const trimmedUserId = createdByUserId?.trim();
    if (!trimmedUserId) {
      throw new Error("Persistent approval requires an authenticated user id.");
    }

    const persistentRuleId = crypto.randomUUID();
    state.persistentRules.push({
      ruleId: persistentRuleId,
      category: proposedRule.category,
      payload: proposedRule,
      createdAt: new Date(now).toISOString(),
      createdByUserId: trimmedUserId,
      source: "approval",
    });
    return persistentRuleId;
  }

  private finalizeResolvedDecision(
    state: ApprovalState,
    pending: ApprovalRequest,
    decision: ApprovalDecision["kind"],
    status: PermissionDecisionResult["status"],
    now: number,
  ): void {
    if (status === "approved") {
      this.resetRiskyAttempt(state, pending.actionFingerprint);
    }
    state.resolvedDecisions[pending.requestId] = {
      decision,
      status,
      resolvedAt: new Date(now).toISOString(),
    };
    delete state.pendingRequest;
    state.updatedAt = new Date(now).toISOString();
  }
}

function createPermissionDecisionResult(
  request: ApprovalRequest,
  decision: ApprovalDecision["kind"],
): PermissionDecisionResult {
  return {
    request,
    decision,
    status:
      decision === "abort"
        ? "aborted"
        : decision === "deny"
          ? "denied"
          : "approved",
  };
}

function isSameState(a: ApprovalState, b: ApprovalState): boolean {
  if (a.destructiveExpiresAt !== b.destructiveExpiresAt) {
    return false;
  }
  if (a.pendingRequest?.requestId !== b.pendingRequest?.requestId) {
    return false;
  }
  if (!areJsonEqual(a.pendingRequest, b.pendingRequest)) {
    return false;
  }
  if (!areJsonEqual(a.resolvedDecisions, b.resolvedDecisions)) {
    return false;
  }
  if (!areJsonEqual(a.runAllowances, b.runAllowances)) {
    return false;
  }
  if (!areJsonEqual(a.persistentRules, b.persistentRules)) {
    return false;
  }
  if (!areJsonEqual(a.riskyAttempts, b.riskyAttempts)) {
    return false;
  }

  const aEntries = Object.entries(a.crossRepo).sort(([aKey], [bKey]) =>
    aKey.localeCompare(bKey),
  );
  const bEntries = Object.entries(b.crossRepo).sort(([aKey], [bKey]) =>
    aKey.localeCompare(bKey),
  );

  if (aEntries.length !== bEntries.length) {
    return false;
  }

  for (let index = 0; index < aEntries.length; index += 1) {
    const aEntry = aEntries[index];
    const bEntry = bEntries[index];
    if (!aEntry || !bEntry) {
      return false;
    }
    if (aEntry[0] !== bEntry[0] || aEntry[1] !== bEntry[1]) {
      return false;
    }
  }

  return true;
}

function isExpired(request: ApprovalRequest, nowMs: number): boolean {
  if (!request.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(request.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function matchesPersistentRule(
  rule: StoredPersistentPermissionRule,
  input: {
    category: RiskyActionCategory;
    command?: string;
    gitAction?: "stage" | "commit";
    providerId?: string;
    providerOperation?: "validate" | "connect";
  },
): boolean {
  if (rule.category !== input.category) {
    return false;
  }

  if (rule.category === "shell_command") {
    const payload = rule.payload;
    if (!input.command) {
      return false;
    }
    const command = input.command.trim();
    if (!command) {
      return false;
    }
    const commandTokens = command
      .split(/\s+/)
      .map((token) => token.toLowerCase());
    if (payload.category !== "shell_command") {
      return false;
    }
    if (payload.prefixTokens.length > commandTokens.length) {
      return false;
    }
    return payload.prefixTokens.every(
      (token, index) => commandTokens[index] === token,
    );
  }

  if (rule.category === "git_mutation") {
    const payload = rule.payload;
    if (payload.category !== "git_mutation") {
      return false;
    }
    if (!input.gitAction) {
      return false;
    }
    return payload.allowedActions.includes(input.gitAction);
  }

  if (rule.category === "provider_connect") {
    const payload = rule.payload;
    if (payload.category !== "provider_connect") {
      return false;
    }
    if (!input.providerId || !input.providerOperation) {
      return false;
    }
    return (
      payload.providerId === input.providerId &&
      payload.allowedOperations.includes(input.providerOperation)
    );
  }

  return false;
}

function isValidProposedPersistentRule(rule: ProposedPersistentRule): boolean {
  if (rule.category === "shell_command") {
    if (rule.cwdScope !== "current_repo") {
      return false;
    }
    if (rule.prefixTokens.length === 0 || rule.prefixTokens.length > 4) {
      return false;
    }
    const normalized = rule.prefixTokens.map((token) =>
      token.trim().toLowerCase(),
    );
    if (normalized.some((token) => token.length === 0)) {
      return false;
    }
    const first = normalized[0];
    if (!first || UNSAFE_SHELL_PREFIXES.has(first)) {
      return false;
    }
    if (normalized.length === 1 && BROAD_SHELL_EXECUTABLES.has(first)) {
      return false;
    }
    return normalized.every((token) => /^[a-z0-9._:-]+$/.test(token));
  }

  if (rule.category === "git_mutation") {
    if (rule.repoScope !== "current_repo") {
      return false;
    }
    if (rule.allowedActions.length === 0) {
      return false;
    }
    return rule.allowedActions.every(
      (action) => action === "stage" || action === "commit",
    );
  }

  if (rule.category === "provider_connect") {
    if (!rule.providerId.trim()) {
      return false;
    }
    if (rule.allowedOperations.length === 0) {
      return false;
    }
    return rule.allowedOperations.every(
      (operation) => operation === "validate" || operation === "connect",
    );
  }

  return false;
}

function areJsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",")}}`;
}
