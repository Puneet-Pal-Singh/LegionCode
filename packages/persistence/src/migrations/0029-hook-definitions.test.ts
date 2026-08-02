import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { hookDefinitionsMigration } from "./0029-hook-definitions.js";

describe("hook definitions migration", () => {
  it("stores user-scoped configuration without becoming lifecycle truth", () => {
    expect(persistenceMigrations).toContain(hookDefinitionsMigration);

    const sql = hookDefinitionsMigration.statements.join("\n");
    expect(sql).toContain(
      "PRIMARY KEY (user_id, workspace_id, handler_id)",
    );
    expect(sql).toContain("FOREIGN KEY (workspace_id, user_id)");
    expect(sql).toContain("REFERENCES workspaces (id, user_id)");
    expect(sql).toContain("ON DELETE CASCADE");
    expect(sql).toContain("hook_definitions_timeout_check");
    expect(sql).toContain("hook_definitions_event_name_check");
    expect(sql).toContain("hook_definitions_source_check");
    expect(sql).not.toMatch(/\b(token|secret|final_output|lifecycle_event)\b/i);
  });
});
