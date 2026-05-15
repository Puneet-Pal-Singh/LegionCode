import type { SqlClient, SqlRow } from "../sql.js";
import type { ProviderQuotaStore } from "./types.js";

interface QuotaRow extends SqlRow {
  usage_count: number;
}

export class PostgresProviderQuotaStore implements ProviderQuotaStore {
  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
    private readonly workspaceId: string,
  ) {}

  async getAxisQuotaUsage(dayKey: string): Promise<number> {
    const result = await this.client.query<QuotaRow>(GET_QUOTA_USAGE_SQL, [
      this.userId,
      this.workspaceId,
      dayKey,
    ]);
    return result.rows[0]?.usage_count ?? 0;
  }

  async setAxisQuotaUsage(dayKey: string, usage: number): Promise<void> {
    await this.client.query(UPSERT_QUOTA_USAGE_SQL, [
      this.userId,
      this.workspaceId,
      dayKey,
      usage,
      new Date().toISOString(),
    ]);
  }

  async incrementAndGetQuota(dayKey: string): Promise<number> {
    const result = await this.client.query<QuotaRow>(INCREMENT_QUOTA_SQL, [
      this.userId,
      this.workspaceId,
      dayKey,
      new Date().toISOString(),
    ]);
    return result.rows[0]?.usage_count ?? 1;
  }
}

const GET_QUOTA_USAGE_SQL = `
  SELECT usage_count
  FROM provider_axis_quota
  WHERE user_id = $1
    AND workspace_id = $2
    AND day_key = $3
`;

const UPSERT_QUOTA_USAGE_SQL = `
  INSERT INTO provider_axis_quota (
    user_id,
    workspace_id,
    day_key,
    usage_count,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (user_id, workspace_id, day_key)
  DO UPDATE SET
    usage_count = EXCLUDED.usage_count,
    updated_at = EXCLUDED.updated_at
`;

const INCREMENT_QUOTA_SQL = `
  INSERT INTO provider_axis_quota (
    user_id,
    workspace_id,
    day_key,
    usage_count,
    updated_at
  )
  VALUES ($1, $2, $3, 1, $4)
  ON CONFLICT (user_id, workspace_id, day_key)
  DO UPDATE SET
    usage_count = provider_axis_quota.usage_count + 1,
    updated_at = EXCLUDED.updated_at
  RETURNING usage_count
`;
