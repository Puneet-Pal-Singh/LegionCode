import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { buildCanonicalEventScopeTypeSqlList } from "../canonical-events/types.js";

const CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST =
  buildCanonicalEventScopeTypeSqlList();

export const canonicalEventScopeSequences = pgTable(
  "canonical_event_scope_sequences",
  {
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    nextSequence: bigint("next_sequence", { mode: "number" })
      .notNull()
      .default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.scopeType, table.scopeId],
      name: "canonical_event_scope_sequences_pk",
    }),
    check(
      "canonical_event_scope_sequences_scope_type_check",
      sql`${table.scopeType} IN (${sql.raw(CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST)})`,
    ),
    check(
      "canonical_event_scope_sequences_next_sequence_check",
      sql`${table.nextSequence} > 0`,
    ),
  ],
);

export const canonicalEvents = pgTable(
  "canonical_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: text("event_id").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    threadId: text("thread_id").notNull(),
    runId: text("run_id"),
    workspaceId: text("workspace_id").notNull(),
    artifactId: text("artifact_id"),
    providerId: text("provider_id"),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    globalSequence: bigserial("global_sequence", { mode: "number" }).notNull(),
    cursor: text("cursor").notNull(),
    idempotencyKey: text("idempotency_key"),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    producerKind: text("producer_kind").notNull(),
    producerId: text("producer_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("canonical_events_event_id_unique").on(table.eventId),
    uniqueIndex("canonical_events_cursor_unique").on(table.cursor),
    uniqueIndex("canonical_events_scope_sequence_unique").on(
      table.scopeType,
      table.scopeId,
      table.sequence,
    ),
    uniqueIndex("canonical_events_scope_idempotency_idx")
      .on(table.scopeType, table.scopeId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("canonical_events_scope_sequence_idx").on(
      table.scopeType,
      table.scopeId,
      table.sequence,
    ),
    index("canonical_events_thread_sequence_idx").on(
      table.threadId,
      table.globalSequence,
    ),
    index("canonical_events_workspace_sequence_idx").on(
      table.workspaceId,
      table.globalSequence,
    ),
    check(
      "canonical_events_scope_type_check",
      sql`${table.scopeType} IN (${sql.raw(CANONICAL_EVENT_SCOPE_TYPE_SQL_LIST)})`,
    ),
    check("canonical_events_sequence_check", sql`${table.sequence} > 0`),
    check(
      "canonical_events_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
  ],
);
