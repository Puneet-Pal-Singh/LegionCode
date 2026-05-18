import type {
  AppendExistingTranscriptMessageInput,
  AppendTranscriptMessageInput,
  EnsureTranscriptSessionInput,
  ListSessionsResult,
  ListTranscriptInput,
  ListTranscriptResult,
  SessionRecord,
  TaskRecord,
  TranscriptMessageRecord,
  TranscriptRepository,
} from "./types.js";
import { assertHasParts, firstSequence, lastSequence } from "./transcriptUtils.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class MemoryTranscriptRepository implements TranscriptRepository {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messagesBySessionId = new Map<
    string,
    TranscriptMessageRecord[]
  >();
  private readonly messageIdByDedupeKeyBySessionId = new Map<
    string,
    Map<string, string>
  >();
  private readonly sequenceBySessionId = new Map<string, number>();
  private idCounter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  async ensureSession(
    input: EnsureTranscriptSessionInput,
  ): Promise<SessionRecord> {
    const now = this.clock.now().toISOString();
    const task = this.upsertTask(input, now);
    const existing = this.sessions.get(input.sessionId);
    const session = {
      id: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
      taskId: task.id,
      title: input.title ?? existing?.title ?? task.title,
      repository: input.repository ?? existing?.repository ?? null,
      activeRunId: input.activeRunId ?? existing?.activeRunId ?? null,
      mode: input.mode ?? existing?.mode ?? "build",
      status: input.status ?? existing?.status ?? "idle",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies SessionRecord;

    this.sessions.set(session.id, session);
    return session;
  }

  async appendMessage(
    input: AppendTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord> {
    await this.ensureSession(input);
    return this.appendMessageToStore(input);
  }

  async appendMessageToExistingSession(
    input: AppendExistingTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord> {
    if (!this.sessions.has(input.sessionId)) {
      throw new Error(`Transcript session not found: ${input.sessionId}`);
    }
    return this.appendMessageToStore(input);
  }

  async listTranscript(
    input: ListTranscriptInput,
  ): Promise<ListTranscriptResult> {
    const limit = input.limit ?? 100;
    const cursor = input.cursor ?? 0;
    const messages = this.readSessionMessages(input)
      .filter((message) =>
        message.parts.some((part) => part.sessionSequence > cursor),
      )
      .sort((left, right) => firstSequence(left) - firstSequence(right))
      .slice(0, limit);
    const lastMessage = messages[messages.length - 1];

    return {
      messages,
      nextCursor: messages.length >= limit && lastMessage ? lastSequence(lastMessage) : null,
    };
  }

  async listSessions(userId: string): Promise<ListSessionsResult> {
    const tasks = Array.from(this.tasks.values())
      .filter((task) => task.userId === userId)
      .filter((task) => task.archivedAt === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const visibleTaskIds = new Set(tasks.map((task) => task.id));
    const sessions = Array.from(this.sessions.values())
      .filter((session) => session.userId === userId)
      .filter((session) => visibleTaskIds.has(session.taskId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return { tasks, sessions };
  }

  async transaction<T>(
    callback: (repository: TranscriptRepository) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }

  private upsertTask(
    input: EnsureTranscriptSessionInput,
    now: string,
  ): TaskRecord {
    const taskId = input.taskId ?? input.sessionId;
    const existing = this.tasks.get(taskId);
    const task = {
      id: taskId,
      userId: input.userId,
      workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
      title: input.title ?? existing?.title ?? "Untitled task",
      status: existing?.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: existing?.archivedAt ?? null,
    } satisfies TaskRecord;

    this.tasks.set(task.id, task);
    return task;
  }

  private appendMessageToStore(
    input: AppendExistingTranscriptMessageInput,
  ): TranscriptMessageRecord {
    assertHasParts(input.parts);
    const messages = this.messagesBySessionId.get(input.sessionId) ?? [];
    const dedupeKeys = this.readDedupeKeys(input.sessionId);
    const existingMessageId = dedupeKeys.get(input.dedupeKey);
    if (existingMessageId) {
      const existing = messages.find((message) => message.id === existingMessageId);
      if (!existing) {
        throw new Error(`Transcript message not found for dedupe key: ${input.dedupeKey}`);
      }
      return existing;
    }

    const now = this.clock.now().toISOString();
    const message = {
      id: this.nextId("message"),
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      role: input.role,
      clientMessageId: input.clientMessageId ?? null,
      createdAt: now,
      parts: input.parts.map((part) => ({
        id: this.nextId("part"),
        messageId: "",
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        type: part.type,
        sessionSequence: this.nextSequence(input.sessionId),
        content: part.content,
        createdAt: now,
      })),
    } satisfies TranscriptMessageRecord;

    const hydratedMessage = {
      ...message,
      parts: message.parts.map((part) => ({ ...part, messageId: message.id })),
    };
    this.messagesBySessionId.set(input.sessionId, [...messages, hydratedMessage]);
    dedupeKeys.set(input.dedupeKey, hydratedMessage.id);
    return hydratedMessage;
  }

  private readSessionMessages(
    input: ListTranscriptInput,
  ): TranscriptMessageRecord[] {
    const session = this.sessions.get(input.sessionId);
    if (input.userId && session?.userId !== input.userId) {
      return [];
    }

    const messages = this.messagesBySessionId.get(input.sessionId) ?? [];
    if (!input.runId) {
      return messages;
    }
    return messages.filter((message) => message.runId === input.runId);
  }

  private nextSequence(sessionId: string): number {
    const next = (this.sequenceBySessionId.get(sessionId) ?? 0) + 1;
    this.sequenceBySessionId.set(sessionId, next);
    return next;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  private readDedupeKeys(sessionId: string): Map<string, string> {
    const existing = this.messageIdByDedupeKeyBySessionId.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, string>();
    this.messageIdByDedupeKeyBySessionId.set(sessionId, created);
    return created;
  }
}
