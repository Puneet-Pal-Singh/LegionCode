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
import {
  assertHasParts,
  firstSequence,
  lastSequence,
} from "./transcriptUtils.js";

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
    const titleSource =
      existing?.titleSource ?? input.titleSource ?? "generated";
    const session = {
      id: input.sessionId,
      userId: input.userId,
      workspaceId: readNullableInput(
        input.workspaceId,
        existing?.workspaceId ?? null,
      ),
      taskId: task.id,
      title: existing?.title ?? input.title ?? task.title,
      titleSource,
      repository: readNullableInput(
        input.repository,
        existing?.repository ?? null,
      ),
      activeRunId: readNullableInput(
        input.activeRunId,
        existing?.activeRunId ?? null,
      ),
      mode: input.mode ?? existing?.mode ?? "build",
      status: input.status ?? existing?.status ?? "idle",
      pinnedAt: existing?.pinnedAt ?? null,
      archivedAt: existing?.archivedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies SessionRecord;

    this.sessions.set(session.id, session);
    return session;
  }

  async updateGeneratedSessionTitle(input: {
    userId: string;
    sessionId: string;
    title: string;
    titleSource: "generated";
  }): Promise<SessionRecord | null> {
    return this.updateSessionTitle(input, "generated");
  }

  async updateSessionStatus(input: {
    userId: string;
    sessionId: string;
    status: SessionRecord["status"];
  }): Promise<SessionRecord | null> {
    const session = this.readUserSession(input.userId, input.sessionId);
    if (!session) {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({
      ...session,
      status: input.status,
      updatedAt: now,
    });
  }

  async renameSessionTitle(input: {
    userId: string;
    sessionId: string;
    title: string;
    titleSource: "user";
  }): Promise<SessionRecord | null> {
    return this.updateSessionTitle(input, "user");
  }

  async pinSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const session = this.readUserSession(userId, sessionId);
    if (!session || session.archivedAt) {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({
      ...session,
      pinnedAt: now,
      updatedAt: now,
    });
  }

  async unpinSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const session = this.readUserSession(userId, sessionId);
    if (!session) {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({ ...session, pinnedAt: null, updatedAt: now });
  }

  async archiveSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const session = this.readUserSession(userId, sessionId);
    if (!session || session.archivedAt) {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({
      ...session,
      pinnedAt: null,
      archivedAt: now,
      updatedAt: now,
    });
  }

  async unarchiveSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const session = this.readUserSession(userId, sessionId);
    if (!session || !session.archivedAt) {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({ ...session, archivedAt: null, updatedAt: now });
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
      nextCursor:
        messages.length >= limit && lastMessage
          ? lastSequence(lastMessage)
          : null,
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
      .filter((session) => session.archivedAt === null)
      .filter((session) => visibleTaskIds.has(session.taskId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return { tasks, sessions };
  }

  async listArchivedSessions(userId: string): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values())
      .filter((session) => session.userId === userId)
      .filter((session) => session.archivedAt !== null)
      .sort((left, right) =>
        (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
      );
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
      workspaceId: readNullableInput(
        input.workspaceId,
        existing?.workspaceId ?? null,
      ),
      title: input.title ?? existing?.title ?? "Untitled task",
      status: existing?.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: existing?.archivedAt ?? null,
    } satisfies TaskRecord;

    this.tasks.set(task.id, task);
    return task;
  }

  private updateSessionTitle(
    input: {
      userId: string;
      sessionId: string;
      title: string;
      titleSource: SessionRecord["titleSource"];
    },
    titleSource: SessionRecord["titleSource"],
  ): SessionRecord | null {
    const session = this.readUserSession(input.userId, input.sessionId);
    if (!session) {
      return null;
    }
    if (titleSource === "generated" && session.titleSource !== "generated") {
      return null;
    }
    const now = this.clock.now().toISOString();
    return this.storeSession({
      ...session,
      title: input.title,
      titleSource,
      updatedAt: now,
    });
  }

  private readUserSession(
    userId: string,
    sessionId: string,
  ): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? session : null;
  }

  private storeSession(session: SessionRecord): SessionRecord {
    this.sessions.set(session.id, session);
    return session;
  }

  private appendMessageToStore(
    input: AppendExistingTranscriptMessageInput,
  ): TranscriptMessageRecord {
    assertHasParts(input.parts);
    const messages = this.messagesBySessionId.get(input.sessionId) ?? [];
    const dedupeKeys = this.readDedupeKeys(input.sessionId);
    const existingMessageId = dedupeKeys.get(input.dedupeKey);
    if (existingMessageId) {
      const existing = messages.find(
        (message) => message.id === existingMessageId,
      );
      if (!existing) {
        throw new Error(
          `Transcript message not found for dedupe key: ${input.dedupeKey}`,
        );
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
    this.messagesBySessionId.set(input.sessionId, [
      ...messages,
      hydratedMessage,
    ]);
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

function readNullableInput<T>(
  value: T | null | undefined,
  fallback: T | null,
): T | null {
  return value === undefined ? fallback : value;
}
