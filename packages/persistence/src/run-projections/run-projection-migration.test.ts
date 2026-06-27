import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApprovalDecisionSchema,
  RunModeSchema,
  RunStatusSchema,
  ThreadItemRoleSchema,
  ThreadItemStatusSchema,
  ThreadItemTypeSchema,
} from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { threadProjectionsMigration } from "../migrations/0017-thread-projections.js";
import { runProjectionsMigration } from "../migrations/0018-run-projections.js";
import { buildSqlList } from "../sessions/types.js";
import {
  buildApprovalProjectionStatusSqlList,
  buildToolCallProjectionStatusSqlList,
} from "./types.js";

const migrationSqlPath = join(
  process.cwd(),
  "drizzle",
  "0018_run_projections.sql",
);

describe("run projection migration", () => {
  it("registers after thread projections", () => {
    expect(persistenceMigrations.indexOf(runProjectionsMigration)).toBe(
      persistenceMigrations.indexOf(threadProjectionsMigration) + 1,
    );
  });

  it("creates canonical run projection tables", () => {
    const sql = runProjectionsMigration.statements.join("\n");

    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_run_projections",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_run_item_projections",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_tool_call_projections",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS canonical_approval_projections",
    );
    expect(sql).toContain("run_id TEXT PRIMARY KEY");
    expect(sql).toContain("last_cursor TEXT NOT NULL");
    expect(sql).toContain("projection_version INTEGER NOT NULL");
    expect(sql).toContain("FOREIGN KEY (run_id)");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("keeps committed SQL aligned with protocol registries", () => {
    const migrationSql = readFileSync(migrationSqlPath, "utf8");

    expect(migrationSql).toContain(
      `CHECK (status IN (${buildSqlList(RunStatusSchema.options)}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (mode IN (${buildSqlList(RunModeSchema.options)}))`,
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
    expect(migrationSql).toContain(
      `CHECK (status IN (${buildToolCallProjectionStatusSqlList()}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (status IN (${buildApprovalProjectionStatusSqlList()}))`,
    );
    expect(migrationSql).toContain(
      `CHECK (decision IS NULL OR decision IN (${buildSqlList(
        ApprovalDecisionSchema.options,
      )}))`,
    );
  });
});
