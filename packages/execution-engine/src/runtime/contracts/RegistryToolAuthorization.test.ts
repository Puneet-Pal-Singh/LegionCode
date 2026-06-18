import type {
  PermissionEffect,
  PermissionPolicy,
} from "@repo/permission-policy";
import { ItemIdSchema, RunSchema } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
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
          permissionProfileId: run.permissionProfileId,
        },
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
