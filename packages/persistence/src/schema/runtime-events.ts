import { sql } from "drizzle-orm";
import {
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
import { buildRuntimeEventInboxStatusSqlList } from "../runtime-events/types.js";

const RUNTIME_EVENT_INBOX_STATUS_SQL_LIST =
  buildRuntimeEventInboxStatusSqlList();

export const runtimeEventInbox = pgTable(
  "runtime_event_inbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull(),
    status: text("status").notNull().default("received"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("runtime_event_inbox_source_idempotency_key_idx").on(
      table.source,
      table.idempotencyKey,
    ),
    index("runtime_event_inbox_status_received_at_idx").on(
      table.status,
      table.receivedAt,
    ),
    check(
      "runtime_event_inbox_status_check",
      sql`${table.status} IN (${sql.raw(RUNTIME_EVENT_INBOX_STATUS_SQL_LIST)})`,
    ),
    check(
      "runtime_event_inbox_payload_schema_version_check",
      sql`${table.payloadSchemaVersion} > 0`,
    ),
  ],
);
