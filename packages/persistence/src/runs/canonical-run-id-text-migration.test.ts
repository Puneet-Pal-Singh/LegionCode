import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { canonicalRunIdTextMigration } from "../migrations/0022-canonical-run-id-text.js";

describe("canonical run id text migration", () => {
  it("registers the canonical run id migration last", () => {
    const sql = canonicalRunIdTextMigration.statements.join("\n");

    expect(persistenceMigrations.at(-1)).toBe(canonicalRunIdTextMigration);
    expect(sql).toContain("ALTER TABLE runs ALTER COLUMN id SET DATA TYPE text");
    expect(sql).toContain("ALTER TABLE run_events ALTER COLUMN run_id SET DATA TYPE text");
    expect(sql).toContain("FOREIGN KEY (run_id)");
  });

  it("registers the committed SQL in the Drizzle journal", () => {
    const journal = readFileSync(
      join(process.cwd(), "drizzle", "meta", "_journal.json"),
      "utf8",
    );

    expect(journal).toContain('"tag": "0022_canonical_run_id_text"');
  });
});
