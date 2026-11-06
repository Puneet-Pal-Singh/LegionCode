import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

export const harnessBindings = pgTable(
  "harness_bindings",
  {
    turnId: text("turn_id").primaryKey(),
    runAttemptId: text("run_attempt_id").notNull().unique(),
    userId: text("user_id").notNull(),
    selectionJson: jsonb("selection_json").notNull(),
    selectionFingerprint: text("selection_fingerprint").notNull(),
    attachmentJson: jsonb("attachment_json"),
    externalTurnId: text("external_turn_id"),
    lastObservationSequence: bigint("last_observation_sequence", {
      mode: "number",
    })
      .notNull()
      .default(0),
  },
  (table) => [
    check(
      "harness_bindings_sequence_check",
      sql`${table.lastObservationSequence} >= 0`,
    ),
  ],
);
export const harnessObservationReceipts = pgTable(
  "harness_observation_receipts",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => harnessBindings.turnId, { onDelete: "cascade" }),
    processGeneration: bigint("process_generation", {
      mode: "number",
    }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    observationFingerprint: text("observation_fingerprint").notNull(),
    eventIdsJson: jsonb("event_ids_json").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.turnId, table.processGeneration, table.sequence],
    }),
    check(
      "harness_receipt_generation_check",
      sql`${table.processGeneration} >= 0`,
    ),
    check("harness_receipt_sequence_check", sql`${table.sequence} > 0`),
  ],
);
