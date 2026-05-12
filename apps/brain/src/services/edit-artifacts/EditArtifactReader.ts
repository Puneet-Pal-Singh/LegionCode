import type { D1Database } from "@cloudflare/workers-types";
import type {
  EditArtifactRecord,
  EditArtifactStatus,
} from "@repo/shared-types";
import { rowToRecord, type EditArtifactRow } from "./EditArtifactRows";

const RESTORABLE_STATUSES: EditArtifactStatus[] = [
  "stored",
  "restored",
  "restore_failed",
  "requires_user_resolution",
];

export class EditArtifactReader {
  constructor(private readonly db: D1Database) {}

  async getLatestRestorableArtifact(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const placeholders = RESTORABLE_STATUSES.map(() => "?").join(", ");
    const row = await this.db
      .prepare(
        `
        SELECT * FROM run_edit_artifacts
        WHERE run_id = ? AND status IN (${placeholders}) AND expires_at > ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .bind(runId, ...RESTORABLE_STATUSES, new Date().toISOString())
      .first<EditArtifactRow>();

    return row ? rowToRecord(row) : null;
  }

  async listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    const result = await this.db
      .prepare(
        `
        SELECT * FROM run_edit_artifacts
        WHERE expires_at <= ? AND status NOT IN ('expired', 'discarded', 'anchored')
        ORDER BY expires_at ASC
      `,
      )
      .bind(now)
      .all<EditArtifactRow>();

    return result.results.map(rowToRecord);
  }

  async listStalePendingArtifacts(
    cutoff: string,
  ): Promise<EditArtifactRecord[]> {
    const result = await this.db
      .prepare(
        `
        SELECT * FROM run_edit_artifacts
        WHERE status = 'pending' AND created_at <= ?
        ORDER BY created_at ASC
      `,
      )
      .bind(cutoff)
      .all<EditArtifactRow>();

    return result.results.map(rowToRecord);
  }
}
