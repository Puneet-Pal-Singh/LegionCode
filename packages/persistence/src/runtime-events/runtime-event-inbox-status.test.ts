import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeEventInboxMigration } from "../migrations/0001-runtime-event-inbox.js";
import {
  RUNTIME_EVENT_INBOX_STATUSES,
  buildRuntimeEventInboxStatusSqlList,
} from "./types.js";

const DRIZZLE_RUNTIME_EVENT_INBOX_MIGRATION = new URL(
  "../../drizzle/0000_runtime_event_inbox.sql",
  import.meta.url,
);

describe("runtime event inbox statuses", () => {
  it("uses one status list for TypeScript and Worker SQL constraints", () => {
    const createTableStatement = runtimeEventInboxMigration.statements.find(
      (statement) => statement.includes("runtime_event_inbox_status_check"),
    );

    expect(RUNTIME_EVENT_INBOX_STATUSES).toEqual([
      "received",
      "processing",
      "processed",
      "failed",
    ]);
    expect(createTableStatement).toContain(
      `CHECK (status IN (${buildRuntimeEventInboxStatusSqlList()}))`,
    );
  });

  it("keeps the committed Drizzle migration aligned with the status list", () => {
    const migrationSql = readFileSync(
      DRIZZLE_RUNTIME_EVENT_INBOX_MIGRATION,
      "utf8",
    );

    expect(migrationSql).toContain(
      `CHECK ("runtime_event_inbox"."status" IN (${buildRuntimeEventInboxStatusSqlList()}))`,
    );
  });
});
