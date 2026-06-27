import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { messages, sessions } from "./transcript.js";
import { runs } from "./runs.js";

export const contextSnapshots = pgTable(
  "context_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    snapshotKind: text("snapshot_kind").notNull(),
    r2ObjectKey: text("r2_object_key"),
    payloadSizeBytes: integer("payload_size_bytes"),
    tokenCount: integer("token_count"),
    triggerReason: text("trigger_reason"),
    sourceMessageRangeJson: jsonb("source_message_range_json"),
    summaryMessageId: uuid("summary_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    replacementHistoryR2ObjectKey: text("replacement_history_r2_object_key"),
    usageBeforeJson: jsonb("usage_before_json"),
    usageAfterJson: jsonb("usage_after_json"),
    validationJson: jsonb("validation_json"),
    modelInfoJson: jsonb("model_info_json"),
    mediaArtifactsJson: jsonb("media_artifacts_json"),
    continuityStateJson: jsonb("continuity_state_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("context_snapshots_session_idx").on(table.sessionId),
    index("context_snapshots_run_idx").on(table.runId),
  ],
);

export const contextSnapshotSources = pgTable(
  "context_snapshot_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextSnapshotId: uuid("context_snapshot_id")
      .notNull()
      .references(() => contextSnapshots.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRangeJson: jsonb("source_range_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("snapshot_sources_snapshot_idx").on(table.contextSnapshotId),
    index("snapshot_sources_type_id_idx").on(table.sourceType, table.sourceId),
  ],
);
