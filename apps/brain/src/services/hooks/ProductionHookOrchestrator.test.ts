import {
  EventIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
  workspaceIdFromExternalId,
} from "@repo/platform-protocol";
import type {
  RuntimeHookAuditEventType,
  RuntimeHookTriggerInput,
} from "@repo/runtime-kernel";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import {
  HookRuntimeScopeError,
  ProductionHookOrchestrator,
} from "./ProductionHookOrchestrator";
import {
  TRUSTED_PROMPT_OBSERVER_KEY,
  TRUSTED_SESSION_OBSERVER_KEY,
} from "./TrustedDeclarativeHookExecutor";

const USER_ID = "1dc4a37d-6bbc-4bdb-9088-62754a067f58";
const WORKSPACE_ID = "10db59dc-7c02-4b04-86ee-d6b584d2d1b3";
const WORKSPACE_ROOT = "/home/sandbox/task-checkout-1";
const PROMPT = "PRIVATE prompt content must not enter hook audit events";
const RUN_ATTEMPT_ID = RunAttemptIdSchema.parse("attempt_hookrun001");
const run = RunSchema.parse({
  id: "run_hookrun001",
  threadId: "thr_hookrun001",
  userId: "usr_hookrun001",
  workspaceId: workspaceIdFromExternalId(WORKSPACE_ID),
  status: "running",
  mode: "auto_edit",
  providerId: "openai",
  modelId: "gpt-5",
  workerId: "worker_hookrun001",
  permissionProfileId: "perm_hookrun001",
  startedAt: "2026-07-19T00:00:00.000Z",
  completedAt: null,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  lastEventSequence: 0,
});
const turn = TurnSchema.parse({
  id: "trn_hookrun001",
  threadId: run.threadId,
  runId: run.id,
  parentTurnId: null,
  status: "queued",
  startedAt: null,
  completedAt: null,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  lastEventSequence: 0,
});

describe("ProductionHookOrchestrator", () => {
  it("loads authenticated persisted definitions and appends only sanitized audits", async () => {
    const audits: Array<{
      eventType: RuntimeHookAuditEventType;
      payload: unknown;
    }> = [];
    const list = vi.fn(async () => definitionRecords());
    const orchestrator = new ProductionHookOrchestrator(
      envWithRepositories(list),
      orchestratorInput(),
    );
    const trigger = triggerInput(async (eventType, payload) => {
      audits.push({ eventType, payload });
    });

    await orchestrator.runSessionStart({
      ...trigger,
      triggerEventId: EventIdSchema.parse("evt_sessionhook001"),
    });
    await orchestrator.runUserPromptSubmit({
      ...trigger,
      triggerEventId: EventIdSchema.parse("evt_prompthook001"),
    });

    expect(list).toHaveBeenCalledOnce();
    expect(audits.map((audit) => audit.eventType)).toEqual([
      "hook.invocation.started",
      "hook.invocation.completed",
      "hook.invocation.started",
      "hook.invocation.completed",
    ]);
    expect(
      audits.map((audit) => {
        const invocation = (
          audit.payload as { invocation: { eventName: string } }
        ).invocation;
        return invocation.eventName;
      }),
    ).toEqual([
      "SessionStart",
      "SessionStart",
      "UserPromptSubmit",
      "UserPromptSubmit",
    ]);
    expect(JSON.stringify(audits)).not.toContain(PROMPT);
    expect(JSON.stringify(audits)).not.toContain("normalizedPrompt");
    expect(JSON.stringify(audits)).not.toContain("modelContextAdditions");
  });

  it("denies a trigger whose checkout root differs from server-owned scope", async () => {
    const appendHookAudit = vi.fn(async () => {});
    const orchestrator = new ProductionHookOrchestrator(
      envWithRepositories(vi.fn(async () => definitionRecords())),
      orchestratorInput(),
    );

    await expect(
      orchestrator.runSessionStart({
        ...triggerInput(appendHookAudit),
        workspace: {
          ...triggerInput(appendHookAudit).workspace,
          filesystemRoot: "/home/sandbox/sibling-task",
        },
      }),
    ).rejects.toBeInstanceOf(HookRuntimeScopeError);
    expect(appendHookAudit).not.toHaveBeenCalled();
  });

  it("fails an unregistered declarative key without executing external content", async () => {
    const audits: Array<{ eventType: string; payload: unknown }> = [];
    const records = definitionRecords().map((record, index) =>
      index === 0
        ? {
            ...record,
            definition: {
              ...record.definition,
              configurationKey: "https://attacker.invalid/hook.sh",
            },
          }
        : record,
    );
    const orchestrator = new ProductionHookOrchestrator(
      envWithRepositories(vi.fn(async () => records)),
      orchestratorInput(),
    );

    await orchestrator.runSessionStart(
      triggerInput(async (eventType, payload) => {
        audits.push({ eventType, payload });
      }),
    );

    expect(audits.map((audit) => audit.eventType)).toEqual([
      "hook.invocation.started",
      "hook.invocation.failed",
    ]);
    expect(JSON.stringify(audits)).not.toContain("attacker.invalid");
  });
});

function orchestratorInput() {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    threadId: run.threadId,
    turnId: turn.id,
    runAttemptId: RUN_ATTEMPT_ID,
    workspaceRoot: WORKSPACE_ROOT,
    prompt: PROMPT,
    selectedMode: "auto_edit" as const,
    backendId: "cloudflare_sandbox",
  };
}

function triggerInput(
  appendHookAudit: RuntimeHookTriggerInput["auditAppender"]["appendHookAudit"],
): RuntimeHookTriggerInput {
  return {
    run,
    turn,
    runAttemptId: RUN_ATTEMPT_ID,
    workspace: {
      runId: run.id,
      workspaceId: run.workspaceId,
      manifestId: "wsm_hookrun001",
      repoOwner: "legion",
      repoName: "hook-test",
      repoUrl: "https://github.com/legion/hook-test",
      baseBranch: "dev",
      workingBranch: "task/hook-test",
      baseCommitSha: "a".repeat(40),
      headCommitSha: "a".repeat(40),
      executionLocation: "cloud_sandbox",
      workerId: run.workerId,
      filesystemRoot: WORKSPACE_ROOT,
      artifactNamespace: "task-checkouts/hook-test",
      permissionProfileId: run.permissionProfileId,
      state: "ready",
      lastError: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
    triggerEventId: EventIdSchema.parse("evt_sessionhook001"),
    auditAppender: { appendHookAudit },
  };
}

function definitionRecords() {
  return [
    record({
      handlerId: "user.session-observer",
      eventName: "SessionStart" as const,
      configurationKey: TRUSTED_SESSION_OBSERVER_KEY,
      order: 10,
    }),
    record({
      handlerId: "user.prompt-observer",
      eventName: "UserPromptSubmit" as const,
      configurationKey: TRUSTED_PROMPT_OBSERVER_KEY,
      order: 20,
    }),
  ];
}

function record(input: {
  handlerId: string;
  eventName: "SessionStart" | "UserPromptSubmit";
  configurationKey: string;
  order: number;
}) {
  return {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    definition: {
      ...input,
      source: "user" as const,
      displayName: input.handlerId,
      enabled: true,
      timeoutMs: 1_000,
    },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function envWithRepositories(list: ReturnType<typeof vi.fn>): Env {
  return {
    AUTH_WORKSPACE_REPOSITORY: {
      async listWorkspaces() {
        return [{ workspace: { id: WORKSPACE_ID } }];
      },
    },
    AUTH_HOOK_DEFINITION_REPOSITORY: { list },
  } as unknown as Env;
}
