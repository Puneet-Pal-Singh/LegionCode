import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { lifecycleEventsProjectionsMigration } from "../migrations/0020-lifecycle-events-projections.js";

describe("lifecycle event persistence migration", () => {
  it("registers durable event and projection tables after their dependencies", () => {
    expect(persistenceMigrations.at(-1)).toBe(lifecycleEventsProjectionsMigration);
    const sql = lifecycleEventsProjectionsMigration.statements.join("\n");
    expect(sql).toContain("canonical_lifecycle_events");
    expect(sql).toContain("canonical_lifecycle_projections");
    expect(sql).toContain("turn_id, sequence");
    expect(sql).toContain("turn_id, idempotency_key");
  });
});
