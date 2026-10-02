import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { sessionThreadIdentityMigration } from "./0030-session-thread-identity.js";
import { lifecycleEventAppendOrderMigration } from "./0031-lifecycle-event-append-order.js";

describe("sessionThreadIdentityMigration", () => {
  it("persists the server-owned thread identity before the append-order migration", () => {
    expect(persistenceMigrations).toContain(sessionThreadIdentityMigration);
    expect(
      persistenceMigrations.indexOf(sessionThreadIdentityMigration),
    ).toBeLessThan(
      persistenceMigrations.indexOf(lifecycleEventAppendOrderMigration),
    );
    expect(sessionThreadIdentityMigration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ADD COLUMN IF NOT EXISTS thread_id TEXT"),
      ]),
    );
  });
});
