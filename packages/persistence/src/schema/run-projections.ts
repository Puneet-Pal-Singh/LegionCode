import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  ApprovalDecisionSchema,
  RunModeSchema,
  RunStatusSchema,
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
} from "@repo/platform-protocol";
import { buildSqlList } from "../sessions/types.js";
import {
  buildApprovalProjectionStatusSqlList,
  buildToolCallProjectionStatusSqlList,
} from "../run-projections/types.js";

const RUN_STATUS_SQL_LIST = buildSqlList(RunStatusSchema.options);
const RUN_MODE_SQL_LIST = buildSqlList(RunModeSchema.options);
const THREAD_ITEM_ROLE_SQL_LIST = buildSqlList(ThreadItemRoleSchema.options);
const THREAD_ITEM_STATUS_SQL_LIST = buildSqlList(
  ThreadItemStatusSchema.options,
);
const THREAD_ITEM_TYPE_SQL_LIST = buildSqlList(ThreadItemTypeSchema.options);
const TOOL_CALL_STATUS_SQL_LIST = buildToolCallProjectionStatusSqlList();
const APPROVAL_STATUS_SQL_LIST = buildApprovalProjectionStatusSqlList();
const APPROVAL_DECISION_SQL_LIST = buildSqlList(
  ApprovalDecisionSchema.options,
);

export const canonicalRunProjections = pgTable(
  "canonical_run_projections",
  {
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    workerId: text("worker_id").notNull(),
    permissionProfileId: text("permission_profile_id").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastEventSequence: bigint("last_event_sequence", {
      mode: "number",
    }).notNull(),
    lastCursor: text("last_cursor").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    rebuiltAt: timestamp("rebuilt_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("canonical_run_projections_thread_updated_idx").on(
      table.threadId,
      table.updatedAt,
    ),
    index("canonical_run_projections_user_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    index("canonical_run_projections_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    check(
      "canonical_run_projections_status_check",
      sql`${table.status} IN (${sql.raw(RUN_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_run_projections_mode_check",
      sql`${table.mode} IN (${sql.raw(RUN_MODE_SQL_LIST)})`,
    ),
    check(
      "canonical_run_projections_last_event_sequence_check",
      sql`${table.lastEventSequence} > 0`,
    ),
    check(
      "canonical_run_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);

export const canonicalRunItemProjections = pgTable(
  "canonical_run_item_projections",
  {
    itemId: text("item_id").primaryKey(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    parentItemId: text("parent_item_id"),
    branchId: text("branch_id"),
    role: text("role").notNull(),
    itemType: text("item_type").notNull(),
    status: text("status").notNull(),
    contentJson: jsonb("content_json").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceCursor: text("source_cursor").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectedAt: timestamp("projected_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [canonicalRunProjections.runId],
      name: "canonical_run_item_projections_run_fk",
    }).onDelete("cascade"),
    index("canonical_run_item_projections_run_sequence_idx").on(
      table.runId,
      table.eventSequence,
    ),
    index("canonical_run_item_projections_thread_sequence_idx").on(
      table.threadId,
      table.eventSequence,
    ),
    check(
      "canonical_run_item_projections_role_check",
      sql`${table.role} IN (${sql.raw(THREAD_ITEM_ROLE_SQL_LIST)})`,
    ),
    check(
      "canonical_run_item_projections_status_check",
      sql`${table.status} IN (${sql.raw(THREAD_ITEM_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_run_item_projections_type_check",
      sql`${table.itemType} IN (${sql.raw(THREAD_ITEM_TYPE_SQL_LIST)})`,
    ),
    check(
      "canonical_run_item_projections_event_sequence_check",
      sql`${table.eventSequence} > 0`,
    ),
    check(
      "canonical_run_item_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);

export const canonicalToolCallProjections = pgTable(
  "canonical_tool_call_projections",
  {
    toolCallId: text("tool_call_id").primaryKey(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    itemId: text("item_id").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    inputJson: jsonb("input_json").notNull(),
    outputJson: jsonb("output_json"),
    outputText: text("output_text").notNull().default(""),
    failureJson: jsonb("failure_json"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceCursor: text("source_cursor").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectedAt: timestamp("projected_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [canonicalRunProjections.runId],
      name: "canonical_tool_call_projections_run_fk",
    }).onDelete("cascade"),
    index("canonical_tool_call_projections_run_sequence_idx").on(
      table.runId,
      table.eventSequence,
    ),
    index("canonical_tool_call_projections_item_idx").on(table.itemId),
    check(
      "canonical_tool_call_projections_status_check",
      sql`${table.status} IN (${sql.raw(TOOL_CALL_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_tool_call_projections_event_sequence_check",
      sql`${table.eventSequence} > 0`,
    ),
    check(
      "canonical_tool_call_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);

export const canonicalApprovalProjections = pgTable(
  "canonical_approval_projections",
  {
    approvalId: text("approval_id").primaryKey(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    itemId: text("item_id"),
    status: text("status").notNull(),
    question: text("question").notNull(),
    optionsJson: jsonb("options_json").notNull(),
    metadataJson: jsonb("metadata_json").notNull(),
    decision: text("decision"),
    decidedBy: text("decided_by"),
    reason: text("reason"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    decidedAt: timestamp("decided_at", {
      withTimezone: true,
      mode: "string",
    }),
    eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceCursor: text("source_cursor").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectedAt: timestamp("projected_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [canonicalRunProjections.runId],
      name: "canonical_approval_projections_run_fk",
    }).onDelete("cascade"),
    index("canonical_approval_projections_run_sequence_idx").on(
      table.runId,
      table.eventSequence,
    ),
    index("canonical_approval_projections_item_idx").on(table.itemId),
    check(
      "canonical_approval_projections_status_check",
      sql`${table.status} IN (${sql.raw(APPROVAL_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_approval_projections_decision_check",
      sql`${table.decision} IS NULL OR ${table.decision} IN (${sql.raw(
        APPROVAL_DECISION_SQL_LIST,
      )})`,
    ),
    check(
      "canonical_approval_projections_event_sequence_check",
      sql`${table.eventSequence} > 0`,
    ),
    check(
      "canonical_approval_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);
