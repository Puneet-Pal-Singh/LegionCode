import type { JsonValue } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import type {
  EncryptedOAuthToken,
  GitHubIdentitySessionInput,
  IdentitySessionRecord,
  IdentitySessionRepository,
} from "./types.js";

interface ExistingAccountRow extends SqlRow {
  user_id: string;
}

interface IdRow extends SqlRow {
  id: string;
}

interface SessionRow extends SqlRow {
  auth_session_id: string;
  user_id: string;
  provider_login: string;
  avatar_url: string | null;
  primary_email: string | null;
  display_name: string | null;
  encrypted_access_token_json: unknown;
  scopes_json: unknown;
  created_at_ms: string | number;
  expires_at: string | Date;
}

export class PostgresIdentitySessionRepository implements IdentitySessionRepository {
  constructor(private readonly client: SqlClient) {}

  async createGitHubSession(
    input: GitHubIdentitySessionInput,
  ): Promise<IdentitySessionRecord> {
    return await this.client.transaction(async (tx) => {
      const existingUserId = await findExistingGitHubUserId(
        tx,
        input.providerAccountId,
      );
      const userId = existingUserId ?? (await insertUser(tx, input));
      if (existingUserId) {
        await updateUser(tx, userId, input);
      }
      const accountId = await upsertGitHubAccount(tx, userId, input);
      await insertOAuthToken(tx, userId, accountId, input);
      const authSessionId = await insertAuthSession(tx, userId, input);

      return {
        authSessionId,
        userId,
        login: input.login,
        avatar: input.avatarUrl,
        email: input.email,
        name: input.displayName,
        githubScopes: input.scopes,
        encryptedToken: input.encryptedAccessToken,
        createdAt: new Date(input.now).getTime(),
        expiresAt: input.sessionExpiresAt,
      };
    });
  }

  async findSessionByHash(
    sessionHash: string,
    now: string,
  ): Promise<IdentitySessionRecord | null> {
    const result = await this.client.query<SessionRow>(
      FIND_ACTIVE_SESSION_SQL,
      [sessionHash, now],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await this.client.query(
      "UPDATE auth_sessions SET last_seen_at = $2 WHERE session_hash = $1",
      [sessionHash, now],
    );

    return mapSessionRow(row);
  }

  async findLatestGitHubSessionByUserId(
    userId: string,
    now: string,
  ): Promise<IdentitySessionRecord | null> {
    const result = await this.client.query<SessionRow>(
      FIND_LATEST_ACTIVE_GITHUB_SESSION_SQL,
      [userId, now],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await this.client.query(
      "UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1",
      [row.auth_session_id, now],
    );

    return mapSessionRow(row);
  }

  async revokeSession(sessionHash: string, now: string): Promise<void> {
    await this.client.query(
      `
        UPDATE auth_sessions
        SET revoked_at = $2
        WHERE session_hash = $1
          AND revoked_at IS NULL
      `,
      [sessionHash, now],
    );
  }
}

async function findExistingGitHubUserId(
  client: SqlClient,
  providerAccountId: string,
): Promise<string | null> {
  const result = await client.query<ExistingAccountRow>(
    `
      SELECT user_id
      FROM accounts
      WHERE provider = 'github'
        AND provider_account_id = $1
      LIMIT 1
    `,
    [providerAccountId],
  );
  return result.rows[0]?.user_id ?? null;
}

async function insertUser(
  client: SqlClient,
  input: GitHubIdentitySessionInput,
): Promise<string> {
  const result = await client.query<IdRow>(
    `
      INSERT INTO users (
        display_name,
        avatar_url,
        primary_email,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $4, $4)
      RETURNING id
    `,
    [input.displayName, input.avatarUrl, input.email, input.now],
  );
  return readReturnedId(result.rows[0], "users");
}

async function updateUser(
  client: SqlClient,
  userId: string,
  input: GitHubIdentitySessionInput,
): Promise<void> {
  await client.query(
    `
      UPDATE users
      SET display_name = $2,
          avatar_url = $3,
          primary_email = $4,
          last_seen_at = $5,
          updated_at = $5
      WHERE id = $1
    `,
    [userId, input.displayName, input.avatarUrl, input.email, input.now],
  );
}

async function upsertGitHubAccount(
  client: SqlClient,
  userId: string,
  input: GitHubIdentitySessionInput,
): Promise<string> {
  const result = await client.query<IdRow>(
    `
      INSERT INTO accounts (
        user_id,
        provider,
        provider_account_id,
        provider_login,
        provider_email,
        avatar_url,
        created_at,
        updated_at
      )
      VALUES ($1, 'github', $2, $3, $4, $5, $6, $6)
      ON CONFLICT (provider, provider_account_id)
      DO UPDATE SET
        provider_login = EXCLUDED.provider_login,
        provider_email = EXCLUDED.provider_email,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `,
    [
      userId,
      input.providerAccountId,
      input.login,
      input.email,
      input.avatarUrl,
      input.now,
    ],
  );
  return readReturnedId(result.rows[0], "accounts");
}

async function insertOAuthToken(
  client: SqlClient,
  userId: string,
  accountId: string,
  input: GitHubIdentitySessionInput,
): Promise<void> {
  await client.query(
    `
      INSERT INTO oauth_tokens (
        user_id,
        account_id,
        provider,
        encrypted_access_token_json,
        token_fingerprint,
        scopes_json,
        expires_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'github', $3::jsonb, $4, $5::jsonb, $6, $7, $7)
    `,
    [
      userId,
      accountId,
      JSON.stringify(input.encryptedAccessToken),
      input.tokenFingerprint,
      JSON.stringify(input.scopes),
      input.tokenExpiresAt ?? null,
      input.now,
    ],
  );
}

async function insertAuthSession(
  client: SqlClient,
  userId: string,
  input: GitHubIdentitySessionInput,
): Promise<string> {
  const result = await client.query<IdRow>(
    `
      INSERT INTO auth_sessions (
        user_id,
        session_hash,
        expires_at,
        created_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $4)
      RETURNING id
    `,
    [userId, input.sessionHash, input.sessionExpiresAt, input.now],
  );
  return readReturnedId(result.rows[0], "auth_sessions");
}

function readReturnedId(row: IdRow | undefined, tableName: string): string {
  if (!row?.id) {
    throw new Error(`${tableName} insert returned no id`);
  }
  return row.id;
}

function mapSessionRow(row: SessionRow): IdentitySessionRecord {
  return {
    authSessionId: row.auth_session_id,
    userId: row.user_id,
    login: row.provider_login,
    avatar: row.avatar_url ?? "",
    email: row.primary_email,
    name: row.display_name,
    githubScopes: readScopes(row.scopes_json),
    encryptedToken: readEncryptedToken(row.encrypted_access_token_json),
    createdAt: Number(row.created_at_ms),
    expiresAt: toIsoString(row.expires_at),
  };
}

function readEncryptedToken(value: unknown): EncryptedOAuthToken {
  const parsed = parseJsonColumn(value, "encrypted OAuth token payload");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid encrypted OAuth token payload");
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.ciphertext !== "string" ||
    typeof record.iv !== "string" ||
    typeof record.tag !== "string"
  ) {
    throw new Error("Invalid encrypted OAuth token payload");
  }

  return {
    ciphertext: record.ciphertext,
    iv: record.iv,
    tag: record.tag,
  };
}

function readScopes(value: unknown): string[] {
  const parsed = parseJsonColumn(value, "OAuth scopes payload");
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseJsonColumn(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const SESSION_SELECT_COLUMNS = `
    auth_sessions.id AS auth_session_id,
    users.id AS user_id,
    accounts.provider_login,
    users.avatar_url,
    users.primary_email,
    users.display_name,
    oauth_tokens.encrypted_access_token_json,
    oauth_tokens.scopes_json,
    EXTRACT(EPOCH FROM auth_sessions.created_at) * 1000 AS created_at_ms,
    auth_sessions.expires_at
`;

const GITHUB_ACCOUNT_AND_TOKEN_JOIN_SQL = `
  INNER JOIN accounts
    ON accounts.user_id = users.id
    AND accounts.provider = 'github'
  INNER JOIN LATERAL (
    SELECT encrypted_access_token_json, scopes_json
    FROM oauth_tokens
    WHERE oauth_tokens.account_id = accounts.id
      AND oauth_tokens.provider = 'github'
    ORDER BY oauth_tokens.created_at DESC
    LIMIT 1
  ) oauth_tokens ON true
`;

const FIND_ACTIVE_SESSION_SQL = `
  SELECT
${SESSION_SELECT_COLUMNS}
  FROM auth_sessions
  INNER JOIN users
    ON users.id = auth_sessions.user_id
${GITHUB_ACCOUNT_AND_TOKEN_JOIN_SQL}
  WHERE auth_sessions.session_hash = $1
    AND auth_sessions.revoked_at IS NULL
    AND auth_sessions.expires_at > $2
  LIMIT 1
`;

const FIND_LATEST_ACTIVE_GITHUB_SESSION_SQL = `
  SELECT
${SESSION_SELECT_COLUMNS}
  FROM auth_sessions
  INNER JOIN users
    ON users.id = auth_sessions.user_id
${GITHUB_ACCOUNT_AND_TOKEN_JOIN_SQL}
  WHERE auth_sessions.user_id = $1
    AND auth_sessions.revoked_at IS NULL
    AND auth_sessions.expires_at > $2
  ORDER BY auth_sessions.last_seen_at DESC, auth_sessions.created_at DESC
  LIMIT 1
`;
