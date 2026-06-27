import {
  EVENT_SCHEMA_VERSION,
  ArtifactEventSchema,
  type ArtifactEvent,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresArtifactMetadataRepository } from "./PostgresArtifactMetadataRepository.js";

interface ArtifactRow extends SqlRow {
  artifact_id: string;
  thread_id: string;
  run_id: string;
  workspace_id: string;
  item_id: string | null;
  artifact_kind: string;
  label: string;
  payload_backend: string;
  payload_object_key: string;
  payload_uri: string | null;
  content_type: string;
  size_bytes: number;
  sha256: string;
  metadata_json: unknown;
  created_at: string;
  event_sequence: number;
  source_event_id: string;
  source_cursor: string;
  projection_version: number;
}

interface ChangedFileRow extends SqlRow {
  artifact_id: string;
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  previous_path: string | null;
}

class ArtifactSqlClient implements SqlClient {
  private readonly artifacts = new Map<string, ArtifactRow>();
  private readonly files = new Map<string, ChangedFileRow>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (statement.includes("INSERT INTO artifact_metadata_changed_files")) {
      this.insertChangedFile(params);
      return rowsResult<Row>([]);
    }
    if (statement.includes("DELETE FROM artifact_metadata_changed_files")) {
      this.deleteChangedFiles(params);
      return rowsResult<Row>([]);
    }
    if (statement.includes("INSERT INTO artifact_metadata")) {
      const row = createArtifactRow(params);
      this.artifacts.set(row.artifact_id, row);
      return rowsResult<Row>([]);
    }
    if (statement.includes("FROM artifact_metadata_changed_files")) {
      return rowsResult<Row>(this.selectChangedFiles(params));
    }
    if (statement.includes("WHERE artifact_id = $1")) {
      const row = this.artifacts.get(readStringParam(params[0], "artifact_id"));
      return rowsResult<Row>(row ? [row] : []);
    }
    if (statement.includes("WHERE run_id = $1")) {
      return rowsResult<Row>(this.selectArtifactsByRun(params));
    }
    throw new Error(`Unhandled SQL: ${statement}`);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return await callback(this);
  }

  private insertChangedFile(params: readonly SqlValue[]): void {
    const row = createChangedFileRow(params);
    this.files.set(`${row.artifact_id}:${row.path}`, row);
  }

  private deleteChangedFiles(params: readonly SqlValue[]): void {
    const artifactId = readStringParam(params[0], "artifact_id");
    for (const key of this.files.keys()) {
      if (key.startsWith(`${artifactId}:`)) {
        this.files.delete(key);
      }
    }
  }

  private selectChangedFiles(params: readonly SqlValue[]): ChangedFileRow[] {
    const artifactId = readStringParam(params[0], "artifact_id");
    return [...this.files.values()]
      .filter((row) => row.artifact_id === artifactId)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private selectArtifactsByRun(params: readonly SqlValue[]): ArtifactRow[] {
    const runId = readStringParam(params[0], "run_id");
    return [...this.artifacts.values()]
      .filter((row) => row.run_id === runId)
      .sort((left, right) => left.event_sequence - right.event_sequence);
  }
}

describe("PostgresArtifactMetadataRepository", () => {
  it("persists artifact events with payload refs and changed files", async () => {
    const repository = new PostgresArtifactMetadataRepository(
      new ArtifactSqlClient(),
    );

    const record = await repository.putArtifactFromEvent(createArtifactEvent());
    const artifacts = await repository.listArtifactsByRun("run_abc123");

    expect(record.kind).toBe("diff");
    expect(record.payloadRef.sha256).toBe("e".repeat(64));
    expect(record.changedFiles[0]).toMatchObject({
      path: "packages/persistence/src/index.ts",
      status: "modified",
    });
    expect(artifacts).toHaveLength(1);
  });
});

function createArtifactEvent(): ArtifactEvent {
  return ArtifactEventSchema.parse({
    eventId: "evt_artifact01",
    threadId: "thr_abc123",
    runId: "run_abc123",
    workspaceId: "wrk_abc123",
    scopeType: "artifact",
    scopeId: "art_abc123",
    sequence: 1,
    cursor: "cursor_abc123",
    idempotencyKey: "artifact:diff",
    createdAt: "2026-06-09T12:00:00.000Z",
    producer: {
      kind: "runtime_kernel",
      id: "kernel",
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    type: "artifact.created",
    payload: {
      itemId: "itm_abc123",
      artifact: {
        artifactId: "art_abc123",
        threadId: "thr_abc123",
        runId: "run_abc123",
        workspaceId: "wrk_abc123",
        itemId: "itm_abc123",
        kind: "diff",
        label: "Diff",
        payloadRef: {
          backend: "r2",
          objectKey: "artifacts/run_abc123/diff.patch",
          uri: null,
          contentType: "text/x-diff",
          sizeBytes: 2048,
          sha256: "e".repeat(64),
        },
        changedFiles: [
          {
            path: "packages/persistence/src/index.ts",
            status: "modified",
            additions: 4,
            deletions: 1,
            previousPath: null,
          },
        ],
        metadata: { source: "git.diff.updated" },
        createdAt: "2026-06-09T12:00:00.000Z",
        eventSequence: 1,
      },
    },
  });
}

function createArtifactRow(params: readonly SqlValue[]): ArtifactRow {
  return {
    artifact_id: readStringParam(params[0], "artifact_id"),
    thread_id: readStringParam(params[1], "thread_id"),
    run_id: readStringParam(params[2], "run_id"),
    workspace_id: readStringParam(params[3], "workspace_id"),
    item_id: readNullableStringParam(params[4], "item_id"),
    artifact_kind: readStringParam(params[5], "artifact_kind"),
    label: readStringParam(params[6], "label"),
    payload_backend: readStringParam(params[7], "payload_backend"),
    payload_object_key: readStringParam(params[8], "payload_object_key"),
    payload_uri: readNullableStringParam(params[9], "payload_uri"),
    content_type: readStringParam(params[10], "content_type"),
    size_bytes: readNumberParam(params[11], "size_bytes"),
    sha256: readStringParam(params[12], "sha256"),
    metadata_json: params[13],
    created_at: readStringParam(params[14], "created_at"),
    event_sequence: readNumberParam(params[15], "event_sequence"),
    source_event_id: readStringParam(params[16], "source_event_id"),
    source_cursor: readStringParam(params[17], "source_cursor"),
    projection_version: readNumberParam(params[18], "projection_version"),
  };
}

function createChangedFileRow(params: readonly SqlValue[]): ChangedFileRow {
  return {
    artifact_id: readStringParam(params[0], "artifact_id"),
    path: readStringParam(params[1], "path"),
    status: readStringParam(params[2], "status"),
    additions: readNullableNumberParam(params[3], "additions"),
    deletions: readNullableNumberParam(params[4], "deletions"),
    previous_path: readNullableStringParam(params[5], "previous_path"),
  };
}

function rowsResult<Row extends SqlRow>(rows: readonly SqlRow[]): SqlQueryResult<Row> {
  return { rows: rows as Row[], rowCount: rows.length };
}

function readStringParam(value: SqlValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string param: ${name}`);
  }
  return value;
}

function readNullableStringParam(
  value: SqlValue | undefined,
  name: string,
): string | null {
  return value === null ? null : readStringParam(value, name);
}

function readNumberParam(value: SqlValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Expected number param: ${name}`);
  }
  return value;
}

function readNullableNumberParam(
  value: SqlValue | undefined,
  name: string,
): number | null {
  return value === null ? null : readNumberParam(value, name);
}
