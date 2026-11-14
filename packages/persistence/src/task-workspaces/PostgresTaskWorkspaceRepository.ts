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
  type TaskCheckoutIssuanceRepository,
  type TaskCheckoutIssuanceReservation,
  type PersistedTaskCheckoutExecutionDomain,
  type ReplaceTaskCheckoutLeaseInput,
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
  secure_session_id?: string;
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
  issuance_token?: string | null;
  issuance_state?: string | null;
  execution_domain_json?: unknown;
  execution_domain_digest?: string | null;
}

/**
 * Durable owner for immutable snapshot records and one isolated checkout per
 * run attempt/lease. The runtime will compose this port later; no browser or
 * adapter writes these rows directly.
 */
export class PostgresTaskWorkspaceRepository
  implements TaskWorkspaceRepository, TaskCheckoutIssuanceRepository
{
  constructor(private readonly client: SqlClient) {}

  async reserveIssuance(
    snapshot: WorkspaceSnapshot,
    reservation: TaskCheckoutIssuanceReservation,
  ): Promise<void> {
    const parsed = WorkspaceSnapshotSchema.parse(snapshot);
    if (
      reservation.snapshotId !== parsed.snapshotId ||
      reservation.workspaceId !== parsed.workspaceId ||
      reservation.startTreeId !== parsed.authorizedTreeId ||
      !reservation.issuanceToken
    ) {
      throw new TaskWorkspacePersistenceError(
        "task_checkout_scope_mismatch",
        "Issuance must pin its actual immutable snapshot",
      );
    }
    await this.client.transaction(async (transaction) => {
      await new PostgresTaskWorkspaceRepository(transaction).createSnapshot(
        parsed,
      );
      const result = await transaction.query<TaskCheckoutRow>(
        `INSERT INTO task_checkouts
        (checkout_id,snapshot_id,workspace_id,thread_id,turn_id,run_attempt_id,
         filesystem_root,git_dir,index_file,working_branch,start_tree_id,created_at,status,issuance_token,issuance_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'issuing',$13,'reserved')
        ON CONFLICT DO NOTHING RETURNING checkout_id`,
        [
          reservation.checkoutId,
          reservation.snapshotId,
          reservation.workspaceId,
          reservation.threadId,
          reservation.turnId,
          reservation.runAttemptId,
          reservation.filesystemRoot,
          reservation.gitDir,
          reservation.indexFile,
          reservation.workingBranch,
          reservation.startTreeId,
          reservation.createdAt,
          reservation.issuanceToken,
        ],
      );
      if (result.rowCount !== 1) throw issuanceRecovery(reservation.checkoutId);
    });
  }

  async beginIssuanceCallback(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
  ): Promise<void> {
    await this.advanceIssuance(
      checkoutId,
      issuanceToken,
      "reserved",
      "callback_started",
    );
  }

  async freezeIssuanceDomain(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
    domain: PersistedTaskCheckoutExecutionDomain,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(domain.digest) ||
      !domain.value ||
      typeof domain.value !== "object" ||
      Array.isArray(domain.value)
    ) {
      throw new TaskWorkspacePersistenceError(
        "task_checkout_scope_mismatch",
        "Execution domain custody requires an opaque object and canonical digest",
      );
    }
    const result = await this.client.query<TaskCheckoutRow>(
      `UPDATE task_checkouts
      SET issuance_state='domain_frozen',execution_domain_json=$3::jsonb,execution_domain_digest=$4
      WHERE checkout_id=$1 AND issuance_token=$2 AND status='issuing' AND issuance_state='callback_started'
      RETURNING checkout_id`,
      [
        checkoutId,
        issuanceToken,
        stringifyJsonColumn(domain.value),
        domain.digest,
      ],
    );
    if (result.rowCount !== 1) throw issuanceRecovery(checkoutId);
  }

  async completeIssuance(
    checkout: TaskCheckout,
    issuanceToken: string,
  ): Promise<TaskCheckout> {
    const parsed = TaskCheckoutSchema.parse(checkout);
    if (parsed.status !== "ready") throw issuanceRecovery(parsed.checkoutId);
    return await this.client.transaction(async (transaction) => {
      const result = await transaction.query<TaskCheckoutRow>(
        SELECT_CHECKOUT_BY_ID_FOR_UPDATE_SQL,
        [parsed.checkoutId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.status !== "issuing" ||
        row.issuance_state !== "domain_frozen" ||
        row.issuance_token !== issuanceToken ||
        row.snapshot_id !== parsed.snapshotId ||
        row.workspace_id !== parsed.workspaceId ||
        row.thread_id !== parsed.threadId ||
        row.turn_id !== parsed.turnId ||
        row.run_attempt_id !== parsed.runAttemptId ||
        row.filesystem_root !== parsed.filesystemRoot ||
        row.git_dir !== parsed.gitDir ||
        row.index_file !== parsed.indexFile ||
        row.working_branch !== parsed.workingBranch ||
        row.start_tree_id !== parsed.startTreeId ||
        toIsoString(row.created_at, "created_at") !== parsed.createdAt
      )
        throw issuanceRecovery(parsed.checkoutId);
      const completed = await transaction.query<TaskCheckoutRow>(
        `UPDATE task_checkouts
        SET secure_session_id=$3,lease_id=$4,sandbox_id=$5,generation=$6,status='ready',issuance_state='ready'
        WHERE checkout_id=$1 AND issuance_token=$2 AND status='issuing' AND issuance_state='domain_frozen'
        RETURNING ${CHECKOUT_COLUMNS}`,
        [
          parsed.checkoutId,
          issuanceToken,
          parsed.secureSessionId,
          parsed.leaseId,
          parsed.sandboxId,
          parsed.generation,
        ],
      );
      const persisted = mapOptionalCheckout(completed.rows[0]);
      if (!persisted) throw issuanceRecovery(parsed.checkoutId);
      return persisted;
    });
  }

  async markIssuanceUnknown(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
  ): Promise<void> {
    // Never turn an ambiguously successful ready commit back into an issuance.
    await this.client.query(
      `UPDATE task_checkouts SET issuance_state='unknown'
      WHERE checkout_id=$1 AND issuance_token=$2 AND status='issuing'
        AND issuance_state IN ('reserved','callback_started','domain_frozen')`,
      [checkoutId, issuanceToken],
    );
  }

  async getCheckoutExecutionDomain(
    checkoutId: TaskCheckoutId,
  ): Promise<PersistedTaskCheckoutExecutionDomain> {
    const result = await this.client.query<TaskCheckoutRow>(
      SELECT_CHECKOUT_BY_ID_SQL,
      [TaskCheckoutIdSchema.parse(checkoutId)],
    );
    const row = result.rows[0];
    if (
      !row ||
      !["ready", "active", "settled"].includes(row.status ?? "") ||
      row.issuance_state !== "ready" ||
      !row.execution_domain_digest ||
      !row.execution_domain_json
    )
      throw issuanceRecovery(checkoutId);
    return {
      value: parseJsonColumn(
        row.execution_domain_json,
        "execution domain",
      ) as PersistedTaskCheckoutExecutionDomain["value"],
      digest: row.execution_domain_digest,
    };
  }

  private async advanceIssuance(
    checkoutId: TaskCheckoutId,
    issuanceToken: string,
    expected: string,
    next: string,
  ): Promise<void> {
    const result = await this.client.query<TaskCheckoutRow>(
      `UPDATE task_checkouts SET issuance_state=$4
      WHERE checkout_id=$1 AND issuance_token=$2 AND status='issuing' AND issuance_state=$3 RETURNING checkout_id`,
      [checkoutId, issuanceToken, expected, next],
    );
    if (result.rowCount !== 1) throw issuanceRecovery(checkoutId);
  }

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
    const inserted = await tryWriteSnapshot(
      this.client,
      INSERT_SNAPSHOT_IF_ABSENT_SQL,
      parsed,
    );
    if (inserted) return inserted;

    const existing = await this.getBySnapshotId(parsed.snapshotId);
    if (existing && canonicalEqual(existing, parsed)) return existing;

    throw new TaskWorkspacePersistenceError(
      "workspace_snapshot_conflict",
      "Workspace snapshot identity is already bound to different immutable data",
      { snapshotId: parsed.snapshotId },
    );
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

  async replaceLease(
    input: ReplaceTaskCheckoutLeaseInput,
  ): Promise<TaskCheckout> {
    const checkoutId = TaskCheckoutIdSchema.parse(input.checkoutId);
    const expectedLeaseId = LeaseIdSchema.parse(input.expectedLeaseId);
    const nextLeaseId = LeaseIdSchema.parse(input.nextLeaseId);
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      !Number.isSafeInteger(input.nextGeneration) ||
      input.expectedGeneration < 0 ||
      input.nextGeneration !== input.expectedGeneration + 1
    ) {
      throw new TaskWorkspacePersistenceError(
        "task_checkout_transition_invalid",
        "Task checkout lease replacement must advance exactly one generation",
        {
          checkoutId,
          expectedGeneration: String(input.expectedGeneration),
          nextGeneration: String(input.nextGeneration),
        },
      );
    }
    const result = await this.client.query<TaskCheckoutRow>(
      REPLACE_CHECKOUT_LEASE_SQL,
      [
        checkoutId,
        expectedLeaseId,
        input.expectedGeneration,
        nextLeaseId,
        input.nextSandboxId,
        input.nextGeneration,
      ],
    );
    const persisted = mapOptionalCheckout(result.rows[0]);
    if (persisted) return persisted;

    throw new TaskWorkspacePersistenceError(
      "task_checkout_transition_conflict",
      "Task checkout lease changed before replacement could be persisted",
      {
        checkoutId,
        expectedLeaseId,
        expectedGeneration: String(input.expectedGeneration),
      },
    );
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
    checkout.secureSessionId,
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

async function tryWriteSnapshot(
  client: SqlClient,
  statement: string,
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot | null> {
  const result = await client.query<WorkspaceSnapshotRow>(
    statement,
    snapshotParams(snapshot),
  );
  return mapOptionalSnapshot(result.rows[0]);
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
  if (row.status === "issuing")
    throw issuanceRecovery(requireString(row.checkout_id, "checkout_id"));
  return TaskCheckoutSchema.parse({
    kind: "task_checkout",
    checkoutId: requireString(row.checkout_id, "checkout_id"),
    snapshotId: requireString(row.snapshot_id, "snapshot_id"),
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    threadId: requireString(row.thread_id, "thread_id"),
    turnId: requireString(row.turn_id, "turn_id"),
    runAttemptId: requireString(row.run_attempt_id, "run_attempt_id"),
    secureSessionId: requireString(row.secure_session_id, "secure_session_id"),
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
  turn_id, run_attempt_id, secure_session_id, lease_id, sandbox_id,
  filesystem_root, git_dir, index_file, working_branch, start_tree_id,
  generation, status, settled_at, failure_code, created_at,
  issuance_token, issuance_state, execution_domain_json, execution_domain_digest`;

const INSERT_SNAPSHOT_IF_ABSENT_SQL = `INSERT INTO workspace_snapshots (${SNAPSHOT_COLUMNS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
  ON CONFLICT (snapshot_id) DO NOTHING
  RETURNING ${SNAPSHOT_COLUMNS}`;
const SELECT_SNAPSHOT_BY_ID_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM workspace_snapshots WHERE snapshot_id=$1`;

const INSERT_CHECKOUT_SQL = `INSERT INTO task_checkouts (checkout_id,snapshot_id,workspace_id,thread_id,turn_id,run_attempt_id,secure_session_id,lease_id,sandbox_id,filesystem_root,git_dir,index_file,working_branch,start_tree_id,generation,status,settled_at,failure_code,created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
const REPLACE_CHECKOUT_LEASE_SQL = `UPDATE task_checkouts
  SET lease_id=$4, sandbox_id=$5, generation=$6
  WHERE checkout_id=$1 AND lease_id=$2 AND generation=$3
    AND status IN ('ready', 'active')
  RETURNING ${CHECKOUT_COLUMNS}`;

function issuanceRecovery(checkoutId: string): TaskWorkspacePersistenceError {
  return new TaskWorkspacePersistenceError(
    "task_checkout_recovery_required",
    "Checkout issuance requires explicit recovery; its callback or physical acquire must not be replayed",
    { checkoutId },
  );
}
