import {
  CreateEditArtifactInputSchema,
  EditArtifactEventSchema,
  EditArtifactEventTypeSchema,
  EditArtifactRecordSchema,
  type CreateEditArtifactInput,
  type EditArtifactEvent,
  type EditArtifactEventType,
  type EditArtifactRecord,
} from "@repo/shared-types";

export interface EditArtifactRow {
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

export interface AppendArtifactEventInput {
  id: string;
  artifactId: string;
  runId: string;
  eventType: EditArtifactEventType;
  message: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export function buildPendingArtifactRecord(
  input: CreateEditArtifactInput,
): EditArtifactRecord {
  const parsed = CreateEditArtifactInputSchema.parse(input);
  const now = new Date().toISOString();

  return EditArtifactRecordSchema.parse({
    ...parsed,
    changedFileCount: parsed.changedFiles.length,
    headCommitSha: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
}

export function buildArtifactEvent(
  input: AppendArtifactEventInput,
): EditArtifactEvent {
  return EditArtifactEventSchema.parse({
    id: input.id,
    artifactId: input.artifactId,
    runId: input.runId,
    eventType: EditArtifactEventTypeSchema.parse(input.eventType),
    message: input.message,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function rowToRecord(row: EditArtifactRow): EditArtifactRecord {
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
