import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./identity.js";
import { workspaces } from "./workspaces.js";
import { sessions, tasks } from "./transcript.js";
import {
  buildRunStatusSqlList,
  buildRunStepStatusSqlList,
} from "../runs/types.js";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("created"),
    mode: text("mode").notNull().default("build"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    branch: text("branch"),
    baseCommitSha: text("base_commit_sha"),
    headCommitSha: text("head_commit_sha"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSequence: integer("last_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("runs_status_check", sql.raw(`status IN (${buildRunStatusSqlList()})`)),
    index("runs_user_idx").on(table.userId),
    index("runs_session_idx").on(table.sessionId),
    index("runs_task_idx").on(table.taskId),
    index("runs_workspace_idx").on(table.workspaceId),
  ],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    stepType: text("step_type").notNull(),
    status: text("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    payloadJson: jsonb("payload_json").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "run_steps_status_check",
      sql.raw(`status IN (${buildRunStepStatusSqlList()})`),
    ),
    uniqueIndex("run_steps_run_index_idx").on(table.runId, table.stepIndex),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").notNull().default({}),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("run_events_run_sequence_idx").on(table.runId, table.sequence),
    uniqueIndex("run_events_run_idempotency_idx").on(
      table.runId,
      table.idempotencyKey,
    ),
    index("run_events_session_idx").on(table.sessionId),
  ],
);
