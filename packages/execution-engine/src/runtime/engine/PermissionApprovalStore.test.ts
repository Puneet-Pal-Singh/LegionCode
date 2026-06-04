import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDurableObjectState, RuntimeStorage } from "../types.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";

describe("PermissionApprovalStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires cross-repo approvals deterministically by TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-1");

    await store.grantCrossRepo("acme/platform-core", 1_000);
    await expect(store.hasCrossRepo("acme/platform-core")).resolves.toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.500Z"));
    await expect(store.hasCrossRepo("acme/platform-core")).resolves.toBe(false);
    await expect(store.hasCrossRepo("acme/platform-core")).resolves.toBe(false);
  });

  it("expires destructive approvals deterministically by TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-2");

    await store.grantDestructive(1_000);
    await expect(store.hasDestructive()).resolves.toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    await expect(store.hasDestructive()).resolves.toBe(false);
    await expect(store.hasDestructive()).resolves.toBe(false);
  });

  it("keeps pending approvals serialized to one unresolved request per run", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-3");

    const firstRequest = await store.setPendingRequest({
      requestId: "req-1",
      runId: "run-approval-3",
      origin: "agent",
      category: "git_mutation",
      title: "Commit changes",
      reason: "Commit mutates repository history.",
      actionFingerprint: "git:commit",
      availableDecisions: ["allow_once", "deny"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const secondRequest = await store.setPendingRequest({
      requestId: "req-2",
      runId: "run-approval-3",
      origin: "agent",
      category: "shell_command",
      title: "Run command",
      reason: "Shell command may mutate state.",
      actionFingerprint: "bash:pnpm test",
      availableDecisions: ["allow_once", "deny"],
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    expect(firstRequest.requestId).toBe("req-1");
    expect(secondRequest.requestId).toBe("req-1");
    await expect(store.getPendingRequest()).resolves.toMatchObject({
      requestId: "req-1",
    });
  });

  it("keeps allow_for_run scoped to a single runId", async () => {
    const state = new MockRuntimeState();
    const runA = new PermissionApprovalStore(state, "run-approval-a");
    const runB = new PermissionApprovalStore(state, "run-approval-b");

    await runA.setPendingRequest({
      requestId: "req-a",
      runId: "run-approval-a",
      origin: "agent",
      category: "shell_command",
      title: "Run tests",
      reason: "Shell command can mutate state.",
      actionFingerprint: "shell:pnpm test",
      availableDecisions: ["allow_for_run", "deny"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runA.resolveDecision(
      { kind: "allow_for_run", requestId: "req-a" },
      "user-1",
    );

    await expect(runA.isActionAllowed("shell:pnpm test")).resolves.toBe(true);
    await expect(runB.isActionAllowed("shell:pnpm test")).resolves.toBe(false);
  });

  it("exposes resolved decision metadata for the waiting runtime loop", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-resolved");

    await store.setPendingRequest({
      requestId: "req-resolved",
      runId: "run-approval-resolved",
      origin: "agent",
      category: "shell_command",
      title: "Run tests",
      reason: "Shell command can mutate state.",
      actionFingerprint: "shell:pnpm test",
      availableDecisions: ["allow_once", "deny"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await store.resolveDecision(
      { kind: "allow_once", requestId: "req-resolved" },
      "user-1",
    );

    await expect(
      store.getResolvedDecision("req-resolved"),
    ).resolves.toMatchObject({
      decision: "allow_once",
      status: "approved",
    });
  });

  it("rejects broad unsafe persistent shell rules", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-4");

    await store.setPendingRequest({
      requestId: "req-unsafe",
      runId: "run-approval-4",
      origin: "agent",
      category: "shell_command",
      title: "Run shell command",
      reason: "Needs approval.",
      actionFingerprint: "shell:bash -lc ls",
      availableDecisions: ["allow_persistent_rule", "deny"],
      proposedPersistentRule: {
        category: "shell_command",
        prefixTokens: ["bash"],
        cwdScope: "current_repo",
        networkAccess: "none",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      store.resolveDecision(
        { kind: "allow_persistent_rule", requestId: "req-unsafe" },
        "user-1",
      ),
    ).rejects.toThrow(
      "Persistent rule was rejected because it is too broad or unsafe.",
    );
  });

  it("persists validated narrow rules and matches future actions", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-5");

    await store.setPendingRequest({
      requestId: "req-safe",
      runId: "run-approval-5",
      origin: "agent",
      category: "git_mutation",
      title: "Stage changes",
      reason: "Needs approval.",
      actionFingerprint: "git:stage",
      availableDecisions: ["allow_persistent_rule", "deny"],
      proposedPersistentRule: {
        category: "git_mutation",
        allowedActions: ["stage"],
        repoScope: "current_repo",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await store.resolveDecision(
      { kind: "allow_persistent_rule", requestId: "req-safe" },
      "user-1",
    );
    expect(result.status).toBe("approved");
    expect(result.persistentRuleId).toBeTruthy();

    await expect(
      store.matchPersistentRule({
        category: "git_mutation",
        gitAction: "stage",
      }),
    ).resolves.toBe(true);
    await expect(
      store.matchPersistentRule({
        category: "git_mutation",
        gitAction: "commit",
      }),
    ).resolves.toBe(false);
  });

  it("rejects broad one-token git shell rules", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-6");

    await store.setPendingRequest({
      requestId: "req-broad-git",
      runId: "run-approval-6",
      origin: "agent",
      category: "shell_command",
      title: "Run git status",
      reason: "Needs approval.",
      actionFingerprint: "shell:git status",
      availableDecisions: ["allow_persistent_rule", "deny"],
      proposedPersistentRule: {
        category: "shell_command",
        prefixTokens: ["git"],
        cwdScope: "current_repo",
        networkAccess: "none",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      store.resolveDecision(
        { kind: "allow_persistent_rule", requestId: "req-broad-git" },
        "user-1",
      ),
    ).rejects.toThrow(
      "Persistent rule was rejected because it is too broad or unsafe.",
    );
  });

  it("requires an authenticated user id for persistent approvals", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-7");

    await store.setPendingRequest({
      requestId: "req-no-user",
      runId: "run-approval-7",
      origin: "agent",
      category: "shell_command",
      title: "Run git status",
      reason: "Needs approval.",
      actionFingerprint: "shell:git status",
      availableDecisions: ["allow_persistent_rule", "deny"],
      proposedPersistentRule: {
        category: "shell_command",
        prefixTokens: ["git", "status"],
        cwdScope: "current_repo",
        networkAccess: "none",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      store.resolveDecision(
        { kind: "allow_persistent_rule", requestId: "req-no-user" },
        undefined,
      ),
    ).rejects.toThrow("Persistent approval requires an authenticated user id.");
  });

  it("rejects approval resolution by a non-owner user", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-owner");

    await store.setPendingRequest(
      {
        requestId: "req-owner",
        runId: "run-approval-owner",
        origin: "agent",
        category: "shell_command",
        title: "Run tests",
        reason: "Shell command can mutate state.",
        actionFingerprint: "shell:pnpm test",
        availableDecisions: ["allow_once", "deny"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "user-owner",
    );

    await expect(
      store.resolveDecision(
        { kind: "allow_once", requestId: "req-owner" },
        "user-attacker",
      ),
    ).rejects.toThrow(
      "Approval request owner does not match the resolving user.",
    );
  });

  it("allows the owning user to resolve the request", async () => {
    const state = new MockRuntimeState();
    const store = new PermissionApprovalStore(state, "run-approval-owner-2");

    await store.setPendingRequest(
      {
        requestId: "req-owner-2",
        runId: "run-approval-owner-2",
        origin: "agent",
        category: "shell_command",
        title: "Run tests",
        reason: "Shell command can mutate state.",
        actionFingerprint: "shell:pnpm test",
        availableDecisions: ["allow_once", "deny"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "user-owner",
    );

    const result = await store.resolveDecision(
      { kind: "allow_once", requestId: "req-owner-2" },
      "user-owner",
    );
    expect(result.decision).toBe("allow_once");
  });
});

class InMemoryStorage implements RuntimeStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.store.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.store.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    const prefix = options?.prefix;
    const start = options?.start;
    const end = options?.end;
    const limit = options?.limit;

    for (const [key, value] of this.store.entries()) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }
      if (start && key < start) {
        continue;
      }
      if (end && key >= end) {
        continue;
      }
      output.set(key, value as T);
      if (typeof limit === "number" && output.size >= limit) {
        break;
      }
    }

    return output;
  }
}

class MockRuntimeState implements RuntimeDurableObjectState {
  storage: RuntimeStorage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await closure();
  }
}
