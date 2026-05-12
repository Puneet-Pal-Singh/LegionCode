import type { D1Database } from "@cloudflare/workers-types";
import type { EditArtifactRow } from "./EditArtifactRows";

export interface EventRow {
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

class EditArtifactMemoryStore {
  readonly artifacts = new Map<string, EditArtifactRow>();
  readonly events: EventRow[] = [];
}

export class MockEditArtifactD1 {
  private readonly store: EditArtifactMemoryStore;
  private readonly mutations: MockD1MutationHandler;
  private readonly queries: MockD1QueryHandler;

  constructor() {
    this.store = new EditArtifactMemoryStore();
    this.mutations = new MockD1MutationHandler(this.store);
    this.queries = new MockD1QueryHandler(this.store);
  }

  get artifacts(): Map<string, EditArtifactRow> {
    return this.store.artifacts;
  }

  get events(): EventRow[] {
    return this.store.events;
  }

  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        run: async (): Promise<RunResult> => this.mutations.run(sql, params),
        first: async <T>(): Promise<T | undefined> =>
          this.queries.first<T>(sql, params),
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.queries.all<T>(sql, params),
        }),
      }),
    };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

class MockD1MutationHandler {
  constructor(private readonly store: EditArtifactMemoryStore) {}

  run(sql: string, params: unknown[]): RunResult {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("INSERT INTO run_edit_artifacts")) {
      insertArtifact(this.store, params);
      return { success: true };
    }

    if (normalized.startsWith("INSERT INTO run_edit_artifact_events")) {
      insertEvent(this.store, params);
      return { success: true };
    }

    if (normalized.startsWith("UPDATE run_edit_artifacts")) {
      updateArtifact(this.store, params);
      return { success: true };
    }

    throw new Error(`Unsupported SQL mutation: ${normalized}`);
  }
}

class MockD1QueryHandler {
  constructor(private readonly store: EditArtifactMemoryStore) {}

  first<T>(sql: string, params: unknown[]): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  all<T>(sql: string, params: unknown[]): T[] {
    const normalized = normalizeSql(sql);
    if (normalized.includes("WHERE run_id = ? AND status IN")) {
      return this.findRestorableArtifacts(params) as T[];
    }

    if (normalized.includes("WHERE expires_at <= ?")) {
      return this.findExpiredArtifacts(params) as T[];
    }

    if (normalized.includes("WHERE status = 'pending' AND created_at <= ?")) {
      return this.findStalePendingArtifacts(params) as T[];
    }

    throw new Error(`Unsupported SQL query: ${normalized}`);
  }

  private findRestorableArtifacts(params: unknown[]): EditArtifactRow[] {
    const runId = String(params[0]);
    const statuses = params.slice(1, -1).map(String);
    const now = String(params[params.length - 1]);
    return sortedArtifacts(this.store).filter(
      (row) =>
        row.run_id === runId &&
        statuses.includes(row.status) &&
        row.expires_at > now,
    );
  }

  private findExpiredArtifacts(params: unknown[]): EditArtifactRow[] {
    const now = String(params[0]);
    return Array.from(this.store.artifacts.values())
      .filter(
        (row) =>
          row.expires_at <= now &&
          !["expired", "discarded", "anchored"].includes(row.status),
      )
      .sort((left, right) => left.expires_at.localeCompare(right.expires_at));
  }

  private findStalePendingArtifacts(params: unknown[]): EditArtifactRow[] {
    const cutoff = String(params[0]);
    return Array.from(this.store.artifacts.values())
      .filter((row) => row.status === "pending" && row.created_at <= cutoff)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
}

function insertArtifact(
  store: EditArtifactMemoryStore,
  params: unknown[],
): void {
  const row = mapArtifactParams(params);
  store.artifacts.set(row.id, row);
}

function insertEvent(store: EditArtifactMemoryStore, params: unknown[]): void {
  const [id, artifactId, runId, eventType, message, metadataJson, createdAt] =
    params;
  store.events.push({
    id: String(id),
    artifact_id: String(artifactId),
    run_id: String(runId),
    event_type: String(eventType),
    message: String(message),
    metadata_json: nullableString(metadataJson),
    created_at: String(createdAt),
  });
}

function updateArtifact(
  store: EditArtifactMemoryStore,
  params: unknown[],
): void {
  const [status, headCommitSha, updatedAt, artifactId] = params;
  const artifact = store.artifacts.get(String(artifactId));
  if (!artifact) {
    return;
  }

  artifact.status = String(status);
  artifact.updated_at = String(updatedAt);
  if (headCommitSha !== null && headCommitSha !== undefined) {
    artifact.head_commit_sha = String(headCommitSha);
  }
}

function mapArtifactParams(params: unknown[]): EditArtifactRow {
  return {
    id: stringAt(params, 0),
    run_id: stringAt(params, 1),
    session_id: stringAt(params, 2),
    workspace_id: stringAt(params, 3),
    repo_owner: nullableStringAt(params, 4),
    repo_name: nullableStringAt(params, 5),
    repo_url: nullableStringAt(params, 6),
    branch: nullableStringAt(params, 7),
    base_commit_sha: nullableStringAt(params, 8),
    head_commit_sha: nullableStringAt(params, 9),
    artifact_kind: stringAt(params, 10),
    r2_object_key: stringAt(params, 11),
    changed_file_count: numberAt(params, 12),
    changed_files_json: stringAt(params, 13),
    status: stringAt(params, 14),
    created_at: stringAt(params, 15),
    updated_at: stringAt(params, 16),
    expires_at: stringAt(params, 17),
  };
}

function stringAt(values: unknown[], index: number): string {
  return String(values[index]);
}

function numberAt(values: unknown[], index: number): number {
  return Number(values[index]);
}

function nullableStringAt(values: unknown[], index: number): string | null {
  return nullableString(values[index]);
}

function sortedArtifacts(store: EditArtifactMemoryStore): EditArtifactRow[] {
  return Array.from(store.artifacts.values()).sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
