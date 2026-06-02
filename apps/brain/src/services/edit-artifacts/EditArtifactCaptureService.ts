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
import { createEditArtifactStorageBackend } from "./EditArtifactStorageBackendFactory";
import {
  EditArtifactPatchParseError,
  parsePatchFileInventory,
} from "./EditArtifactPatchParser";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { withArtifactRepository } from "./ArtifactPersistenceFactory";
import type { CompositeEditArtifactStorageResult } from "./CompositeEditArtifactStorageBackend";

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
  userMessageId?: string;
  assistantMessageId?: string;
  sourceTurnId?: string;
  captureSequence?: number;
}

interface CapturedPatchPayload {
  patch: string;
  branch: string | null;
  baseCommitSha: string | null;
}

interface CaptureArtifactMetadata {
  artifactId: string;
  capturedAt: string;
  r2ObjectKey: string;
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
    const metadata = this.buildCaptureArtifactMetadata(input);
    const artifact = await this.createAndRecordPendingArtifact(
      repository,
      input,
      changedFiles,
      capturedPatch,
      metadata,
    );
    await this.writeAndFinalizeCapturedArtifact(
      repository,
      input,
      changedFiles,
      capturedPatch,
      artifact,
      metadata,
    );
  }

  private buildCaptureArtifactMetadata(
    input: CaptureAfterRunInput,
  ): CaptureArtifactMetadata {
    const artifactId = crypto.randomUUID();
    return {
      artifactId,
      capturedAt: new Date().toISOString(),
      r2ObjectKey: this.buildPatchKey(input, artifactId),
    };
  }

  private async createAndRecordPendingArtifact(
    repository: ArtifactRepository,
    input: CaptureAfterRunInput,
    changedFiles: EditArtifactChangedFile[],
    capturedPatch: CapturedPatchPayload,
    metadata: CaptureArtifactMetadata,
  ): Promise<EditArtifactRecord> {
    const artifact = await this.createPendingArtifact(repository, {
      ...metadata,
      capturedPatch,
      changedFiles,
      input,
    });
    await this.recordCaptureStarted(
      repository,
      metadata.artifactId,
      input.runId,
      metadata.r2ObjectKey,
      metadata.capturedAt,
    );
    return artifact;
  }

  private async writeAndFinalizeCapturedArtifact(
    repository: ArtifactRepository,
    input: CaptureAfterRunInput,
    changedFiles: EditArtifactChangedFile[],
    capturedPatch: CapturedPatchPayload,
    artifact: EditArtifactRecord,
    metadata: CaptureArtifactMetadata,
  ): Promise<void> {
    const storedArtifact = await this.writePatch({
      repository,
      artifact: {
        branch: artifact.branch,
        baseCommitSha: artifact.baseCommitSha,
      },
      artifactId: metadata.artifactId,
      capturedAt: metadata.capturedAt,
      changedFiles,
      input,
      patch: capturedPatch.patch,
      r2ObjectKey: metadata.r2ObjectKey,
    });
    try {
      await this.markCaptureStored(
        repository,
        metadata.artifactId,
        input.userId,
        input.runId,
        changedFiles.length,
        storedArtifact.patchSha256,
        new TextEncoder().encode(capturedPatch.patch).byteLength,
        storedArtifact,
      );
      await this.recordPatchParseStatus(
        repository,
        input,
        metadata.artifactId,
        storedArtifact.patchSha256,
        capturedPatch.patch,
        changedFiles,
        storedArtifact,
      );
    } catch (error) {
      await this.markCaptureFailed(
        repository,
        metadata.artifactId,
        input.userId,
        input.runId,
        error,
      );
      throw error;
    }
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

  private async createPendingArtifact(
    repository: ArtifactRepository,
    input: {
      artifactId: string;
      capturedAt: string;
      capturedPatch: CapturedPatchPayload;
      changedFiles: EditArtifactChangedFile[];
      input: CaptureAfterRunInput;
      r2ObjectKey: string;
    },
  ): Promise<EditArtifactRecord> {
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
      userMessageId: input.input.userMessageId ?? null,
      assistantMessageId: input.input.assistantMessageId ?? null,
      sourceTurnId: input.input.sourceTurnId ?? null,
      captureSequence: input.input.captureSequence ?? 0,
      patchParseStatus: "unknown",
      patchSha256: null,
      storageBackend: "r2_postgres",
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
  }): Promise<CompositeEditArtifactStorageResult> {
    const storageBackend = createEditArtifactStorageBackend(this.env);
    const storedArtifact = (await storageBackend.writeArtifact({
      artifactId: input.artifactId,
      userId: input.input.userId,
      workspaceId: input.input.workspaceId,
      runId: input.input.runId,
      sessionId: input.input.sessionId,
      objectKey: input.r2ObjectKey,
      patch: input.patch,
      metadata: buildPatchMetadata(input, await sha256Hex(input.patch)),
    })) as CompositeEditArtifactStorageResult;
    await input.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId: input.artifactId,
      runId: input.input.runId,
      eventType: "r2_write_succeeded",
      message: "Edit artifact patch written to R2",
      metadata: { patchSha256: storedArtifact.patchSha256 },
    });
    if (storedArtifact.secondaryError) {
      await input.repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId: input.artifactId,
        runId: input.input.runId,
        eventType: "cf_artifacts_write_failed",
        message: "Cloudflare Artifacts secondary write failed",
        metadata: { error: storedArtifact.secondaryError },
      });
    } else if (storedArtifact.secondary) {
      await input.repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId: input.artifactId,
        runId: input.input.runId,
        eventType: "cf_artifacts_write_succeeded",
        message: "Cloudflare Artifacts secondary write succeeded",
        metadata: {
          cfArtifactRepo: storedArtifact.secondary.cfRepo ?? null,
          cfArtifactCommitSha: storedArtifact.secondary.cfCommitSha ?? null,
          cfArtifactPath: storedArtifact.secondary.cfPath ?? null,
        },
      });
    }
    return storedArtifact;
  }

  private async markCaptureStored(
    repository: ArtifactRepository,
    artifactId: string,
    userId: string,
    runId: string,
    changedFileCount: number,
    patchSha256: string,
    patchSizeBytes: number,
    storedArtifact: CompositeEditArtifactStorageResult,
  ): Promise<void> {
    await repository.updateStatus({
      artifactId,
      userId,
      status: storedArtifact.secondaryError
        ? "secondary_write_failed"
        : storedArtifact.secondary
          ? "stored_with_secondary"
          : "stored",
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
      metadata: {
        changedFileCount,
        secondaryBackend: storedArtifact.secondary?.backend ?? null,
      },
    });
  }

  private async recordPatchParseStatus(
    repository: ArtifactRepository,
    input: CaptureAfterRunInput,
    artifactId: string,
    patchSha256: string,
    patch: string,
    changedFiles: EditArtifactChangedFile[],
    storedArtifact: CompositeEditArtifactStorageResult,
  ): Promise<void> {
    const parseStatus = resolvePatchParseStatus(patch, changedFiles);
    await repository.updateReviewMetadata({
      artifactId,
      userId: input.userId,
      userMessageId: input.userMessageId ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      captureSequence: input.captureSequence ?? 0,
      patchParseStatus: parseStatus,
      patchSha256,
      storageBackend: storedArtifact.secondary
        ? "cloudflare_artifacts"
        : "r2_postgres",
      cfArtifactRepo: storedArtifact.secondary?.cfRepo ?? null,
      cfArtifactCommitSha: storedArtifact.secondary?.cfCommitSha ?? null,
      cfArtifactPath: storedArtifact.secondary?.cfPath ?? null,
    });
    await repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId: input.runId,
      eventType:
        parseStatus === "parsed"
          ? "patch_parse_succeeded"
          : "patch_parse_failed",
      message:
        parseStatus === "parsed"
          ? "Edit artifact patch parsed successfully"
          : parseStatus === "corrupt"
            ? "Edit artifact patch could not be parsed"
            : "Edit artifact patch inventory did not match captured files",
      metadata: { patchParseStatus: parseStatus },
    });
  }

  private async markCaptureFailed(
    repository: ArtifactRepository,
    artifactId: string,
    userId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Unknown capture failure";
    try {
      await repository.updateStatus({
        artifactId,
        userId,
        status: "capture_failed",
      });
      await repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId,
        runId,
        eventType: "capture_failed",
        message: "Edit artifact capture failed after patch write",
        metadata: { error: message },
      });
    } catch (compensationError) {
      console.warn("[edit-artifacts/capture] compensation failed", {
        artifactId,
        error: compensationError,
      });
    }
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

interface EditArtifactCapturePort {
  captureAfterRunMutation(input: CaptureAfterRunInput): Promise<void>;
}

interface EditArtifactMessageContext {
  userMessageId?: string;
  assistantMessageId?: string;
  sourceTurnId?: string;
}

interface EditArtifactCoordinator {
  handleEvent(event: RunEvent): void;
  setMessageContext(context: EditArtifactMessageContext): void;
  waitForPendingCapture(): Promise<void>;
}

export class EditArtifactRunCaptureCoordinator implements EditArtifactCoordinator {
  private readonly changedFiles = new Map<string, EditArtifactChangedFile>();
  private captureInFlight: Promise<void> = Promise.resolve();
  private captureSequence = 0;
  private runCompleted = false;
  private captured = false;
  private messageContext: EditArtifactMessageContext = {};

  constructor(
    private readonly service: EditArtifactCapturePort,
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
      this.runCompleted = true;
    }
  }

  setMessageContext(context: EditArtifactMessageContext): void {
    this.messageContext = {
      ...this.messageContext,
      ...removeEmptyMessageContextFields(context),
    };
  }

  async waitForPendingCapture(): Promise<void> {
    if (this.runCompleted && !this.captured) {
      this.captured = true;
      this.captureInFlight = this.captureInFlight
        .then(() => this.capture())
        .catch((error) => {
          console.warn("[edit-artifacts/capture] failed", error);
        });
    }
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
    this.captureSequence += 1;
    await this.service.captureAfterRunMutation({
      ...this.context,
      ...this.messageContext,
      changedFiles: Array.from(this.changedFiles.values()),
      captureSequence: this.captureSequence,
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

  setMessageContext(): void {
    return;
  }

  async waitForPendingCapture(): Promise<void> {
    return;
  }
}

function removeEmptyMessageContextFields(
  context: EditArtifactMessageContext,
): EditArtifactMessageContext {
  return {
    userMessageId: normalizeOptionalMessageId(context.userMessageId),
    assistantMessageId: normalizeOptionalMessageId(context.assistantMessageId),
    sourceTurnId: normalizeOptionalMessageId(context.sourceTurnId),
  };
}

function normalizeOptionalMessageId(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    userMessageId: input.input.userMessageId ?? null,
    assistantMessageId: input.input.assistantMessageId ?? null,
    sourceTurnId: input.input.sourceTurnId ?? null,
    captureSequence: input.input.captureSequence ?? 0,
    patchParseStatus: "unknown",
    storageBackend: "r2_postgres",
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

function resolvePatchParseStatus(
  patch: string,
  changedFiles: EditArtifactChangedFile[],
): "parsed" | "mismatch" | "corrupt" {
  try {
    const inventory = parsePatchFileInventory(patch);
    const inventoryPaths = new Set(inventory.map((file) => file.path));
    const hasAllCapturedFiles = changedFiles.every((file) =>
      inventoryPaths.has(file.path),
    );
    return hasAllCapturedFiles ? "parsed" : "mismatch";
  } catch (error) {
    if (error instanceof EditArtifactPatchParseError) {
      return "corrupt";
    }
    throw error;
  }
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
