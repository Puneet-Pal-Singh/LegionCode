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
    if (!existing) {
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

  async listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter(
      (artifact) =>
        artifact.status === "stored" && artifact.expiresAt.localeCompare(now) <= 0,
    );
  }

  async listStalePendingArtifacts(cutoff: string): Promise<EditArtifactRecord[]> {
    return Array.from(this.artifacts.values()).filter(
      (artifact) =>
        artifact.status === "pending" && artifact.createdAt.localeCompare(cutoff) <= 0,
    );
  }

  async transaction<T>(
    callback: (repository: ArtifactRepository) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

function isRestorable(
  artifact: EditArtifactRecord,
  runId: string,
  userId: string,
): boolean {
  return (
    artifact.runId === runId &&
    artifact.userId === userId &&
    ["stored", "restore_failed", "restore_in_progress"].includes(
      artifact.status,
    ) &&
    hasChangedFiles(artifact.changedFiles)
  );
}

function hasChangedFiles(changedFiles: EditArtifactChangedFile[]): boolean {
  return changedFiles.length > 0;
}
