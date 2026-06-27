import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { sessions } from "./transcript.js";
import { runs } from "./runs.js";
import {
  buildPermissionDecisionKindSqlList,
  buildPermissionRequestStatusSqlList,
} from "../permissions/types.js";

export const permissionRequests = pgTable(
  "permission_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    requestType: text("request_type").notNull(),
    status: text("status").notNull(),
    payloadJson: jsonb("payload_json"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "permission_requests_status_check",
      sql.raw(`status IN (${buildPermissionRequestStatusSqlList()})`),
    ),
    index("permission_requests_run_created_idx").on(table.runId, table.createdAt),
    index("permission_requests_user_status_created_idx").on(
      table.userId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const permissionDecisions = pgTable(
  "permission_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    permissionRequestId: uuid("permission_request_id")
      .notNull()
      .references(() => permissionRequests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    payloadJson: jsonb("payload_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "permission_decisions_kind_check",
      sql.raw(`decision IN (${buildPermissionDecisionKindSqlList()})`),
    ),
    index("permission_decisions_request_created_idx").on(
      table.permissionRequestId,
      table.createdAt,
    ),
    index("permission_decisions_user_created_idx").on(table.userId, table.createdAt),
  ],
);
