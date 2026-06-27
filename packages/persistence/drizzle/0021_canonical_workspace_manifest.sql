ALTER TABLE workspace_manifests DROP CONSTRAINT IF EXISTS workspace_manifests_state_check;
ALTER TABLE workspace_manifests DROP COLUMN manifest_id;
ALTER TABLE workspace_manifests DROP COLUMN user_id;
ALTER TABLE workspace_manifests RENAME COLUMN base_commit_sha TO base_sha;
ALTER TABLE workspace_manifests RENAME COLUMN head_commit_sha TO head_sha;
ALTER TABLE workspace_manifests ADD PRIMARY KEY (workspace_id);
ALTER TABLE workspace_manifests
  ADD CONSTRAINT workspace_manifests_state_check
  CHECK (state IN ('empty', 'preparing', 'cloning', 'ready', 'dirty', 'committed', 'pushed', 'pr_opened', 'failed', 'closed'));
