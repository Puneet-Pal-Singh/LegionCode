import type {
  ApprovalId,
  ArtifactId,
  ArtifactMetadata,
  EventCursor,
  EventId,
  EventIdempotencyKey,
  PermissionProfileId,
  ProviderId,
  Run,
  RunEvent,
  Thread,
  ThreadId,
  UserId,
  WorkerId,
  WorkspaceId,
  WorkspaceManifest,
  WorkspaceManifestId,
} from "@repo/platform-protocol";
import type {
  AppendRunEventRequest,
  CreateRunRequest,
  CreateThreadRequest,
  SubmitApprovalRequest,
} from "./types.js";

export const TEST_IDS = {
  userId: "usr_123456" as UserId,
  workspaceId: "wrk_123456" as WorkspaceId,
  threadId: "thr_123456" as ThreadId,
  runId: "run_123456" as Run["id"],
  eventId: "evt_123456" as EventId,
  cursor: "cursor_123456" as EventCursor,
  nextCursor: "cursor_abcdef" as EventCursor,
  providerId: "openai" as ProviderId,
  workerId: "worker_123456" as WorkerId,
  permissionProfileId: "perm_123456" as PermissionProfileId,
  artifactId: "art_123456" as ArtifactId,
  manifestId: "wsm_123456" as WorkspaceManifestId,
};

const TEST_TIMESTAMP = "2026-03-06T00:00:00.000Z";

export function createThreadRequest(): CreateThreadRequest {
  return {
    userId: TEST_IDS.userId,
    workspaceId: TEST_IDS.workspaceId,
    title: "Build SDK",
    metadata: { source: "test" },
  };
}

export function createThread(): Thread {
  return {
    id: TEST_IDS.threadId,
    userId: TEST_IDS.userId,
    workspaceId: TEST_IDS.workspaceId,
    title: "Build SDK",
    titleSource: "user",
    status: "active",
    pinnedAt: null,
    archivedAt: null,
    activeRunId: TEST_IDS.runId,
    activeLeafItemId: null,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    lastEventSequence: 1,
  };
}

export function createRunRequest(): CreateRunRequest {
  return {
    threadId: TEST_IDS.threadId,
    userId: TEST_IDS.userId,
    workspaceId: TEST_IDS.workspaceId,
    mode: "auto_edit",
    providerId: TEST_IDS.providerId,
    modelId: "gpt-4o" as Run["modelId"],
    workerId: TEST_IDS.workerId,
    permissionProfileId: TEST_IDS.permissionProfileId,
    input: { prompt: "Implement the SDK" },
  };
}

export function createRun(): Run {
  return {
    id: TEST_IDS.runId,
    threadId: TEST_IDS.threadId,
    userId: TEST_IDS.userId,
    workspaceId: TEST_IDS.workspaceId,
    status: "queued",
    mode: "auto_edit",
    providerId: TEST_IDS.providerId,
    modelId: "gpt-4o" as Run["modelId"],
    workerId: TEST_IDS.workerId,
    permissionProfileId: TEST_IDS.permissionProfileId,
    startedAt: null,
    completedAt: null,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    lastEventSequence: 1,
  };
}

export function createRunEvent(): RunEvent {
  const run = createRun();
  return {
    eventId: TEST_IDS.eventId,
    threadId: TEST_IDS.threadId,
    workspaceId: TEST_IDS.workspaceId,
    runId: TEST_IDS.runId,
    sequence: 1,
    cursor: TEST_IDS.cursor,
    idempotencyKey: "run.created.1" as EventIdempotencyKey,
    createdAt: TEST_TIMESTAMP,
    producer: { kind: "control_plane", id: "platform-client-sdk-test" },
    schemaVersion: 1,
    scopeType: "run",
    scopeId: TEST_IDS.runId,
    type: "run.created",
    payload: { run },
  };
}

export function createAppendRunEventRequest(): AppendRunEventRequest {
  const { eventId, sequence, cursor, createdAt, ...request } = createRunEvent();
  void eventId;
  void sequence;
  void cursor;
  void createdAt;
  return request;
}

export function createApprovalRequest(): SubmitApprovalRequest {
  return {
    runId: TEST_IDS.runId,
    approvalId: "appr_123456" as ApprovalId,
    decision: "approved",
    decidedBy: TEST_IDS.userId,
    reason: "Looks good",
  };
}

export function createApprovalEvent(): RunEvent {
  return {
    eventId: TEST_IDS.eventId,
    threadId: TEST_IDS.threadId,
    workspaceId: TEST_IDS.workspaceId,
    runId: TEST_IDS.runId,
    sequence: 1,
    cursor: TEST_IDS.cursor,
    idempotencyKey: "approval.decided.1" as EventIdempotencyKey,
    createdAt: TEST_TIMESTAMP,
    producer: { kind: "control_plane", id: "platform-client-sdk-test" },
    schemaVersion: 1,
    scopeType: "run",
    scopeId: TEST_IDS.runId,
    type: "approval.decided",
    payload: {
      approvalId: "appr_123456" as ApprovalId,
      decision: "approved",
      decidedBy: TEST_IDS.userId,
      reason: "Looks good",
    },
  };
}

export function createArtifact(): ArtifactMetadata {
  return {
    artifactId: TEST_IDS.artifactId,
    threadId: TEST_IDS.threadId,
    runId: TEST_IDS.runId,
    workspaceId: TEST_IDS.workspaceId,
    itemId: null,
    kind: "generated_file",
    label: "SDK output",
    payloadRef: {
      backend: "local_blob",
      objectKey: "artifacts/sdk-output.txt",
      uri: null,
      contentType: "text/plain",
      sizeBytes: 12,
      sha256: "a".repeat(64),
    },
    changedFiles: [],
    metadata: {},
    createdAt: TEST_TIMESTAMP,
    eventSequence: 1,
  };
}

export function createWorkspaceManifest(): WorkspaceManifest {
  return {
    manifestId: TEST_IDS.manifestId,
    workspaceId: TEST_IDS.workspaceId,
    runId: TEST_IDS.runId,
    userId: TEST_IDS.userId,
    workerId: TEST_IDS.workerId,
    permissionProfileId: TEST_IDS.permissionProfileId,
    repoOwner: "Puneet-Pal-Singh",
    repoName: "shadowbox",
    repoUrl: "https://github.com/Puneet-Pal-Singh/shadowbox",
    baseBranch: "dev",
    workingBranch: "rebuild/001-platform-sdk-v1",
    baseCommitSha: "abcdef1",
    headCommitSha: "abcdef2",
    executionLocation: "cloud_sandbox",
    filesystemRoot: "/home/sandbox/runs/run_123456",
    artifactNamespace: "runs/run_123456",
    state: "ready",
    lastError: null,
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
  };
}
