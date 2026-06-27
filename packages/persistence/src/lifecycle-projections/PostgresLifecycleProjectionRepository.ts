import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { SqlClient, SqlRow } from "../sql.js";
import { projectLifecycleEvents } from "./LifecycleProjector.js";
import {
  LifecycleProjectionSnapshotSchema,
  type LifecycleProjectionSnapshot,
} from "./types.js";

interface ProjectionRow extends SqlRow {
  projection_json?: unknown;
}

export class PostgresLifecycleProjectionRepository {
  constructor(private readonly client: SqlClient) {}

  async rebuild(
    events: readonly LifecycleEvent[],
  ): Promise<LifecycleProjectionSnapshot | null> {
    const projection = projectLifecycleEvents(events);
    if (projection) await this.save(projection);
    return projection;
  }

  async save(projection: LifecycleProjectionSnapshot): Promise<void> {
    const parsed = LifecycleProjectionSnapshotSchema.parse(projection);
    await this.client.query(UPSERT_SQL, [
      parsed.turnId,
      parsed.lastSequence,
      parsed.projectionVersion,
      JSON.stringify(parsed),
    ]);
  }

  async get(turnId: string): Promise<LifecycleProjectionSnapshot | null> {
    const result = await this.client.query<ProjectionRow>(READ_SQL, [turnId]);
    const value = result.rows[0]?.projection_json;
    if (value === undefined) return null;
    return LifecycleProjectionSnapshotSchema.parse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
  }
}

const UPSERT_SQL = `INSERT INTO canonical_lifecycle_projections (turn_id, last_sequence, projection_version, projection_json) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (turn_id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence, projection_version = EXCLUDED.projection_version, projection_json = EXCLUDED.projection_json, updated_at = now() WHERE canonical_lifecycle_projections.last_sequence <= EXCLUDED.last_sequence`;
const READ_SQL = `SELECT projection_json FROM canonical_lifecycle_projections WHERE turn_id = $1`;
