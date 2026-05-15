import type { SqlClient } from "../sql.js";
import type { ProviderAuditEvent, ProviderAuditLog } from "./types.js";

export class PostgresProviderAuditLog implements ProviderAuditLog {
  constructor(
    private readonly client: SqlClient,
    private readonly userId: string,
    private readonly workspaceId: string,
  ) {}

  async appendAuditEvent(event: ProviderAuditEvent): Promise<void> {
    await this.client.query(INSERT_AUDIT_EVENT_SQL, [
      this.userId,
      this.workspaceId,
      event.providerId ?? null,
      event.credentialId ?? null,
      event.eventType,
      event.status,
      event.errorCode ?? null,
      buildMetadataJson(event),
      new Date().toISOString(),
    ]);
  }
}

function buildMetadataJson(event: ProviderAuditEvent): string | null {
  const metadata: Record<string, unknown> = {};
  if (event.validationMode) {
    metadata.validationMode = event.validationMode;
  }
  if (event.message) {
    metadata.message = event.message;
  }
  if (event.metadataJson) {
    metadata.details = event.metadataJson;
  }

  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

const INSERT_AUDIT_EVENT_SQL = `
  INSERT INTO provider_audit_events (
    user_id,
    workspace_id,
    provider_id,
    credential_id,
    operation,
    status,
    error_code,
    metadata_json,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;
