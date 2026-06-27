CREATE TABLE IF NOT EXISTS workspace_manifests (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  permission_profile_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  working_branch TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  head_commit_sha TEXT NOT NULL,
  execution_location TEXT NOT NULL,
  filesystem_root TEXT NOT NULL,
  artifact_namespace TEXT NOT NULL,
  state TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT workspace_manifests_state_check
    CHECK (state IN ('preparing', 'ready', 'dirty', 'failed', 'archived')),
  CONSTRAINT workspace_manifests_execution_location_check
    CHECK (execution_location IN ('cloud_sandbox', 'desktop_local', 'local_worktree', 'cloud_vm', 'ssh_remote', 'self_hosted_worker'))
);

CREATE INDEX IF NOT EXISTS workspace_manifests_run_updated_idx
  ON workspace_manifests (run_id, updated_at);

CREATE INDEX IF NOT EXISTS workspace_manifests_workspace_updated_idx
  ON workspace_manifests (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS artifact_metadata (
  artifact_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  item_id TEXT,
  artifact_kind TEXT NOT NULL,
  label TEXT NOT NULL,
  payload_backend TEXT NOT NULL,
  payload_object_key TEXT NOT NULL,
  payload_uri TEXT,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  event_sequence BIGINT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_cursor TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  CONSTRAINT artifact_metadata_kind_check
    CHECK (artifact_kind IN ('git_patch', 'file_snapshot', 'command_log', 'diff', 'screenshot', 'browser_recording', 'context_checkpoint', 'workspace_snapshot', 'final_report', 'generated_file')),
  CONSTRAINT artifact_metadata_payload_backend_check
    CHECK (payload_backend IN ('r2', 'cloudflare_artifacts', 'local_blob')),
  CONSTRAINT artifact_metadata_size_check
    CHECK (size_bytes >= 0),
  CONSTRAINT artifact_metadata_sha256_check
    CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT artifact_metadata_event_sequence_check
    CHECK (event_sequence >= 0),
  CONSTRAINT artifact_metadata_projection_version_check
    CHECK (projection_version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_metadata_payload_object_key_idx
  ON artifact_metadata (payload_object_key);

CREATE INDEX IF NOT EXISTS artifact_metadata_run_sequence_idx
  ON artifact_metadata (run_id, event_sequence);

CREATE INDEX IF NOT EXISTS artifact_metadata_workspace_created_idx
  ON artifact_metadata (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_metadata_changed_files (
  artifact_id TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  additions BIGINT,
  deletions BIGINT,
  previous_path TEXT,
  CONSTRAINT artifact_metadata_changed_files_artifact_fk
    FOREIGN KEY (artifact_id)
    REFERENCES artifact_metadata (artifact_id)
    ON DELETE CASCADE,
  CONSTRAINT artifact_metadata_changed_files_status_check
    CHECK (status IN ('added', 'modified', 'deleted', 'renamed', 'copied', 'unchanged')),
  CONSTRAINT artifact_metadata_changed_files_additions_check
    CHECK (additions IS NULL OR additions >= 0),
  CONSTRAINT artifact_metadata_changed_files_deletions_check
    CHECK (deletions IS NULL OR deletions >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_metadata_changed_files_artifact_path_idx
  ON artifact_metadata_changed_files (artifact_id, path);
