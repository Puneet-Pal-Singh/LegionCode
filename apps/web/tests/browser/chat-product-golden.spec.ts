import { expect, test, type Route } from "@playwright/test";

const TURN_ID = "trn_productgolden_001";
const NOW = "2026-07-07T10:00:00.000Z";
const TURN_DIFF = {
  turnId: TURN_ID,
  startSnapshot: { turnId: TURN_ID, snapshotKey: "start", treeId: "a".repeat(40), headSha: "a".repeat(40), phase: "start", capturedAt: NOW },
  terminalSnapshot: { turnId: TURN_ID, snapshotKey: "terminal", treeId: "b".repeat(40), headSha: "b".repeat(40), phase: "terminal", capturedAt: NOW },
  files: [
    { path: "src/feature.ts", status: "modified", additions: 1, deletions: 0, previousPath: null },
    { path: "src/utils.ts", status: "modified", additions: 3, deletions: 2, previousPath: null },
  ],
  patch: "diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1,2 @@\n export const enabled = false;\n+export const governed = true;\n",
};

const LIFECYCLE_EVENTS = [
  event(1, "turn.queued", {}),
  event(2, "turn.started", {}),
  event(3, "run_attempt.started", {}),
  event(4, "item.started", { itemId: "itm_tool1", payload: { kind: "tool_call", text: "file.write src/feature.ts" } }),
  event(5, "approval.requested", { itemId: "itm_approval1", approvalId: "appr_product1", payload: { kind: "approval_request", question: "Approve product edit?", options: [{ label: "Approve" }, { label: "Deny" }] } }),
  event(6, "approval.decided", { itemId: "itm_approval1", approvalId: "appr_product1", payload: { decision: "approved" } }),
  event(7, "item.completed", { itemId: "itm_tool1", payload: { result: { content: "wrote src/feature.ts" } } }),
  event(8, "turn.diff_updated", { payload: { diff: TURN_DIFF } }),
  event(9, "turn.completed", { payload: { outcome: { status: "completed" } } }),
];

test("ChatInterface lifecycle projection renders workflow, approval, diff, and terminal through real hooks", async ({ page }) => {
  let releaseLiveStream: () => void = () => {};
  let replayMode: "initial" | "refresh" = "initial";
  const releaseGate = new Promise<void>((resolve) => { releaseLiveStream = resolve; });

  await page.route("**/turns/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stream")) {
      await releaseGate;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: replayMode === "initial" ? ndjson(LIFECYCLE_EVENTS.slice(5)) : "",
      });
      return;
    }
    const events = replayMode === "initial" ? LIFECYCLE_EVENTS.slice(0, 5) : LIFECYCLE_EVENTS;
    await fulfillReplay(route, events);
  });

  await page.goto("/chat-product-golden.html");

  // Wait for turn identity to arrive via lifecycle
  await expect(page.getByTestId("turn-id")).not.toHaveText("pending");

  // Approval appears
  await expect(page.getByTestId("chat-approval")).toContainText("Approve product edit?");

  // Workflow rows appear
  await expect(page.getByTestId("item-tool_call")).toBeVisible();

  releaseLiveStream();

  // Terminal state settles
  await expect(page.getByTestId("chat-terminal")).toHaveText("completed:completed");

  // Diff files appear
  const diffFiles = page.getByTestId("diff-file");
  await expect(diffFiles.nth(0)).toHaveText("src/feature.ts");
  await expect(diffFiles.nth(1)).toHaveText("src/utils.ts");

  // Thinking cleared
  await expect(page.getByTestId("thinking-active")).toHaveText("no");

  // Refresh parity
  replayMode = "refresh";
  const firstTerminal = await page.getByTestId("chat-terminal").textContent();
  await page.reload();
  await expect(page.getByTestId("chat-terminal")).toHaveText(firstTerminal ?? "");
  await expect(page.getByTestId("diff-file")).toHaveCount(2);
});

async function fulfillReplay(route: Route, events: readonly unknown[]): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      events,
      nextSequence: events.length ? (events.at(-1) as { readonly sequence: number }).sequence : null,
    }),
  });
}

function ndjson(values: readonly unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join("\n");
}

function event(sequence: number, type: string, overrides: { readonly itemId?: string; readonly approvalId?: string; readonly payload?: Record<string, unknown> }) {
  return {
    eventId: `evt_product${String(sequence).padStart(3, "0")}`,
    threadId: "thr_productgolden1",
    turnId: TURN_ID,
    runAttemptId: "attempt_productgolden1",
    itemId: overrides.itemId,
    approvalId: overrides.approvalId,
    sequence,
    idempotencyKey: `${TURN_ID}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "runtime-kernel-product-gate" },
    schemaVersion: 1,
    createdAt: NOW,
    type,
    payload: overrides.payload ?? {},
  };
}
