import type { BYOKPreferences, BYOKPreferencesPatch } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import type { PreferenceStore } from "./types.js";
import { parseJsonColumn, stringifyJsonColumn } from "./json.js";

interface PreferenceRow extends SqlRow {
  user_id: string;
  workspace_id: string;
  default_provider_id: string | null;
  default_credential_id: string | null;
  default_model_id: string | null;
  fallback_mode: string;
  fallback_json: unknown | null;
  visible_model_ids_json: unknown | null;
  credential_labels_json: unknown | null;
  updated_at: string;
}

export class PostgresPreferenceStore implements PreferenceStore {
  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
    private readonly workspaceId: string,
  ) {}

  async getPreferences(): Promise<BYOKPreferences> {
    const result = await this.client.query<PreferenceRow>(GET_PREFERENCES_SQL, [
      this.userId,
      this.workspaceId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return this.createDefaultPreferences();
    }

    return this.rowToPreferences(row);
  }

  async updatePreferences(
    patch: BYOKPreferencesPatch,
  ): Promise<BYOKPreferences> {
    const result = await this.client.query<PreferenceRow>(
      UPSERT_PREFERENCES_SQL,
      [
        this.userId,
        this.workspaceId,
        patch.defaultProviderId ?? null,
        patch.defaultModelId ?? null,
        patch.visibleModelIds
          ? stringifyJsonColumn(patch.visibleModelIds)
          : null,
        new Date().toISOString(),
        patch.defaultProviderId !== undefined,
        patch.defaultModelId !== undefined,
        patch.visibleModelIds !== undefined,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        "[PostgresPreferenceStore/updatePreferences] update did not return preferences",
      );
    }
    return this.rowToPreferences(row);
  }

  async setCredentialLabel(credentialId: string, label: string): Promise<void> {
    await this.client.query(SET_CREDENTIAL_LABEL_SQL, [
      this.userId,
      this.workspaceId,
      credentialId,
      label,
      new Date().toISOString(),
    ]);
  }

  async deleteCredentialLabel(credentialId: string): Promise<void> {
    await this.client.query(DELETE_CREDENTIAL_LABEL_SQL, [
      this.userId,
      this.workspaceId,
      credentialId,
      new Date().toISOString(),
    ]);
  }

  private createDefaultPreferences(): BYOKPreferences {
    return {
      defaultProviderId: undefined,
      defaultModelId: undefined,
      visibleModelIds: {},
      credentialLabels: {},
      updatedAt: new Date().toISOString(),
    };
  }

  private rowToPreferences(row: PreferenceRow): BYOKPreferences {
    let visibleModelIds: Record<string, string[]> = {};
    if (row.visible_model_ids_json) {
      try {
        visibleModelIds = parseRecordArrayJson(row.visible_model_ids_json);
      } catch (error) {
        console.error(
          "[PostgresPreferenceStore/rowToPreferences] Failed to parse visible_model_ids_json",
          error,
        );
      }
    }

    let credentialLabels: Record<string, string> = {};
    if (row.credential_labels_json) {
      try {
        credentialLabels = parseRecordStringJson(row.credential_labels_json);
      } catch (error) {
        console.error(
          "[PostgresPreferenceStore/rowToPreferences] Failed to parse credential_labels_json",
          error,
        );
      }
    }

    return {
      defaultProviderId: row.default_provider_id ?? undefined,
      defaultModelId: row.default_model_id ?? undefined,
      visibleModelIds,
      credentialLabels,
      updatedAt: row.updated_at,
    };
  }
}

function parseRecordArrayJson(value: unknown): Record<string, string[]> {
  const parsed = parseJsonColumn(value, "visible model ids");
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (Array.isArray(entry)) {
      result[key] = entry.filter(
        (item): item is string => typeof item === "string",
      );
    }
  }
  return result;
}

function parseRecordStringJson(value: unknown): Record<string, string> {
  const parsed = parseJsonColumn(value, "credential labels");
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

const GET_PREFERENCES_SQL = `
  SELECT
    user_id,
    workspace_id,
    default_provider_id,
    default_credential_id,
    default_model_id,
    fallback_mode,
    fallback_json,
    visible_model_ids_json,
    credential_labels_json,
    updated_at
  FROM provider_preferences
  WHERE user_id = $1
    AND workspace_id = $2
  LIMIT 1
`;

const UPSERT_PREFERENCES_SQL = `
  INSERT INTO provider_preferences (
    user_id,
    workspace_id,
    default_provider_id,
    default_model_id,
    visible_model_ids_json,
    updated_at
  )
  VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6)
  ON CONFLICT (user_id, workspace_id)
  DO UPDATE SET
    default_provider_id = CASE
      WHEN $7::boolean THEN EXCLUDED.default_provider_id
      ELSE provider_preferences.default_provider_id
    END,
    default_model_id = CASE
      WHEN $8::boolean THEN EXCLUDED.default_model_id
      ELSE provider_preferences.default_model_id
    END,
    visible_model_ids_json = CASE
      WHEN $9::boolean THEN EXCLUDED.visible_model_ids_json
      ELSE provider_preferences.visible_model_ids_json
    END,
    updated_at = EXCLUDED.updated_at
  RETURNING
    user_id,
    workspace_id,
    default_provider_id,
    default_credential_id,
    default_model_id,
    fallback_mode,
    fallback_json,
    visible_model_ids_json,
    credential_labels_json,
    updated_at
`;

const SET_CREDENTIAL_LABEL_SQL = `
  INSERT INTO provider_preferences (
    user_id,
    workspace_id,
    credential_labels_json,
    updated_at
  )
  VALUES ($1, $2, jsonb_build_object($3::text, $4::text), $5)
  ON CONFLICT (user_id, workspace_id)
  DO UPDATE SET
    credential_labels_json =
      COALESCE(provider_preferences.credential_labels_json, '{}'::jsonb)
      || jsonb_build_object($3::text, $4::text),
    updated_at = EXCLUDED.updated_at
`;

const DELETE_CREDENTIAL_LABEL_SQL = `
  UPDATE provider_preferences
  SET credential_labels_json =
        COALESCE(credential_labels_json, '{}'::jsonb) - $3::text,
      updated_at = $4
  WHERE user_id = $1
    AND workspace_id = $2
`;
