import { MemoryEventStore } from "@repo/event-store";
import type { ApprovalRequestedPayload } from "@repo/platform-protocol";
import {
  ApprovalRequestedPayloadSchema,
  RunSchema,
  TurnSchema,
} from "@repo/platform-protocol";
import {
  MemoryWorkspaceManifestRepository,
  parseWorkspaceManifest,
} from "@repo/workspace-core";
import { vi } from "vitest";
import type {
  ApprovalWaitPort,
  ContextAssemblyPort,
  ProviderPort,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "./ports.js";

export const timestamp = "2026-06-14T10:00:00.000Z";

export const run = RunSchema.parse({
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

export const turn = TurnSchema.parse({
  id: "trn_runtime001",
  threadId: run.threadId,
  runId: run.id,
  parentTurnId: null,
  status: "queued",
  startedAt: null,
  completedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSequence: 0,
});

export const manifest = parseWorkspaceManifest({
  runId: run.id,
  workspaceId: run.workspaceId,
  repoOwner: "shadowbox",
  repoName: "runtime-kernel",
  repoUrl: "https://github.com/shadowbox/runtime-kernel",
  baseBranch: "dev",
  workingBranch: "codex/feat-runtime-kernel-shell",
  baseSha: "a".repeat(40),
  headSha: "a".repeat(40),
  executionLocation: "cloud_sandbox",
  workerId: run.workerId,
  filesystemRoot: "/home/sandbox/runs/run_runtime001",
  artifactNamespace: "runtime-kernel/run_runtime001",
  permissionProfileId: run.permissionProfileId,
  state: "ready",
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const approvalRequest: ApprovalRequestedPayload =
  ApprovalRequestedPayloadSchema.parse({
    approvalId: "appr_runtime001",
    itemId: "itm_runtime001",
    question: "Allow the worker to write the requested file?",
    options: [
      {
        id: "approve",
        label: "Approve",
        description: "Allow this exact action",
      },
      { id: "deny", label: "Deny", description: null },
    ],
    metadata: { risk: "write" },
  });

export async function createManifestRepository(): Promise<MemoryWorkspaceManifestRepository> {
  const repository = new MemoryWorkspaceManifestRepository();
  await repository.create(manifest);
  return repository;
}

export function createPorts(): {
  contextAssembly: ContextAssemblyPort;
  provider: ProviderPort;
  worker: WorkerProtocolPort;
  approvals: ApprovalWaitPort;
  toolAuthorization: ToolAuthorizationPort;
} {
  return {
    contextAssembly: {
      assemble: vi.fn(async () => ({
        instructions: "Implement the requested change",
        metadata: {},
      })),
    },
    provider: {
      generateNext: vi.fn(async () => ({
        kind: "complete" as const,
        output: "Done",
      })),
    },
    worker: {
      executeTool: vi.fn(async () => ({
        kind: "completed" as const,
        output: { ok: true },
      })),
    },
    approvals: {
      waitForDecision: vi.fn(async () => ({
        decision: "approved" as const,
        decidedBy: run.userId,
        reason: null,
      })),
    },
    toolAuthorization: {
      authorize: vi.fn(async ({ toolCall }) => ({
        status: "authorized" as const,
        toolCall,
      })),
    },
  };
}

export function createEventStore(): MemoryEventStore {
  return new MemoryEventStore();
}
