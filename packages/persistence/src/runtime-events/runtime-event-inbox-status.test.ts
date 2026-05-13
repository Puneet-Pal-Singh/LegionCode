import { describe, expect, it } from "vitest";
import { runtimeEventInboxMigration } from "../migrations/0001-runtime-event-inbox.js";
import {
  RUNTIME_EVENT_INBOX_STATUSES,
  buildRuntimeEventInboxStatusSqlList,
} from "./types.js";

describe("runtime event inbox statuses", () => {
  it("uses one status list for TypeScript and SQL constraints", () => {
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
});
