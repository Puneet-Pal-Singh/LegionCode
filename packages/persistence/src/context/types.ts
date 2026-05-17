import type { JsonValue } from "@repo/shared-types";

export interface ContextSnapshotRecord {
  id: string;
  userId: string;
  sessionId: string;
  runId: string | null;
  snapshotKind: string;
  r2ObjectKey: string | null;
  payloadSizeBytes: number | null;
  tokenCount: number | null;
  triggerReason: string | null;
  sourceMessageRangeJson: JsonValue | null;
  summaryMessageId: string | null;
  replacementHistoryR2ObjectKey: string | null;
  usageBeforeJson: JsonValue | null;
  usageAfterJson: JsonValue | null;
  validationJson: JsonValue | null;
  modelInfoJson: JsonValue | null;
  mediaArtifactsJson: JsonValue | null;
  continuityStateJson: JsonValue | null;
  createdAt: string;
}

export interface ContextSnapshotSourceRecord {
  id: string;
  contextSnapshotId: string;
  sourceType: string;
  sourceId: string;
  sourceRangeJson: JsonValue | null;
  createdAt: string;
}

export interface CreateContextSnapshotInput {
  userId: string;
  sessionId: string;
  runId?: string | null;
  snapshotKind: string;
  r2ObjectKey?: string | null;
  payloadSizeBytes?: number | null;
  tokenCount?: number | null;
  triggerReason?: string | null;
  sourceMessageRangeJson?: JsonValue | null;
  summaryMessageId?: string | null;
  replacementHistoryR2ObjectKey?: string | null;
  usageBeforeJson?: JsonValue | null;
  usageAfterJson?: JsonValue | null;
  validationJson?: JsonValue | null;
  modelInfoJson?: JsonValue | null;
  mediaArtifactsJson?: JsonValue | null;
  continuityStateJson?: JsonValue | null;
}

export interface AddContextSourceInput {
  contextSnapshotId: string;
  sourceType: string;
  sourceId: string;
  sourceRangeJson?: JsonValue | null;
}

export interface ContextRepository {
  createSnapshot(input: CreateContextSnapshotInput): Promise<ContextSnapshotRecord>;
  addSource(input: AddContextSourceInput): Promise<ContextSnapshotSourceRecord>;
  listSnapshotsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<ContextSnapshotRecord[]>;
  listSourcesBySnapshot(
    snapshotId: string,
    userId?: string,
  ): Promise<ContextSnapshotSourceRecord[]>;
  transaction<T>(
    callback: (repository: ContextRepository) => Promise<T>,
  ): Promise<T>;
}
