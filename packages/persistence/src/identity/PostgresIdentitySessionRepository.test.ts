import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresIdentitySessionRepository } from "./PostgresIdentitySessionRepository.js";

class ConcurrentAccountSqlClient implements SqlClient {
  public readonly queries: Array<{
    statement: string;
    params: readonly SqlValue[];
  }> = [];

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params: params ?? [] });

    if (
      statement.includes("SELECT user_id") &&
      statement.includes("accounts")
    ) {
      return rows([]);
    }

    if (statement.includes("INSERT INTO users")) {
      return rows([{ id: "tentative-user" }]);
    }

    if (statement.includes("INSERT INTO accounts")) {
      return rows([{ id: "account-1", user_id: "canonical-user" }]);
    }

    if (statement.includes("INSERT INTO auth_sessions")) {
      return rows([{ id: "auth-session-1" }]);
    }

    return rows([]);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

describe("PostgresIdentitySessionRepository", () => {
  it("uses the canonical account user when concurrent first login races", async () => {
    const client = new ConcurrentAccountSqlClient();
    const repository = new PostgresIdentitySessionRepository(client);

    const session = await repository.createGitHubSession({
      providerAccountId: "123",
      login: "shadowbox-user",
      avatarUrl: "https://example.com/avatar.png",
      email: "user@example.com",
      displayName: "Shadowbox User",
      encryptedAccessToken: {
        ciphertext: "ciphertext",
        iv: "iv",
        tag: "tag",
      },
      tokenFingerprint: "token-fingerprint",
      scopes: ["repo", "read:user"],
      sessionHash: "session-hash",
      sessionExpiresAt: "2026-05-21T00:00:00.000Z",
      now: "2026-05-14T00:00:00.000Z",
    });

    const oauthInsert = findQuery(client, "INSERT INTO oauth_tokens");
    const authSessionInsert = findQuery(client, "INSERT INTO auth_sessions");
    const orphanCleanup = findQuery(client, "DELETE FROM users");

    expect(session.userId).toBe("canonical-user");
    expect(oauthInsert.params[0]).toBe("canonical-user");
    expect(authSessionInsert.params[0]).toBe("canonical-user");
    expect(orphanCleanup.params[0]).toBe("tentative-user");
  });
});

function findQuery(
  client: ConcurrentAccountSqlClient,
  pattern: string,
): { statement: string; params: readonly SqlValue[] } {
  const query = client.queries.find((entry) =>
    entry.statement.includes(pattern),
  );
  if (!query) {
    throw new Error(`Missing query: ${pattern}`);
  }
  return query;
}

function rows<Row extends SqlRow>(rows: Row[]): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}
