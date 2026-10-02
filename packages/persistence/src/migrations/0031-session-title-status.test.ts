import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { sessionTitleStatusMigration } from "./0031-session-title-status.js";
import { readFileSync } from "node:fs";

describe("session title status migration", () => {
  it("registers the same additive migration as the SQL deployment path", () => {
    expect(persistenceMigrations.at(-1)).toBe(sessionTitleStatusMigration);
    const sql = readFileSync(
      new URL("../../drizzle/0031_session_title_status.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sessionTitleStatusMigration.statements)
      expect(sql).toContain(statement);
  });
});
