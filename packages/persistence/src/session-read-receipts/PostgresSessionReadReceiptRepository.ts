import type { SqlClient, SqlRow } from "../sql.js";
import type {
  AcknowledgeSessionReadReceiptInput,
  SessionReadReceipt,
  SessionReadState,
  SessionReadReceiptRepository,
} from "./types.js";
import { SessionReadReceiptError } from "./types.js";

interface ReadStateRow extends SqlRow {
  session_id: string;
  last_terminal_turn_id: string | null;
  last_acknowledged_terminal_turn_id: string | null;
  acknowledged_at: string | Date | null;
}

interface ReceiptRow extends SqlRow {
  session_id: string;
  viewer_id: string;
  last_acknowledged_terminal_turn_id: string;
  acknowledged_at: string | Date;
}

export class PostgresSessionReadReceiptRepository implements SessionReadReceiptRepository {
  constructor(private readonly client: SqlClient) {}

  async listReadStates(viewerId: string, sessionIds: readonly string[]): Promise<SessionReadState[]> {
    if (sessionIds.length === 0) return [];
    const result = await this.client.query<ReadStateRow>(LIST_READ_STATES_SQL, [viewerId, [...sessionIds]]);
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      lastTerminalTurnId: row.last_terminal_turn_id,
      lastAcknowledgedTerminalTurnId: row.last_acknowledged_terminal_turn_id,
      acknowledgedAt: row.acknowledged_at === null ? null : toIsoString(row.acknowledged_at),
    }));
  }

  async acknowledge(input: AcknowledgeSessionReadReceiptInput): Promise<SessionReadReceipt> {
    return await this.client.transaction(async (tx) => {
      const owned = await tx.query(LOCK_OWNED_SESSION_SQL, [input.sessionId, input.viewerId]);
      if (owned.rows.length === 0) {
        throw new SessionReadReceiptError("session_not_found", "Session not found");
      }
      const current = await tx.query<{ turn_id: string } & SqlRow>(LATEST_TERMINAL_TURN_SQL, [input.sessionId]);
      if (current.rows[0]?.turn_id !== input.terminalTurnId) {
        throw new SessionReadReceiptError("stale_terminal_turn", "Acknowledgement does not match the latest terminal turn");
      }
      const result = await tx.query<ReceiptRow>(UPSERT_SESSION_RECEIPT_SQL, [
        input.sessionId,
        input.viewerId,
        input.terminalTurnId,
        input.acknowledgedAt,
      ]);
      const row = result.rows[0];
      if (!row) throw new SessionReadReceiptError("stale_terminal_turn", "Acknowledgement does not match the latest terminal turn");
      return {
        sessionId: row.session_id,
        viewerId: row.viewer_id,
        lastAcknowledgedTerminalTurnId: row.last_acknowledged_terminal_turn_id,
        acknowledgedAt: toIsoString(row.acknowledged_at),
      };
    });
  }
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const TERMINAL_EVENT_TYPES = "'turn.completed', 'turn.failed', 'turn.interrupted'";

const LATEST_TERMINAL_TURN_SQL = `
  SELECT admission.turn_id
  FROM sessions session
  JOIN canonical_turn_admissions admission
    ON admission.session_id = session.id
   AND admission.thread_id = session.thread_id
   AND admission.admission_state = 'admitted'
   AND admission.admission_order IS NOT NULL
  JOIN canonical_lifecycle_events event
    ON event.thread_id = admission.thread_id
   AND event.turn_id = admission.turn_id
   AND event.run_attempt_id = admission.run_attempt_id
   AND event.event_type IN (${TERMINAL_EVENT_TYPES})
  WHERE session.id = $1
  ORDER BY admission.admission_order DESC
  LIMIT 1
`;

const LIST_READ_STATES_SQL = `
  SELECT session.id AS session_id,
    terminal.turn_id AS last_terminal_turn_id,
    receipt.last_acknowledged_terminal_turn_id,
    receipt.acknowledged_at
  FROM sessions session
  LEFT JOIN LATERAL (
    SELECT admission.turn_id
    FROM canonical_turn_admissions admission
    JOIN canonical_lifecycle_events event
      ON event.thread_id = admission.thread_id
     AND event.turn_id = admission.turn_id
     AND event.run_attempt_id = admission.run_attempt_id
     AND event.event_type IN (${TERMINAL_EVENT_TYPES})
    WHERE admission.session_id = session.id
      AND session.thread_id IS NOT NULL
      AND admission.thread_id = session.thread_id
      AND admission.admission_state = 'admitted'
      AND admission.admission_order IS NOT NULL
    ORDER BY admission.admission_order DESC
    LIMIT 1
  ) terminal ON TRUE
  LEFT JOIN thread_read_receipts receipt
    ON receipt.session_id = session.id AND receipt.viewer_id = $1::uuid::text
  WHERE session.user_id = $1::uuid AND session.id = ANY($2::uuid[])
`;

const LOCK_OWNED_SESSION_SQL = `
  SELECT id FROM sessions WHERE id = $1 AND user_id = $2::uuid FOR UPDATE
`;

const UPSERT_SESSION_RECEIPT_SQL = `
  INSERT INTO thread_read_receipts
    (session_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at)
  SELECT $1::uuid, $2::text, $3::text, $4::timestamptz
  WHERE EXISTS (
    SELECT 1 FROM sessions session
    WHERE session.id = $1 AND session.user_id = $2::uuid AND session.thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM canonical_turn_admissions admission
        JOIN canonical_lifecycle_events event
          ON event.thread_id = admission.thread_id
         AND event.turn_id = admission.turn_id
         AND event.run_attempt_id = admission.run_attempt_id
         AND event.event_type IN (${TERMINAL_EVENT_TYPES})
        WHERE admission.session_id = session.id
          AND admission.thread_id = session.thread_id
          AND admission.admission_state = 'admitted'
          AND admission.admission_order IS NOT NULL
          AND admission.turn_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM canonical_turn_admissions later
            JOIN canonical_lifecycle_events later_event
              ON later_event.thread_id = later.thread_id
             AND later_event.turn_id = later.turn_id
             AND later_event.run_attempt_id = later.run_attempt_id
             AND later_event.event_type IN (${TERMINAL_EVENT_TYPES})
            WHERE later.session_id = admission.session_id
              AND later.thread_id = session.thread_id
              AND later.admission_state = 'admitted'
              AND later.admission_order IS NOT NULL
              AND later.admission_order > admission.admission_order
          )
      )
  )
  ON CONFLICT (session_id, viewer_id) DO UPDATE SET
    last_acknowledged_terminal_turn_id = EXCLUDED.last_acknowledged_terminal_turn_id,
    acknowledged_at = CASE
      WHEN thread_read_receipts.last_acknowledged_terminal_turn_id = EXCLUDED.last_acknowledged_terminal_turn_id
      THEN thread_read_receipts.acknowledged_at
      ELSE EXCLUDED.acknowledged_at
    END
  RETURNING session_id, viewer_id, last_acknowledged_terminal_turn_id, acknowledged_at
`;
