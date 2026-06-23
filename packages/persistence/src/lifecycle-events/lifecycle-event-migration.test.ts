import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { lifecycleEventsProjectionsMigration } from "../migrations/0020-lifecycle-events-projections.js";

describe("lifecycle event persistence migration", () => {
  it("registers durable event and projection tables after their dependencies", () => {
    expect(persistenceMigrations).toContain(
      lifecycleEventsProjectionsMigration,
    );
    const sql = lifecycleEventsProjectionsMigration.statements.join("\n");
    expect(sql).toContain("canonical_lifecycle_events");
    expect(sql).toContain("canonical_lifecycle_projections");
    expect(sql).toContain("turn_id, sequence");
    expect(sql).toContain("turn_id, idempotency_key");
  });

  it("registers the committed lifecycle SQL in the Drizzle journal", () => {
    const journal = readFileSync(
      join(process.cwd(), "drizzle", "meta", "_journal.json"),
      "utf8",
    );

    expect(journal).toContain('"tag": "0020_lifecycle_events_projections"');
  });
});
