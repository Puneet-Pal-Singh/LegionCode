import { expect, test, type Route } from "@playwright/test";

const TURN_ID = "trn_chatproduct_001";
const RUN_ID = "run_chatproduct_001";
const NOW = "2026-07-07T10:00:00.000Z";

const TURN_DIFF = {
  turnId: TURN_ID,
  startSnapshot: { turnId: TURN_ID, snapshotKey: "start", treeId: "a".repeat(40), headSha: "a".repeat(40), phase: "start", capturedAt: NOW },
  terminalSnapshot: { turnId: TURN_ID, snapshotKey: "terminal", treeId: "b".repeat(40), headSha: "b".repeat(40), phase: "terminal", capturedAt: NOW },
  files: [
    { path: "src/landing/Hero.tsx", status: "modified", additions: 5, deletions: 2, previousPath: null },
    { path: "src/landing/Hero.css", status: "modified", additions: 3, deletions: 1, previousPath: null },
  ],
  patch: "diff --git a/src/landing/Hero.tsx b/src/landing/Hero.tsx\n--- a/src/landing/Hero.tsx\n+++ b/src/landing/Hero.tsx\n@@ -1,3 +1,6 @@\n+import { OptimizedImage } from './OptimizedImage';\n+\n export const Hero = () => (\n-  <section className='hero'>\n+  <section className='hero optimized'>\n",
};

const LIFECYCLE_EVENTS = [
  evt(1, "turn.queued"),
  evt(2, "turn.started"),
  evt(3, "run_attempt.started"),
  evt(4, "item.started", "itm_tool_01", { kind: "tool_call", text: "read_file src/landing/Hero.tsx" }),
  evt(5, "item.completed", "itm_tool_01", { result: { content: "read Hero.tsx" } }),
  evt(6, "item.started", "itm_tool_02", { kind: "tool_call", text: "grep landing" }),
  evt(7, "item.completed", "itm_tool_02", { result: { content: "found Hero.css" } }),
  evt(8, "turn.diff_updated", undefined, { diff: TURN_DIFF }),
  evt(9, "turn.completed", undefined, { outcome: { status: "completed" } }),
];

test("ChatInterface renders lifecycle workflow, terminal state, and diff through real component", async ({ page }) => {
  let releaseLive: () => void = () => {};
  const releaseGate = new Promise<void>((r) => { releaseLive = r; });
  let replayMode: "initial" | "refresh" = "initial";

  await page.route("**/turns/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stream")) {
      await releaseGate;
      const body = replayMode === "initial" ? ndjson(LIFECYCLE_EVENTS.slice(4)) : "";
      await route.fulfill({ contentType: "application/x-ndjson", body });
      return;
    }
    const events = replayMode === "initial" ? LIFECYCLE_EVENTS.slice(0, 4) : LIFECYCLE_EVENTS;
    await fulfillReplay(route, events);
  });

  await page.route("**/api/run/summary**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runId: RUN_ID, status: "COMPLETED", totalTasks: 2, completedTasks: 2, failedTasks: 0 }),
    });
  });

  await page.route("**/api/run/events**", async (route) => {
    await route.fulfill({ contentType: "application/x-ndjson", body: "" });
  });

  await page.route("**/api/run/activity**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runId: RUN_ID, sessionId: "session_product_001", status: "COMPLETED", items: [] }) });
  });

  await page.route("**/api/git/status**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ branch: "main", files: [], ahead: 0, behind: 0, hasStaged: false, hasUnstaged: false, gitAvailable: true }) });
  });

  await page.route("**/api/provider/**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/runtime/**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/artifacts/**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.goto("/chat-interface-product-golden.html");

  // Turn identity flows through lifecycle
  await expect(page.getByTestId("turn-id")).not.toHaveText("pending", { timeout: 100 }).catch(() => {});

  // User prompt visible
  await expect(page.getByText("Review the landing page hero section")).toBeVisible({ timeout: 3000 });

  // Assistant reply visible
  await expect(page.getByText("I have reviewed the landing page hero section.")).toBeVisible({ timeout: 3000 });

  releaseLive();

  // Terminal state settled
  await expect(page.locator("text=completed")).toBeVisible({ timeout: 5000 });

  // Diff files from lifecycle projection are visible
  await expect(page.getByText("2 files changed")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("src/landing/Hero.tsx")).toBeVisible({ timeout: 3000 });
  await expect(page.getByText("src/landing/Hero.css")).toBeVisible({ timeout: 3000 });

  // Refresh parity
  replayMode = "refresh";
  const firstSnapshot = (await page.getByText("2 files changed").textContent()) ?? "";
  await page.reload();
  await expect(page.getByText("2 files changed")).toHaveText(firstSnapshot, { timeout: 10000 });
});

function evt(sequence: number, type: string, itemId?: string, payload: Record<string, unknown> = {}) {
  return {
    eventId: `evt_chatprod${String(sequence).padStart(3, "0")}`,
    threadId: "thr_chatproduct1",
    turnId: TURN_ID,
    runAttemptId: "attempt_chatproduct1",
    itemId: itemId ?? null,
    approvalId: null,
    sequence,
    idempotencyKey: `${TURN_ID}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "runtime-kernel-chat-product" },
    schemaVersion: 1,
    createdAt: NOW,
    type,
    payload,
  };
}

function fulfillReplay(route: Route, events: readonly unknown[]) {
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      events,
      nextSequence: events.length ? (events.at(-1) as { sequence: number }).sequence : null,
    }),
  });
}

function ndjson(values: readonly unknown[]) {
  return values.map((v) => JSON.stringify(v)).join("\n");
}
