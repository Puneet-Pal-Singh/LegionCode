import type {
  EditArtifactChangedFile,
  EditArtifactPatchObjectMetadata,
  EditArtifactRecord,
  GitStatusResponse,
  RunEvent,
  ToolCompletedEvent,
} from "@repo/shared-types";
import type { ArtifactRepository } from "@repo/persistence";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { withArtifactRepository } from "./ArtifactPersistenceFactory";

const EDIT_ARTIFACT_RETENTION_DAYS = 30;

interface CaptureAfterRunInput {
  userId: string;
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
  private readonly objectStore: EditArtifactObjectStore;

  constructor(private readonly env: Env) {
    if (!env.EDIT_ARTIFACTS) {
      throw new Error("EDIT_ARTIFACTS binding is unavailable");
    }
    this.objectStore = new EditArtifactObjectStore(env.EDIT_ARTIFACTS);
  }

  async captureAfterRunMutation(input: CaptureAfterRunInput): Promise<void> {
    const gitClient = this.createGitClient(input);
    const changedFiles = await this.resolveChangedFiles(input, gitClient);
    if (changedFiles.length === 0) {
      return;
    }

    const capturedPatch = await gitClient.capturePatch();
    if (!capturedPatch) {
      return;
    }

    await withArtifactRepository(this.env, async (repository) => {
      await this.persistCapturedArtifact(
        repository,
        input,
        changedFiles,
        capturedPatch,
      );
    });
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
    const gitChangedFiles = await this.loadChangedFilesFromGit(gitClient);
    if (input.changedFiles.length === 0) {
      return gitChangedFiles;
    }

    return mergePromptChangedFilesWithGitStats(
      input.changedFiles,
      gitChangedFiles,
    );
  }

  private async persistCapturedArtifact(
    repository: ArtifactRepository,
    input: CaptureAfterRunInput,
    changedFiles: EditArtifactChangedFile[],
    capturedPatch: CapturedPatchPayload,
  ): Promise<void> {
    const artifactId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const r2ObjectKey = this.buildPatchKey(input, artifactId);
    const artifact = await this.createPendingArtifact(repository, {
      artifactId,
      capturedAt,
      capturedPatch,
      changedFiles,
      input,
      r2ObjectKey,
    });
    await this.recordCaptureStarted(
      repository,
      artifactId,
      input.runId,
      r2ObjectKey,
      capturedAt,
    );

    const patchSha256 = await this.writePatch({
      repository,
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
    await this.markCaptureStored(
      repository,
      artifactId,
      input.userId,
      input.runId,
      changedFiles.length,
      patchSha256,
      new TextEncoder().encode(capturedPatch.patch).byteLength,
    );
  }

  private buildPatchKey(
    input: CaptureAfterRunInput,
    artifactId: string,
  ): string {
    return this.objectStore.buildPatchKey({
      userId: input.userId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      artifactId,
    });
  }

  private async createPendingArtifact(repository: ArtifactRepository, input: {
    artifactId: string;
    capturedAt: string;
    capturedPatch: CapturedPatchPayload;
    changedFiles: EditArtifactChangedFile[];
    input: CaptureAfterRunInput;
    r2ObjectKey: string;
  }): Promise<EditArtifactRecord> {
    return repository.createPendingArtifact({
      id: input.artifactId,
      userId: input.input.userId,
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
    repository: ArtifactRepository,
    artifactId: string,
    runId: string,
    r2ObjectKey: string,
    capturedAt: string,
  ): Promise<void> {
    await repository.appendEvent({
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
    repository: ArtifactRepository;
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
    await input.repository.appendEvent({
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
    repository: ArtifactRepository,
    artifactId: string,
    userId: string,
    runId: string,
    changedFileCount: number,
    patchSha256: string,
    patchSizeBytes: number,
  ): Promise<void> {
    await repository.updateStatus({
      artifactId,
      userId,
      status: "stored",
      contentType: "text/x-patch",
      sizeBytes: patchSizeBytes,
      sha256: patchSha256,
    });
    await repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "metadata_commit_succeeded",
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
      userId: string;
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

    const changedFile = extractChangedFileFromToolResult(event.payload.result);
    if (!changedFile) {
      return;
    }
    this.changedFiles.set(changedFile.path, changedFile);
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
  userId?: string;
  workspaceId?: string;
  runId: string;
  sessionId: string;
  repositoryContext?: {
    owner?: string;
    repo?: string;
    baseUrl?: string;
  };
}): EditArtifactCoordinator {
  if (!input.env.EDIT_ARTIFACTS || !input.userId || !input.workspaceId) {
    return new NoopEditArtifactCoordinator();
  }

  return new EditArtifactRunCaptureCoordinator(
    new EditArtifactCaptureService(input.env),
    {
      userId: input.userId,
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      muscleSession: input.runId,
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
    userId: input.input.userId,
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

export function mergePromptChangedFilesWithGitStats(
  promptFiles: EditArtifactChangedFile[],
  gitFiles: EditArtifactChangedFile[],
): EditArtifactChangedFile[] {
  const gitFilesByPath = new Map(gitFiles.map((file) => [file.path, file]));
  return promptFiles.map((file) => ({
    ...file,
    ...readGitStatsForPromptFile(file, gitFilesByPath.get(file.path)),
  }));
}

function readGitStatsForPromptFile(
  promptFile: EditArtifactChangedFile,
  gitFile: EditArtifactChangedFile | undefined,
): Pick<
  EditArtifactChangedFile,
  "status" | "additions" | "deletions" | "isStaged"
> {
  const hasRealGitStats =
    gitFile &&
    ((gitFile.additions ?? 0) > 0 ||
      (gitFile.deletions ?? 0) > 0 ||
      gitFile.status === "added" ||
      gitFile.status === "deleted" ||
      gitFile.status === "renamed");
  return {
    status: gitFile?.status ?? promptFile.status,
    additions: hasRealGitStats ? gitFile.additions : promptFile.additions,
    deletions: hasRealGitStats ? gitFile.deletions : promptFile.deletions,
    isStaged: gitFile?.isStaged ?? promptFile.isStaged,
  };
}

export function extractChangedFileFromToolResult(
  result: unknown,
): EditArtifactChangedFile | undefined {
  const activity = extractActivityMetadata(result);
  const filePath = getObjectProperty(activity, "filePath");
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return undefined;
  }

  return {
    path: filePath,
    status: "modified",
    additions: readNonNegativeInteger(activity, "additions"),
    deletions: readNonNegativeInteger(activity, "deletions"),
  };
}

function extractActivityMetadata(result: unknown): unknown {
  const metadata = getObjectProperty(result, "metadata");
  const activity = getObjectProperty(metadata, "activity");
  if (activity) {
    return activity;
  }

  const output = getObjectProperty(result, "output");
  const outputMetadata = getObjectProperty(output, "metadata");
  return getObjectProperty(outputMetadata, "activity");
}

function readNonNegativeInteger<K extends string>(
  value: unknown,
  key: K,
): number | undefined {
  const rawValue = getObjectProperty(value, key);
  return typeof rawValue === "number" &&
    Number.isInteger(rawValue) &&
    rawValue >= 0
    ? rawValue
    : undefined;
}

function getObjectProperty<K extends string>(value: unknown, key: K): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return (value as Record<K, unknown>)[key];
}
