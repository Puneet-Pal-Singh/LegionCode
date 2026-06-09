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
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
  ThreadStatusSchema,
  ThreadTitleSourceSchema,
} from "@repo/platform-protocol";
import { buildSqlList } from "../sessions/types.js";

const THREAD_STATUS_SQL_LIST = buildSqlList(ThreadStatusSchema.options);
const THREAD_TITLE_SOURCE_SQL_LIST = buildSqlList(
  ThreadTitleSourceSchema.options,
);
const THREAD_ITEM_ROLE_SQL_LIST = buildSqlList(ThreadItemRoleSchema.options);
const THREAD_ITEM_STATUS_SQL_LIST = buildSqlList(
  ThreadItemStatusSchema.options,
);
const THREAD_ITEM_TYPE_SQL_LIST = buildSqlList(ThreadItemTypeSchema.options);

export const canonicalThreadProjections = pgTable(
  "canonical_thread_projections",
  {
    threadId: text("thread_id").primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    titleSource: text("title_source").notNull(),
    status: text("status").notNull(),
    pinnedAt: timestamp("pinned_at", {
      withTimezone: true,
      mode: "string",
    }),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "string",
    }),
    activeRunId: text("active_run_id"),
    activeLeafItemId: text("active_leaf_item_id"),
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
    index("canonical_thread_projections_user_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    index("canonical_thread_projections_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    check(
      "canonical_thread_projections_status_check",
      sql`${table.status} IN (${sql.raw(THREAD_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_thread_projections_title_source_check",
      sql`${table.titleSource} IN (${sql.raw(THREAD_TITLE_SOURCE_SQL_LIST)})`,
    ),
    check(
      "canonical_thread_projections_last_event_sequence_check",
      sql`${table.lastEventSequence} > 0`,
    ),
    check(
      "canonical_thread_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);

export const canonicalThreadItemProjections = pgTable(
  "canonical_thread_item_projections",
  {
    itemId: text("item_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    runId: text("run_id"),
    turnId: text("turn_id"),
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
      columns: [table.threadId],
      foreignColumns: [canonicalThreadProjections.threadId],
      name: "canonical_thread_item_projections_thread_fk",
    }).onDelete("cascade"),
    index("canonical_thread_item_projections_thread_sequence_idx").on(
      table.threadId,
      table.eventSequence,
    ),
    index("canonical_thread_item_projections_run_sequence_idx").on(
      table.runId,
      table.eventSequence,
    ),
    check(
      "canonical_thread_item_projections_role_check",
      sql`${table.role} IN (${sql.raw(THREAD_ITEM_ROLE_SQL_LIST)})`,
    ),
    check(
      "canonical_thread_item_projections_status_check",
      sql`${table.status} IN (${sql.raw(THREAD_ITEM_STATUS_SQL_LIST)})`,
    ),
    check(
      "canonical_thread_item_projections_type_check",
      sql`${table.itemType} IN (${sql.raw(THREAD_ITEM_TYPE_SQL_LIST)})`,
    ),
    check(
      "canonical_thread_item_projections_event_sequence_check",
      sql`${table.eventSequence} > 0`,
    ),
    check(
      "canonical_thread_item_projections_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);
