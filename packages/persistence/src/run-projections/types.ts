import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalIdSchema,
  ApprovalOptionSchema,
  ItemIdSchema,
  JsonRecordSchema,
  ProtocolErrorSchema,
  ProtocolTimestampSchema,
  RunIdSchema,
  ThreadIdSchema,
  ToolCallIdSchema,
  UserIdSchema,
  type EventCursor,
  type PlatformEvent,
  type Run,
  type RunId,
  type RunItem,
} from "@repo/platform-protocol";

export const RUN_PROJECTION_VERSION = 1;

export const ToolCallProjectionStatusSchema = z.enum([
  "requested",
  "running",
  "completed",
  "failed",
]);
export type ToolCallProjectionStatus = z.infer<
  typeof ToolCallProjectionStatusSchema
>;

export const ApprovalProjectionStatusSchema = z.enum([
  "requested",
  "decided",
]);
export type ApprovalProjectionStatus = z.infer<
  typeof ApprovalProjectionStatusSchema
>;

export const ToolCallProjectionSchema = z
  .object({
    toolCallId: ToolCallIdSchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    itemId: ItemIdSchema,
    toolName: z.string().min(1).max(160),
    status: ToolCallProjectionStatusSchema,
    input: JsonRecordSchema,
    output: JsonRecordSchema.nullable(),
    outputText: z.string(),
    failure: ProtocolErrorSchema.nullable(),
    requestedAt: ProtocolTimestampSchema,
    startedAt: ProtocolTimestampSchema.nullable(),
    completedAt: ProtocolTimestampSchema.nullable(),
    eventSequence: z.number().int().safe().positive(),
  })
  .strict();
export type ToolCallProjection = z.infer<
  typeof ToolCallProjectionSchema
>;

export const ApprovalProjectionSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    itemId: ItemIdSchema.nullable(),
    status: ApprovalProjectionStatusSchema,
    question: z.string().min(1).max(2_000),
    options: z.array(ApprovalOptionSchema).min(1).max(12),
    metadata: JsonRecordSchema,
    decision: ApprovalDecisionSchema.nullable(),
    decidedBy: UserIdSchema.nullable(),
    reason: z.string().min(1).max(2_000).nullable(),
    requestedAt: ProtocolTimestampSchema,
    decidedAt: ProtocolTimestampSchema.nullable(),
    eventSequence: z.number().int().safe().positive(),
  })
  .strict();
export type ApprovalProjection = z.infer<typeof ApprovalProjectionSchema>;

export interface RunProjectionEventInput {
  event: PlatformEvent;
  projectionSequence: number;
}

export interface RunProjectionSnapshot {
  run: Run;
  items: readonly RunItem[];
  toolCalls: readonly ToolCallProjection[];
  approvals: readonly ApprovalProjection[];
  lastCursor: EventCursor;
  projectionVersion: typeof RUN_PROJECTION_VERSION;
}

export interface RebuildRunProjectionInput {
  runId: RunId;
  events: readonly RunProjectionEventInput[];
}

export interface RunProjectionRepository {
  rebuildFromEvents(
    input: RebuildRunProjectionInput,
  ): Promise<RunProjectionSnapshot | null>;
  getRunProjection(runId: RunId): Promise<RunProjectionSnapshot | null>;
}

export class RunProjectionError extends Error {
  constructor(
    readonly code:
      | "approval_not_requested"
      | "event_run_mismatch"
      | "event_scope_mismatch"
      | "invalid_projection_sequence"
      | "missing_item_source"
      | "missing_run_created"
      | "missing_text_item"
      | "missing_tool_call_source"
      | "missing_tool_request",
    message: string,
  ) {
    super(message);
    this.name = "RunProjectionError";
  }
}

export function buildToolCallProjectionStatusSqlList(): string {
  return buildSqlList(ToolCallProjectionStatusSchema.options);
}

export function buildApprovalProjectionStatusSqlList(): string {
  return buildSqlList(ApprovalProjectionStatusSchema.options);
}

export function buildApprovalDecisionSqlList(): string {
  return buildSqlList(ApprovalDecisionSchema.options);
}

export function parseToolCallProjection(value: {
  toolCallId: unknown;
  runId: unknown;
  threadId: unknown;
  itemId: unknown;
  toolName: string;
  status: unknown;
  input: unknown;
  output: unknown;
  outputText: string;
  failure: unknown;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  eventSequence: number;
}): ToolCallProjection {
  return ToolCallProjectionSchema.parse(value);
}

export function parseApprovalProjection(value: {
  approvalId: unknown;
  runId: unknown;
  threadId: unknown;
  itemId: unknown;
  status: unknown;
  question: string;
  options: unknown;
  metadata: unknown;
  decision: unknown;
  decidedBy: unknown;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  eventSequence: number;
}): ApprovalProjection {
  return ApprovalProjectionSchema.parse(value);
}

function buildSqlList(values: readonly string[]): string {
  return values.map(quoteSqlLiteral).join(", ");
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
