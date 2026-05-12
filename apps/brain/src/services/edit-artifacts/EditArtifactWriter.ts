import type { D1Database } from "@cloudflare/workers-types";
import {
  EditArtifactStatusSchema,
  type CreateEditArtifactInput,
  type EditArtifactEvent,
  type EditArtifactRecord,
  type EditArtifactStatus,
} from "@repo/shared-types";
import {
  buildArtifactEvent,
  buildPendingArtifactRecord,
  type AppendArtifactEventInput,
} from "./EditArtifactRows";

const INSERT_ARTIFACT_SQL = `
  INSERT INTO run_edit_artifacts (
    id, run_id, session_id, workspace_id, repo_owner, repo_name,
    repo_url, branch, base_commit_sha, head_commit_sha, artifact_kind,
    r2_object_key, changed_file_count, changed_files_json, status,
    created_at, updated_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EVENT_SQL = `
  INSERT INTO run_edit_artifact_events (
    id, artifact_id, run_id, event_type, message, metadata_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_STATUS_SQL = `
  UPDATE run_edit_artifacts
  SET status = ?, head_commit_sha = COALESCE(?, head_commit_sha), updated_at = ?
  WHERE id = ?
`;

export class EditArtifactWriter {
  constructor(private readonly db: D1Database) {}

  async createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord> {
    const record = buildPendingArtifactRecord(input);
    await runMutation(
      this.db,
      INSERT_ARTIFACT_SQL,
      artifactBindings(record),
      "Failed to create edit artifact metadata",
    );
    return record;
  }

  async appendEvent(
    input: AppendArtifactEventInput,
  ): Promise<EditArtifactEvent> {
    const event = buildArtifactEvent(input);
    await runMutation(
      this.db,
      INSERT_EVENT_SQL,
      eventBindings(event),
      "Failed to append edit artifact event",
    );
    return event;
  }

  async updateStatus(input: {
    artifactId: string;
    status: EditArtifactStatus;
    headCommitSha?: string | null;
  }): Promise<void> {
    await runMutation(
      this.db,
      UPDATE_STATUS_SQL,
      statusBindings(input),
      "Failed to update edit artifact status",
      { requireRowsWritten: true },
    );
  }
}

function artifactBindings(record: EditArtifactRecord): unknown[] {
  return [
    record.id,
    record.runId,
    record.sessionId,
    record.workspaceId,
    record.repoOwner,
    record.repoName,
    record.repoUrl,
    record.branch,
    record.baseCommitSha,
    record.headCommitSha,
    record.artifactKind,
    record.r2ObjectKey,
    record.changedFileCount,
    JSON.stringify(record.changedFiles),
    record.status,
    record.createdAt,
    record.updatedAt,
    record.expiresAt,
  ];
}

function eventBindings(event: EditArtifactEvent): unknown[] {
  return [
    event.id,
    event.artifactId,
    event.runId,
    event.eventType,
    event.message,
    event.metadata ? JSON.stringify(event.metadata) : null,
    event.createdAt,
  ];
}

function statusBindings(input: {
  artifactId: string;
  status: EditArtifactStatus;
  headCommitSha?: string | null;
}): unknown[] {
  return [
    EditArtifactStatusSchema.parse(input.status),
    input.headCommitSha ?? null,
    new Date().toISOString(),
    input.artifactId,
  ];
}

async function runMutation(
  db: D1Database,
  sql: string,
  bindings: unknown[],
  errorMessage: string,
  options: { requireRowsWritten?: boolean } = {},
): Promise<void> {
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .run();
  if (!result.success) {
    throw new Error(errorMessage);
  }
  if (options.requireRowsWritten && getRowsWritten(result) === 0) {
    throw new Error(`${errorMessage}: artifact row not found`);
  }
}

type D1MutationResult = Awaited<
  ReturnType<ReturnType<D1Database["prepare"]>["run"]>
>;

function getRowsWritten(result: D1MutationResult): number | null {
  const rowsWritten = result.meta?.rows_written;
  return typeof rowsWritten === "number" ? rowsWritten : null;
}
