import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextMemoryPermissionsBootstrapMigration } from "../migrations/0007-context-memory-permissions-bootstrap.js";
import {
  PERMISSION_REQUEST_STATUSES,
  PERMISSION_DECISION_KINDS,
  buildPermissionRequestStatusSqlList,
  buildPermissionDecisionKindSqlList,
} from "./types.js";

const DRIZZLE_CONTEXT_MEMORY_PERMISSIONS_MIGRATION = new URL(
  "../../drizzle/0007_context_memory_permissions_bootstrap.sql",
  import.meta.url,
);

describe("permission request statuses", () => {
  it("uses one status list for TypeScript and Worker SQL constraints", () => {
    const createTableStatement =
      contextMemoryPermissionsBootstrapMigration.statements.find((s) =>
        s.includes("permission_requests_status_check"),
      );

    expect(PERMISSION_REQUEST_STATUSES).toEqual([
      "pending",
      "resolved",
      "expired",
      "aborted",
    ]);
    expect(createTableStatement).toContain(
      `CHECK (status IN (${buildPermissionRequestStatusSqlList()}))`,
    );
  });

  it("generates a valid SQL list from status constants", () => {
    const sqlList = buildPermissionRequestStatusSqlList();
    expect(sqlList).toContain("'pending'");
    expect(sqlList).toContain("'resolved'");
    expect(sqlList).toContain("'expired'");
    expect(sqlList).toContain("'aborted'");
  });

  it("keeps the committed Drizzle migration aligned with request statuses", () => {
    const migrationSql = readFileSync(
      DRIZZLE_CONTEXT_MEMORY_PERMISSIONS_MIGRATION,
      "utf8",
    );

    expect(migrationSql).toContain(
      `CHECK (status IN (${buildPermissionRequestStatusSqlList()}))`,
    );
  });
});

describe("permission decision kinds", () => {
  it("uses one decision kind list for TypeScript and Worker SQL constraints", () => {
    const createTableStatement =
      contextMemoryPermissionsBootstrapMigration.statements.find((s) =>
        s.includes("permission_decisions_kind_check"),
      );

    expect(PERMISSION_DECISION_KINDS).toEqual([
      "allow_once",
      "allow_for_run",
      "allow_persistent_rule",
      "deny",
      "abort",
    ]);
    expect(createTableStatement).toContain(
      `CHECK (decision IN (${buildPermissionDecisionKindSqlList()}))`,
    );
  });

  it("generates a valid SQL list from decision kind constants", () => {
    const sqlList = buildPermissionDecisionKindSqlList();
    expect(sqlList).toContain("'allow_once'");
    expect(sqlList).toContain("'allow_for_run'");
    expect(sqlList).toContain("'allow_persistent_rule'");
    expect(sqlList).toContain("'deny'");
    expect(sqlList).toContain("'abort'");
  });

  it("keeps the committed Drizzle migration aligned with decision kinds", () => {
    const migrationSql = readFileSync(
      DRIZZLE_CONTEXT_MEMORY_PERMISSIONS_MIGRATION,
      "utf8",
    );

    expect(migrationSql).toContain(
      `CHECK (decision IN (${buildPermissionDecisionKindSqlList()}))`,
    );
  });
});
