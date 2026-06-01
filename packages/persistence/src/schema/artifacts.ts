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
import {
  EDIT_ARTIFACT_EVENT_TYPES,
  EDIT_ARTIFACT_KINDS,
  EDIT_ARTIFACT_STATUSES,
} from "@repo/shared-types";
import { users } from "./identity.js";
import { runs } from "./runs.js";
import { sessions } from "./transcript.js";
import { workspaces } from "./workspaces.js";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoUrl: text("repo_url"),
    branch: text("branch"),
    baseCommitSha: text("base_commit_sha"),
    headCommitSha: text("head_commit_sha"),
    artifactKind: text("artifact_kind").notNull(),
    r2ObjectKey: text("r2_object_key").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    sourceTurnId: text("source_turn_id"),
    captureSequence: integer("capture_sequence").notNull().default(0),
    patchParseStatus: text("patch_parse_status").notNull().default("unknown"),
    patchSha256: text("patch_sha256"),
    storageBackend: text("storage_backend").notNull().default("r2_postgres"),
    cfArtifactRepo: text("cf_artifact_repo"),
    cfArtifactCommitSha: text("cf_artifact_commit_sha"),
    cfArtifactPath: text("cf_artifact_path"),
    storageReconciliationStatus: text("storage_reconciliation_status"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("artifacts_kind_check", sql.raw(`artifact_kind IN (${buildSqlList(EDIT_ARTIFACT_KINDS)})`)),
    check("artifacts_status_check", sql.raw(`status IN (${buildSqlList(EDIT_ARTIFACT_STATUSES)})`)),
    uniqueIndex("artifacts_r2_object_key_idx").on(table.r2ObjectKey),
    index("artifacts_user_workspace_updated_idx").on(
      table.userId,
      table.workspaceId,
      table.updatedAt,
    ),
    index("artifacts_run_status_updated_idx").on(
      table.runId,
      table.status,
      table.updatedAt,
    ),
    index("artifacts_run_user_status_updated_idx").on(
      table.runId,
      table.userId,
      table.status,
      table.updatedAt,
    ),
    index("artifacts_run_assistant_message_idx").on(
      table.runId,
      table.assistantMessageId,
      table.createdAt.desc(),
    ),
    index("artifacts_run_session_created_idx").on(
      table.runId,
      table.sessionId,
      table.createdAt.desc(),
    ),
    index("artifacts_storage_reconciliation_idx").on(
      table.storageReconciliationStatus,
      table.createdAt,
    ),
    index("artifacts_expiry_status_idx").on(table.expiresAt, table.status),
  ],
);

export const artifactEvents = pgTable(
  "artifact_events",
  {
    id: uuid("id").primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    metadataJson: jsonb("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("artifact_events_type_check", sql.raw(`event_type IN (${buildSqlList(EDIT_ARTIFACT_EVENT_TYPES)})`)),
    index("artifact_events_artifact_created_idx").on(
      table.artifactId,
      table.createdAt,
    ),
    index("artifact_events_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const artifactChangedFiles = pgTable(
  "artifact_changed_files",
  {
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    changeType: text("change_type").notNull(),
    additions: integer("additions"),
    deletions: integer("deletions"),
    metadataJson: jsonb("metadata_json"),
  },
  (table) => [uniqueIndex("artifact_changed_files_artifact_path_idx").on(table.artifactId, table.path)],
);

function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}
