import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";

interface ArtifactRow {
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

interface EventRow {
  id: string;
  artifact_id: string;
  run_id: string;
  event_type: string;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

interface RunResult {
  success: boolean;
}

class MockEditArtifactD1 {
  readonly artifacts = new Map<string, ArtifactRow>();
  readonly events: EventRow[] = [];

  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        run: async (): Promise<RunResult> => this.run(sql, params),
        first: async <T>(): Promise<T | undefined> =>
          this.first(sql, params) as T | undefined,
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.all(sql, params) as T[],
        }),
      }),
    };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  private run(sql: string, params: unknown[]): RunResult {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("INSERT INTO run_edit_artifacts")) {
      this.insertArtifact(params);
      return { success: true };
    }

    if (normalized.startsWith("INSERT INTO run_edit_artifact_events")) {
      this.insertEvent(params);
      return { success: true };
    }

    if (normalized.startsWith("UPDATE run_edit_artifacts")) {
      this.updateArtifact(params);
      return { success: true };
    }

    throw new Error(`Unsupported SQL mutation: ${normalized}`);
  }

  private first(sql: string, params: unknown[]): ArtifactRow | undefined {
    return this.all(sql, params)[0];
  }

  private all(sql: string, params: unknown[]): ArtifactRow[] {
    const normalized = normalizeSql(sql);
    if (normalized.includes("WHERE run_id = ? AND status IN")) {
      const runId = String(params[0]);
      const statuses = params.slice(1, -1).map(String);
      const now = String(params[params.length - 1]);
      return Array.from(this.artifacts.values())
        .filter(
          (row) =>
            row.run_id === runId &&
            statuses.includes(row.status) &&
            row.expires_at > now,
        )
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    }

    if (normalized.includes("WHERE expires_at <= ?")) {
      const now = String(params[0]);
      return Array.from(this.artifacts.values())
        .filter(
          (row) =>
            row.expires_at <= now &&
            !["expired", "discarded", "anchored"].includes(row.status),
        )
        .sort((left, right) => left.expires_at.localeCompare(right.expires_at));
    }

    throw new Error(`Unsupported SQL query: ${normalized}`);
  }

  private insertArtifact(params: unknown[]): void {
    const [
      id,
      runId,
      sessionId,
      workspaceId,
      repoOwner,
      repoName,
      repoUrl,
      branch,
      baseCommitSha,
      headCommitSha,
      artifactKind,
      r2ObjectKey,
      changedFileCount,
      changedFilesJson,
      status,
      createdAt,
      updatedAt,
      expiresAt,
    ] = params;
    this.artifacts.set(String(id), {
      id: String(id),
      run_id: String(runId),
      session_id: String(sessionId),
      workspace_id: String(workspaceId),
      repo_owner: nullableString(repoOwner),
      repo_name: nullableString(repoName),
      repo_url: nullableString(repoUrl),
      branch: nullableString(branch),
      base_commit_sha: nullableString(baseCommitSha),
      head_commit_sha: nullableString(headCommitSha),
      artifact_kind: String(artifactKind),
      r2_object_key: String(r2ObjectKey),
      changed_file_count: Number(changedFileCount),
      changed_files_json: String(changedFilesJson),
      status: String(status),
      created_at: String(createdAt),
      updated_at: String(updatedAt),
      expires_at: String(expiresAt),
    });
  }

  private insertEvent(params: unknown[]): void {
    const [id, artifactId, runId, eventType, message, metadataJson, createdAt] =
      params;
    this.events.push({
      id: String(id),
      artifact_id: String(artifactId),
      run_id: String(runId),
      event_type: String(eventType),
      message: String(message),
      metadata_json: nullableString(metadataJson),
      created_at: String(createdAt),
    });
  }

  private updateArtifact(params: unknown[]): void {
    const [status, headCommitSha, updatedAt, artifactId] = params;
    const artifact = this.artifacts.get(String(artifactId));
    if (!artifact) {
      return;
    }

    artifact.status = String(status);
    artifact.updated_at = String(updatedAt);
    if (headCommitSha !== null && headCommitSha !== undefined) {
      artifact.head_commit_sha = String(headCommitSha);
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

describe("D1EditArtifactRepository", () => {
  let db: MockEditArtifactD1;
  let repository: D1EditArtifactRepository;

  beforeEach(() => {
    db = new MockEditArtifactD1();
    repository = new D1EditArtifactRepository(db.asD1());
  });

  it("creates pending artifact metadata and appends capture events", async () => {
    const artifact = await repository.createPendingArtifact({
      id: "artifact-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: "owner",
      repoName: "repo",
      repoUrl: "https://github.com/owner/repo",
      branch: "main",
      baseCommitSha: "abc123",
      artifactKind: "git_patch",
      r2ObjectKey: "edit-artifacts/workspace-1/run-1/artifact-1/diff.patch",
      changedFiles: [{ path: "src/main.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const event = await repository.appendEvent({
      id: "event-1",
      artifactId: artifact.id,
      runId: artifact.runId,
      eventType: "capture_started",
      message: "Capture started",
      metadata: { r2ObjectKey: artifact.r2ObjectKey },
    });

    expect(artifact.status).toBe("pending");
    expect(artifact.changedFileCount).toBe(1);
    expect(event.eventType).toBe("capture_started");
    expect(db.events).toHaveLength(1);
  });

  it("returns latest non-expired restorable artifact", async () => {
    await repository.createPendingArtifact({
      id: "artifact-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      repoOwner: null,
      repoName: null,
      repoUrl: null,
      branch: "main",
      baseCommitSha: null,
      artifactKind: "git_patch",
      r2ObjectKey: "key-1",
      changedFiles: [{ path: "a.ts", status: "modified" }],
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await repository.updateStatus({
      artifactId: "artifact-1",
      status: "stored",
    });

    const latest = await repository.getLatestRestorableArtifact("run-1");

    expect(latest?.id).toBe("artifact-1");
    expect(latest?.status).toBe("stored");
  });
});
