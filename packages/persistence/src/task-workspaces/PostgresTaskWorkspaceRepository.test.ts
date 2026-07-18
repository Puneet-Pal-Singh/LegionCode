import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresTaskWorkspaceRepository } from "./PostgresTaskWorkspaceRepository.js";
import type { TaskCheckout, WorkspaceSnapshot } from "@repo/platform-protocol";

const TIMESTAMP = "2026-07-18T12:00:00.000Z";

class TaskWorkspaceSqlClient implements SqlClient {
  readonly snapshots = new Map<string, SqlRow>();
  readonly checkouts = new Map<string, SqlRow>();
  readonly statements: Array<{
    readonly statement: string;
    readonly params: readonly SqlValue[];
  }> = [];

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push({ statement, params });
    if (statement.startsWith("INSERT INTO workspace_snapshots")) {
      const row = snapshotRow(params);
      if (this.snapshots.has(String(params[0]))) {
        throw { code: "23505", constraint: "workspace_snapshots_pkey" };
      }
      this.snapshots.set(row.snapshot_id as string, row);
      return rows<Row>([row]);
    }
    if (statement.includes("FROM workspace_snapshots")) {
      const row = this.snapshots.get(String(params[0]));
      return rows<Row>(row ? [row] : []);
    }
    if (statement.startsWith("INSERT INTO task_checkouts")) {
      const row = checkoutRow(params);
      const snapshot = this.snapshots.get(String(params[1]));
      if (!snapshot || snapshot.workspace_id !== params[2]) {
        throw new Error("snapshot/workspace foreign key violated");
      }
      if (
        this.checkouts.has(String(params[0])) ||
        [...this.checkouts.values()].some(
          (candidate) =>
            candidate.run_attempt_id === params[5] ||
            candidate.lease_id === params[6],
        )
      ) {
        throw { code: "23505", constraint: "task_checkouts_identity" };
      }
      this.checkouts.set(row.checkout_id as string, row);
      return rows<Row>([row]);
    }
    if (statement.startsWith("UPDATE task_checkouts")) {
      const row = this.checkouts.get(String(params[0]));
      if (!row || row.status !== params[1]) return rows<Row>([]);
      const next = {
        ...row,
        status: params[2],
        settled_at: params[3],
        failure_code: params[4],
      };
      this.checkouts.set(String(params[0]), next);
      return rows<Row>([next]);
    }
    if (statement.includes("FROM task_checkouts")) {
      const row = statement.includes("WHERE checkout_id=$1")
        ? this.checkouts.get(String(params[0]))
        : statement.includes("WHERE run_attempt_id=$1")
          ? [...this.checkouts.values()].find(
              (candidate) => candidate.run_attempt_id === params[0],
            )
          : [...this.checkouts.values()].find(
              (candidate) => candidate.lease_id === params[0],
            );
      return rows<Row>(row ? [row] : []);
    }
    throw new Error(`Unhandled task workspace SQL: ${statement}`);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

describe("PostgresTaskWorkspaceRepository", () => {
  it("idempotently persists an immutable snapshot and rejects replacement", async () => {
    const repository = createRepository();
    const first = await repository.createSnapshot(snapshot());

    await expect(repository.createSnapshot(snapshot())).resolves.toEqual(first);
    await expect(
      repository.createSnapshot(snapshot({ configDigest: "e".repeat(64) })),
    ).rejects.toMatchObject({ code: "workspace_snapshot_conflict" });
  });

  it("persists exactly one checkout for a run attempt and lease", async () => {
    const repository = createRepository();
    await repository.createSnapshot(snapshot());
    const created = await repository.createCheckout(checkout());

    await expect(repository.createCheckout(checkout())).resolves.toEqual(
      created,
    );
    await expect(
      repository.createCheckout(checkout({ sandboxId: "sb-replaced" })),
    ).rejects.toMatchObject({ code: "task_checkout_conflict" });
    await expect(
      repository.createCheckout(
        checkout({
          checkoutId: "checkout_other01",
          sandboxId: "sb-other",
        }),
      ),
    ).rejects.toMatchObject({ code: "task_checkout_conflict" });
    await expect(
      repository.getByRunAttemptId(created.runAttemptId),
    ).resolves.toEqual(created);
    await expect(repository.getByLeaseId(created.leaseId)).resolves.toEqual(
      created,
    );
  });

  it("rejects a checkout whose workspace does not equal its snapshot scope", async () => {
    const repository = createRepository();
    await repository.createSnapshot(snapshot());

    await expect(
      repository.createCheckout(checkout({ workspaceId: "wrk_workspace2" })),
    ).rejects.toMatchObject({ code: "task_checkout_scope_mismatch" });
    await expect(
      repository.createCheckout(
        checkout({ status: "active", settledAt: null, failureCode: null }),
      ),
    ).rejects.toMatchObject({ code: "task_checkout_transition_invalid" });
  });

  it("uses compare-and-set status transitions and leaves terminal checkouts immutable", async () => {
    const client = new TaskWorkspaceSqlClient();
    const repository = new PostgresTaskWorkspaceRepository(client);
    await repository.createSnapshot(snapshot());
    await repository.createCheckout(checkout());

    const active = await repository.activate("checkout_task01");
    const settled = await repository.settle({
      checkoutId: active.checkoutId,
      status: "settled",
      settledAt: "2026-07-18T12:01:00.000Z",
      failureCode: null,
    });

    expect(settled.status).toBe("settled");
    await expect(repository.activate(active.checkoutId)).rejects.toMatchObject({
      code: "task_checkout_transition_invalid",
    });
    await expect(
      repository.settle({
        checkoutId: active.checkoutId,
        status: "failed",
        settledAt: "2026-07-18T12:02:00.000Z",
        failureCode: "SHOULD_NOT_REPLACE",
      }),
    ).rejects.toMatchObject({ code: "task_checkout_transition_invalid" });

    const transition = client.statements.find((entry) =>
      entry.statement.startsWith("UPDATE task_checkouts"),
    );
    expect(transition?.statement).toContain(
      "WHERE checkout_id=$1 AND status=$2",
    );
  });
});

function createRepository(): PostgresTaskWorkspaceRepository {
  return new PostgresTaskWorkspaceRepository(new TaskWorkspaceSqlClient());
}

function snapshot(
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    kind: "workspace_snapshot",
    snapshotId: "wsnap_snapshot1",
    workspaceId: "wrk_workspace1",
    repository: {
      provider: "github",
      owner: "Puneet-Pal-Singh",
      name: "LegionCode",
      canonicalUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
    },
    authorizedCommitId: "b".repeat(40),
    authorizedTreeId: "c".repeat(40),
    manifestDigest: "a".repeat(64),
    configDigest: "d".repeat(64),
    capturedAt: TIMESTAMP,
    provenance: {
      kind: "authorized_repository",
      requestedRef: "dev",
      resolvedRef: "refs/heads/dev",
      authorizedByUserId: "usr_user123",
      authorizationContextDigest: "e".repeat(64),
    },
    ...overrides,
  } as WorkspaceSnapshot;
}

function checkout(overrides: Partial<TaskCheckout> = {}): TaskCheckout {
  return {
    kind: "task_checkout",
    checkoutId: "checkout_task01",
    snapshotId: "wsnap_snapshot1",
    workspaceId: "wrk_workspace1",
    threadId: "thr_thread01",
    turnId: "trn_turn0001",
    runAttemptId: "attempt_attempt1",
    leaseId: "lease_lease001",
    sandboxId: "sb-a1b2c3d4",
    filesystemRoot: "/workspace/checkouts/checkout_task01",
    gitDir: "/workspace/git/checkout_task01",
    indexFile: "/workspace/indexes/checkout_task01.index",
    workingBranch: "task/checkout-task01",
    startTreeId: "c".repeat(40),
    generation: 1,
    status: "ready",
    settledAt: null,
    failureCode: null,
    createdAt: TIMESTAMP,
    ...overrides,
  } as TaskCheckout;
}

function snapshotRow(params: readonly SqlValue[]): SqlRow {
  return {
    snapshot_id: params[0],
    workspace_id: params[1],
    repository_provider: params[2],
    repository_owner: params[3],
    repository_name: params[4],
    repository_url: params[5],
    authorized_commit_id: params[6],
    authorized_tree_id: params[7],
    manifest_digest: params[8],
    config_digest: params[9],
    captured_at: params[10],
    provenance_json: params[11],
  };
}

function checkoutRow(params: readonly SqlValue[]): SqlRow {
  return {
    checkout_id: params[0],
    snapshot_id: params[1],
    workspace_id: params[2],
    thread_id: params[3],
    turn_id: params[4],
    run_attempt_id: params[5],
    lease_id: params[6],
    sandbox_id: params[7],
    filesystem_root: params[8],
    git_dir: params[9],
    index_file: params[10],
    working_branch: params[11],
    start_tree_id: params[12],
    generation: params[13],
    status: params[14],
    settled_at: params[15],
    failure_code: params[16],
    created_at: params[17],
  };
}

function rows<Row extends SqlRow>(values: SqlRow[]): SqlQueryResult<Row> {
  return { rows: values as Row[], rowCount: values.length };
}
