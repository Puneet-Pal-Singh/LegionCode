import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { runProjectionsMigration } from "../migrations/0018-run-projections.js";
import { workspaceManifestsArtifactMetadataMigration } from "../migrations/0019-workspace-manifests-artifact-metadata.js";

const migrationSqlPath = join(
  process.cwd(),
  "drizzle",
  "0019_workspace_manifests_artifact_metadata.sql",
);

describe("workspace manifest and artifact metadata migration", () => {
  it("registers after canonical run projections", () => {
    const runProjectionIndex = persistenceMigrations.indexOf(
      runProjectionsMigration,
    );
    const workspaceManifestIndex = persistenceMigrations.indexOf(
      workspaceManifestsArtifactMetadataMigration,
    );

    expect(workspaceManifestIndex).toBe(runProjectionIndex + 1);
  });

  it("creates manifest and generalized artifact metadata tables", () => {
    const sql =
      workspaceManifestsArtifactMetadataMigration.statements.join("\n");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workspace_manifests");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS artifact_metadata");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS artifact_metadata_changed_files",
    );
    expect(sql).toContain("'command_log'");
    expect(sql).toContain("'diff'");
    expect(sql).toContain("'context_checkpoint'");
    expect(sql).toContain("sha256 ~ '^[a-f0-9]{64}$'");
  });

  it("keeps committed SQL aligned with generalized artifact kinds", () => {
    const migrationSql = readFileSync(migrationSqlPath, "utf8");

    expect(migrationSql).toContain("'command_log'");
    expect(migrationSql).toContain("'diff'");
    expect(migrationSql).toContain("'context_checkpoint'");
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS workspace_manifests",
    );
  });
});
