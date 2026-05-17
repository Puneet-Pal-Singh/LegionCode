import type {
  AppendRunEventInput,
  EnsureRunInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  UpdateRunStatusInput,
} from "./types.js";

export class MemoryRunRepository implements RunRepository {
  private runs = new Map<string, RunRecord>();
  private events = new Map<string, RunEventRecord[]>();

  async ensureRun(input: EnsureRunInput): Promise<RunRecord> {
    const existing = this.runs.get(input.id);
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: input.id,
      userId: input.userId,
      workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
      sessionId: input.sessionId,
      taskId: input.taskId,
      status: input.status ?? existing?.status ?? "created",
      mode: input.mode ?? existing?.mode ?? "build",
      providerId: input.providerId ?? existing?.providerId ?? null,
      modelId: input.modelId ?? existing?.modelId ?? null,
      branch: input.branch ?? existing?.branch ?? null,
      baseCommitSha: input.baseCommitSha ?? existing?.baseCommitSha ?? null,
      headCommitSha: input.headCommitSha ?? existing?.headCommitSha ?? null,
      startedAt: existing?.startedAt ?? null,
      completedAt: existing?.completedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.runs.set(input.id, record);
    return record;
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord> {
    const existing = this.runs.get(input.id);
    if (!existing) {
      throw new Error(`Run not found: ${input.id}`);
    }
    const record: RunRecord = {
      ...existing,
      status: input.status,
      startedAt: input.startedAt ?? existing.startedAt,
      completedAt: input.completedAt ?? existing.completedAt,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(input.id, record);
    return record;
  }

  async appendEvent(input: AppendRunEventInput): Promise<RunEventRecord> {
    if (!this.runs.has(input.runId)) {
      throw new Error(`Run not found: ${input.runId}`);
    }
    const runEvents = this.events.get(input.runId) ?? [];
    if (input.idempotencyKey) {
      const existing = runEvents.find((e) => e.idempotencyKey === input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const sequence = runEvents.length + 1;
    const record: RunEventRecord = {
      id: Math.random().toString(36).substring(7),
      runId: input.runId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      payload: input.payload,
      sequence,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
    };
    runEvents.push(record);
    this.events.set(input.runId, runEvents);
    return record;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    return this.events.get(runId) ?? [];
  }

  async transaction<T>(callback: (repository: RunRepository) => Promise<T>): Promise<T> {
    return await callback(this);
  }
}
