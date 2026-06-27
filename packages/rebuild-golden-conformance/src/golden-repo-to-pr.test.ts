import { MemoryLifecycleEventStore } from "@repo/event-store/lifecycle";
import {
  DefaultGitService,
  type GitCommandExecutionInput,
  type GitCommandExecutionResult,
  type GitCommandExecutor,
} from "@repo/git-service";
import {
  DefaultPlatformClient,
  type PlatformClientTransport,
  type ReplayLifecycleEventsResponse,
} from "@repo/platform-client-sdk";
import {
  ArtifactMetadataSchema,
  LifecycleEventSchema,
  RunSchema,
  ThreadSchema,
  TurnSchema,
  type ApprovalId,
  type ArtifactMetadata,
  type EventSequence,
  type ItemId,
  type LifecycleEvent,
  type Run,
  type RunAttemptId,
  type Thread,
  type Turn,
  type TurnDiffPayload,
  type ToolCallItemContent,
  type UserId,
} from "@repo/platform-protocol";
import { RuntimeKernel, type RuntimeTurnArtifactPort } from "@repo/runtime-kernel";
import type {
  ApprovalResolution,
  ApprovalWaitPort,
  ContextAssemblyPort,
  ProviderCallInput,
  ProviderPort,
  ProviderStep,
  RuntimeGitDiffFile,
  RuntimeGitSnapshotPort,
  RuntimeGitWorkspaceSnapshot,
  ToolAuthorizationPort,
  ToolAuthorizationResult,
  WorkerProtocolPort,
  WorkerToolResult,
} from "@repo/runtime-kernel";
import {
  CreateRunRequestSchema,
  StartTurnRequestSchema,
} from "@repo/platform-client-sdk";
import {
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolRequestSchema,
} from "@repo/worker-protocol";
import {
  MemoryWorkspaceManifestRepository,
  parseWorkspaceManifest,
  type WorkspaceManifest,
} from "@repo/workspace-core";
import { describe, expect, it } from "vitest";

const NOW = "2026-06-24T00:00:00.000Z";
const SHA_BASE = "a".repeat(40);
const SHA_EDITED = "b".repeat(40);
const SHA_COMMITTED = "c".repeat(40);
const SHA256 = "d".repeat(64);
const PATCH = `diff --git a/src/feature.ts b/src/feature.ts
index 1111111..2222222 100644
--- a/src/feature.ts
+++ b/src/feature.ts
@@ -1 +1,2 @@
 export const enabled = false;
+export const governed = true;
diff --git a/src/review.md b/src/review.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/review.md
@@ -0,0 +1 @@
+review artifact
`;

const IDS = {
  userId: "usr_golden0001" as UserId,
  workspaceId: "wrk_golden0001" as Thread["workspaceId"],
  threadId: "thr_golden0001" as Thread["id"],
  runId: "run_golden0001" as Run["id"],
  turnId: "trn_golden0001" as Turn["id"],
  attemptId: "attempt_golden0001" as RunAttemptId,
  workerId: "worker_golden0001" as Run["workerId"],
  permissionProfileId: "perm_golden0001" as Run["permissionProfileId"],
  toolItemId: "itm_golden_tool" as ItemId,
  finalItemId: "itm_golden_final" as ItemId,
  approvalItemId: "itm_golden_approval" as ItemId,
  approvalId: "appr_golden0001" as ApprovalId,
  toolCallId: "toolcall_golden0001" as ToolCallItemContent["toolCallId"],
  snapshotArtifactId: "art_golden_snapshot" as ArtifactMetadata["artifactId"],
  diffArtifactId: "art_golden_diff" as ArtifactMetadata["artifactId"],
} as const;

describe("golden repo-to-PR conformance", () => {
  it("settles prompt to PR workflow through canonical lifecycle replay", async () => {
    const fixture = createGoldenFixture();
    const client = new DefaultPlatformClient(fixture.transport);

    const thread = await client.createThread({
      userId: IDS.userId,
      workspaceId: IDS.workspaceId,
      title: "Golden repo to PR",
    });
    await client.createRun(createRunRequest(thread));
    const start = await client.startTurn(createStartTurnRequest(thread));

    await fixture.waitForApprovalRequest();
    await client.submitLifecycleApproval({
      turnId: start.turn.id,
      approvalId: IDS.approvalId,
      decision: "approved",
      decidedBy: IDS.userId,
      reason: "fixture approves deterministic edit",
    });
    await fixture.waitForCompletion();

    const status = await fixture.git.getStatus({
      runId: start.run.id,
      workspaceRoot: fixture.workspace.filesystemRoot,
    });
    const diff = await fixture.git.getDiff({
      workspace: fixture.gitWorkspace,
      paths: ["src/feature.ts", "src/review.md"],
      staged: false,
    });
    const commit = await fixture.git.commit({
      workspace: fixture.gitWorkspace,
      paths: ["src/feature.ts", "src/review.md"],
      message: "test: golden repo to pr",
      author: { name: "LegionCode", email: "legion@example.com" },
    });
    const push = await fixture.git.push({
      workspace: fixture.gitWorkspace,
      remoteName: "origin",
    });
    const pullRequest = fixture.pullRequests.open({
      runId: start.run.id,
      branchName: push.branchName,
      commitSha: commit.commitSha,
    });

    const artifacts = await client.listArtifacts({
      runId: start.run.id,
      limit: 10,
      afterCursor: null,
    });
    const turnDiff = await client.getTurnDiff({ turnId: start.turn.id });
    const replay = await client.replayLifecycleEvents({
      turnId: start.turn.id,
      limit: 100,
    });
    const followed = await readAll(
      client.followTurnLifecycle({ turnId: start.turn.id, replayLimit: 4 }),
    );
    const reloadedManifest = await client.getWorkspaceManifest(start.run.id);

    expect(status.entries.map((entry) => entry.path)).toEqual([
      "src/feature.ts",
      "src/review.md",
    ]);
    expect(diff.patch).toContain("export const governed = true");
    expect(pullRequest.url).toBe("https://example.test/pull/1");
    expect(turnDiff?.files.map((file) => file.path)).toEqual([
      "src/feature.ts",
      "src/review.md",
    ]);
    expect(artifacts.artifacts.map((artifact) => artifact.kind)).toContain(
      "diff",
    );
    expect(reloadedManifest).toMatchObject({
      manifestId: "wsm_golden0001",
      runId: fixture.workspace.runId,
      workspaceId: fixture.workspace.workspaceId,
      baseCommitSha: fixture.workspace.baseSha,
      headCommitSha: fixture.workspace.headSha,
    });
    assertLifecycleTruth(replay);
    expect(followed).toEqual(replay.events);
    expect(fixture.gitExecutor.workerProtocolOperations).toEqual([
      "workspace.prepare",
      "file.write",
      "git.diff",
      "git.commit",
      "git.push",
    ]);
  });
});

function createGoldenFixture(): GoldenFixture {
  const workspaceManifests = new MemoryWorkspaceManifestRepository();
  const lifecycleEvents = new MemoryLifecycleEventStore();
  const workspace = createWorkspaceManifest();
  const gitExecutor = new GoldenGitExecutor();
  const git = new DefaultGitService(gitExecutor);
  const turnArtifacts = new GoldenArtifactStore();
  const approvals = new GoldenApprovalWaitPort();
  const pullRequests = new GoldenPullRequestGateway(gitExecutor);
  const gitSnapshots = createGitSnapshotPort(git);
  const provider = new GoldenProvider();
  const worker = new GoldenWorker(gitExecutor);

  void workspaceManifests.create(workspace);
  const kernel = new RuntimeKernel({
    lifecycleEvents,
    gitSnapshots,
    turnArtifacts,
    workspaceManifests,
    contextAssembly: createContextAssembly(),
    provider,
    worker,
    toolAuthorization: new GoldenToolAuthorization(),
    approvals,
    producerId: "runtime_kernel",
    clock: { now: () => NOW },
  });
  const transport = new GoldenPlatformTransport({
    kernel,
    lifecycleEvents,
    workspaceManifests,
    approvals,
    turnArtifacts,
    workspace,
  });

  return {
    transport,
    git,
    gitExecutor,
    gitWorkspace: {
      runId: IDS.runId,
      filesystemRoot: workspace.filesystemRoot,
      workingBranch: workspace.workingBranch,
    },
    pullRequests,
    workspace,
    waitForApprovalRequest: () => approvals.waitUntilRequested(),
    waitForCompletion: () => transport.waitForCompletion(),
  };
}

function createWorkspaceManifest(): WorkspaceManifest {
  return parseWorkspaceManifest({
    runId: IDS.runId,
    workspaceId: IDS.workspaceId,
    repoOwner: "shadowbox",
    repoName: "golden-fixture",
    repoUrl: "https://example.test/shadowbox/golden-fixture.git",
    baseBranch: "dev",
    workingBranch: "feat/golden-repo-to-pr",
    baseSha: SHA_BASE,
    headSha: SHA_BASE,
    executionLocation: "local_worktree",
    workerId: IDS.workerId,
    filesystemRoot: "/tmp/legioncode-golden/run_golden0001",
    artifactNamespace: "golden/run_golden0001",
    permissionProfileId: IDS.permissionProfileId,
    state: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function toProtocolWorkspaceManifest(workspace: WorkspaceManifest) {
  return {
    manifestId: "wsm_golden0001",
    workspaceId: workspace.workspaceId,
    runId: workspace.runId,
    userId: IDS.userId,
    workerId: workspace.workerId,
    permissionProfileId: workspace.permissionProfileId,
    repoOwner: workspace.repoOwner,
    repoName: workspace.repoName,
    repoUrl: workspace.repoUrl,
    baseBranch: workspace.baseBranch,
    workingBranch: workspace.workingBranch,
    baseCommitSha: workspace.baseSha,
    headCommitSha: workspace.headSha,
    executionLocation: workspace.executionLocation,
    filesystemRoot: workspace.filesystemRoot,
    artifactNamespace: workspace.artifactNamespace,
    state: workspace.state,
    lastError: workspace.lastError,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function createRunRequest(thread: Thread) {
  return CreateRunRequestSchema.parse({
    threadId: thread.id,
    userId: IDS.userId,
    workspaceId: thread.workspaceId,
    mode: "auto_edit" as const,
    providerId: "golden-provider",
    modelId: "golden-model",
    workerId: IDS.workerId,
    permissionProfileId: IDS.permissionProfileId,
    input: { prompt: "make a deterministic edit and open a PR" },
  });
}

function createStartTurnRequest(thread: Thread) {
  return StartTurnRequestSchema.parse({
    ...createRunRequest(thread),
    input: { prompt: "make a deterministic edit and open a PR" },
  });
}

function createContextAssembly(): ContextAssemblyPort {
  return {
    async assemble() {
      return {
        instructions: "Use canonical lifecycle and worker protocol only.",
        metadata: { fixture: "golden-repo-to-pr" },
      };
    },
  };
}

function createGitSnapshotPort(git: DefaultGitService): RuntimeGitSnapshotPort {
  return {
    async captureSnapshot(input) {
      return (await git.captureSnapshot(input)) as RuntimeGitWorkspaceSnapshot;
    },
    async getSnapshotDiff(input) {
      const diff = await git.getSnapshotDiff(input);
      return {
        files: diff.files.map(mapRuntimeDiffFile),
        patch: diff.patch,
      };
    },
  };
}

function mapRuntimeDiffFile(file: {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: RuntimeGitDiffFile["status"];
  readonly additions: number;
  readonly deletions: number;
}): RuntimeGitDiffFile {
  return file;
}

class GoldenPlatformTransport implements PlatformClientTransport {
  private thread: Thread | null = null;
  private run: Run | null = null;
  private turn: Turn | null = null;
  private completion: Promise<void> | null = null;

  constructor(private readonly deps: GoldenPlatformDependencies) {}

  async createThread(): Promise<Thread> {
    this.thread = ThreadSchema.parse({
      id: IDS.threadId,
      userId: IDS.userId,
      workspaceId: IDS.workspaceId,
      title: "Golden repo to PR",
      titleSource: "user",
      status: "active",
      pinnedAt: null,
      archivedAt: null,
      activeRunId: IDS.runId,
      activeLeafItemId: null,
      createdAt: NOW,
      updatedAt: NOW,
      lastEventSequence: 0,
    });
    return this.thread;
  }

  async createRun(): Promise<Run> {
    this.run = createRun();
    return this.run;
  }

  async startTurn(): Promise<{ readonly run: Run; readonly turn: Turn }> {
    const run = this.run ?? createRun();
    const turn = createTurn(run);
    this.run = run;
    this.turn = turn;
    this.prepareWorkspace(run);
    this.completion = this.deps.kernel
      .startTurn({ run, turn, runAttemptId: IDS.attemptId })
      .then(() => undefined);
    return { run, turn };
  }

  async getThread(): Promise<Thread> {
    const thread = this.thread;
    if (!thread) throw new Error("thread was not created");
    return thread;
  }

  async listThreads() {
    return { threads: [await this.getThread()], nextCursor: null };
  }

  async getRun(): Promise<Run> {
    return requireValue(this.run, "run was not created");
  }

  async *attachRunStream(): AsyncIterable<never> {}

  async *attachLifecycleStream(request: {
    readonly afterSequence?: EventSequence | null;
  }): AsyncIterable<LifecycleEvent> {
    const replay = await this.replayLifecycleEvents(request);
    for (const event of replay.events) yield event;
  }

  async replayRunEvents() {
    return { events: [], nextCursor: null };
  }

  async replayLifecycleEvents(request: {
    readonly afterSequence?: EventSequence | null;
    readonly limit?: number;
  }): Promise<ReplayLifecycleEventsResponse> {
    const turn = requireValue(this.turn, "turn was not started");
    return await this.deps.lifecycleEvents.replay({
      turnId: turn.id,
      afterSequence: request.afterSequence ?? null,
      limit: request.limit ?? 100,
    });
  }

  async submitApproval() {
    return LifecycleEventSchema.parse(
      await this.submitLifecycleApproval({
        decision: "approved",
        decidedBy: IDS.userId,
        reason: "legacy approval bridge is unused in golden gate",
      }),
    );
  }

  async submitLifecycleApproval(request: {
    readonly decision: ApprovalResolution["decision"];
    readonly decidedBy: ApprovalResolution["decidedBy"];
    readonly reason: ApprovalResolution["reason"];
  }): Promise<LifecycleEvent> {
    return this.deps.approvals.resolve(request);
  }

  async submitUserInputResponse(): Promise<LifecycleEvent> {
    throw new Error("golden gate does not permit user-input fallback paths");
  }

  async getTurnDiff(): Promise<{ readonly diff: TurnDiffPayload | null }> {
    return { diff: this.deps.turnArtifacts.turnDiff };
  }

  async getArtifact(artifactId: string): Promise<ArtifactMetadata> {
    return this.deps.turnArtifacts.getArtifact(artifactId);
  }

  async listArtifacts() {
    return { artifacts: this.deps.turnArtifacts.artifacts, nextCursor: null };
  }

  async getWorkspaceManifest(): Promise<unknown> {
    const workspace = requireValue(
      await this.deps.workspaceManifests.getLatestByRunId(IDS.runId),
      "workspace manifest missing on reload",
    );
    return toProtocolWorkspaceManifest(workspace);
  }

  async waitForCompletion(): Promise<void> {
    await requireValue(this.completion, "turn was not started");
  }

  private prepareWorkspace(run: Run): void {
    WorkerProtocolRequestSchema.parse({
      requestId: "req-golden-prepare",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      runId: run.id,
      operation: "workspace.prepare",
      payload: { manifest: toProtocolWorkspaceManifest(this.deps.workspace) },
    });
  }
}

class GoldenProvider implements ProviderPort {
  async generateNext(input: ProviderCallInput): Promise<ProviderStep> {
    if (input.toolResults.length === 0) {
      return {
        kind: "tool_call" as const,
        itemId: IDS.toolItemId,
        content: {
          toolCallId: IDS.toolCallId,
          toolName: "file.write",
          input: {
            path: "src/feature.ts",
            content: "export const enabled = false;\nexport const governed = true;\n",
          },
        },
      };
    }
    return {
      kind: "complete" as const,
      itemId: IDS.finalItemId,
      output: "Opened deterministic PR after canonical artifact settlement.",
    };
  }
}

class GoldenToolAuthorization implements ToolAuthorizationPort {
  async authorize(): Promise<ToolAuthorizationResult> {
    return {
      status: "approval_required" as const,
      toolCall: {
        toolCallId: IDS.toolCallId,
        toolName: "file.write",
        input: {
          path: "src/feature.ts",
          content: "export const enabled = false;\nexport const governed = true;\n",
        },
      },
      request: {
        approvalId: IDS.approvalId,
        itemId: IDS.approvalItemId,
        question: "Approve deterministic repo edit",
        options: [
          {
            id: "approve",
            label: "Approve",
            description: "Apply the deterministic golden edit.",
          },
          {
            id: "deny",
            label: "Deny",
            description: "Reject the deterministic golden edit.",
          },
        ],
        metadata: { gate: "golden-repo-to-pr" },
      },
    };
  }
}

class GoldenApprovalWaitPort implements ApprovalWaitPort {
  private requested: Deferred<void> = createDeferred<void>();
  private decision: Deferred<ApprovalResolution> = createDeferred<ApprovalResolution>();

  async waitForDecision(): Promise<ApprovalResolution> {
    this.requested.resolve();
    return await this.decision.promise;
  }

  async waitUntilRequested(): Promise<void> {
    await this.requested.promise;
  }

  resolve(decision: ApprovalResolution): LifecycleEvent {
    this.decision.resolve(decision);
    return LifecycleEventSchema.parse({
      eventId: "evt_golden_approval_echo",
      turnId: IDS.turnId,
      threadId: IDS.threadId,
      runAttemptId: IDS.attemptId,
      itemId: IDS.approvalItemId,
      approvalId: IDS.approvalId,
      producer: { kind: "runtime_kernel", id: "runtime_kernel" },
      sequence: 999,
      schemaVersion: 1,
      type: "approval.decided",
      createdAt: NOW,
      idempotencyKey: "golden-approval-echo",
      payload: {
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        reason: decision.reason,
      },
    });
  }
}

class GoldenWorker implements WorkerProtocolPort {
  constructor(private readonly gitExecutor: GoldenGitExecutor) {}

  async executeTool(input: Parameters<WorkerProtocolPort["executeTool"]>[0]): Promise<WorkerToolResult> {
    if (!input.approval || input.approval.decision !== "approved") {
      return {
        kind: "failed",
        failure: {
          code: "unauthorized",
          message: "approval missing",
          retryable: false,
          correlationId: null,
          details: null,
        },
      };
    }
    WorkerProtocolRequestSchema.parse({
      requestId: "req-golden-write",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      runId: input.runId,
      operation: "file.write",
      payload: {
        path: "src/feature.ts",
        encoding: "utf8",
        content: String(input.toolCall.input.content),
        overwrite: true,
        createParents: true,
      },
    });
    this.gitExecutor.applyEdit();
    return {
      kind: "completed",
      output: { changedFiles: ["src/feature.ts", "src/review.md"] },
    };
  }
}

class GoldenArtifactStore implements RuntimeTurnArtifactPort {
  readonly artifacts: ArtifactMetadata[] = [];
  turnDiff: TurnDiffPayload | null = null;

  async putSnapshot(input: Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0]) {
    const artifact = createArtifact({
      artifactId: IDS.snapshotArtifactId,
      itemId: null,
      kind: "workspace_snapshot",
      label: `${input.snapshot.phase} workspace snapshot`,
      changedFiles: [],
      metadata: { snapshot: input.snapshot },
    });
    this.artifacts.push(artifact);
    return artifact;
  }

  async putTurnDiff(input: Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0]) {
    this.turnDiff = input.diff;
    const artifact = createArtifact({
      artifactId: IDS.diffArtifactId,
      itemId: IDS.finalItemId,
      kind: "diff",
      label: "turn diff",
      changedFiles: input.diff.files,
      metadata: { turnId: input.diff.turnId },
    });
    this.artifacts.push(artifact);
    return artifact;
  }

  getArtifact(artifactId: string): ArtifactMetadata {
    return requireValue(
      this.artifacts.find((artifact) => artifact.artifactId === artifactId),
      `artifact missing: ${artifactId}`,
    );
  }
}

class GoldenGitExecutor implements GitCommandExecutor {
  readonly calls: GitCommandExecutionInput[] = [];
  readonly workerProtocolOperations: string[] = ["workspace.prepare"];
  private edited = false;
  private staged = false;
  private committed = false;
  private pushed = false;

  async execute(input: GitCommandExecutionInput): Promise<GitCommandExecutionResult> {
    this.calls.push(input);
    const command = findGitCommand(input.args);
    if (isStatusCommand(input.args)) return ok(this.statusOutput());
    if (isNameStatusDiff(input.args)) return ok(this.nameStatusOutput());
    if (isNumstatDiff(input.args)) return ok(this.numstatOutput());
    if (isDiffCommand(input.args)) {
      this.recordWorkerOperation("git.diff");
      return ok(PATCH);
    }
    if (command === "rev-parse") return ok(this.revParse(input.args));
    if (command === "read-tree") return ok("");
    if (command === "add") return this.add(input.args);
    if (command === "write-tree") return ok(`${this.edited ? SHA_EDITED : SHA_BASE}\n`);
    if (command === "config") return ok("");
    if (command === "commit") return this.commit();
    if (command === "branch") return ok("feat/golden-repo-to-pr\n");
    if (command === "push") return this.push(input.args);
    return { exitCode: 1, stdout: "", stderr: `unexpected git command: ${input.args.join(" ")}` };
  }

  applyEdit(): void {
    this.edited = true;
    this.recordWorkerOperation("file.write");
  }

  ensurePushed(): void {
    if (!this.pushed) throw new Error("golden PR opened before canonical push");
  }

  private statusOutput(): string {
    if (!this.edited || this.committed) return "# branch.head feat/golden-repo-to-pr\0";
    const code = this.staged ? "M." : ".M";
    return [
      "# branch.head feat/golden-repo-to-pr\0",
      `1 ${code} N... 100644 100644 100644 ${SHA_BASE} ${SHA_BASE} src/feature.ts\0`,
      `1 ${code} N... 100644 100644 100644 ${SHA_BASE} ${SHA_BASE} src/review.md\0`,
    ].join("");
  }

  private nameStatusOutput(): string {
    return "M\tsrc/feature.ts\0A\tsrc/review.md\0";
  }

  private numstatOutput(): string {
    return ["1\t0\tsrc/feature.ts", "1\t0\tsrc/review.md", ""].join("\0");
  }

  private revParse(args: readonly string[]): string {
    if (args.includes("--git-path")) return "/tmp/golden-index\n";
    return `${this.committed ? SHA_COMMITTED : SHA_BASE}\n`;
  }

  private add(args: readonly string[]): GitCommandExecutionResult {
    this.staged = true;
    if (args.includes("-A")) return ok("");
    return ok("");
  }

  private commit(): GitCommandExecutionResult {
    this.committed = true;
    this.recordWorkerOperation("git.commit");
    return ok("[feat/golden-repo-to-pr abc123] test\n");
  }

  private push(args: readonly string[]): GitCommandExecutionResult {
    this.pushed = true;
    this.recordWorkerOperation("git.push");
    expect(args).toContain("HEAD:feat/golden-repo-to-pr");
    return ok("");
  }

  private recordWorkerOperation(operation: string): void {
    if (!this.workerProtocolOperations.includes(operation)) {
      this.workerProtocolOperations.push(operation);
    }
  }
}

class GoldenPullRequestGateway {
  constructor(private readonly gitExecutor: GoldenGitExecutor) {}

  open(input: { readonly runId: Run["id"]; readonly branchName: string; readonly commitSha: string }) {
    this.gitExecutor.ensurePushed();
    expect(input.runId).toBe(IDS.runId);
    expect(input.branchName).toBe("feat/golden-repo-to-pr");
    expect(input.commitSha).toBe(SHA_COMMITTED);
    return { number: 1, url: "https://example.test/pull/1" };
  }
}

function createRun(): Run {
  return RunSchema.parse({
    id: IDS.runId,
    threadId: IDS.threadId,
    userId: IDS.userId,
    workspaceId: IDS.workspaceId,
    status: "running",
    mode: "auto_edit",
    providerId: "golden-provider",
    modelId: "golden-model",
    workerId: IDS.workerId,
    permissionProfileId: IDS.permissionProfileId,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 0,
  });
}

function createTurn(run: Run): Turn {
  return TurnSchema.parse({
    id: IDS.turnId,
    threadId: run.threadId,
    runId: run.id,
    parentTurnId: null,
    status: "running",
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastEventSequence: 0,
  });
}

function createArtifact(input: {
  readonly artifactId: ArtifactMetadata["artifactId"];
  readonly itemId: ArtifactMetadata["itemId"];
  readonly kind: ArtifactMetadata["kind"];
  readonly label: string;
  readonly changedFiles: ArtifactMetadata["changedFiles"];
  readonly metadata: ArtifactMetadata["metadata"];
}): ArtifactMetadata {
  return ArtifactMetadataSchema.parse({
    artifactId: input.artifactId,
    threadId: IDS.threadId,
    runId: IDS.runId,
    workspaceId: IDS.workspaceId,
    itemId: input.itemId,
    kind: input.kind,
    label: input.label,
    payloadRef: {
      backend: "local_blob",
      objectKey: `golden/${input.artifactId}`,
      uri: null,
      contentType: "application/json",
      sizeBytes: 2,
      sha256: SHA256,
    },
    changedFiles: input.changedFiles,
    metadata: input.metadata,
    createdAt: NOW,
    eventSequence: 1,
  });
}

function assertLifecycleTruth(replay: ReplayLifecycleEventsResponse): void {
  const eventTypes = replay.events.map((event) => event.type);
  expect(eventTypes).toContain("approval.requested");
  expect(eventTypes).toContain("approval.decided");
  expect(eventTypes).toContain("artifact.created");
  expect(eventTypes.at(-1)).toBe("turn.completed");
  expect(replay.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  expect(replay.events.every((event) => event.producer.kind === "runtime_kernel")).toBe(true);
  expect(replay.events.map((event) => event.sequence)).toEqual(
    replay.events.map((_, index) => index + 1),
  );
}

async function readAll<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

function isStatusCommand(args: readonly string[]): boolean {
  return findGitCommand(args) === "status" && args.includes("--porcelain=v2");
}

function isDiffCommand(args: readonly string[]): boolean {
  return findGitCommand(args) === "diff";
}

function isNameStatusDiff(args: readonly string[]): boolean {
  return isDiffCommand(args) && args.includes("--name-status");
}

function isNumstatDiff(args: readonly string[]): boolean {
  return isDiffCommand(args) && args.includes("--numstat");
}

function ok(stdout: string): GitCommandExecutionResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function findGitCommand(args: readonly string[]): string | undefined {
  return args.find((arg) =>
    [
      "status",
      "diff",
      "rev-parse",
      "read-tree",
      "add",
      "write-tree",
      "config",
      "commit",
      "branch",
      "push",
    ].includes(arg),
  );
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface GoldenFixture {
  readonly transport: GoldenPlatformTransport;
  readonly git: DefaultGitService;
  readonly gitExecutor: GoldenGitExecutor;
  readonly gitWorkspace: {
    readonly runId: Run["id"];
    readonly filesystemRoot: string;
    readonly workingBranch: string;
  };
  readonly pullRequests: GoldenPullRequestGateway;
  readonly workspace: WorkspaceManifest;
  readonly waitForApprovalRequest: () => Promise<void>;
  readonly waitForCompletion: () => Promise<void>;
}

interface GoldenPlatformDependencies {
  readonly kernel: RuntimeKernel;
  readonly lifecycleEvents: MemoryLifecycleEventStore;
  readonly workspaceManifests: MemoryWorkspaceManifestRepository;
  readonly approvals: GoldenApprovalWaitPort;
  readonly turnArtifacts: GoldenArtifactStore;
  readonly workspace: WorkspaceManifest;
}
