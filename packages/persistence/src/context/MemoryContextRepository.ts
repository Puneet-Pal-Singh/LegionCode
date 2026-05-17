import type {
  AddContextSourceInput,
  ContextRepository,
  ContextSnapshotRecord,
  ContextSnapshotSourceRecord,
  CreateContextSnapshotInput,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class MemoryContextRepository implements ContextRepository {
  private readonly snapshots: ContextSnapshotRecord[] = [];
  private readonly sources: ContextSnapshotSourceRecord[] = [];
  private idCounter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  async createSnapshot(
    input: CreateContextSnapshotInput,
  ): Promise<ContextSnapshotRecord> {
    const record = {
      id: this.nextId("cs"),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      snapshotKind: input.snapshotKind,
      r2ObjectKey: input.r2ObjectKey ?? null,
      payloadSizeBytes: input.payloadSizeBytes ?? null,
      tokenCount: input.tokenCount ?? null,
      triggerReason: input.triggerReason ?? null,
      sourceMessageRangeJson: input.sourceMessageRangeJson ?? null,
      summaryMessageId: input.summaryMessageId ?? null,
      replacementHistoryR2ObjectKey: input.replacementHistoryR2ObjectKey ?? null,
      usageBeforeJson: input.usageBeforeJson ?? null,
      usageAfterJson: input.usageAfterJson ?? null,
      validationJson: input.validationJson ?? null,
      modelInfoJson: input.modelInfoJson ?? null,
      mediaArtifactsJson: input.mediaArtifactsJson ?? null,
      continuityStateJson: input.continuityStateJson ?? null,
      createdAt: this.clock.now().toISOString(),
    } satisfies ContextSnapshotRecord;

    this.snapshots.push(record);
    return cloneSnapshot(record);
  }

  async addSource(
    input: AddContextSourceInput,
  ): Promise<ContextSnapshotSourceRecord> {
    if (!this.snapshots.some((s) => s.id === input.contextSnapshotId)) {
      throw new Error(`Context snapshot not found: ${input.contextSnapshotId}`);
    }

    const record = {
      id: this.nextId("css"),
      contextSnapshotId: input.contextSnapshotId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRangeJson: input.sourceRangeJson ?? null,
      createdAt: this.clock.now().toISOString(),
    } satisfies ContextSnapshotSourceRecord;

    this.sources.push(record);
    return cloneSource(record);
  }

  async listSnapshotsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<ContextSnapshotRecord[]> {
    return this.snapshots
      .filter(
        (s) =>
          s.sessionId === sessionId &&
          (!userId || s.userId === userId),
      )
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )
      .map(cloneSnapshot);
  }

  async listSourcesBySnapshot(
    snapshotId: string,
    userId?: string,
  ): Promise<ContextSnapshotSourceRecord[]> {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot || (userId && snapshot.userId !== userId)) {
      return [];
    }

    return this.sources
      .filter((s) => s.contextSnapshotId === snapshotId)
      .map(cloneSource);
  }

  async transaction<T>(
    callback: (repository: ContextRepository) => Promise<T>,
  ): Promise<T> {
    const snapshotsBefore = this.snapshots.map(cloneSnapshot);
    const sourcesBefore = this.sources.map(cloneSource);
    const idCounterBefore = this.idCounter;

    try {
      return await callback(this);
    } catch (error) {
      this.snapshots.length = 0;
      this.snapshots.push(...snapshotsBefore);
      this.sources.length = 0;
      this.sources.push(...sourcesBefore);
      this.idCounter = idCounterBefore;
      throw error;
    }
  }
}

function cloneSnapshot(record: ContextSnapshotRecord): ContextSnapshotRecord {
  return {
    ...record,
    sourceMessageRangeJson: cloneJson(record.sourceMessageRangeJson),
    usageBeforeJson: cloneJson(record.usageBeforeJson),
    usageAfterJson: cloneJson(record.usageAfterJson),
    validationJson: cloneJson(record.validationJson),
    modelInfoJson: cloneJson(record.modelInfoJson),
    mediaArtifactsJson: cloneJson(record.mediaArtifactsJson),
    continuityStateJson: cloneJson(record.continuityStateJson),
  };
}

function cloneSource(
  record: ContextSnapshotSourceRecord,
): ContextSnapshotSourceRecord {
  return {
    ...record,
    sourceRangeJson: cloneJson(record.sourceRangeJson),
  };
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
