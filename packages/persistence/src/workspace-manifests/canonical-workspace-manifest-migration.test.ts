import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceStateSchema } from "@repo/workspace-core";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { canonicalWorkspaceManifestMigration } from "../migrations/0021-canonical-workspace-manifest.js";

describe("canonical workspace manifest migration", () => {
  it("hard-cuts the obsolete manifest identity columns", () => {
    const sql = canonicalWorkspaceManifestMigration.statements.join("\n");

    expect(persistenceMigrations.at(-1)).toBe(
      canonicalWorkspaceManifestMigration,
    );
    expect(sql).toContain("DROP COLUMN manifest_id");
    expect(sql).toContain("DROP COLUMN user_id");
    expect(sql).toContain("ADD PRIMARY KEY (workspace_id)");
    expect(sql).toContain("RENAME COLUMN base_commit_sha TO base_sha");
  });

  it("keeps committed SQL aligned with workspace-core states", () => {
    const sql = readFileSync(
      join(process.cwd(), "drizzle", "0021_canonical_workspace_manifest.sql"),
      "utf8",
    );

    for (const state of WorkspaceStateSchema.options) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it("registers the committed SQL in the Drizzle journal", () => {
    const journal = readFileSync(
      join(process.cwd(), "drizzle", "meta", "_journal.json"),
      "utf8",
    );

    expect(journal).toContain('"tag": "0021_canonical_workspace_manifest"');
  });
});
