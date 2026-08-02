import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_SOURCE = join(process.cwd(), "src/App.tsx");

describe("App run summary boundary", () => {
  it("does not reconcile sidebar sessions by polling run summaries", () => {
    const source = readFileSync(APP_SOURCE, "utf8");

    expect(source).not.toContain("/api/run/summary");
    expect(source).not.toContain("fetchRunSummaryStatus");
    expect(source).not.toContain("reconcilableSessions");
  });

  it("does not remount Workspace from a scope emitted by Workspace itself", () => {
    const source = readFileSync(APP_SOURCE, "utf8");

    expect(source).not.toContain("CONVERSATION_SCOPE_READY_EVENT");
    expect(source).not.toContain("activeConversationScopeKey");
  });
});
