import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { taskWorkspacesMigration } from "../migrations/0025-task-workspaces.js";

describe("task workspaces migration", () => {
  it("registers immutable snapshot and isolated checkout storage after artifact provenance", () => {
    expect(persistenceMigrations.at(-1)).toBe(taskWorkspacesMigration);

    const sql = taskWorkspacesMigration.statements.join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workspace_snapshots");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS task_checkouts");
    expect(sql).toContain("FOREIGN KEY (snapshot_id, workspace_id)");
    expect(sql).toContain("UNIQUE (run_attempt_id)");
    expect(sql).toContain("UNIQUE (lease_id)");
    expect(sql).toContain("task_checkouts_terminal_fields_check");
    expect(sql).toContain("workspace_snapshots_immutable_trigger");
    expect(sql).toContain("task_checkouts_transition_trigger");
  });
});
