import type { D1Database } from "@cloudflare/workers-types";
import {
  CreateEditArtifactInputSchema,
  EditArtifactEventSchema,
  EditArtifactEventTypeSchema,
  EditArtifactRecordSchema,
  EditArtifactStatusSchema,
  type CreateEditArtifactInput,
  type EditArtifactEvent,
  type EditArtifactEventType,
  type EditArtifactRecord,
  type EditArtifactStatus,
} from "@repo/shared-types";

interface EditArtifactRow {
  id: string;
  run_id: string;
  session_id: string;
  workspace_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  repo_url: string | null;
  branch: string | null;
  base_commit_sha: string | null;
  head_commit_sha: string | null;
  artifact_kind: string;
  r2_object_key: string;
  changed_file_count: number;
  changed_files_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface AppendArtifactEventInput {
  id: string;
  artifactId: string;
  runId: string;
  eventType: EditArtifactEventType;
  message: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

const RESTORABLE_STATUSES: EditArtifactStatus[] = [
  "stored",
  "restored",
  "restore_failed",
  "requires_user_resolution",
];

export class D1EditArtifactRepository {
  constructor(private readonly db: D1Database) {}

  async createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord> {
    const parsed = CreateEditArtifactInputSchema.parse(input);
    const now = new Date().toISOString();
    const row = {
      ...parsed,
      changedFileCount: parsed.changedFiles.length,
      headCommitSha: null,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.db
      .prepare(
        `
        INSERT INTO run_edit_artifacts (
          id, run_id, session_id, workspace_id, repo_owner, repo_name,
          repo_url, branch, base_commit_sha, head_commit_sha, artifact_kind,
          r2_object_key, changed_file_count, changed_files_json, status,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        row.id,
        row.runId,
        row.sessionId,
        row.workspaceId,
        row.repoOwner,
        row.repoName,
        row.repoUrl,
        row.branch,
        row.baseCommitSha,
        row.headCommitSha,
        row.artifactKind,
        row.r2ObjectKey,
        row.changedFileCount,
        JSON.stringify(row.changedFiles),
        row.status,
        row.createdAt,
        row.updatedAt,
        row.expiresAt,
      )
      .run();

    if (!result.success) {
      throw new Error("Failed to create edit artifact metadata");
    }

    return EditArtifactRecordSchema.parse(row);
  }

  async appendEvent(input: AppendArtifactEventInput): Promise<EditArtifactEvent> {
    const event = EditArtifactEventSchema.parse({
      id: input.id,
      artifactId: input.artifactId,
      runId: input.runId,
      eventType: EditArtifactEventTypeSchema.parse(input.eventType),
      message: input.message,
      metadata: input.metadata ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });

    const result = await this.db
      .prepare(
        `
        INSERT INTO run_edit_artifact_events (
          id, artifact_id, run_id, event_type, message, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        event.id,
        event.artifactId,
        event.runId,
        event.eventType,
        event.message,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.createdAt,
      )
      .run();

    if (!result.success) {
      throw new Error("Failed to append edit artifact event");
    }

    return event;
  }

  async updateStatus(input: {
    artifactId: string;
    status: EditArtifactStatus;
    headCommitSha?: string | null;
  }): Promise<void> {
    const status = EditArtifactStatusSchema.parse(input.status);
    const result = await this.db
      .prepare(
        `
        UPDATE run_edit_artifacts
        SET status = ?, head_commit_sha = COALESCE(?, head_commit_sha), updated_at = ?
        WHERE id = ?
      `,
      )
      .bind(
        status,
        input.headCommitSha ?? null,
        new Date().toISOString(),
        input.artifactId,
      )
      .run();

    if (!result.success) {
      throw new Error("Failed to update edit artifact status");
    }
  }

  async getLatestRestorableArtifact(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const placeholders = RESTORABLE_STATUSES.map(() => "?").join(", ");
    const row = await this.db
      .prepare(
        `
        SELECT * FROM run_edit_artifacts
        WHERE run_id = ? AND status IN (${placeholders}) AND expires_at > ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .bind(runId, ...RESTORABLE_STATUSES, new Date().toISOString())
      .first<EditArtifactRow>();

    return row ? this.rowToRecord(row) : null;
  }

  async listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    const result = await this.db
      .prepare(
        `
        SELECT * FROM run_edit_artifacts
        WHERE expires_at <= ? AND status NOT IN ('expired', 'discarded', 'anchored')
        ORDER BY expires_at ASC
      `,
      )
      .bind(now)
      .all<EditArtifactRow>();

    return result.results.map((row) => this.rowToRecord(row));
  }

  private rowToRecord(row: EditArtifactRow): EditArtifactRecord {
    return EditArtifactRecordSchema.parse({
      id: row.id,
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
      changedFileCount: row.changed_file_count,
      changedFiles: JSON.parse(row.changed_files_json) as unknown,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    });
  }
}
