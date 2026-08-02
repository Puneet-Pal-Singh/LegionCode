import { describe, expect, it } from "vitest";
import { persistenceMigrations } from "../migrations/0001-runtime-event-inbox.js";
import { taskCheckoutSecureSessionMigration } from "../migrations/0028-task-checkout-secure-session.js";

describe("task checkout secure session migration", () => {
  it("makes the opaque resume reference mandatory without persisting a bearer", () => {
    expect(persistenceMigrations).toContain(taskCheckoutSecureSessionMigration);
    const sql = taskCheckoutSecureSessionMigration.statements.join("\n");
    expect(sql).toContain("secure_session_id");
    expect(sql).toContain("SET NOT NULL");
    expect(sql).toContain("NEW.generation = OLD.generation + 1");
    expect(sql).toContain("task checkout lease replacement is invalid");
    expect(sql).not.toContain("token");
  });
});
