import { describe, expect, it } from "vitest";
import type { RuntimeDurableObjectState, RuntimeStorage } from "../types.js";
import { PermissionApprovalStore } from "./PermissionApprovalStore.js";
import { evaluateToolPermission } from "./RunRiskyActionPolicy.js";

describe("RunRiskyActionPolicy", () => {
  it("allows low-risk read exploration by default", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-1");

    const result = await evaluateToolPermission({
      runId: "run-risk-1",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "explore",
      toolName: "read_file",
      toolArgs: { path: "README.md" },
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("allow");
  });

  it("allows read-only GitHub connector metadata tools by default", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-1b");

    const result = await evaluateToolPermission({
      runId: "run-risk-1b",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "explore",
      toolName: "github_pr_get",
      toolArgs: { owner: "acme", repo: "career-crew", number: 228 },
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("allow");
  });

  it("allows read-only github_cli metadata tools by default", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-1c");

    const result = await evaluateToolPermission({
      runId: "run-risk-1c",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "explore",
      toolName: "github_cli_actions_job_logs_get",
      toolArgs: { owner: "acme", repo: "career-crew", actionsJobId: 901 },
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("allow");
  });

  it("asks before git commit even when the current run did not edit files", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-2");

    const result = await evaluateToolPermission({
      runId: "run-risk-2",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "git_commit",
      toolArgs: { message: "feat: test" },
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
  });

  it("bypasses mutation evidence denials on read-only turns", async () => {
    const store = new PermissionApprovalStore(
      new MockRuntimeState(),
      "run-risk-2-read-only",
    );

    const result = await evaluateToolPermission({
      runId: "run-risk-2-read-only",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "explore",
      toolName: "git_commit",
      toolArgs: { message: "feat: test" },
      currentTurnIntent: "read_only",
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
  });

  it("denies git push without in-run mutation evidence unless continuation explicitly allows resume", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-2a");

    const result = await evaluateToolPermission({
      runId: "run-risk-2a",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "git_push",
      toolArgs: { remote: "origin", branch: "feat/floating-hero-carousels" },
      hasMutationEvidence: false,
      approvalStore: store,
    });

    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") {
      throw new Error("Expected deny result");
    }
    expect(result.reason).toContain("no successful file mutation");
  });

  it("allows git push resume when prior commit evidence exists in continuation", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-2b");

    const result = await evaluateToolPermission({
      runId: "run-risk-2b",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "git_push",
      toolArgs: { remote: "origin", branch: "feat/floating-hero-carousels" },
      hasMutationEvidence: false,
      allowResumeGitPush: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
  });

  it("asks for git mutation approvals and offers persistent rule only when safe", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-3");

    const result = await evaluateToolPermission({
      runId: "run-risk-3",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "git_stage",
      toolArgs: { files: ["src/index.ts"] },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
    expect(result.request.availableDecisions).toEqual(
      expect.arrayContaining([
        "allow_once",
        "allow_for_run",
        "allow_persistent_rule",
        "deny",
      ]),
    );
  });

  it("does not offer persistent shell rules for unsafe interpreter prefixes", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4");

    const result = await evaluateToolPermission({
      runId: "run-risk-4",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "build",
      toolName: "bash",
      toolArgs: { command: "bash -lc 'echo hi'" },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.proposedPersistentRule).toBeUndefined();
    expect(result.request.availableDecisions).toEqual(
      expect.not.arrayContaining(["allow_persistent_rule"]),
    );
  });

  it("narrows persistent shell rules for broad executables", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4b");

    const result = await evaluateToolPermission({
      runId: "run-risk-4b",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "build",
      toolName: "bash",
      toolArgs: { command: "git status --short" },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.proposedPersistentRule).toEqual({
      category: "shell_command",
      prefixTokens: ["git", "status"],
      cwdScope: "current_repo",
      networkAccess: "none",
    });
  });

  it("denies shell git commit identity config commands", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4bb");

    const result = await evaluateToolPermission({
      runId: "run-risk-4bb",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "build",
      toolName: "bash",
      toolArgs: {
        command:
          'git config user.email "agent@shadowbox.ai" && git config user.name "Shadowbox Agent"',
      },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("deny");
    if (result.kind !== "deny") {
      throw new Error("Expected deny result");
    }
    expect(result.reason).toContain(
      "Do not run git config user.name/user.email through shell",
    );
  });

  it("treats bash cwd traversal as outside-workspace work even in full_agent", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4c");

    const result = await evaluateToolPermission({
      runId: "run-risk-4c",
      sessionId: "session-1",
      origin: "agent",
      productMode: "full_agent",
      workflowIntent: "build",
      toolName: "bash",
      toolArgs: { command: "pwd", cwd: "../.." },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("outside_workspace");
    expect(result.request.affectedPaths).toContain("../..");
  });

  it("asks for risky git actions in review intent instead of auto-allowing them", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4d");

    const result = await evaluateToolPermission({
      runId: "run-risk-4d",
      sessionId: "session-1",
      origin: "agent",
      productMode: "full_agent",
      workflowIntent: "review",
      toolName: "git_push",
      toolArgs: { remote: "origin" },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
  });

  it("maps github_cli_pr_comment to git_mutation approval with PR-and-body fingerprint", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4dd");

    const result = await evaluateToolPermission({
      runId: "run-risk-4dd",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "github_cli_pr_comment",
      toolArgs: {
        owner: "acme",
        repo: "career-crew",
        number: 228,
        body: "Please rerun CI after rebase.",
      },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(result.request.category).toBe("git_mutation");
    expect(result.request.actionFingerprint).toMatch(
      /^git_mutation:github_cli_pr_comment:acme\/career-crew:pr:228:body:[0-9a-f]{8}$/,
    );
    expect(result.request.remoteTarget).toBe("acme/career-crew");
    expect(result.request.availableDecisions).toEqual(
      expect.arrayContaining(["allow_once", "allow_for_run", "deny"]),
    );
    expect(result.request.availableDecisions).toEqual(
      expect.not.arrayContaining(["allow_persistent_rule"]),
    );
  });

  it("produces different PR comment approval fingerprints for different bodies", async () => {
    const firstStore = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4de-1");
    const secondStore = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4de-2");

    const first = await evaluateToolPermission({
      runId: "run-risk-4de-1",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "github_cli_pr_comment",
      toolArgs: {
        owner: "acme",
        repo: "career-crew",
        number: 228,
        body: "Please rerun CI after rebase.",
      },
      hasMutationEvidence: true,
      approvalStore: firstStore,
    });
    const second = await evaluateToolPermission({
      runId: "run-risk-4de-2",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "github_cli_pr_comment",
      toolArgs: {
        owner: "acme",
        repo: "career-crew",
        number: 228,
        body: "LGTM, shipping now.",
      },
      hasMutationEvidence: true,
      approvalStore: secondStore,
    });

    expect(first.kind).toBe("ask");
    expect(second.kind).toBe("ask");
    if (first.kind !== "ask" || second.kind !== "ask") {
      throw new Error("Expected ask result");
    }

    expect(first.request.actionFingerprint).not.toBe(
      second.request.actionFingerprint,
    );
  });

  it("allows file writes in auto_for_safe mode", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-4e");

    const result = await evaluateToolPermission({
      runId: "run-risk-4e",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "build",
      toolName: "write_file",
      toolArgs: { path: "src/index.ts", content: "export const ok = true;" },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(result.kind).toBe("allow");
  });

  it("escalates repeated risky retries into dangerous_retry interruption", async () => {
    const store = new PermissionApprovalStore(new MockRuntimeState(), "run-risk-5");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptResult = await evaluateToolPermission({
        runId: "run-risk-5",
        sessionId: "session-1",
        origin: "agent",
        productMode: "auto_for_safe",
        workflowIntent: "ship",
        toolName: "bash",
        toolArgs: { command: "wrangler deploy" },
        hasMutationEvidence: true,
        approvalStore: store,
      });
      expect(attemptResult.kind).toBe("ask");
      if (attemptResult.kind !== "ask") {
        throw new Error("Expected ask result");
      }
      expect(attemptResult.request.category).toBe("deploy_or_infra_mutation");
      await store.resolveDecision(
        { kind: "deny", requestId: attemptResult.request.requestId },
        "user-1",
      );
    }

    const thirdAttempt = await evaluateToolPermission({
      runId: "run-risk-5",
      sessionId: "session-1",
      origin: "agent",
      productMode: "auto_for_safe",
      workflowIntent: "ship",
      toolName: "bash",
      toolArgs: { command: "wrangler deploy" },
      hasMutationEvidence: true,
      approvalStore: store,
    });

    expect(thirdAttempt.kind).toBe("ask");
    if (thirdAttempt.kind !== "ask") {
      throw new Error("Expected ask result");
    }
    expect(thirdAttempt.request.category).toBe("dangerous_retry");
    expect(thirdAttempt.request.availableDecisions).toEqual(
      expect.arrayContaining(["abort"]),
    );
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
