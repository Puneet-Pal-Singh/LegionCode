import type {
  ApprovalRequestedPayload,
  LifecycleEvent,
} from "@repo/platform-protocol";
import {
  ApprovalRequestedPayloadSchema,
  ItemIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
} from "@repo/platform-protocol";
import type { ArtifactMetadata } from "@repo/artifact-store";
import type { GitDiffResult } from "@repo/git-service";
import {
  MemoryWorkspaceManifestRepository,
  parseWorkspaceManifest,
} from "@repo/workspace-core";
import { vi } from "vitest";
import type {
  ApprovalWaitPort,
  ContextAssemblyPort,
  RuntimeLifecycleEventStore,
  RuntimeGitSnapshotPort,
  RuntimeTurnArtifactPort,
  ProviderPort,
  ToolAuthorizationPort,
  WorkerProtocolPort,
} from "./ports.js";

export const timestamp = "2026-06-14T10:00:00.000Z";
export const runAttemptId = RunAttemptIdSchema.parse("attempt_runtime001");
export const finalItemId = ItemIdSchema.parse("itm_assistant001");

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
    itemId: "itm_approval001",
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
        itemId: finalItemId,
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

export class MemoryLifecycleEventSink implements RuntimeLifecycleEventStore {
  readonly events: LifecycleEvent[] = [];

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const existingKeys = new Set(
      this.events.map((event) => event.idempotencyKey),
    );
    const newEvents = events.filter(
      (event) => !existingKeys.has(event.idempotencyKey),
    );
    this.events.push(...newEvents);
    return events;
  }

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async replay(input: {
    turnId?: LifecycleEvent["turnId"];
    afterSequence: number | null;
    limit: number;
  }): Promise<{
    events: readonly LifecycleEvent[];
    nextSequence: number | null;
  }> {
    const events = this.events
      .filter(
        (event) => input.turnId === undefined || event.turnId === input.turnId,
      )
      .filter((event) =>
        input.afterSequence === null
          ? true
          : event.sequence > input.afterSequence,
      )
      .slice(0, input.limit);
    return { events, nextSequence: events.at(-1)?.sequence ?? null };
  }
}

export function createLifecycleSink(): MemoryLifecycleEventSink {
  return new MemoryLifecycleEventSink();
}

export function createArtifactPorts(
  diff: GitDiffResult = { files: [], patch: "" },
): {
  gitSnapshots: RuntimeGitSnapshotPort;
  turnArtifacts: RuntimeTurnArtifactPort;
} {
  let captureCount = 0;
  const gitSnapshots: RuntimeGitSnapshotPort = {
    captureSnapshot: vi.fn(async () => {
      captureCount += 1;
      return {
        runId: run.id,
        filesystemRoot: manifest.filesystemRoot,
        headSha: manifest.headSha,
        treeId: (captureCount === 1 ? "b" : "c").repeat(40),
      };
    }),
    getSnapshotDiff: vi.fn(async () => diff),
  };
  const turnArtifacts: RuntimeTurnArtifactPort = {
    putSnapshot: vi.fn(async ({ snapshot }) =>
      artifactMetadata(
        snapshot.phase === "start" ? "art_snapshot001" : "art_snapshot002",
        "workspace_snapshot",
        { role: "turn_snapshot", turnId: turn.id, phase: snapshot.phase },
      ),
    ),
    putTurnDiff: vi.fn(async () =>
      artifactMetadata("art_turndiff001", "diff", {
        role: "turn_diff",
        turnId: turn.id,
        changedFileCount: 0,
      }),
    ),
    getTurnDiff: vi.fn(async () => null),
    listWorkspaceDiffs: vi.fn(async () => []),
  };
  return { gitSnapshots, turnArtifacts };
}

function artifactMetadata(
  artifactId: string,
  kind: ArtifactMetadata["kind"],
  properties: ArtifactMetadata["properties"],
): ArtifactMetadata {
  return {
    artifactId: artifactId as ArtifactMetadata["artifactId"],
    kind,
    ownership: {
      createdBy: run.userId,
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
    },
    visibility: "run",
    payload: {
      backend: "memory",
      storageKey: `artifacts/${artifactId}`,
      contentType: "application/json",
      byteSize: 2,
      sha256: "a".repeat(64),
    },
    properties,
    createdAt: timestamp,
  };
}
