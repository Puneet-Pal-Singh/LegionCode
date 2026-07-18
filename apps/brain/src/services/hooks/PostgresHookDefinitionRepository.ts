import {
  HookDefinitionSchema,
  HookHandlerIdSchema,
  type HookDefinition,
  type HookHandlerId,
} from "@repo/hook-protocol";
import type { SqlClient, SqlRow } from "@repo/persistence";
import {
  HookDefinitionWriteConflictError,
  type HookDefinitionRecord,
  type HookDefinitionRepository,
  type HookDefinitionScope,
} from "./HookDefinitionRepository";

interface HookDefinitionRow extends SqlRow {
  user_id: string;
  workspace_id: string;
  handler_id: string;
  event_name: string;
  source: string;
  display_name: string;
  enabled: boolean;
  hook_order: number;
  timeout_ms: number;
  configuration_key: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class PostgresHookDefinitionRepository
  implements HookDefinitionRepository
{
  constructor(private readonly client: SqlClient) {}

  async list(
    scope: HookDefinitionScope,
  ): Promise<readonly HookDefinitionRecord[]> {
    const result = await this.client.query<HookDefinitionRow>(
      LIST_HOOK_DEFINITIONS_SQL,
      [scope.userId, scope.workspaceId],
    );
    return result.rows.map(mapHookDefinitionRow);
  }

  async upsert(
    scope: HookDefinitionScope,
    definition: HookDefinition,
    now: string,
  ): Promise<HookDefinitionRecord> {
    const parsed = HookDefinitionSchema.parse(definition);
    const result = await this.client.query<HookDefinitionRow>(
      UPSERT_HOOK_DEFINITION_SQL,
      [
        scope.userId,
        scope.workspaceId,
        parsed.handlerId,
        parsed.eventName,
        parsed.source,
        parsed.displayName,
        parsed.enabled,
        parsed.order,
        parsed.timeoutMs,
        parsed.configurationKey,
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new HookDefinitionWriteConflictError();
    }
    return mapHookDefinitionRow(row);
  }

  async deleteUserDefinition(
    scope: HookDefinitionScope,
    handlerId: HookHandlerId,
  ): Promise<boolean> {
    const parsedHandlerId = HookHandlerIdSchema.parse(handlerId);
    const result = await this.client.query(
      DELETE_USER_HOOK_DEFINITION_SQL,
      [scope.userId, scope.workspaceId, parsedHandlerId],
    );
    return result.rowCount > 0;
  }
}

function mapHookDefinitionRow(
  row: HookDefinitionRow,
): HookDefinitionRecord {
  const definition = HookDefinitionSchema.parse({
    handlerId: row.handler_id,
    eventName: row.event_name,
    source: row.source,
    displayName: row.display_name,
    enabled: row.enabled,
    order: row.hook_order,
    timeoutMs: row.timeout_ms,
    configurationKey: row.configuration_key,
  });

  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    definition,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const HOOK_DEFINITION_COLUMNS = `
  user_id,
  workspace_id,
  handler_id,
  event_name,
  source,
  display_name,
  enabled,
  hook_order,
  timeout_ms,
  configuration_key,
  created_at,
  updated_at
`;

const LIST_HOOK_DEFINITIONS_SQL = `
  SELECT ${HOOK_DEFINITION_COLUMNS}
  FROM hook_definitions
  WHERE user_id = $1 AND workspace_id = $2
  ORDER BY
    hook_order ASC,
    CASE source
      WHEN 'project' THEN 0
      WHEN 'plugin' THEN 1
      ELSE 2
    END ASC,
    handler_id ASC
`;

const UPSERT_HOOK_DEFINITION_SQL = `
  INSERT INTO hook_definitions (
    user_id,
    workspace_id,
    handler_id,
    event_name,
    source,
    display_name,
    enabled,
    hook_order,
    timeout_ms,
    configuration_key,
    created_at,
    updated_at
  )
  SELECT
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11
  FROM workspaces
  WHERE id = $2 AND user_id = $1
  ON CONFLICT (user_id, workspace_id, handler_id)
  DO UPDATE SET
    event_name = EXCLUDED.event_name,
    display_name = EXCLUDED.display_name,
    enabled = EXCLUDED.enabled,
    hook_order = EXCLUDED.hook_order,
    timeout_ms = EXCLUDED.timeout_ms,
    configuration_key = EXCLUDED.configuration_key,
    updated_at = EXCLUDED.updated_at
  WHERE hook_definitions.source = EXCLUDED.source
  RETURNING ${HOOK_DEFINITION_COLUMNS}
`;

const DELETE_USER_HOOK_DEFINITION_SQL = `
  DELETE FROM hook_definitions
  WHERE
    user_id = $1 AND
    workspace_id = $2 AND
    handler_id = $3 AND
    source = 'user'
`;
