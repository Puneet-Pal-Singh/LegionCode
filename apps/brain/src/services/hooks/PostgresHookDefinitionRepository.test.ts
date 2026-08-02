import type {
  SqlClient,
  SqlQueryResult,
  SqlRow,
  SqlValue,
} from "@repo/persistence";
import { describe, expect, it } from "vitest";
import { HookDefinitionWriteConflictError } from "./HookDefinitionRepository";
import { PostgresHookDefinitionRepository } from "./PostgresHookDefinitionRepository";

const SCOPE = {
  userId: "user-1",
  workspaceId: "10db59dc-7c02-4b04-86ee-d6b584d2d1b3",
};

const DEFINITION = {
  handlerId: "user.prompt-check",
  eventName: "UserPromptSubmit" as const,
  source: "user" as const,
  displayName: "Prompt check",
  enabled: true,
  order: 20,
  timeoutMs: 1_000,
  configurationKey: "hooks/prompt-check",
};

describe("PostgresHookDefinitionRepository", () => {
  it("upserts only through a workspace ownership join and maps canonical data", async () => {
    const client = new RecordingSqlClient([
      result([rowFor(DEFINITION)], 1),
    ]);
    const repository = new PostgresHookDefinitionRepository(client);

    const record = await repository.upsert(
      SCOPE,
      DEFINITION,
      "2026-07-19T10:00:00.000Z",
    );

    expect(client.calls[0]?.statement).toContain(
      "FROM workspaces",
    );
    expect(client.calls[0]?.statement).toContain(
      "WHERE id = $2 AND user_id = $1",
    );
    expect(client.calls[0]?.params?.slice(0, 3)).toEqual([
      SCOPE.userId,
      SCOPE.workspaceId,
      DEFINITION.handlerId,
    ]);
    expect(record.definition).toEqual(DEFINITION);
    expect(record.userId).toBe(SCOPE.userId);
  });

  it("fails closed when workspace ownership or source provenance changes", async () => {
    const client = new RecordingSqlClient([result([], 0)]);
    const repository = new PostgresHookDefinitionRepository(client);

    await expect(
      repository.upsert(SCOPE, DEFINITION, "2026-07-19T10:00:00.000Z"),
    ).rejects.toBeInstanceOf(HookDefinitionWriteConflictError);
    expect(client.calls[0]?.statement).toContain(
      "hook_definitions.source = EXCLUDED.source",
    );
  });

  it("validates persisted definitions and restricts public deletion to user hooks", async () => {
    const invalidRow = rowFor({
      ...DEFINITION,
      eventName: "PreToolUse",
    });
    const client = new RecordingSqlClient([
      result([invalidRow], 1),
      result([], 1),
    ]);
    const repository = new PostgresHookDefinitionRepository(client);

    await expect(repository.list(SCOPE)).rejects.toThrow();
    await expect(
      repository.deleteUserDefinition(SCOPE, DEFINITION.handlerId),
    ).resolves.toBe(true);
    expect(client.calls[1]?.statement).toContain("source = 'user'");
    expect(client.calls[1]?.params).toEqual([
      SCOPE.userId,
      SCOPE.workspaceId,
      DEFINITION.handlerId,
    ]);
  });
});

class RecordingSqlClient implements SqlClient {
  readonly calls: Array<{
    statement: string;
    params?: readonly SqlValue[];
  }> = [];

  constructor(private readonly results: SqlQueryResult[]) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ statement, params });
    const next = this.results.shift();
    if (!next) {
      throw new Error("Unexpected SQL query");
    }
    return next as SqlQueryResult<Row>;
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

function result(rows: SqlRow[], rowCount: number): SqlQueryResult {
  return { rows, rowCount };
}

function rowFor(
  definition: typeof DEFINITION | (typeof DEFINITION & { eventName: string }),
): SqlRow {
  return {
    user_id: SCOPE.userId,
    workspace_id: SCOPE.workspaceId,
    handler_id: definition.handlerId,
    event_name: definition.eventName,
    source: definition.source,
    display_name: definition.displayName,
    enabled: definition.enabled,
    hook_order: definition.order,
    timeout_ms: definition.timeoutMs,
    configuration_key: definition.configurationKey,
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-19T10:00:00.000Z",
  };
}
