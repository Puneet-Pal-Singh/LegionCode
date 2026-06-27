import {
  ArtifactChangedFileSchema,
  ArtifactIdSchema,
  JsonRecordSchema,
  RunIdSchema,
  type ArtifactChangedFile,
  type ArtifactEvent,
  type ArtifactId,
  type RunId,
} from "@repo/platform-protocol";
import type { SqlClient, SqlRow } from "../sql.js";
import {
  ARTIFACT_METADATA_VERSION,
  ArtifactMetadataRecordSchema,
  projectArtifactMetadataEvent,
  type ArtifactMetadataRecord,
  type ArtifactMetadataRepository,
} from "./types.js";

interface ArtifactMetadataRow extends SqlRow {
  artifact_id?: string;
  thread_id?: string;
  run_id?: string;
  workspace_id?: string;
  item_id?: string | null;
  artifact_kind?: string;
  label?: string;
  payload_backend?: string;
  payload_object_key?: string;
  payload_uri?: string | null;
  content_type?: string;
  size_bytes?: number | string;
  sha256?: string;
  metadata_json?: unknown;
  created_at?: string | Date;
  event_sequence?: number | string;
  source_event_id?: string;
  source_cursor?: string;
  projection_version?: number | string;
}

interface ArtifactChangedFileRow extends SqlRow {
  artifact_id?: string;
  path?: string;
  status?: string;
  additions?: number | string | null;
  deletions?: number | string | null;
  previous_path?: string | null;
}

export class PostgresArtifactMetadataRepository
  implements ArtifactMetadataRepository
{
  constructor(private readonly client: SqlClient) {}

  async putArtifactFromEvent(
    event: ArtifactEvent,
  ): Promise<ArtifactMetadataRecord> {
    const record = projectArtifactMetadataEvent(event);
    await this.client.transaction(async (tx) => {
      await upsertArtifactMetadata(tx, record);
      await replaceChangedFiles(tx, record);
    });
    const persisted = await this.getArtifact(record.artifactId);
    if (!persisted) {
      throw new Error(`Artifact metadata was not persisted: ${record.artifactId}`);
    }
    return persisted;
  }

  async getArtifact(
    artifactId: ArtifactId,
  ): Promise<ArtifactMetadataRecord | null> {
    return await readArtifact(this.client, ArtifactIdSchema.parse(artifactId));
  }

  async listArtifactsByRun(
    runId: RunId,
  ): Promise<ArtifactMetadataRecord[]> {
    const result = await this.client.query<ArtifactMetadataRow>(
      SELECT_ARTIFACTS_BY_RUN_SQL,
      [RunIdSchema.parse(runId)],
    );
    return await hydrateArtifacts(this.client, result.rows);
  }
}

async function upsertArtifactMetadata(
  client: SqlClient,
  record: ArtifactMetadataRecord,
): Promise<void> {
  await client.query(UPSERT_ARTIFACT_METADATA_SQL, [
    record.artifactId,
    record.threadId,
    record.runId,
    record.workspaceId,
    record.itemId,
    record.kind,
    record.label,
    record.payloadRef.backend,
    record.payloadRef.objectKey,
    record.payloadRef.uri,
    record.payloadRef.contentType,
    record.payloadRef.sizeBytes,
    record.payloadRef.sha256,
    record.metadata,
    record.createdAt,
    record.eventSequence,
    record.sourceEventId,
    record.sourceCursor,
    record.projectionVersion,
  ]);
}

async function replaceChangedFiles(
  client: SqlClient,
  record: ArtifactMetadataRecord,
): Promise<void> {
  await client.query(DELETE_ARTIFACT_CHANGED_FILES_SQL, [record.artifactId]);
  for (const file of record.changedFiles) {
    await client.query(INSERT_ARTIFACT_CHANGED_FILE_SQL, [
      record.artifactId,
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.previousPath,
    ]);
  }
}

async function readArtifact(
  client: SqlClient,
  artifactId: ArtifactId,
): Promise<ArtifactMetadataRecord | null> {
  const result = await client.query<ArtifactMetadataRow>(
    SELECT_ARTIFACT_SQL,
    [artifactId],
  );
  const records = await hydrateArtifacts(client, result.rows);
  return records[0] ?? null;
}

async function hydrateArtifacts(
  client: SqlClient,
  rows: readonly ArtifactMetadataRow[],
): Promise<ArtifactMetadataRecord[]> {
  const records: ArtifactMetadataRecord[] = [];
  for (const row of rows) {
    records.push(await hydrateArtifact(client, row));
  }
  return records;
}

async function hydrateArtifact(
  client: SqlClient,
  row: ArtifactMetadataRow,
): Promise<ArtifactMetadataRecord> {
  const artifactId = requireString(row.artifact_id, "artifact_id");
  const changedFiles = await readChangedFiles(client, artifactId);
  return ArtifactMetadataRecordSchema.parse({
    artifactId,
    threadId: requireString(row.thread_id, "thread_id"),
    runId: requireString(row.run_id, "run_id"),
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    itemId: row.item_id ?? null,
    kind: requireString(row.artifact_kind, "artifact_kind"),
    label: requireString(row.label, "label"),
    payloadRef: {
      backend: requireString(row.payload_backend, "payload_backend"),
      objectKey: requireString(row.payload_object_key, "payload_object_key"),
      uri: row.payload_uri ?? null,
      contentType: requireString(row.content_type, "content_type"),
      sizeBytes: toNumber(row.size_bytes, "size_bytes"),
      sha256: requireString(row.sha256, "sha256"),
    },
    changedFiles,
    metadata: JsonRecordSchema.parse(row.metadata_json),
    createdAt: toIsoString(row.created_at, "created_at"),
    eventSequence: toNumber(row.event_sequence, "event_sequence"),
    sourceEventId: requireString(row.source_event_id, "source_event_id"),
    sourceCursor: requireString(row.source_cursor, "source_cursor"),
    projectionVersion: toNumber(
      row.projection_version,
      "projection_version",
    ),
  });
}

async function readChangedFiles(
  client: SqlClient,
  artifactId: string,
): Promise<ArtifactChangedFile[]> {
  const result = await client.query<ArtifactChangedFileRow>(
    SELECT_ARTIFACT_CHANGED_FILES_SQL,
    [artifactId],
  );
  return result.rows.map(mapChangedFileRow);
}

function mapChangedFileRow(row: ArtifactChangedFileRow): ArtifactChangedFile {
  return ArtifactChangedFileSchema.parse({
    path: requireString(row.path, "path"),
    status: requireString(row.status, "status"),
    additions: row.additions === null ? null : toNumber(row.additions, "additions"),
    deletions: row.deletions === null ? null : toNumber(row.deletions, "deletions"),
    previousPath: row.previous_path ?? null,
  });
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string column: ${column}`);
  }
  return value;
}

function toIsoString(value: unknown, column: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return requireString(value, column);
}

function toNumber(value: unknown, column: string): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue)) {
    throw new Error(`Expected safe integer column: ${column}`);
  }
  return numberValue;
}

const ARTIFACT_METADATA_COLUMNS = `
  artifact_id,
  thread_id,
  run_id,
  workspace_id,
  item_id,
  artifact_kind,
  label,
  payload_backend,
  payload_object_key,
  payload_uri,
  content_type,
  size_bytes,
  sha256,
  metadata_json,
  created_at,
  event_sequence,
  source_event_id,
  source_cursor,
  projection_version
`;

const UPSERT_ARTIFACT_METADATA_SQL = `
  INSERT INTO artifact_metadata (
    artifact_id,
    thread_id,
    run_id,
    workspace_id,
    item_id,
    artifact_kind,
    label,
    payload_backend,
    payload_object_key,
    payload_uri,
    content_type,
    size_bytes,
    sha256,
    metadata_json,
    created_at,
    event_sequence,
    source_event_id,
    source_cursor,
    projection_version
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19
  )
  ON CONFLICT (artifact_id)
  DO UPDATE SET
    item_id = EXCLUDED.item_id,
    artifact_kind = EXCLUDED.artifact_kind,
    label = EXCLUDED.label,
    payload_backend = EXCLUDED.payload_backend,
    payload_object_key = EXCLUDED.payload_object_key,
    payload_uri = EXCLUDED.payload_uri,
    content_type = EXCLUDED.content_type,
    size_bytes = EXCLUDED.size_bytes,
    sha256 = EXCLUDED.sha256,
    metadata_json = EXCLUDED.metadata_json,
    created_at = EXCLUDED.created_at,
    event_sequence = EXCLUDED.event_sequence,
    source_event_id = EXCLUDED.source_event_id,
    source_cursor = EXCLUDED.source_cursor,
    projection_version = EXCLUDED.projection_version
`;

const DELETE_ARTIFACT_CHANGED_FILES_SQL = `
  DELETE FROM artifact_metadata_changed_files
  WHERE artifact_id = $1
`;

const INSERT_ARTIFACT_CHANGED_FILE_SQL = `
  INSERT INTO artifact_metadata_changed_files (
    artifact_id,
    path,
    status,
    additions,
    deletions,
    previous_path
  )
  VALUES ($1, $2, $3, $4, $5, $6)
`;

const SELECT_ARTIFACT_SQL = `
  SELECT ${ARTIFACT_METADATA_COLUMNS}
  FROM artifact_metadata
  WHERE artifact_id = $1
`;

const SELECT_ARTIFACTS_BY_RUN_SQL = `
  SELECT ${ARTIFACT_METADATA_COLUMNS}
  FROM artifact_metadata
  WHERE run_id = $1
  ORDER BY event_sequence, created_at
`;

const SELECT_ARTIFACT_CHANGED_FILES_SQL = `
  SELECT artifact_id, path, status, additions, deletions, previous_path
  FROM artifact_metadata_changed_files
  WHERE artifact_id = $1
  ORDER BY path
`;
