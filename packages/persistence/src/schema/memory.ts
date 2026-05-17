import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { sessions } from "./transcript.js";
import { runs } from "./runs.js";

export const memoryEvents = pgTable(
  "memory_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memory_events_session_created_idx").on(table.sessionId, table.createdAt),
    uniqueIndex("memory_events_session_idempotency_idx")
      .on(table.sessionId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
