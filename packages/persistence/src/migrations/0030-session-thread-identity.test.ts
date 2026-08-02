import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { sessionThreadIdentityMigration } from "./0030-session-thread-identity.js";

describe("sessionThreadIdentityMigration", () => {
  it("is the current migration and persists the server-owned thread identity", () => {
    expect(persistenceMigrations.at(-1)).toBe(sessionThreadIdentityMigration);
    expect(sessionThreadIdentityMigration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ADD COLUMN IF NOT EXISTS thread_id TEXT'),
      ]),
    );
  });
});
