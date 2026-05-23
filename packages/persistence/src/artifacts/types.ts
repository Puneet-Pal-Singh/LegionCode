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
  listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]>;
  listStalePendingArtifacts(cutoff: string): Promise<EditArtifactRecord[]>;
  transaction<T>(
    callback: (repository: ArtifactRepository) => Promise<T>,
  ): Promise<T>;
}

export type { CreateEditArtifactInput, EditArtifactEvent, EditArtifactRecord };
