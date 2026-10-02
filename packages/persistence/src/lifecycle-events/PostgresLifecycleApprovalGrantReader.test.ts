import { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresLifecycleApprovalGrantReader } from "./PostgresLifecycleApprovalGrantReader.js";
import { describe, expect, it } from "vitest";

class PGliteSqlClient implements SqlClient {
  constructor(private readonly db: PGlite) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.db.query(statement, [...params]);
    return {
      rows: result.rows as Row[],
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return await this.db.transaction(
      async (transaction) =>
        await callback(new PGliteSqlClient(transaction as unknown as PGlite)),
    );
  }
}

describe("PostgresLifecycleApprovalGrantReader", () => {
  it("matches approved lifecycle decisions only in the originating thread and workspace", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE canonical_lifecycle_events (
          event_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_json JSONB NOT NULL
        );
      `);
      await db.query(
        `INSERT INTO canonical_lifecycle_events
          (event_id, thread_id, turn_id, event_type, event_json)
         VALUES
          ($1, 'thr_origin123', 'trn_origin123', 'approval.requested', $2::jsonb),
          ($3, 'thr_origin123', 'trn_origin123', 'approval.decided', $4::jsonb)`,
        [
          "requested-1",
          JSON.stringify(requested("appr_origin123", "wrk_origin123", true)),
          "decided-1",
          JSON.stringify(decided("appr_origin123", "matching_in_chat")),
        ],
      );
      const reader = new PostgresLifecycleApprovalGrantReader(
        new PGliteSqlClient(db),
      );
      const matcherKey = "tool:git_commit";

      await expect(
        reader.hasMatchingInChatGrant({
          threadId: "thr_origin123",
          workspaceId: "wrk_origin123",
          matcherKey,
        }),
      ).resolves.toBe(true);
      await expect(
        reader.hasMatchingInChatGrant({
          threadId: "thr_other123",
          workspaceId: "wrk_origin123",
          matcherKey,
        }),
      ).resolves.toBe(false);
      await expect(
        reader.hasMatchingInChatGrant({
          threadId: "thr_origin123",
          workspaceId: "wrk_other123",
          matcherKey,
        }),
      ).resolves.toBe(false);
      await expect(
        reader.hasMatchingInChatGrant({
          threadId: "thr_origin123",
          workspaceId: "wrk_origin123",
          matcherKey: "tool:git_push",
        }),
      ).resolves.toBe(false);
    } finally {
      await db.close();
    }
  });

  it("requires both the matching-in-chat option and an approved scoped decision", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE canonical_lifecycle_events (
          event_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_json JSONB NOT NULL
        );
      `);
      const requestedWithoutOption = requested("appr_optionless1", "wrk_origin123", false);
      await insertPair(db, "optionless", requestedWithoutOption, decided("appr_optionless1", "matching_in_chat"));
      await insertPair(db, "denied", requested("appr_denied123", "wrk_origin123", true), decided("appr_denied123", "matching_in_chat", "denied"));
      await insertPair(db, "once", requested("appr_once123", "wrk_origin123", true), decided("appr_once123", null));
      const reader = new PostgresLifecycleApprovalGrantReader(
        new PGliteSqlClient(db),
      );
      for (const threadId of ["thr_optionless", "thr_denied", "thr_once"]) {
        await expect(
          reader.hasMatchingInChatGrant({
            threadId,
            workspaceId: "wrk_origin123",
            matcherKey: "tool:git_commit",
          }),
        ).resolves.toBe(false);
      }
    } finally {
      await db.close();
    }
  });
});

function requested(
  approvalId: string,
  workspaceId: string,
  allowMatching: boolean,
) {
  return {
    approvalId,
    payload: {
      metadata: {
        grantMatcherKey: "tool:git_commit",
        grantWorkspaceId: workspaceId,
      },
      options: allowMatching
        ? [{ id: "allow_matching_in_chat" }, { id: "approve" }]
        : [{ id: "approve" }],
    },
  };
}

function decided(
  approvalId: string,
  grantScope: "matching_in_chat" | null,
  status = "approved",
) {
  return {
    approvalId,
    payload: {
      status,
      ...(grantScope ? { grantScope } : {}),
    },
  };
}

async function insertPair(
  db: PGlite,
  threadSuffix: string,
  requestedEvent: ReturnType<typeof requested>,
  decidedEvent: ReturnType<typeof decided>,
): Promise<void> {
  const threadId = `thr_${threadSuffix}`;
  const turnId = `trn_${threadSuffix}`;
  await db.query(
    `INSERT INTO canonical_lifecycle_events
      (event_id, thread_id, turn_id, event_type, event_json)
     VALUES ($1, $2, $3, 'approval.requested', $4::jsonb),
            ($5, $2, $3, 'approval.decided', $6::jsonb)`,
    [
      `${threadSuffix}-requested`,
      threadId,
      turnId,
      JSON.stringify(requestedEvent),
      `${threadSuffix}-decided`,
      JSON.stringify(decidedEvent),
    ],
  );
}
