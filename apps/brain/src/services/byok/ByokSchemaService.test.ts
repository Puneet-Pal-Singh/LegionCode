import { afterEach, describe, expect, it } from "vitest";
import {
  createByokSchemaService,
  resetByokSchemaReadyCacheForTests,
  splitSqlStatements,
} from "./ByokSchemaService.js";
import { createTestByokD1Database } from "../../test-utils/byokTestD1";

describe("ByokSchemaService", () => {
  afterEach(() => {
    resetByokSchemaReadyCacheForTests();
  });

  it("applies migrations once and provisions every required table", async () => {
    const db = createTestByokD1Database();
    const service = createByokSchemaService(db.database);

    await service.ensureReady();

    const appliedMigrations = db.inspect.getAppliedMigrationIds();
    expect(appliedMigrations.length).toBeGreaterThan(0);
    expect(appliedMigrations).toContain("byok_migration_000");
    expect(appliedMigrations).toContain("byok_migration_005");
    expect(db.inspect.hasTable("run_edit_artifacts")).toBe(true);
    expect(db.inspect.hasTable("run_edit_artifact_events")).toBe(true);
  });

  it("skips already-applied migrations on subsequent ensureReady calls", async () => {
    const db = createTestByokD1Database();
    const service = createByokSchemaService(db.database);

    await service.ensureReady();
    const firstPass = db.inspect.getAppliedMigrationIds();

    await service.ensureReady();
    const secondPass = db.inspect.getAppliedMigrationIds();

    expect(secondPass).toEqual(firstPass);
  });

  it("treats pre-existing add-column targets as already satisfied", async () => {
    const db = createTestByokD1Database();
    db.inspect.seedTable("byok_preferences", [
      "user_id",
      "workspace_id",
      "default_provider_id",
      "default_credential_id",
      "default_model_id",
      "fallback_mode",
      "fallback_json",
      "updated_at",
      "visible_model_ids_json",
      "credential_labels_json",
    ]);
    db.inspect.seedTable("provider_registry_cache", [
      "provider_id",
      "display_name",
      "auth_modes_json",
      "capabilities_json",
      "models_json",
      "source_version",
      "fetched_at",
      "expires_at",
      "refreshed_at",
    ]);

    const service = createByokSchemaService(db.database);

    await expect(service.ensureReady()).resolves.toBeUndefined();
    expect(db.inspect.getAppliedMigrationIds().length).toBeGreaterThan(0);
  });

  it("appends new migrations without renumbering previously applied ids", async () => {
    const db = createTestByokD1Database();
    for (let index = 0; index <= 9; index += 1) {
      db.inspect.seedAppliedMigration(
        `byok_migration_${index.toString().padStart(3, "0")}`,
      );
    }

    const service = createByokSchemaService(db.database);

    await service.ensureReady();

    const appliedMigrations = db.inspect.getAppliedMigrationIds();
    expect(appliedMigrations).toContain("byok_migration_010");
    expect(appliedMigrations).toHaveLength(14);
  });

  it("recovers local ledgers that recorded the old migration id without creating the user cache table", async () => {
    const db = createTestByokD1Database();
    for (let index = 0; index <= 10; index += 1) {
      db.inspect.seedAppliedMigration(
        `byok_migration_${index.toString().padStart(3, "0")}`,
      );
    }

    const service = createByokSchemaService(db.database);

    await service.ensureReady();

    const appliedMigrations = db.inspect.getAppliedMigrationIds();
    expect(appliedMigrations).toContain("byok_migration_011");
    expect(appliedMigrations).toHaveLength(14);
    expect(db.inspect.hasTable("provider_user_model_cache")).toBe(true);
  });

  it("repairs missing required tables even when the migration ledger is already complete", async () => {
    const db = createTestByokD1Database();
    for (let index = 0; index <= 13; index += 1) {
      db.inspect.seedAppliedMigration(
        `byok_migration_${index.toString().padStart(3, "0")}`,
      );
    }

    const service = createByokSchemaService(db.database);

    await service.ensureReady();

    expect(db.inspect.hasTable("provider_user_model_cache")).toBe(true);
  });

  it("preserves quoted string literals while splitting migration statements", () => {
    const statements = splitSqlStatements(`
      CREATE TABLE example (
        status TEXT NOT NULL DEFAULT 'connected',
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT '2026-03-21T09:46:32.204Z'
      );
      INSERT INTO example (status, payload, created_at) VALUES ('connected', '{}', '2026-03-21T09:46:32.204Z');
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DEFAULT 'connected'");
    expect(statements[0]).toContain("DEFAULT '{}'");
    expect(statements[0]).toContain("DEFAULT '2026-03-21T09:46:32.204Z'");
    expect(statements[1]).toContain("VALUES ('connected', '{}', '2026-03-21T09:46:32.204Z')");
  });

  it("ignores trailing comment-only fragments after executable statements", () => {
    const statements = splitSqlStatements(`
      -- Drop old workspace-scoped index if it exists
      DROP INDEX IF EXISTS uq_byok_cred_scope_label;

      -- User-global unique index already created in BYOK_CREDENTIALS_SCHEMA
      -- This migration file exists for reference only
    `);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("DROP INDEX IF EXISTS uq_byok_cred_scope_label");
  });
});
