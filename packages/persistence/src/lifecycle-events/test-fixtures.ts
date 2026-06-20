import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";

export class LifecycleSqlClient implements SqlClient {
  private events: LifecycleEvent[] = [];
  private projections = new Map<string, unknown>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (statement.includes("idempotency_key = $2"))
      return this.findIdempotent<Row>(params);
    if (statement.includes("ORDER BY sequence DESC"))
      return this.lastSequence<Row>(params);
    if (statement.startsWith("INSERT INTO canonical_lifecycle_events"))
      return this.insertEvent<Row>(params);
    if (statement.includes("sequence > $2")) return this.replay<Row>(params);
    if (statement.startsWith("INSERT INTO canonical_lifecycle_projections")) {
      this.projections.set(String(params[0]), JSON.parse(String(params[3])));
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes("FROM canonical_lifecycle_projections")) {
      const projection = this.projections.get(String(params[0]));
      return rows<Row>(projection ? [{ projection_json: projection }] : []);
    }
    throw new Error(`Unhandled lifecycle SQL: ${statement}`);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const events = structuredClone(this.events);
    try {
      return await callback(this);
    } catch (error) {
      this.events = events;
      throw error;
    }
  }

  private findIdempotent<Row extends SqlRow>(params: readonly SqlValue[]) {
    return rows<Row>(
      this.events
        .filter(
          (event) =>
            event.turnId === params[0] && event.idempotencyKey === params[1],
        )
        .map(eventRow),
    );
  }

  private lastSequence<Row extends SqlRow>(params: readonly SqlValue[]) {
    const event = this.events
      .filter((item) => item.turnId === params[0])
      .at(-1);
    return rows<Row>(event ? [{ sequence: event.sequence }] : []);
  }

  private insertEvent<Row extends SqlRow>(params: readonly SqlValue[]) {
    const event = JSON.parse(String(params[7])) as LifecycleEvent;
    this.events.push(event);
    return rows<Row>([eventRow(event)]);
  }

  private replay<Row extends SqlRow>(params: readonly SqlValue[]) {
    const events = this.events
      .filter(
        (event) =>
          event.turnId === params[0] && event.sequence > Number(params[1]),
      )
      .slice(0, Number(params[2]));
    return rows<Row>(events.map(eventRow));
  }
}

function eventRow(event: LifecycleEvent): SqlRow {
  return { event_json: event, sequence: event.sequence };
}

function rows<Row extends SqlRow>(values: SqlRow[]): SqlQueryResult<Row> {
  return { rows: values as Row[], rowCount: values.length };
}
