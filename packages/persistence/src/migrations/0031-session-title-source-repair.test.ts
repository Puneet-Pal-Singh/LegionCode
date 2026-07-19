import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { sessionTitleSourceRepairMigration } from "./0031-session-title-source-repair.js";

describe("sessionTitleSourceRepairMigration", () => {
  it("is registered after the existing session migrations", () => {
    expect(persistenceMigrations.at(-1)).toBe(sessionTitleSourceRepairMigration);
    expect(sessionTitleSourceRepairMigration.statements).toEqual([
      expect.stringContaining("DROP CONSTRAINT IF EXISTS sessions_title_source_check"),
      expect.stringContaining("title_source IN ('preview', 'generated', 'user')"),
    ]);
  });
});
