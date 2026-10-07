import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "./0001-runtime-event-inbox.js";
import { lifecycleEventAppendOrderMigration } from "./0031-lifecycle-event-append-order.js";
import { chatDurabilityMigration } from "./0032-chat-durability.js";

describe("lifecycleEventAppendOrderMigration", () => {
  it("adds a durable global append order and a turn-start lookup index", () => {
    expect(persistenceMigrations.at(-3)).toBe(lifecycleEventAppendOrderMigration);
    expect(persistenceMigrations.at(-1)).toBe(chatDurabilityMigration);
    expect(lifecycleEventAppendOrderMigration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "ADD COLUMN IF NOT EXISTS append_order BIGSERIAL NOT NULL",
        ),
        expect.stringContaining("WHERE event_type = 'turn.started'"),
      ]),
    );
  });
});
