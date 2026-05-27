import type {
  CreateEditArtifactInput,
  EditArtifactEvent,
  EditArtifactEventType,
  EditArtifactRecord,
  EditArtifactStatus,
} from "@repo/shared-types";

export interface AppendArtifactEventInput {
  id: string;
  artifactId: string;
  runId: string;
  eventType: EditArtifactEventType;
  message: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface UpdateArtifactStatusInput {
  artifactId: string;
  userId: string;
  status: EditArtifactStatus;
  contentType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  headCommitSha?: string | null;
}

export interface UpdateArtifactReviewMetadataInput {
  artifactId: string;
  userId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  sourceTurnId?: string | null;
  captureSequence?: number;
  patchParseStatus?: string;
  patchSha256?: string | null;
  storageBackend?: "r2_postgres" | "cloudflare_artifacts";
  cfArtifactRepo?: string | null;
  cfArtifactCommitSha?: string | null;
  cfArtifactPath?: string | null;
  storageReconciliationStatus?: string | null;
}

export interface ArtifactRepository {
  createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord>;
  appendEvent(input: AppendArtifactEventInput): Promise<EditArtifactEvent>;
  updateStatus(input: UpdateArtifactStatusInput): Promise<EditArtifactRecord>;
  getLatestRestorableArtifact(
    runId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null>;
  getLatestRestorableArtifactForRun(
    runId: string,
  ): Promise<EditArtifactRecord | null>;
  getArtifactById(
    artifactId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null>;
  getArtifactByIdForRun(
    artifactId: string,
    runId: string,
  ): Promise<EditArtifactRecord | null>;
  getLatestReviewArtifact(input: {
    runId: string;
    userId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null>;
  getLatestReviewArtifactForRun(input: {
    runId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null>;
  getReviewArtifactByMessage(input: {
    runId: string;
    userId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null>;
  getReviewArtifactByMessageForRun(input: {
    runId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null>;
  updateReviewMetadata(
    input: UpdateArtifactReviewMetadataInput,
  ): Promise<EditArtifactRecord>;
  listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]>;
  listStalePendingArtifacts(cutoff: string): Promise<EditArtifactRecord[]>;
  transaction<T>(
    callback: (repository: ArtifactRepository) => Promise<T>,
  ): Promise<T>;
}

export type { CreateEditArtifactInput, EditArtifactEvent, EditArtifactRecord };
