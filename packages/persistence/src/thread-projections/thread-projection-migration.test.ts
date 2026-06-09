import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
  ThreadStatusSchema,
  ThreadTitleSourceSchema,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { threadProjectionsMigration } from "../migrations/0017-thread-projections.js";
import { buildSqlList } from "../sessions/types.js";

const migrationSqlPath = join(
  process.cwd(),
  "drizzle",
  "0017_thread_projections.sql",
);

describe("thread projection migration", () => {
  it("registers after canonical event tables", () => {
    const migrationIds = persistenceMigrations.map((migration) => migration.id);
    const canonicalEventsIndex = migrationIds.indexOf(
      "0016_canonical_event_tables",
    );

    expect(canonicalEventsIndex).toBeGreaterThanOrEqual(0);
    expect(persistenceMigrations[canonicalEventsIndex + 1]).toBe(
      threadProjectionsMigration,
    );
  });

  it("creates canonical thread and item projection tables", () => {
    const sql = threadProjectionsMigration.statements.join("\n");

    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_thread_projections",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_thread_item_projections",
    );
    expect(sql).toContain("thread_id TEXT PRIMARY KEY");
    expect(sql).toContain("last_cursor TEXT NOT NULL");
    expect(sql).toContain("projection_version INTEGER NOT NULL");
    expect(sql).toContain("FOREIGN KEY (thread_id)");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("keeps committed SQL aligned with protocol registries", () => {
    const migrationSql = readFileSync(migrationSqlPath, "utf8");

    expect(migrationSql).toContain(
      `CHECK (status IN (${buildSqlList(ThreadStatusSchema.options)}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (title_source IN (${buildSqlList(ThreadTitleSourceSchema.options)}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (role IN (${buildSqlList(ThreadItemRoleSchema.options)}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (status IN (${buildSqlList(ThreadItemStatusSchema.options)}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (item_type IN (${buildSqlList(ThreadItemTypeSchema.options)}))`,
    );
  });
});
