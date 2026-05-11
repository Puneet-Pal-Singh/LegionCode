import type {
  EditArtifactChangedFile,
  EditArtifactPatchObjectMetadata,
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

  async captureAfterRunMutation(input: {
    runId: string;
    sessionId: string;
    workspaceId: string;
    muscleSession: string;
    repoOwner: string | null;
    repoName: string | null;
    repoUrl: string | null;
    changedFiles: EditArtifactChangedFile[];
  }): Promise<void> {
    await ensureByokSchemaReady(this.env.BYOK_DB);
    const gitClient = new SecureGitArtifactClient(
      this.env,
      input.muscleSession,
      input.runId,
    );
    const changedFiles =
      input.changedFiles.length > 0
        ? input.changedFiles
        : await this.loadChangedFilesFromGit(gitClient);
    if (changedFiles.length === 0) {
      return;
    }

    const capturedPatch = await gitClient.capturePatch();
    if (!capturedPatch) {
      return;
    }

    const artifactId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const r2ObjectKey = this.objectStore.buildPatchKey({
      workspaceId: input.workspaceId,
      runId: input.runId,
      artifactId,
    });
    const artifact = await this.repository.createPendingArtifact({
      id: artifactId,
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      repoUrl: input.repoUrl,
      branch: capturedPatch.branch,
      baseCommitSha: capturedPatch.baseCommitSha,
      artifactKind: "git_patch",
      r2ObjectKey,
      changedFiles,
      expiresAt: addDays(capturedAt, EDIT_ARTIFACT_RETENTION_DAYS),
    });

    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId: input.runId,
      eventType: "capture_started",
      message: "Edit artifact capture started",
      metadata: { r2ObjectKey },
      createdAt: capturedAt,
    });

    const patchSha256 = await sha256Hex(capturedPatch.patch);
    const metadata: EditArtifactPatchObjectMetadata = {
      schemaVersion: 1,
      artifactId,
      runId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      branch: artifact.branch,
      baseCommitSha: artifact.baseCommitSha,
      patchSha256,
      changedFiles,
      capturedAt,
    };
    await this.objectStore.writePatch({
      key: r2ObjectKey,
      patch: capturedPatch.patch,
      metadata,
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId: input.runId,
      eventType: "r2_write_succeeded",
      message: "Edit artifact patch written to R2",
      metadata: { patchSha256 },
    });

    await this.repository.updateStatus({ artifactId, status: "stored" });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId: input.runId,
      eventType: "d1_commit_succeeded",
      message: "Edit artifact metadata committed",
      metadata: { changedFileCount: changedFiles.length },
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

    const result = event.payload.result as {
      output?: { metadata?: { activity?: { filePath?: unknown } } };
    };
    const filePath = result?.output?.metadata?.activity?.filePath;
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
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
