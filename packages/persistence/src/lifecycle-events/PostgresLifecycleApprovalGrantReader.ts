import type { ThreadId, WorkspaceId } from "@repo/platform-protocol";
import type { SqlClient, SqlRow } from "../sql.js";

export interface MatchingInChatApprovalGrantQuery {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly matcherKey: string;
}

interface GrantResultRow extends SqlRow {
  readonly granted?: boolean;
}

/** Reads reusable approvals from the canonical lifecycle event stream. */
export class PostgresLifecycleApprovalGrantReader {
  constructor(private readonly client: SqlClient) {}

  async hasMatchingInChatGrant(
    input: MatchingInChatApprovalGrantQuery,
  ): Promise<boolean> {
    const result = await this.client.query<GrantResultRow>(
      HAS_MATCHING_IN_CHAT_GRANT_SQL,
      [input.threadId, input.workspaceId, input.matcherKey],
    );
    return result.rows[0]?.granted === true;
  }
}

export const HAS_MATCHING_IN_CHAT_GRANT_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM canonical_lifecycle_events AS requested
    JOIN canonical_lifecycle_events AS decided
      ON decided.thread_id = requested.thread_id
      AND decided.turn_id = requested.turn_id
      AND decided.event_json->>'approvalId' = requested.event_json->>'approvalId'
    WHERE requested.thread_id = $1
      AND requested.event_type = 'approval.requested'
      AND decided.event_type = 'approval.decided'
      AND requested.event_json #> '{payload,options}' @> '[{"id":"allow_matching_in_chat"}]'::jsonb
      AND requested.event_json #>> '{payload,metadata,grantMatcherKey}' = $3
      AND requested.event_json #>> '{payload,metadata,grantWorkspaceId}' = $2
      AND decided.event_json #>> '{payload,status}' = 'approved'
      AND decided.event_json #>> '{payload,grantScope}' = 'matching_in_chat'
  ) AS granted
`;
