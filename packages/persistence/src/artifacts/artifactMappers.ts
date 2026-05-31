import {
  EditArtifactEventSchema,
  EditArtifactRecordSchema,
  type EditArtifactChangedFile,
  type EditArtifactEvent,
  type EditArtifactRecord,
} from "@repo/shared-types";
import type { SqlRow } from "../sql.js";

export interface ArtifactRow extends SqlRow {
  id: string;
  user_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  repo_url: string | null;
  branch: string | null;
  base_commit_sha: string | null;
  head_commit_sha: string | null;
  artifact_kind: string;
  r2_object_key: string;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  source_turn_id?: string | null;
  capture_sequence?: number | null;
  patch_parse_status?: string | null;
  patch_sha256?: string | null;
  storage_backend?: string | null;
  cf_artifact_repo?: string | null;
  cf_artifact_commit_sha?: string | null;
  cf_artifact_path?: string | null;
  storage_reconciliation_status?: string | null;
  status: string;
  changed_files_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at: string | Date;
}

export interface ArtifactEventRow extends SqlRow {
  id: string;
  artifact_id: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json: unknown;
  created_at: string | Date;
}

export function mapArtifactRow(row: ArtifactRow): EditArtifactRecord {
  const changedFiles = parseChangedFiles(row.changed_files_json);
  return EditArtifactRecordSchema.parse({
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    branch: row.branch,
    baseCommitSha: row.base_commit_sha,
    headCommitSha: row.head_commit_sha,
    artifactKind: row.artifact_kind,
    r2ObjectKey: row.r2_object_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    userMessageId: row.user_message_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    sourceTurnId: row.source_turn_id ?? null,
    captureSequence: row.capture_sequence ?? 0,
    patchParseStatus: row.patch_parse_status ?? "unknown",
    patchSha256: row.patch_sha256 ?? row.sha256,
    storageBackend: row.storage_backend ?? "r2_postgres",
    cfArtifactRepo: row.cf_artifact_repo ?? null,
    cfArtifactCommitSha: row.cf_artifact_commit_sha ?? null,
    cfArtifactPath: row.cf_artifact_path ?? null,
    storageReconciliationStatus: row.storage_reconciliation_status ?? null,
    changedFileCount: changedFiles.length,
    changedFiles,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    expiresAt: toIsoString(row.expires_at),
  });
}

export function mapArtifactEventRow(row: ArtifactEventRow): EditArtifactEvent {
  return EditArtifactEventSchema.parse({
    id: row.id,
    artifactId: row.artifact_id,
    runId: row.run_id,
    eventType: row.event_type,
    message: row.message,
    metadata: parseMetadata(row.metadata_json),
    createdAt: toIsoString(row.created_at),
  });
}

export function readReturnedRow<Row>(row: Row | undefined, table: string): Row {
  if (!row) {
    throw new Error(`${table} write returned no row`);
  }
  return row;
}

function parseChangedFiles(value: unknown): EditArtifactChangedFile[] {
  if (Array.isArray(value)) {
    return value as EditArtifactChangedFile[];
  }

  if (typeof value === "string") {
    return JSON.parse(value) as EditArtifactChangedFile[];
  }

  return [];
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
