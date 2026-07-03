import { expect, test, type Page, type Route } from "@playwright/test";

const TURN_ID = "trn_run_browsergolden1";
const NOW = "2026-07-01T10:00:00.000Z";
const START_SNAPSHOT = {
  turnId: TURN_ID,
  snapshotKey: "start-browsergolden",
  treeId: "a".repeat(40),
  headSha: "a".repeat(40),
  phase: "start",
  capturedAt: NOW,
};
const TERMINAL_SNAPSHOT = {
  turnId: TURN_ID,
  snapshotKey: "terminal-browsergolden",
  treeId: "b".repeat(40),
  headSha: "b".repeat(40),
  phase: "terminal",
  capturedAt: NOW,
};
const TURN_DIFF = {
  turnId: TURN_ID,
  startSnapshot: START_SNAPSHOT,
  terminalSnapshot: TERMINAL_SNAPSHOT,
  files: [
    {
      path: "src/feature.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      previousPath: null,
    },
  ],
  patch: [
    "diff --git a/src/feature.ts b/src/feature.ts",
    "--- a/src/feature.ts",
    "+++ b/src/feature.ts",
    "@@ -1 +1,2 @@",
    " export const enabled = false;",
    "+export const governed = true;",
  ].join("\n"),
};
const LIFECYCLE_EVENTS = [
  event(1, "turn.queued", {}),
  event(2, "turn.started", {}),
  event(3, "run_attempt.started", {}),
  event(4, "item.started", {
    itemId: "itm_browsertool1",
    payload: { kind: "tool_call", text: "file.write src/feature.ts" },
  }),
  event(5, "approval.requested", {
    itemId: "itm_browserapproval1",
    approvalId: "appr_browsergolden1",
    payload: {
      kind: "approval_request",
      question: "Approve deterministic edit",
      options: [{ label: "Approve" }, { label: "Deny" }],
    },
  }),
  event(6, "approval.decided", {
    itemId: "itm_browserapproval1",
    approvalId: "appr_browsergolden1",
    payload: { decision: "approved" },
  }),
  event(7, "item.completed", {
    itemId: "itm_browsertool1",
    payload: { result: { content: "wrote src/feature.ts" } },
  }),
  event(8, "item.started", {
    itemId: "itm_browserfinal1",
    payload: { kind: "assistant_message", text: "" },
  }),
  event(9, "assistant_message.delta", {
    itemId: "itm_browserfinal1",
    payload: { delta: "Done with deterministic edit." },
  }),
  event(10, "workspace.snapshot_captured", {
    payload: { snapshot: TERMINAL_SNAPSHOT },
  }),
  event(11, "turn.diff_updated", {
    payload: { diff: TURN_DIFF },
  }),
  event(12, "artifact.created", {
    payload: {
      artifact: {
        artifactId: "art_browserdiff1",
        kind: "diff",
        changedFiles: TURN_DIFF.files,
      },
    },
  }),
  event(13, "item.completed", {
    itemId: "itm_browserfinal1",
    payload: { result: { content: "Done with deterministic edit." } },
  }),
  event(14, "turn.completed", {
    payload: {
      outcome: { status: "completed" },
    },
  }),
];

test("SDK replay/live lifecycle projection survives browser refresh", async ({
  page,
}) => {
  let releaseLiveStream: (() => void) | null = null;
  let replayMode: "initial" | "refresh" = "initial";
  const releaseGate = new Promise<void>((resolve) => {
    releaseLiveStream = resolve;
  });

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

    const events =
      replayMode === "initial"
        ? LIFECYCLE_EVENTS.slice(0, 5)
        : LIFECYCLE_EVENTS;
    await fulfillReplay(route, events);
  });

  await page.goto("/agents/runtime-lifecycle-golden.html");
  await expect(page.getByTestId("user-prompt")).toHaveCount(1);
  await expect(page.getByTestId("approval")).toContainText(
    "Approve deterministic edit",
  );

  releaseLiveStream?.();
  await expect(page.getByTestId("terminal")).toHaveText(
    "completed:Turn completed.",
  );
  await assertDiffParity(page);
  const firstTerminal = await page.getByTestId("terminal").textContent();
  const firstWorkflow = await page.getByTestId("workflow").textContent();

  replayMode = "refresh";
  await page.reload();

  await expect(page.getByTestId("terminal")).toHaveText(firstTerminal ?? "");
  await expect(page.getByTestId("workflow")).toHaveText(firstWorkflow ?? "");
  await expect(page.getByTestId("user-prompt")).toHaveCount(1);
  await assertDiffParity(page);
});

async function fulfillReplay(
  route: Route,
  events: readonly unknown[],
): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      events,
      nextSequence: events.length
        ? (events.at(-1) as { readonly sequence: number }).sequence
        : null,
    }),
  });
}

async function assertDiffParity(page: Page): Promise<void> {
  await expect(page.getByTestId("artifact-diff")).toHaveText("src/feature.ts");
  await expect(page.getByTestId("review-diff")).toHaveText("src/feature.ts");
  await expect(page.getByTestId("sidebar-diff")).toHaveText("src/feature.ts");
}

function ndjson(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n");
}

function event(
  sequence: number,
  type: string,
  overrides: {
    readonly itemId?: string;
    readonly approvalId?: string;
    readonly payload?: Record<string, unknown>;
  },
) {
  return {
    eventId: `evt_browsergolden${String(sequence).padStart(3, "0")}`,
    threadId: "thr_browsergolden1",
    turnId: TURN_ID,
    runAttemptId: "attempt_browsergolden1",
    itemId: overrides.itemId,
    approvalId: overrides.approvalId,
    sequence,
    idempotencyKey: `${TURN_ID}:${sequence}:${type}`,
    producer: { kind: "runtime_kernel", id: "runtime-kernel-browser-gate" },
    schemaVersion: 1,
    createdAt: NOW,
    type,
    payload: overrides.payload ?? {},
  };
}
