import {
  ProtocolTimestampSchema,
  LeaseIdSchema,
  RunAttemptIdSchema,
  TaskCheckoutSchema,
  TaskCheckoutIdSchema,
  WorkspaceSnapshotIdSchema,
  WorkspaceSnapshotSchema,
  type LeaseId,
  type RunAttemptId,
  type TaskCheckout,
  type TaskCheckoutId,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotId,
} from "@repo/platform-protocol";
import { parseJsonColumn, stringifyJsonColumn } from "../providers/json.js";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import {
  TaskWorkspacePersistenceError,
  type SettleTaskCheckoutInput,
  type TaskWorkspaceRepository,
} from "./types.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

interface WorkspaceSnapshotRow extends SqlRow {
  snapshot_id?: string;
  workspace_id?: string;
  repository_provider?: string;
  repository_owner?: string | null;
  repository_name?: string;
  repository_url?: string;
  authorized_commit_id?: string;
  authorized_tree_id?: string;
  manifest_digest?: string;
  config_digest?: string;
  captured_at?: string | Date;
  provenance_json?: unknown;
}

interface TaskCheckoutRow extends SqlRow {
  checkout_id?: string;
  snapshot_id?: string;
  workspace_id?: string;
  thread_id?: string;
  turn_id?: string;
  run_attempt_id?: string;
  lease_id?: string;
  sandbox_id?: string;
  filesystem_root?: string;
  git_dir?: string;
  index_file?: string;
  working_branch?: string;
  start_tree_id?: string;
  generation?: number;
  status?: string;
  settled_at?: string | Date | null;
  failure_code?: string | null;
  created_at?: string | Date;
}

/**
 * Durable owner for immutable snapshot records and one isolated checkout per
 * run attempt/lease. The runtime will compose this port later; no browser or
 * adapter writes these rows directly.
 */
export class PostgresTaskWorkspaceRepository implements TaskWorkspaceRepository {
  constructor(private readonly client: SqlClient) {}

  async issueSnapshotCheckout(
    snapshot: WorkspaceSnapshot,
    checkout: TaskCheckout,
  ): Promise<{
    readonly snapshot: WorkspaceSnapshot;
    readonly checkout: TaskCheckout;
  }> {
    const parsedSnapshot = WorkspaceSnapshotSchema.parse(snapshot);
    const parsedCheckout = TaskCheckoutSchema.parse(checkout);
    assertReadyCheckoutMatchesSnapshot(parsedSnapshot, parsedCheckout);

    return await this.client.transaction(async (transaction) => {
      const repository = new PostgresTaskWorkspaceRepository(transaction);
      const persistedSnapshot = await repository.createSnapshot(parsedSnapshot);
      const persistedCheckout = await repository.createCheckout(parsedCheckout);
      return {
        snapshot: persistedSnapshot,
        checkout: persistedCheckout,
      };
    });
  }

  async createSnapshot(
    snapshot: WorkspaceSnapshot,
  ): Promise<WorkspaceSnapshot> {
    const parsed = WorkspaceSnapshotSchema.parse(snapshot);
    try {
      return await writeSnapshot(this.client, INSERT_SNAPSHOT_SQL, parsed);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.getBySnapshotId(parsed.snapshotId);
      if (existing && canonicalEqual(existing, parsed)) return existing;

      throw new TaskWorkspacePersistenceError(
        "workspace_snapshot_conflict",
        "Workspace snapshot identity is already bound to different immutable data",
        { snapshotId: parsed.snapshotId },
      );
    }
  }

  async getBySnapshotId(
    snapshotId: WorkspaceSnapshotId,
  ): Promise<WorkspaceSnapshot | null> {
    const parsedSnapshotId = WorkspaceSnapshotIdSchema.parse(snapshotId);
    const result = await this.client.query<WorkspaceSnapshotRow>(
      SELECT_SNAPSHOT_BY_ID_SQL,
      [parsedSnapshotId],
    );
    return mapOptionalSnapshot(result.rows[0]);
  }

  async createCheckout(checkout: TaskCheckout): Promise<TaskCheckout> {
    const parsed = TaskCheckoutSchema.parse(checkout);
    if (parsed.status !== "ready") {
      throw new TaskWorkspacePersistenceError(
        "task_checkout_transition_invalid",
        "Task checkouts must be created in the ready state",
        { checkoutId: parsed.checkoutId, status: parsed.status },
      );
    }
    const snapshot = await this.getBySnapshotId(parsed.snapshotId);
    if (!snapshot) {
      throw new TaskWorkspacePersistenceError(
        "workspace_snapshot_not_found",
        "Task checkout requires an existing workspace snapshot",
        { snapshotId: parsed.snapshotId },
      );
    }
    assertReadyCheckoutMatchesSnapshot(snapshot, parsed);

    try {
      return await writeCheckout(this.client, INSERT_CHECKOUT_SQL, parsed);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existingById = await this.getByCheckoutId(parsed.checkoutId);
      if (existingById && canonicalEqual(existingById, parsed)) {
        return existingById;
      }

      const [existingByAttempt, existingByLease] = await Promise.all([
        this.getByRunAttemptId(parsed.runAttemptId),
        this.getByLeaseId(parsed.leaseId),
      ]);
      const conflicting = existingById ?? existingByAttempt ?? existingByLease;
      throw new TaskWorkspacePersistenceError(
        "task_checkout_conflict",
        "Task checkout identity cannot replace an existing isolated checkout",
        {
          checkoutId: parsed.checkoutId,
          conflictingCheckoutId: conflicting?.checkoutId ?? "unknown",
          leaseId: parsed.leaseId,
          runAttemptId: parsed.runAttemptId,
        },
      );
    }
  }

  async getByCheckoutId(
    checkoutId: TaskCheckoutId,
  ): Promise<TaskCheckout | null> {
    const parsedCheckoutId = TaskCheckoutIdSchema.parse(checkoutId);
    return await readCheckout(this.client, SELECT_CHECKOUT_BY_ID_SQL, [
      parsedCheckoutId,
    ]);
  }

  async getByRunAttemptId(
    runAttemptId: RunAttemptId,
  ): Promise<TaskCheckout | null> {
    const parsedRunAttemptId = RunAttemptIdSchema.parse(runAttemptId);
    return await readCheckout(this.client, SELECT_CHECKOUT_BY_RUN_ATTEMPT_SQL, [
      parsedRunAttemptId,
    ]);
  }

  async getByLeaseId(leaseId: LeaseId): Promise<TaskCheckout | null> {
    const parsedLeaseId = LeaseIdSchema.parse(leaseId);
    return await readCheckout(this.client, SELECT_CHECKOUT_BY_LEASE_SQL, [
      parsedLeaseId,
    ]);
  }

  async activate(checkoutId: TaskCheckoutId): Promise<TaskCheckout> {
    return await this.transition(checkoutId, "ready", {
      status: "active",
      settledAt: null,
      failureCode: null,
    });
  }

  async settle(input: SettleTaskCheckoutInput): Promise<TaskCheckout> {
    const settledAt = ProtocolTimestampSchema.parse(input.settledAt);
    const next =
      input.status === "settled"
        ? { status: "settled" as const, settledAt, failureCode: null }
        : {
            status: "failed" as const,
            settledAt,
            failureCode: input.failureCode,
          };

    return await this.transition(input.checkoutId, "active", next);
  }

  private async transition(
    checkoutId: TaskCheckoutId,
    expectedStatus: "ready" | "active",
    next: Pick<TaskCheckout, "status" | "settledAt" | "failureCode">,
  ): Promise<TaskCheckout> {
    const parsedCheckoutId = TaskCheckoutIdSchema.parse(checkoutId);
    return await this.client.transaction(async (transaction) => {
      const current = await readCheckout(
        transaction,
        SELECT_CHECKOUT_BY_ID_FOR_UPDATE_SQL,
        [parsedCheckoutId],
      );
      if (!current) {
        throw new TaskWorkspacePersistenceError(
          "task_checkout_not_found",
          "Task checkout does not exist",
          { checkoutId: parsedCheckoutId },
        );
      }
      if (current.status !== expectedStatus) {
        throw new TaskWorkspacePersistenceError(
          "task_checkout_transition_invalid",
          "Task checkout state transition is not permitted",
          {
            checkoutId: parsedCheckoutId,
            expectedStatus,
            actualStatus: current.status,
          },
        );
      }

      const candidate = TaskCheckoutSchema.parse({ ...current, ...next });
      const result = await transaction.query<TaskCheckoutRow>(
        TRANSITION_CHECKOUT_SQL,
        [
          parsedCheckoutId,
          expectedStatus,
          candidate.status,
          candidate.settledAt,
          candidate.failureCode,
        ],
      );
      const persisted = mapOptionalCheckout(result.rows[0]);
      if (persisted) return persisted;

      throw new TaskWorkspacePersistenceError(
        "task_checkout_transition_conflict",
        "Task checkout changed before its transition could be persisted",
        { checkoutId: parsedCheckoutId, expectedStatus },
      );
    });
  }
}

function assertReadyCheckoutMatchesSnapshot(
  snapshot: WorkspaceSnapshot,
  checkout: TaskCheckout,
): void {
  if (checkout.status !== "ready") {
    throw new TaskWorkspacePersistenceError(
      "task_checkout_transition_invalid",
      "Task checkouts must be issued in the ready state",
      { checkoutId: checkout.checkoutId, status: checkout.status },
    );
  }
  if (
    snapshot.snapshotId === checkout.snapshotId &&
    snapshot.workspaceId === checkout.workspaceId &&
    snapshot.authorizedTreeId === checkout.startTreeId
  ) {
    return;
  }

  throw new TaskWorkspacePersistenceError(
    "task_checkout_scope_mismatch",
    "Task checkout must match its immutable snapshot workspace and start tree",
    {
      checkoutId: checkout.checkoutId,
      snapshotId: checkout.snapshotId,
      workspaceId: checkout.workspaceId,
    },
  );
}

function snapshotParams(snapshot: WorkspaceSnapshot): readonly SqlValue[] {
  return [
    snapshot.snapshotId,
    snapshot.workspaceId,
    snapshot.repository.provider,
    snapshot.repository.owner,
    snapshot.repository.name,
    snapshot.repository.canonicalUrl,
    snapshot.authorizedCommitId,
    snapshot.authorizedTreeId,
    snapshot.manifestDigest,
    snapshot.configDigest,
    snapshot.capturedAt,
    stringifyJsonColumn(snapshot.provenance),
  ];
}

function checkoutParams(checkout: TaskCheckout): readonly SqlValue[] {
  return [
    checkout.checkoutId,
    checkout.snapshotId,
    checkout.workspaceId,
    checkout.threadId,
    checkout.turnId,
    checkout.runAttemptId,
    checkout.leaseId,
    checkout.sandboxId,
    checkout.filesystemRoot,
    checkout.gitDir,
    checkout.indexFile,
    checkout.workingBranch,
    checkout.startTreeId,
    checkout.generation,
    checkout.status,
    checkout.settledAt,
    checkout.failureCode,
    checkout.createdAt,
  ];
}

async function writeSnapshot(
  client: SqlClient,
  statement: string,
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot> {
  const result = await client.query<WorkspaceSnapshotRow>(
    statement,
    snapshotParams(snapshot),
  );
  const persisted = mapOptionalSnapshot(result.rows[0]);
  if (!persisted) {
    throw new Error(
      `Workspace snapshot write returned no row: ${snapshot.snapshotId}`,
    );
  }
  return persisted;
}

async function writeCheckout(
  client: SqlClient,
  statement: string,
  checkout: TaskCheckout,
): Promise<TaskCheckout> {
  const result = await client.query<TaskCheckoutRow>(
    statement,
    checkoutParams(checkout),
  );
  const persisted = mapOptionalCheckout(result.rows[0]);
  if (!persisted) {
    throw new Error(
      `Task checkout write returned no row: ${checkout.checkoutId}`,
    );
  }
  return persisted;
}

async function readCheckout(
  client: SqlClient,
  statement: string,
  params: readonly SqlValue[],
): Promise<TaskCheckout | null> {
  const result = await client.query<TaskCheckoutRow>(statement, params);
  return mapOptionalCheckout(result.rows[0]);
}

function mapOptionalSnapshot(
  row: WorkspaceSnapshotRow | undefined,
): WorkspaceSnapshot | null {
  if (!row) return null;
  return WorkspaceSnapshotSchema.parse({
    kind: "workspace_snapshot",
    snapshotId: requireString(row.snapshot_id, "snapshot_id"),
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    repository: {
      provider: requireString(row.repository_provider, "repository_provider"),
      owner: row.repository_owner ?? null,
      name: requireString(row.repository_name, "repository_name"),
      canonicalUrl: requireString(row.repository_url, "repository_url"),
    },
    authorizedCommitId: requireString(
      row.authorized_commit_id,
      "authorized_commit_id",
    ),
    authorizedTreeId: requireString(
      row.authorized_tree_id,
      "authorized_tree_id",
    ),
    manifestDigest: requireString(row.manifest_digest, "manifest_digest"),
    configDigest: requireString(row.config_digest, "config_digest"),
    capturedAt: toIsoString(row.captured_at, "captured_at"),
    provenance: parseJsonColumn(
      row.provenance_json,
      "workspace snapshot provenance",
    ),
  });
}

function mapOptionalCheckout(
  row: TaskCheckoutRow | undefined,
): TaskCheckout | null {
  if (!row) return null;
  return TaskCheckoutSchema.parse({
    kind: "task_checkout",
    checkoutId: requireString(row.checkout_id, "checkout_id"),
    snapshotId: requireString(row.snapshot_id, "snapshot_id"),
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    turnId: requireString(row.turn_id, "turn_id"),
    runAttemptId: requireString(row.run_attempt_id, "run_attempt_id"),
    leaseId: requireString(row.lease_id, "lease_id"),
    sandboxId: requireString(row.sandbox_id, "sandbox_id"),
    filesystemRoot: requireString(row.filesystem_root, "filesystem_root"),
    gitDir: requireString(row.git_dir, "git_dir"),
    indexFile: requireString(row.index_file, "index_file"),
    workingBranch: requireString(row.working_branch, "working_branch"),
    startTreeId: requireString(row.start_tree_id, "start_tree_id"),
    generation: requireNumber(row.generation, "generation"),
    status: requireString(row.status, "status"),
    settledAt:
      row.settled_at === null || row.settled_at === undefined
        ? null
        : toIsoString(row.settled_at, "settled_at"),
    failureCode: row.failure_code ?? null,
    createdAt: toIsoString(row.created_at, "created_at"),
  });
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty task workspace column: ${column}`);
  }
  return value;
}

function requireNumber(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Expected safe integer task workspace column: ${column}`);
  }
  return value;
}

function toIsoString(value: unknown, column: string): string {
  return value instanceof Date
    ? value.toISOString()
    : requireString(value, column);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === POSTGRES_UNIQUE_VIOLATION
  );
}

const SNAPSHOT_COLUMNS = `snapshot_id, workspace_id, repository_provider,
  repository_owner, repository_name, repository_url, authorized_commit_id,
  authorized_tree_id, manifest_digest, config_digest, captured_at, provenance_json`;

const CHECKOUT_COLUMNS = `checkout_id, snapshot_id, workspace_id, thread_id,
  turn_id, run_attempt_id, lease_id, sandbox_id, filesystem_root, git_dir,
  index_file, working_branch, start_tree_id, generation, status, settled_at,
  failure_code, created_at`;

const INSERT_SNAPSHOT_SQL = `INSERT INTO workspace_snapshots (${SNAPSHOT_COLUMNS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
  RETURNING ${SNAPSHOT_COLUMNS}`;
const SELECT_SNAPSHOT_BY_ID_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM workspace_snapshots WHERE snapshot_id=$1`;

const INSERT_CHECKOUT_SQL = `INSERT INTO task_checkouts (${CHECKOUT_COLUMNS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  RETURNING ${CHECKOUT_COLUMNS}`;
const SELECT_CHECKOUT_BY_ID_SQL = `SELECT ${CHECKOUT_COLUMNS}
  FROM task_checkouts WHERE checkout_id=$1`;
const SELECT_CHECKOUT_BY_ID_FOR_UPDATE_SQL = `${SELECT_CHECKOUT_BY_ID_SQL} FOR UPDATE`;
const SELECT_CHECKOUT_BY_RUN_ATTEMPT_SQL = `SELECT ${CHECKOUT_COLUMNS}
  FROM task_checkouts WHERE run_attempt_id=$1`;
const SELECT_CHECKOUT_BY_LEASE_SQL = `SELECT ${CHECKOUT_COLUMNS}
  FROM task_checkouts WHERE lease_id=$1`;
const TRANSITION_CHECKOUT_SQL = `UPDATE task_checkouts
  SET status=$3, settled_at=$4, failure_code=$5
  WHERE checkout_id=$1 AND status=$2
  RETURNING ${CHECKOUT_COLUMNS}`;
