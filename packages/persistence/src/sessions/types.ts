import type { JsonValue } from "@repo/shared-types";

export const TASK_STATUSES = ["active", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SESSION_STATUSES = ["idle", "running", "completed", "failed"] as const;
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
  repository: string | null;
  activeRunId: string | null;
  mode: string;
  status: SessionStatus;
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
  appendMessage(input: AppendTranscriptMessageInput): Promise<TranscriptMessageRecord>;
  appendMessageToExistingSession(
    input: AppendExistingTranscriptMessageInput,
  ): Promise<TranscriptMessageRecord>;
  listTranscript(input: ListTranscriptInput): Promise<ListTranscriptResult>;
  listSessions(userId: string): Promise<ListSessionsResult>;
  transaction<T>(
    callback: (repository: TranscriptRepository) => Promise<T>,
  ): Promise<T>;
}
