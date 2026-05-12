import type {
  EditArtifactChangedFile,
  EditArtifactPatchObjectMetadata,
  EditArtifactRecord,
  GitStatusResponse,
  RunEvent,
  ToolCompletedEvent,
} from "@repo/shared-types";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { ensureByokSchemaReady } from "../byok/ByokSchemaService";

const EDIT_ARTIFACT_RETENTION_DAYS = 30;

interface CaptureAfterRunInput {
  runId: string;
  sessionId: string;
  workspaceId: string;
  muscleSession: string;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  changedFiles: EditArtifactChangedFile[];
}

interface CapturedPatchPayload {
  patch: string;
  branch: string | null;
  baseCommitSha: string | null;
}

export class EditArtifactCaptureService {
  private readonly repository: D1EditArtifactRepository;
  private readonly objectStore: EditArtifactObjectStore;

  constructor(private readonly env: Env) {
    this.repository = new D1EditArtifactRepository(env.BYOK_DB);
    if (!env.EDIT_ARTIFACTS) {
      throw new Error("EDIT_ARTIFACTS binding is unavailable");
    }
    this.objectStore = new EditArtifactObjectStore(env.EDIT_ARTIFACTS);
  }

  async captureAfterRunMutation(input: CaptureAfterRunInput): Promise<void> {
    await ensureByokSchemaReady(this.env.BYOK_DB);
    const gitClient = this.createGitClient(input);
    const changedFiles = await this.resolveChangedFiles(input, gitClient);
    if (changedFiles.length === 0) {
      return;
    }

    const capturedPatch = await gitClient.capturePatch();
    if (!capturedPatch) {
      return;
    }

    await this.persistCapturedArtifact(input, changedFiles, capturedPatch);
  }

  private createGitClient(
    input: CaptureAfterRunInput,
  ): SecureGitArtifactClient {
    return new SecureGitArtifactClient(
      this.env,
      input.muscleSession,
      input.runId,
    );
  }

  private async resolveChangedFiles(
    input: CaptureAfterRunInput,
    gitClient: SecureGitArtifactClient,
  ): Promise<EditArtifactChangedFile[]> {
    return input.changedFiles.length > 0
      ? input.changedFiles
      : await this.loadChangedFilesFromGit(gitClient);
  }

  private async persistCapturedArtifact(
    input: CaptureAfterRunInput,
    changedFiles: EditArtifactChangedFile[],
    capturedPatch: CapturedPatchPayload,
  ): Promise<void> {
    const artifactId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const r2ObjectKey = this.buildPatchKey(input, artifactId);
    const artifact = await this.createPendingArtifact({
      artifactId,
      capturedAt,
      capturedPatch,
      changedFiles,
      input,
      r2ObjectKey,
    });
    await this.recordCaptureStarted(
      artifactId,
      input.runId,
      r2ObjectKey,
      capturedAt,
    );

    const patchSha256 = await this.writePatch({
      artifact: {
        branch: artifact.branch,
        baseCommitSha: artifact.baseCommitSha,
      },
      artifactId,
      capturedAt,
      changedFiles,
      input,
      patch: capturedPatch.patch,
      r2ObjectKey,
    });
    await this.markCaptureStored(artifactId, input.runId, changedFiles.length);
  }

  private buildPatchKey(
    input: CaptureAfterRunInput,
    artifactId: string,
  ): string {
    return this.objectStore.buildPatchKey({
      workspaceId: input.workspaceId,
      runId: input.runId,
      artifactId,
    });
  }

  private async createPendingArtifact(input: {
    artifactId: string;
    capturedAt: string;
    capturedPatch: CapturedPatchPayload;
    changedFiles: EditArtifactChangedFile[];
    input: CaptureAfterRunInput;
    r2ObjectKey: string;
  }): Promise<EditArtifactRecord> {
    return this.repository.createPendingArtifact({
      id: input.artifactId,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      workspaceId: input.input.workspaceId,
      repoOwner: input.input.repoOwner,
      repoName: input.input.repoName,
      repoUrl: input.input.repoUrl,
      branch: input.capturedPatch.branch,
      baseCommitSha: input.capturedPatch.baseCommitSha,
      artifactKind: "git_patch",
      r2ObjectKey: input.r2ObjectKey,
      changedFiles: input.changedFiles,
      expiresAt: addDays(input.capturedAt, EDIT_ARTIFACT_RETENTION_DAYS),
    });
  }

  private async recordCaptureStarted(
    artifactId: string,
    runId: string,
    r2ObjectKey: string,
    capturedAt: string,
  ): Promise<void> {
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "capture_started",
      message: "Edit artifact capture started",
      metadata: { r2ObjectKey },
      createdAt: capturedAt,
    });
  }

  private async writePatch(input: {
    artifact: { branch: string | null; baseCommitSha: string | null };
    artifactId: string;
    capturedAt: string;
    changedFiles: EditArtifactChangedFile[];
    input: CaptureAfterRunInput;
    patch: string;
    r2ObjectKey: string;
  }): Promise<string> {
    const patchSha256 = await sha256Hex(input.patch);
    await this.objectStore.writePatch({
      key: input.r2ObjectKey,
      patch: input.patch,
      metadata: buildPatchMetadata(input, patchSha256),
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId: input.artifactId,
      runId: input.input.runId,
      eventType: "r2_write_succeeded",
      message: "Edit artifact patch written to R2",
      metadata: { patchSha256 },
    });
    return patchSha256;
  }

  private async markCaptureStored(
    artifactId: string,
    runId: string,
    changedFileCount: number,
  ): Promise<void> {
    await this.repository.updateStatus({ artifactId, status: "stored" });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "d1_commit_succeeded",
      message: "Edit artifact metadata committed",
      metadata: { changedFileCount },
    });
  }

  private async loadChangedFilesFromGit(
    gitClient: SecureGitArtifactClient,
  ): Promise<EditArtifactChangedFile[]> {
    const status = await gitClient.getStatus();
    if (!status) {
      return [];
    }
    return status.files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isStaged: file.isStaged,
    }));
  }
}

interface EditArtifactCoordinator {
  handleEvent(event: RunEvent): void;
  waitForPendingCapture(): Promise<void>;
}

export class EditArtifactRunCaptureCoordinator implements EditArtifactCoordinator {
  private readonly changedFiles = new Map<string, EditArtifactChangedFile>();
  private captureInFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: EditArtifactCaptureService,
    private readonly context: {
      runId: string;
      sessionId: string;
      workspaceId: string;
      muscleSession: string;
      repoOwner: string | null;
      repoName: string | null;
      repoUrl: string | null;
    },
  ) {}

  handleEvent(event: RunEvent): void {
    if (event.type === RUN_EVENT_TYPES.TOOL_COMPLETED) {
      this.recordMutation(event);
    }

    if (event.type === RUN_EVENT_TYPES.RUN_COMPLETED) {
      this.captureInFlight = this.captureInFlight
        .then(() => this.capture())
        .catch((error) => {
          console.warn("[edit-artifacts/capture] failed", error);
        });
    }
  }

  async waitForPendingCapture(): Promise<void> {
    await this.captureInFlight;
  }

  private recordMutation(event: ToolCompletedEvent): void {
    if (event.payload.toolName !== "write_file") {
      return;
    }

    const filePath = extractFilePathFromToolResult(event.payload.result);
    if (!filePath) {
      return;
    }
    this.changedFiles.set(filePath, {
      path: filePath,
      status: "modified",
    });
  }

  private async capture(): Promise<void> {
    await this.service.captureAfterRunMutation({
      ...this.context,
      changedFiles: Array.from(this.changedFiles.values()),
    });
  }
}

export function createEditArtifactCoordinator(input: {
  env: Env;
  runId: string;
  sessionId: string;
  repositoryContext?: {
    owner?: string;
    repo?: string;
    baseUrl?: string;
  };
}): EditArtifactCoordinator {
  if (!input.env.EDIT_ARTIFACTS) {
    return new NoopEditArtifactCoordinator();
  }

  return new EditArtifactRunCaptureCoordinator(
    new EditArtifactCaptureService(input.env),
    {
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: resolveWorkspaceId(input),
      muscleSession: input.sessionId || input.runId,
      repoOwner: input.repositoryContext?.owner ?? null,
      repoName: input.repositoryContext?.repo ?? null,
      repoUrl: input.repositoryContext?.baseUrl ?? null,
    },
  );
}

class NoopEditArtifactCoordinator implements EditArtifactCoordinator {
  handleEvent(): void {
    return;
  }

  async waitForPendingCapture(): Promise<void> {
    return;
  }
}

export function changedFilesFromStatus(
  status: GitStatusResponse,
): EditArtifactChangedFile[] {
  return status.gitAvailable
    ? status.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        isStaged: file.isStaged,
      }))
    : [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function resolveWorkspaceId(input: {
  sessionId: string;
  repositoryContext?: { owner?: string; repo?: string };
}): string {
  const owner = input.repositoryContext?.owner?.trim();
  const repo = input.repositoryContext?.repo?.trim();
  return owner && repo ? `${owner}/${repo}` : input.sessionId;
}

function buildPatchMetadata(
  input: {
    artifact: { branch: string | null; baseCommitSha: string | null };
    artifactId: string;
    capturedAt: string;
    changedFiles: EditArtifactChangedFile[];
    input: CaptureAfterRunInput;
  },
  patchSha256: string,
): EditArtifactPatchObjectMetadata {
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    runId: input.input.runId,
    sessionId: input.input.sessionId,
    workspaceId: input.input.workspaceId,
    repoOwner: input.input.repoOwner,
    repoName: input.input.repoName,
    branch: input.artifact.branch,
    baseCommitSha: input.artifact.baseCommitSha,
    patchSha256,
    changedFiles: input.changedFiles,
    capturedAt: input.capturedAt,
  };
}

function extractFilePathFromToolResult(result: unknown): string | undefined {
  const output = getObjectProperty(result, "output");
  const metadata = getObjectProperty(output, "metadata");
  const activity = getObjectProperty(metadata, "activity");
  const filePath = getObjectProperty(activity, "filePath");
  return typeof filePath === "string" && filePath.trim().length > 0
    ? filePath
    : undefined;
}

function getObjectProperty<K extends string>(value: unknown, key: K): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return (value as Record<K, unknown>)[key];
}
