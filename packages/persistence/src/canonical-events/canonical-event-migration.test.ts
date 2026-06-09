import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalEventTablesMigration } from "../migrations/0016-canonical-event-tables.js";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { ALLOCATE_CANONICAL_EVENT_SEQUENCE_SQL } from "./sequence.js";
import {
  CANONICAL_EVENT_SCOPE_TYPES,
  buildCanonicalEventScopeTypeSqlList,
} from "./types.js";

const migrationSqlPath = join(
  process.cwd(),
  "drizzle",
  "0016_canonical_event_tables.sql",
);

describe("canonical event table migration", () => {
  it("registers the migration after existing persistence migrations", () => {
    expect(persistenceMigrations.at(-1)).toBe(canonicalEventTablesMigration);
  });

  it("creates append-only canonical event tables with scoped uniqueness", () => {
    const sql = canonicalEventTablesMigration.statements.join("\n");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS canonical_events");
    expect(sql).toContain("event_id TEXT NOT NULL");
    expect(sql).toContain("scope_type TEXT NOT NULL");
    expect(sql).toContain("scope_id TEXT NOT NULL");
    expect(sql).toContain("sequence BIGINT NOT NULL");
    expect(sql).toContain("schema_version INTEGER NOT NULL");
    expect(sql).toContain("producer_kind TEXT NOT NULL");
    expect(sql).toContain("producer_id TEXT");
    expect(sql).toContain("UNIQUE (event_id)");
    expect(sql).toContain("UNIQUE (cursor)");
    expect(sql).toContain("UNIQUE (scope_type, scope_id, sequence)");
    expect(sql).toContain(
      "ON canonical_events (scope_type, scope_id, idempotency_key)",
    );
    expect(sql).toContain("WHERE idempotency_key IS NOT NULL");
    expect(sql).toContain(
      `CHECK (scope_type IN (${buildCanonicalEventScopeTypeSqlList()}))`,
    );
  });

  it("creates a scoped sequence allocation table for concurrent appends", () => {
    const sql = canonicalEventTablesMigration.statements.join("\n");

    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_event_scope_sequences",
    );
    expect(sql).toContain("PRIMARY KEY (scope_type, scope_id)");
    expect(ALLOCATE_CANONICAL_EVENT_SEQUENCE_SQL).toContain(
      "ON CONFLICT (scope_type, scope_id)",
    );
    expect(ALLOCATE_CANONICAL_EVENT_SEQUENCE_SQL).toContain(
      "next_sequence = canonical_event_scope_sequences.next_sequence + 1",
    );
    expect(ALLOCATE_CANONICAL_EVENT_SEQUENCE_SQL).toContain(
      "RETURNING next_sequence - 1 AS sequence",
    );
  });

  it("keeps the committed Drizzle migration aligned with scope registry", () => {
    const migrationSql = readFileSync(migrationSqlPath, "utf8");

    expect(migrationSql).toContain(
      `CHECK (scope_type IN (${buildCanonicalEventScopeTypeSqlList()}))`,
    );
    expect(migrationSql).toContain(
      `CONSTRAINT "canonical_event_scope_sequences_scope_type_check" CHECK (scope_type IN (${buildCanonicalEventScopeTypeSqlList()}))`,
    );
    expect(migrationSql).toContain(
      `CONSTRAINT "canonical_events_scope_type_check" CHECK (scope_type IN (${buildCanonicalEventScopeTypeSqlList()}))`,
    );
    for (const scopeType of CANONICAL_EVENT_SCOPE_TYPES) {
      expect(migrationSql).toContain(`'${scopeType}'`);
    }
  });
});
