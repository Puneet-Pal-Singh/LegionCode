import {
  ItemIdSchema,
  RunAttemptIdSchema,
  RunSchema,
  TurnSchema,
  type Run,
  type RunAttemptId,
  type Turn,
} from "@repo/platform-protocol";
import {
  RuntimeKernel,
  type RuntimeGitSnapshotPort,
  type RuntimeKernelDependencies,
  type RuntimeLifecycleEventStore,
  type RuntimeTurnArtifactPort,
  type WorkerToolResult,
} from "@repo/runtime-kernel";
import type { CoreTool } from "ai";
import type { RunInput } from "../types.js";

const DEFAULT_SHA = "0".repeat(40);
const ID_SUFFIX_MIN_LENGTH = 6;
type KernelWorkspaceManifest = NonNullable<
  Awaited<
    ReturnType<
      RuntimeKernelDependencies["workspaceManifests"]["getLatestByRunId"]
    >
  >
>;

export interface RunEngineKernelAdapterInput {
  runId: string;
  sessionId: string;
  userId?: string;
  workspaceId?: string;
  correlationId: string;
  input: RunInput;
  tools: Record<string, CoreTool>;
  executeLegacyRunEngine: () => Promise<Response>;
  lifecycleEvents: RuntimeLifecycleEventStore;
  now?: () => string;
}

/**
 * Quarantined legacy executor adapter.
 *
 * Owner: Runtime platform.
 * Why it exists: direct-file legacy characterization tests still cover the old
 * adapter contract while the native RuntimeKernel runner soaks.
 * Canonical path: RuntimeKernel startTurn with native provider, worker,
 * tool authorization, approval, manifest, and artifact ports.
 * Deletion criteria: remove this adapter when no direct references remain and
 * native RuntimeKernel runner parity has soaked.
 */
export async function executeRunEngineThroughRuntimeKernel(
  input: RunEngineKernelAdapterInput,
): Promise<Response> {
  const now = input.now ?? (() => new Date().toISOString());
  const protocol = buildProtocolEnvelope(input, now());
  let response: Response | null = null;

  console.log(
    `[runtime-kernel/live-adapter] starting runId=${input.runId} turnId=${protocol.turn.id} correlationId=${input.correlationId} toolCount=${Object.keys(input.tools).length}`,
  );
  const result: { response?: Response } = {};
  const kernel = new RuntimeKernel({
    lifecycleEvents: input.lifecycleEvents,
    workspaceManifests: createWorkspaceManifestRepository(protocol.manifest),
    gitSnapshots: createSnapshotPort(protocol.manifest),
    turnArtifacts: createTurnArtifactPort(),
    contextAssembly: {
      assemble: async () => ({
        instructions: "Execute the active LegionCode run through RunEngine.",
        metadata: { correlationId: input.correlationId },
      }),
    },
    provider: {
      generateNext: async () => {
        result.response = await input.executeLegacyRunEngine();
        return {
          kind: "complete",
          itemId: ItemIdSchema.parse(
            toProtocolId("itm", `${input.runId}-final`),
          ),
          output: `RunEngine completed with HTTP ${result.response.status}`,
        };
      },
    },
    worker: {
      executeTool: async () => createKernelAdapterWorkerFailure(),
    },
    toolAuthorization: {
      authorize: async () => ({
        status: "rejected",
        code: "tool_not_registered",
        reason:
          "RuntimeKernel rejected an unexpected adapter tool call; live execution is delegated through the LegacyRunEngineExecutorAdapter provider boundary.",
      }),
    },
    approvals: {
      waitForDecision: async () => ({
        decision: "denied",
        decidedBy: null,
        reason:
          "RuntimeKernel rejected an unexpected adapter approval wait; live execution is delegated through the LegacyRunEngineExecutorAdapter provider boundary.",
      }),
    },
    producerId: "legacy-run-engine-adapter",
    maxToolCalls: 0,
    clock: { now },
  });

  await kernel.startTurn({
    run: protocol.run,
    turn: protocol.turn,
    runAttemptId: protocol.runAttemptId,
  });

  response = result.response ?? null;
  if (!response) {
    throw new Error("[runtime-kernel/live-adapter] RunEngine returned no response");
  }
  console.log(
    `[runtime-kernel/live-adapter] completed runId=${input.runId} turnId=${protocol.turn.id} correlationId=${input.correlationId} responseStatus=${response.status}`,
  );
  return response;
}

function buildProtocolEnvelope(
  input: RunEngineKernelAdapterInput,
  timestamp: string,
) {
  const workspaceId = toProtocolId("wrk", input.workspaceId ?? input.sessionId);
  const threadId = toProtocolId("thr", input.sessionId);
  const workerId = toProtocolId("worker", input.runId);
  const permissionProfileId = toProtocolId("perm", input.runId);
  const run = RunSchema.parse({
    id: input.runId,
    threadId,
    userId: toProtocolId("usr", input.userId ?? input.sessionId),
    workspaceId,
    status: "running",
    mode: mapRunMode(input.input.mode),
    providerId: normalizeProviderId(input.input.providerId),
    modelId: normalizeModelId(input.input.runtimeModelId ?? input.input.modelId),
    workerId,
    permissionProfileId,
    startedAt: timestamp,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastEventSequence: 0,
  });
  const turn = TurnSchema.parse({
    id: toProtocolId("trn", `${input.runId}-${input.correlationId}`),
    threadId,
    runId: input.runId,
    parentTurnId: null,
    status: "queued",
    startedAt: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastEventSequence: 0,
  });
  const manifest = {
    runId: run.id,
    workspaceId: run.workspaceId,
    repoOwner: normalizeRepoPart(input.input.repositoryContext?.owner, "local"),
    repoName: normalizeRepoPart(input.input.repositoryContext?.repo, "workspace"),
    repoUrl: buildRepoUrl(input.input.repositoryContext),
    baseBranch: normalizeBranch(input.input.repositoryContext?.branch),
    workingBranch: `run/${input.runId}`,
    baseSha: DEFAULT_SHA,
    headSha: DEFAULT_SHA,
    executionLocation: "cloud_sandbox",
    workerId,
    filesystemRoot: `/home/sandbox/runs/${input.runId}`,
    artifactNamespace: `runtime-kernel/${input.runId}`,
    permissionProfileId,
    state: "ready",
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as KernelWorkspaceManifest;
  return {
    run: run as Run,
    turn: turn as Turn,
    runAttemptId: RunAttemptIdSchema.parse(
      toProtocolId("attempt", `${input.runId}-attempt`),
    ) as RunAttemptId,
    manifest,
  };
}

function createWorkspaceManifestRepository(
  manifest: KernelWorkspaceManifest,
): RuntimeKernelDependencies["workspaceManifests"] {
  return {
    create: async () => manifest,
    update: async () => manifest,
    getByWorkspaceId: async () => manifest,
    getLatestByRunId: async () => manifest,
  };
}

function createSnapshotPort(
  manifest: KernelWorkspaceManifest,
): RuntimeGitSnapshotPort {
  return {
    captureSnapshot: async () => ({
      runId: manifest.runId,
      filesystemRoot: manifest.filesystemRoot,
      headSha: DEFAULT_SHA,
      treeId: DEFAULT_SHA,
    }),
    getSnapshotDiff: async () => ({ files: [], patch: "" }),
  };
}

function createTurnArtifactPort(): RuntimeTurnArtifactPort {
  return {
    putSnapshot: async ({ snapshot }: { snapshot: { phase: string } }) => ({
      kind: "turn_snapshot",
      phase: snapshot.phase,
    }),
    putTurnDiff: async () => ({ kind: "turn_diff" }),
  };
}

function createKernelAdapterWorkerFailure(): WorkerToolResult {
  return {
    kind: "failed",
    failure: {
      code: "validation_failed",
      message:
        "RuntimeKernel rejected an unexpected adapter worker call; live execution is delegated through the LegacyRunEngineExecutorAdapter provider boundary.",
      details: null,
      retryable: false,
      correlationId: null,
    },
  };
}

function mapRunMode(mode: RunInput["mode"]): Run["mode"] {
  return mode === "plan" ? "plan" : "auto_edit";
}

function normalizeProviderId(value: string | undefined): Run["providerId"] {
  return normalizeSlug(value, "default-provider", 64) as Run["providerId"];
}

function normalizeModelId(value: string | undefined): Run["modelId"] {
  const normalized = (value ?? "default-model")
    .replace(/[^A-Za-z0-9._:/+-]+/g, "-")
    .slice(0, 192);
  return normalized as Run["modelId"];
}

function normalizeRepoPart(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized || fallback;
}

function normalizeBranch(value: string | undefined): string {
  return value && value.trim() ? value.trim() : "dev";
}

function buildRepoUrl(context: RunInput["repositoryContext"]): string {
  if (context?.baseUrl?.startsWith("http://") || context?.baseUrl?.startsWith("https://")) {
    return context.baseUrl;
  }
  const owner = normalizeRepoPart(context?.owner, "local");
  const repo = normalizeRepoPart(context?.repo, "workspace");
  return `https://github.com/${owner}/${repo}`;
}

function normalizeSlug(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const normalized = (value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function toProtocolId(prefix: string, value: string): string {
  if (new RegExp(`^${prefix}_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$`).test(value)) {
    return value;
  }
  const suffix = stableIdSuffix(value);
  return `${prefix}_${suffix}`;
}

function stableIdSuffix(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  const suffix = Math.abs(hash).toString(36);
  return suffix.padEnd(ID_SUFFIX_MIN_LENGTH, "0");
}
