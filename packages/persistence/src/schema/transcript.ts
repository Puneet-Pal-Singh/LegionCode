import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./identity.js";
import { workspaces } from "./workspaces.js";
import {
  buildMessagePartTypeSqlList,
  buildMessageRoleSqlList,
  buildSessionStatusSqlList,
  buildTaskStatusSqlList,
} from "../sessions/types.js";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    check("tasks_status_check", sql.raw(`status IN (${buildTaskStatusSqlList()})`)),
    index("tasks_user_updated_idx").on(table.userId, table.updatedAt),
    index("tasks_workspace_idx").on(table.workspaceId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    repository: text("repository"),
    activeRunId: uuid("active_run_id"),
    mode: text("mode").notNull().default("build"),
    status: text("status").notNull().default("idle"),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("sessions_status_check", sql.raw(`status IN (${buildSessionStatusSqlList()})`)),
    index("sessions_user_updated_idx").on(table.userId, table.updatedAt),
    index("sessions_task_idx").on(table.taskId),
    index("sessions_workspace_idx").on(table.workspaceId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    role: text("role").notNull(),
    clientMessageId: text("client_message_id"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("messages_role_check", sql.raw(`role IN (${buildMessageRoleSqlList()})`)),
    uniqueIndex("messages_session_dedupe_idx").on(table.sessionId, table.dedupeKey),
    index("messages_session_created_idx").on(table.sessionId, table.createdAt),
    index("messages_run_idx").on(table.runId),
  ],
);

export const messageParts = pgTable(
  "message_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    partType: text("part_type").notNull(),
    sessionSequence: bigint("session_sequence", { mode: "number" }).notNull(),
    contentJson: jsonb("content_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("message_parts_type_check", sql.raw(`part_type IN (${buildMessagePartTypeSqlList()})`)),
    uniqueIndex("message_parts_session_sequence_idx").on(
      table.sessionId,
      table.sessionSequence,
    ),
    index("message_parts_message_idx").on(table.messageId),
    index("message_parts_run_idx").on(table.runId),
  ],
);

export const tasksRelations = relations(tasks, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  task: one(tasks, {
    fields: [sessions.taskId],
    references: [tasks.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
  parts: many(messageParts),
}));

export const messagePartsRelations = relations(messageParts, ({ one }) => ({
  message: one(messages, {
    fields: [messageParts.messageId],
    references: [messages.id],
  }),
}));
