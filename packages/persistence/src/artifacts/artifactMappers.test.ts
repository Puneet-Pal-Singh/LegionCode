import { describe, expect, it } from "vitest";
import { mapArtifactRow, type ArtifactRow } from "./artifactMappers.js";

describe("artifactMappers", () => {
  it("accepts Postgres changed-file metadata with nullable isStaged", () => {
    const record = mapArtifactRow({
      id: "artifact-1",
      user_id: "user-1",
      workspace_id: "workspace-1",
      session_id: "session-1",
      run_id: "run-1",
      repo_owner: "owner",
      repo_name: "repo",
      repo_url: "https://github.com/owner/repo",
      branch: "main",
      base_commit_sha: "abc123",
      head_commit_sha: null,
      artifact_kind: "git_patch",
      r2_object_key:
        "edit-artifacts/user-1/workspace-1/run-1/artifact-1/diff.patch",
      content_type: null,
      size_bytes: null,
      sha256: null,
      status: "pending",
      changed_files_json: [
        {
          path: "src/main.ts",
          status: "modified",
          additions: null,
          deletions: null,
          isStaged: null,
        },
      ],
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
      expires_at: "2026-06-10T00:00:00.000Z",
    } satisfies ArtifactRow);

    expect(record.changedFiles).toEqual([
      {
        path: "src/main.ts",
        status: "modified",
        additions: null,
        deletions: null,
        isStaged: null,
      },
    ]);
  });
});
