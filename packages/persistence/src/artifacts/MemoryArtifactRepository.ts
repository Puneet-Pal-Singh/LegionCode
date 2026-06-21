import {
  CreateEditArtifactInputSchema,
  EditArtifactEventSchema,
  EditArtifactEventTypeSchema,
  EditArtifactRecordSchema,
  type EditArtifactChangedFile,
  type EditArtifactEvent,
  type EditArtifactRecord,
} from "@repo/shared-types";
import type {
  AppendArtifactEventInput,
  ArtifactRepository,
  CreateEditArtifactInput,
  UpdateArtifactReviewMetadataInput,
  UpdateArtifactStatusInput,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class MemoryArtifactRepository implements ArtifactRepository {
  private readonly artifacts = new Map<string, EditArtifactRecord>();
  private readonly events = new Map<string, EditArtifactEvent[]>();

  constructor(private readonly clock: Clock = systemClock) {}

  async createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord> {
    const parsed = CreateEditArtifactInputSchema.parse(input);
    const now = this.clock.now().toISOString();
    const existing = this.artifacts.get(parsed.id);
    const record = EditArtifactRecordSchema.parse({
      ...parsed,
      changedFileCount: parsed.changedFiles.length,
      headCommitSha: existing?.headCommitSha ?? null,
      contentType: existing?.contentType ?? null,
      sizeBytes: existing?.sizeBytes ?? null,
      sha256: existing?.sha256 ?? null,
      userMessageId: parsed.userMessageId ?? existing?.userMessageId ?? null,
      assistantMessageId:
        parsed.assistantMessageId ?? existing?.assistantMessageId ?? null,
      sourceTurnId: parsed.sourceTurnId ?? existing?.sourceTurnId ?? null,
      captureSequence: parsed.captureSequence ?? existing?.captureSequence ?? 0,
      patchParseStatus:
        parsed.patchParseStatus ?? existing?.patchParseStatus ?? "unknown",
      patchSha256: parsed.patchSha256 ?? existing?.patchSha256 ?? null,
      storageBackend:
        parsed.storageBackend ?? existing?.storageBackend ?? "r2_postgres",
      cfArtifactRepo: parsed.cfArtifactRepo ?? existing?.cfArtifactRepo ?? null,
      cfArtifactCommitSha:
        parsed.cfArtifactCommitSha ?? existing?.cfArtifactCommitSha ?? null,
      cfArtifactPath: parsed.cfArtifactPath ?? existing?.cfArtifactPath ?? null,
      storageReconciliationStatus:
        parsed.storageReconciliationStatus ??
        existing?.storageReconciliationStatus ??
        null,
      status: existing?.status ?? "pending",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.artifacts.set(record.id, record);
    return record;
  }

  async appendEvent(
    input: AppendArtifactEventInput,
  ): Promise<EditArtifactEvent> {
    const event = EditArtifactEventSchema.parse({
      id: input.id,
      artifactId: input.artifactId,
      runId: input.runId,
      eventType: EditArtifactEventTypeSchema.parse(input.eventType),
      message: input.message,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt ?? this.clock.now().toISOString(),
    });
    const artifactEvents = this.events.get(input.artifactId) ?? [];
    artifactEvents.push(event);
    this.events.set(input.artifactId, artifactEvents);
    return event;
  }

  async updateStatus(
    input: UpdateArtifactStatusInput,
  ): Promise<EditArtifactRecord> {
    const existing = this.artifacts.get(input.artifactId);
    if (!existing || existing.userId !== input.userId) {
      throw new Error(`Artifact not found: ${input.artifactId}`);
    }
    const record = EditArtifactRecordSchema.parse({
      ...existing,
      contentType: input.contentType ?? existing.contentType,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      sha256: input.sha256 ?? existing.sha256,
      headCommitSha: input.headCommitSha ?? existing.headCommitSha,
      status: input.status,
      updatedAt: this.clock.now().toISOString(),
    });
    this.artifacts.set(record.id, record);
    return record;
  }

  async getLatestRestorableArtifact(
    runId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null> {
    const matches = Array.from(this.artifacts.values())
      .filter((artifact) => isRestorable(artifact, runId, userId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0] ?? null;
  }

  async getLatestRestorableArtifactForRun(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const matches = Array.from(this.artifacts.values())
      .filter((artifact) => isRestorableForRun(artifact, runId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0] ?? null;
  }

  async listRestorableArtifacts(input: {
    runId: string;
    userId?: string;
  }): Promise<EditArtifactRecord[]> {
    return Array.from(this.artifacts.values())
      .filter((artifact) =>
        input.userId
          ? isRestorable(artifact, input.runId, input.userId)
          : isRestorableForRun(artifact, input.runId),
      )
      .sort(compareRestoreOrder);
  }

  async getArtifactById(
    artifactId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact?.userId === userId ? artifact : null;
  }

  async getArtifactByIdForRun(
    artifactId: string,
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact?.runId === runId ? artifact : null;
  }

  async getLatestReviewArtifact(input: {
    runId: string;
    userId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null> {
    return this.findLatestReviewArtifact((artifact) => {
      return (
        artifact.runId === input.runId &&
        artifact.userId === input.userId &&
        (!input.sessionId || artifact.sessionId === input.sessionId)
      );
    });
  }

  async getLatestReviewArtifactForRun(input: {
    runId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null> {
    return this.findLatestReviewArtifact((artifact) => {
      return (
        artifact.runId === input.runId &&
        (!input.sessionId || artifact.sessionId === input.sessionId)
      );
    });
  }

  async getReviewArtifactByMessage(input: {
    runId: string;
    userId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null> {
    return this.findLatestReviewArtifact((artifact) => {
      return (
        artifact.runId === input.runId &&
        artifact.userId === input.userId &&
        artifact.assistantMessageId === input.assistantMessageId
      );
    });
  }

  async getReviewArtifactByMessageForRun(input: {
    runId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null> {
    return this.findLatestReviewArtifact((artifact) => {
      return (
        artifact.runId === input.runId &&
        artifact.assistantMessageId === input.assistantMessageId
      );
    });
  }

  async updateReviewMetadata(input: {
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
  }): Promise<EditArtifactRecord> {
    const existing = await this.getArtifactById(input.artifactId, input.userId);
    if (!existing) {
      throw new Error(`Artifact not found: ${input.artifactId}`);
    }

    const record = EditArtifactRecordSchema.parse({
      ...existing,
      userMessageId: readReviewMetadataField(input, "userMessageId", existing),
      assistantMessageId: readReviewMetadataField(
        input,
        "assistantMessageId",
        existing,
      ),
      sourceTurnId: readReviewMetadataField(input, "sourceTurnId", existing),
      captureSequence:
        readReviewMetadataField(input, "captureSequence", existing) ?? 0,
      patchParseStatus:
        readReviewMetadataField(input, "patchParseStatus", existing) ??
        "unknown",
      patchSha256: readReviewMetadataField(input, "patchSha256", existing),
      storageBackend:
        readReviewMetadataField(input, "storageBackend", existing) ??
        "r2_postgres",
      cfArtifactRepo: readReviewMetadataField(
        input,
        "cfArtifactRepo",
        existing,
      ),
      cfArtifactCommitSha: readReviewMetadataField(
        input,
        "cfArtifactCommitSha",
        existing,
      ),
      cfArtifactPath: readReviewMetadataField(
        input,
        "cfArtifactPath",
        existing,
      ),
      storageReconciliationStatus:
        readReviewMetadataField(
          input,
          "storageReconciliationStatus",
          existing,
        ) ?? null,
      updatedAt: this.clock.now().toISOString(),
    });
    this.artifacts.set(record.id, record);
    return record;
  }

  async listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter(
      (artifact) =>
        artifact.status === "stored" &&
        artifact.expiresAt.localeCompare(now) <= 0,
    );
  }

  async listStalePendingArtifacts(
    cutoff: string,
  ): Promise<EditArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter(
      (artifact) =>
        artifact.status === "pending" &&
        artifact.createdAt.localeCompare(cutoff) <= 0,
    );
  }

  async transaction<T>(
    callback: (repository: ArtifactRepository) => Promise<T>,
  ): Promise<T> {
    const artifactsSnapshot = new Map(this.artifacts);
    const eventsSnapshot = new Map(
      Array.from(this.events.entries()).map(([artifactId, events]) => [
        artifactId,
        [...events],
      ]),
    );
    try {
      return await callback(this);
    } catch (error) {
      this.artifacts.clear();
      this.events.clear();
      for (const [artifactId, artifact] of artifactsSnapshot) {
        this.artifacts.set(artifactId, artifact);
      }
      for (const [artifactId, events] of eventsSnapshot) {
        this.events.set(artifactId, events);
      }
      throw error;
    }
  }

  private findLatestReviewArtifact(
    predicate: (artifact: EditArtifactRecord) => boolean,
  ): EditArtifactRecord | null {
    const matches = Array.from(this.artifacts.values())
      .filter((artifact) => predicate(artifact) && isReviewable(artifact))
      .sort(compareReviewArtifacts);
    return matches[0] ?? null;
  }
}

type ReviewMetadataKey = Extract<
  keyof UpdateArtifactReviewMetadataInput,
  keyof EditArtifactRecord
>;

function readReviewMetadataField<K extends ReviewMetadataKey>(
  input: UpdateArtifactReviewMetadataInput,
  key: K,
  existing: EditArtifactRecord,
): UpdateArtifactReviewMetadataInput[K] | EditArtifactRecord[K] {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? input[key]
    : existing[key];
}

function isRestorable(
  artifact: EditArtifactRecord,
  runId: string,
  userId: string,
): boolean {
  return isRestorableForRun(artifact, runId) && artifact.userId === userId;
}

function isRestorableForRun(
  artifact: EditArtifactRecord,
  runId: string,
): boolean {
  return (
    artifact.runId === runId &&
    [
      "stored",
      "stored_with_secondary",
      "secondary_write_failed",
      "restored",
      "restore_failed",
      "restore_in_progress",
      "requires_user_resolution",
    ].includes(artifact.status) &&
    hasChangedFiles(artifact.changedFiles)
  );
}

function compareRestoreOrder(
  left: EditArtifactRecord,
  right: EditArtifactRecord,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    (left.captureSequence ?? 0) - (right.captureSequence ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function hasChangedFiles(changedFiles: EditArtifactChangedFile[]): boolean {
  return changedFiles.length > 0;
}

function isReviewable(artifact: EditArtifactRecord): boolean {
  return (
    [
      "stored",
      "stored_with_secondary",
      "secondary_write_failed",
      "restored",
      "requires_user_resolution",
    ].includes(artifact.status) && hasChangedFiles(artifact.changedFiles)
  );
}

function compareReviewArtifacts(
  left: EditArtifactRecord,
  right: EditArtifactRecord,
): number {
  const sequenceDelta =
    (right.captureSequence ?? 0) - (left.captureSequence ?? 0);
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  return right.createdAt.localeCompare(left.createdAt);
}
