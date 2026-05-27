import {
  CHAT_TITLE_SOURCES,
  type ChatTitleSource,
  type JsonValue,
} from "@repo/shared-types";

export const TASK_STATUSES = ["active", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SESSION_STATUSES = [
  "idle",
  "running",
  "completed",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type TranscriptMessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_PART_TYPES = [
  "text",
  "tool_call",
  "tool_result",
  "activity",
  "compaction_summary",
  "raw",
] as const;
export type TranscriptMessagePartType = (typeof MESSAGE_PART_TYPES)[number];

export function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

export function buildTaskStatusSqlList(): string {
  return buildSqlList(TASK_STATUSES);
}

export function buildSessionStatusSqlList(): string {
  return buildSqlList(SESSION_STATUSES);
}

export function buildChatTitleSourceSqlList(): string {
  return buildSqlList(CHAT_TITLE_SOURCES);
}

export function buildMessageRoleSqlList(): string {
  return buildSqlList(MESSAGE_ROLES);
}

export function buildMessagePartTypeSqlList(): string {
  return buildSqlList(MESSAGE_PART_TYPES);
}

export interface TaskRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  taskId: string;
  title: string;
  titleSource: ChatTitleSource;
  repository: string | null;
  activeRunId: string | null;
  mode: string;
  status: SessionStatus;
  pinnedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptMessagePartRecord {
  id: string;
  messageId: string;
  sessionId: string;
  runId: string | null;
  type: TranscriptMessagePartType;
  sessionSequence: number;
  content: JsonValue;
  createdAt: string;
}

export interface TranscriptMessageRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  role: TranscriptMessageRole;
  clientMessageId: string | null;
  createdAt: string;
  parts: TranscriptMessagePartRecord[];
}

export interface EnsureTranscriptSessionInput {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  taskId?: string | null;
  title?: string | null;
  titleSource?: ChatTitleSource | null;
  repository?: string | null;
  activeRunId?: string | null;
  mode?: string | null;
  status?: SessionStatus | null;
}

export interface AppendTranscriptMessageInput extends EnsureTranscriptSessionInput {
  runId?: string | null;
  role: TranscriptMessageRole;
  clientMessageId?: string | null;
  dedupeKey: string;
  parts: Array<{
    type: TranscriptMessagePartType;
    content: JsonValue;
  }>;
}

export interface AppendExistingTranscriptMessageInput {
  sessionId: string;
  runId?: string | null;
  role: TranscriptMessageRole;
  clientMessageId?: string | null;
  dedupeKey: string;
  parts: Array<{
    type: TranscriptMessagePartType;
    content: JsonValue;
  }>;
}

export interface ListTranscriptInput {
  sessionId: string;
  userId?: string | null;
  runId?: string | null;
  cursor?: number | null;
  limit?: number | null;
}

export interface ListTranscriptResult {
  messages: TranscriptMessageRecord[];
  nextCursor: number | null;
}

export interface ListSessionsResult {
  tasks: TaskRecord[];
  sessions: SessionRecord[];
}

export interface TranscriptRepository {
  ensureSession(input: EnsureTranscriptSessionInput): Promise<SessionRecord>;
  updateGeneratedSessionTitle(input: {
    userId: string;
    sessionId: string;
    title: string;
    titleSource: "generated";
  }): Promise<SessionRecord | null>;
  renameSessionTitle(input: {
    userId: string;
    sessionId: string;
    title: string;
    titleSource: "user";
  }): Promise<SessionRecord | null>;
  pinSession(userId: string, sessionId: string): Promise<SessionRecord | null>;
  unpinSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null>;
  archiveSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null>;
  unarchiveSession(
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null>;
  appendMessage(
    input: AppendTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord>;
  appendMessageToExistingSession(
    input: AppendExistingTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord>;
  listTranscript(input: ListTranscriptInput): Promise<ListTranscriptResult>;
  listSessions(userId: string): Promise<ListSessionsResult>;
  listArchivedSessions(userId: string): Promise<SessionRecord[]>;
  transaction<T>(
    callback: (repository: TranscriptRepository) => Promise<T>,
  ): Promise<T>;
}
