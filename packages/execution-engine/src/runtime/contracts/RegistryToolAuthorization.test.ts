import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBashWorker } from "../desktop/LocalBashWorker.js";
import type {
  PermissionEffect,
  PermissionPolicy,
} from "@repo/permission-policy";
import { ItemIdSchema, RunSchema } from "@repo/platform-protocol";
import { describe, expect, it, vi } from "vitest";
import { RegistryToolAuthorization } from "./RegistryToolAuthorization.js";

const timestamp = "2026-06-18T10:00:00.000Z";
const itemId = ItemIdSchema.parse("itm_runtime001");
const run = RunSchema.parse({
  id: "run_runtime001",
  threadId: "thr_runtime001",
  userId: "usr_runtime001",
  workspaceId: "wrk_runtime001",
  status: "running",
  mode: "auto_edit",
  providerId: "openai",
  modelId: "gpt-5",
  workerId: "worker_runtime001",
  permissionProfileId: "perm_runtime001",
  startedAt: timestamp,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 0,
});

describe("RegistryToolAuthorization", () => {
  it("authorizes a registered tool with schema-normalized input", async () => {
    const authorization = createAuthorization("allow");

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "read_file",
          input: { path: "package.json", limit: 10_000 },
        },
      }),
    ).resolves.toMatchObject({
      status: "authorized",
      toolCall: { input: { path: "package.json", limit: 1_000 } },
    });
  });

  it("rejects tools and inputs outside the canonical registry contracts", async () => {
    const authorization = createAuthorization("allow");

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "missing_tool",
          input: {},
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "tool_not_registered",
    });
    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime002",
          toolName: "read_file",
          input: {},
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_tool_input",
    });
  });

  it("denies mutating tools in read-only run modes before profile evaluation", async () => {
    const authorization = createAuthorization("allow");

    await expect(
      authorization.authorize({
        run: { ...run, mode: "review" },
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "write_file",
          input: { path: "src/index.ts", content: "export {};" },
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "tool_policy_denied",
      reason: expect.stringContaining("review"),
    });
  });

  it("turns ask decisions into typed approval requests", async () => {
    const authorization = createAuthorization("ask");

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "write_file",
          input: { path: "src/index.ts", content: "export {};" },
        },
      }),
    ).resolves.toMatchObject({
      status: "approval_required",
      request: {
        approvalId: "appr_runtime001",
        itemId: "itm_approval_runtime001",
        metadata: {
          toolName: "write_file",
          category: "filesystem_write",
          permissionProfileId: run.permissionProfileId,
          grantMatcherKey: expect.stringMatching(/^input:write_file:sha256:/),
          grantWorkspaceId: run.workspaceId,
        },
        options: expect.not.arrayContaining([
          expect.objectContaining({ id: "allow_matching_in_chat" }),
        ]),
      },
    });
  });

  it("reuses an approved matching grant only in its thread and workspace", async () => {
    const requests: Array<{
      threadId: string;
      workspaceId: string;
      matcherKey: string;
    }> = [];
    const policy = createPolicy("ask");
    policy.commands.defaultEffect = "ask";
    const authorization = new RegistryToolAuthorization(
      { resolve: async () => policy },
      {
        hasMatchingInChatGrant: async (input) => {
          requests.push(input);
          return (
            input.threadId === run.threadId &&
            input.workspaceId === run.workspaceId
          );
        },
      },
    );

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "bash",
          input: { command: "pnpm test", cwd: "/workspace" },
        },
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    expect(requests[0]).toMatchObject({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      matcherKey: expect.stringMatching(/^input:bash:sha256:/),
    });

    const isolated = new RegistryToolAuthorization(
      {
        resolve: async () => {
          const isolatedPolicy = createPolicy("ask");
          isolatedPolicy.commands.defaultEffect = "ask";
          return isolatedPolicy;
        },
      },
      { hasMatchingInChatGrant: async () => false },
    );
    await expect(
      isolated.authorize({
        run: { ...run, threadId: "thr_other001" },
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime002",
          toolName: "bash",
          input: { command: "pnpm test", cwd: "/workspace" },
        },
      }),
    ).resolves.toMatchObject({ status: "approval_required" });
  });

  it("keeps policy denial ahead of matching grants", async () => {
    const policy = createPolicy("deny");
    policy.commands.defaultEffect = "deny";
    const authorization = new RegistryToolAuthorization(
      { resolve: async () => policy },
      { hasMatchingInChatGrant: async () => true },
    );

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "bash",
          input: { command: "pnpm test" },
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "tool_policy_denied",
    });
  });

  it("matches git commits by tool while requiring exact bash input matches", async () => {
    const policy = createPolicy("ask");
    policy.git.defaultEffect = "ask";
    policy.commands.defaultEffect = "ask";
    const matcherKeys: string[] = [];
    const authorization = new RegistryToolAuthorization(
      { resolve: async () => policy },
      {
        hasMatchingInChatGrant: async ({ matcherKey }) => {
          matcherKeys.push(matcherKey);
          return matcherKey === "tool:git_commit";
        },
      },
    );
    const authorize = (toolCallId: string, toolName: string, input: object) =>
      authorization.authorize({
        run,
        itemId,
        toolCall: { toolCallId, toolName, input },
      });

    await expect(
      authorize("toolcall_runtime001", "git_commit", { message: "first" }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(
      authorize("toolcall_runtime002", "git_commit", { message: "second" }),
    ).resolves.toMatchObject({ status: "authorized" });
    expect(matcherKeys.slice(0, 2)).toEqual([
      "tool:git_commit",
      "tool:git_commit",
    ]);

    const firstBash = await authorize("toolcall_runtime003", "bash", {
      command: "pnpm test",
    });
    const secondBash = await authorize("toolcall_runtime004", "bash", {
      command: "pnpm deploy",
    });
    expect(firstBash.status).toBe("approval_required");
    expect(secondBash.status).toBe("approval_required");
    expect(matcherKeys[2]).toMatch(/^input:bash:sha256:/);
    expect(matcherKeys[3]).toMatch(/^input:bash:sha256:/);
    expect(matcherKeys[2]).not.toBe(matcherKeys[3]);
  });

  it("offers reusable approval only when a canonical grant reader is wired", async () => {
    const policy = createPolicy("ask");
    policy.git.defaultEffect = "ask";
    const withoutReader = new RegistryToolAuthorization({
      resolve: async () => policy,
    });
    const withReader = new RegistryToolAuthorization(
      { resolve: async () => policy },
      { hasMatchingInChatGrant: async () => false },
    );
    const input = {
      run,
      itemId,
      toolCall: {
        toolCallId: "toolcall_runtime001",
        toolName: "git_commit",
        input: { message: "update" },
      },
    };
    const withoutReaderResult = await withoutReader.authorize(input);
    const withReaderResult = await withReader.authorize(input);

    expect(withoutReaderResult).toMatchObject({
      status: "approval_required",
      request: {
        options: expect.not.arrayContaining([
          expect.objectContaining({ id: "allow_matching_in_chat" }),
        ]),
      },
    });
    expect(withReaderResult).toMatchObject({
      status: "approval_required",
      request: {
        options: expect.arrayContaining([
          expect.objectContaining({ id: "allow_matching_in_chat" }),
        ]),
      },
    });
  });

  it("returns a typed rejection for deny decisions", async () => {
    const authorization = createAuthorization("deny");

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "write_file",
          input: { path: "src/index.ts", content: "export {};" },
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "tool_policy_denied",
    });
  });

  it("evaluates the permission domain declared by the tool registry", async () => {
    const policy = createPolicy("allow");
    policy.commands.defaultEffect = "deny";
    const authorization = new RegistryToolAuthorization({
      resolve: async () => policy,
    });

    await expect(
      authorization.authorize({
        run,
        itemId,
        toolCall: {
          toolCallId: "toolcall_runtime001",
          toolName: "bash",
          input: { command: "pnpm test" },
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "tool_policy_denied",
      reason: expect.stringContaining("command"),
    });

    // Exercise the real native command boundary under the same canonical policy.
    const root = await mkdtemp(join(tmpdir(), "legion-bash-"));
    const grantAbort = new AbortController();
    let current = true;
    const bashPolicy = createPolicy("ask");
    const worker = new LocalBashWorker({
      attempt: { workspaceId: run.workspaceId, runId: run.id, turnId: "trn_runtime001", runAttemptId: "attempt_runtime001" },
      grant: { filesystemRoot: root, generation: 1, signal: grantAbort.signal,
        assertCurrent: () => { if (!current) throw new Error("Grant was replaced"); } },
      permissionPolicy: bashPolicy,
      artifactCapture: "required",
    });
    const command: Parameters<LocalBashWorker["executeTool"]>[0] = {
      runId: run.id, turnId: "trn_runtime001", runAttemptId: "attempt_runtime001",
      workspace: { runId: run.id, workspaceId: run.workspaceId, repoOwner: "local", repoName: "fixture", repoUrl: "https://example.com/local/fixture",
        baseBranch: "dev", workingBranch: "task", baseSha: "a".repeat(40), headSha: "a".repeat(40), executionLocation: "local",
        workerId: run.workerId, filesystemRoot: root, artifactNamespace: "test", permissionProfileId: run.permissionProfileId,
        state: "ready", lastError: null, createdAt: timestamp, updatedAt: timestamp },
      toolCall: { toolCallId: "toolcall_runtime001", toolName: "bash", input: { command: "node --test test.cjs" } },
      approval: { decision: "approved", decidedBy: run.userId, reason: null },
    };
    try {
      await writeFile(join(root, "test.cjs"), 'require("node:assert/strict").equal(2 + 2, 4); console.log("approved native test passed");');
      const result = await worker.executeTool(command);
      expect(result).toMatchObject({ kind: "completed", output: { exitCode: 0, timedOut: false } });
      if (result.kind === "completed") expect(result.output.stdout).toContain("approved native test passed");
      expect(await worker.awaitQuiescence({ turnId: command.turnId, timeoutMs: 500 })).toBe(true);
      const bounded = await worker.executeTool({ ...command, toolCall: { ...command.toolCall,
        input: { command: `node -e 'process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000))'` } } });
      expect(bounded).toMatchObject({ kind: "completed", output: { exitCode: 0, truncated: true } });
      if (bounded.kind === "completed") {
        expect(Buffer.byteLength(String(bounded.output.stdout))).toBe(64 * 1024);
        expect(Buffer.byteLength(String(bounded.output.stderr))).toBe(64 * 1024);
      }

      const mutating = { ...command, toolCall: { ...command.toolCall, input: { command: "printf forbidden > denied.txt" } } };
      for (const approval of [null, { decision: "denied" as const, decidedBy: run.userId, reason: null }]) {
        expect(await worker.executeTool({ ...mutating, approval })).toMatchObject({ kind: "failed" });
      }
      expect(await worker.executeTool({ ...mutating, runAttemptId: "attempt_other001" })).toMatchObject({ kind: "failed" });
      current = false;
      expect(await worker.executeTool(mutating)).toMatchObject({ kind: "failed" });
      await expect(readFile(join(root, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      current = true;
      const abort = new AbortController();
      const execution = worker.executeTool({ ...command, signal: abort.signal,
        toolCall: { ...command.toolCall, input: { command: "printf started > started.txt; exec sleep 30" } } });
      await vi.waitFor(async () => expect(await readFile(join(root, "started.txt"), "utf8")).toBe("started"));
      abort.abort();
      expect(await execution).toMatchObject({ kind: "cancelled" });
      expect(await worker.stop()).toBe(true);
      expect(await worker.stop()).toBe(true);
      expect(await worker.executeTool(command)).toMatchObject({ kind: "cancelled" });
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }

  });
});

function createAuthorization(effect: PermissionEffect) {
  const policy = createPolicy(effect);
  return new RegistryToolAuthorization({
    resolve: async () => policy,
  });
}

function createPolicy(toolEffect: PermissionEffect): PermissionPolicy {
  const allow = {
    defaultEffect: "allow" as const,
    defaultRiskLevel: "low" as const,
    rules: [],
  };
  return {
    commands: allow,
    paths: allow,
    network: allow,
    git: allow,
    packageManagers: allow,
    secrets: allow,
    externalServices: allow,
    tools: {
      defaultEffect: toolEffect,
      defaultRiskLevel: "high",
      rules: [],
    },
  };
}
