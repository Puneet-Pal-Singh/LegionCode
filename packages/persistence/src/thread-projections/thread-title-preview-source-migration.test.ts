import { ThreadTitleSourceSchema } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { threadTitlePreviewSourceMigration } from "../migrations/0027-thread-title-preview-source.js";
import { buildSqlList } from "../sessions/types.js";

describe("thread title preview source migration", () => {
  it("updates existing projection constraints after title version storage", () => {
    expect(persistenceMigrations.at(-1)).toBe(
      threadTitlePreviewSourceMigration,
    );
    expect(threadTitlePreviewSourceMigration.statements.join("\n")).toContain(
      `CHECK (title_source IN (${buildSqlList(ThreadTitleSourceSchema.options)}))`,
    );
  });
});
