import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const hookDefinitions = pgTable(
  "hook_definitions",
  {
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    handlerId: text("handler_id").notNull(),
    eventName: text("event_name").notNull(),
    source: text("source").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    order: integer("hook_order").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    configurationKey: text("configuration_key"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "hook_definitions_pk",
      columns: [table.userId, table.workspaceId, table.handlerId],
    }),
    foreignKey({
      name: "hook_definitions_workspace_owner_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaces.id, workspaces.userId],
    }).onDelete("cascade"),
    index("hook_definitions_workspace_updated_at_idx").on(
      table.userId,
      table.workspaceId,
      table.updatedAt,
    ),
    check(
      "hook_definitions_handler_id_length_check",
      sql`char_length(${table.handlerId}) BETWEEN 1 AND 128`,
    ),
    check(
      "hook_definitions_display_name_length_check",
      sql`char_length(${table.displayName}) BETWEEN 1 AND 120`,
    ),
    check(
      "hook_definitions_event_name_check",
      sql`${table.eventName} IN ('SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop')`,
    ),
    check(
      "hook_definitions_source_check",
      sql`${table.source} IN ('user', 'project', 'plugin')`,
    ),
    check(
      "hook_definitions_order_check",
      sql`${table.order} BETWEEN 0 AND 10000`,
    ),
    check(
      "hook_definitions_timeout_check",
      sql`${table.timeoutMs} BETWEEN 50 AND 30000`,
    ),
    check(
      "hook_definitions_configuration_key_length_check",
      sql`${table.configurationKey} IS NULL OR char_length(${table.configurationKey}) BETWEEN 1 AND 256`,
    ),
  ],
);
