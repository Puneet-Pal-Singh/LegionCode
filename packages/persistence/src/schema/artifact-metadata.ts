import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  buildArtifactChangedFileStatusSqlList,
  buildArtifactKindSqlList,
  buildArtifactPayloadBackendSqlList,
} from "@repo/platform-protocol";

const ARTIFACT_KIND_SQL_LIST = buildArtifactKindSqlList();
const ARTIFACT_PAYLOAD_BACKEND_SQL_LIST =
  buildArtifactPayloadBackendSqlList();
const ARTIFACT_CHANGED_FILE_STATUS_SQL_LIST =
  buildArtifactChangedFileStatusSqlList();

export const artifactMetadata = pgTable(
  "artifact_metadata",
  {
    artifactId: text("artifact_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    itemId: text("item_id"),
    artifactKind: text("artifact_kind").notNull(),
    label: text("label").notNull(),
    payloadBackend: text("payload_backend").notNull(),
    payloadObjectKey: text("payload_object_key").notNull(),
    payloadUri: text("payload_uri"),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    metadataJson: jsonb("metadata_json").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceCursor: text("source_cursor").notNull(),
    projectionVersion: integer("projection_version").notNull(),
  },
  (table) => [
    uniqueIndex("artifact_metadata_payload_object_key_idx").on(
      table.payloadObjectKey,
    ),
    index("artifact_metadata_run_sequence_idx").on(
      table.runId,
      table.eventSequence,
    ),
    index("artifact_metadata_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    check(
      "artifact_metadata_kind_check",
      sql`${table.artifactKind} IN (${sql.raw(ARTIFACT_KIND_SQL_LIST)})`,
    ),
    check(
      "artifact_metadata_payload_backend_check",
      sql`${table.payloadBackend} IN (${sql.raw(ARTIFACT_PAYLOAD_BACKEND_SQL_LIST)})`,
    ),
    check("artifact_metadata_size_check", sql`${table.sizeBytes} >= 0`),
    check(
      "artifact_metadata_sha256_check",
      sql`${table.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "artifact_metadata_event_sequence_check",
      sql`${table.eventSequence} >= 0`,
    ),
    check(
      "artifact_metadata_projection_version_check",
      sql`${table.projectionVersion} > 0`,
    ),
  ],
);

export const artifactMetadataChangedFiles = pgTable(
  "artifact_metadata_changed_files",
  {
    artifactId: text("artifact_id").notNull(),
    path: text("path").notNull(),
    status: text("status").notNull(),
    additions: bigint("additions", { mode: "number" }),
    deletions: bigint("deletions", { mode: "number" }),
    previousPath: text("previous_path"),
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [artifactMetadata.artifactId],
      name: "artifact_metadata_changed_files_artifact_fk",
    }).onDelete("cascade"),
    uniqueIndex("artifact_metadata_changed_files_artifact_path_idx").on(
      table.artifactId,
      table.path,
    ),
    check(
      "artifact_metadata_changed_files_status_check",
      sql`${table.status} IN (${sql.raw(ARTIFACT_CHANGED_FILE_STATUS_SQL_LIST)})`,
    ),
    check(
      "artifact_metadata_changed_files_additions_check",
      sql`${table.additions} IS NULL OR ${table.additions} >= 0`,
    ),
    check(
      "artifact_metadata_changed_files_deletions_check",
      sql`${table.deletions} IS NULL OR ${table.deletions} >= 0`,
    ),
  ],
);
