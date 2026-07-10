import { expect, test, type Page } from "@playwright/test";

/**
 * Plan 039.1 product gate.
 *
 * This is intentionally environment-gated: the route must be authenticated
 * and backed by the deterministic runtime fixture (or a deployed real cloud
 * route). A skipped run is reported by Playwright and is not evidence that
 * the product path is healthy.
 *
 * Local deterministic command:
 *   SHADOWBOX_CONCURRENT_PRODUCT_GATE=1 \
 *   SHADOWBOX_DETERMINISTIC_RUNTIME_FIXTURE=1 pnpm --dir apps/web test:browser \
 *   concurrent-product-reproduction.spec.ts
 *
 * Real cloud command:
 *   SHADOWBOX_CONCURRENT_PRODUCT_GATE=1 \
 *   SHADOWBOX_REAL_CLOUD_CONCURRENT_GATE=1 \
 *   VITE_BRAIN_BASE_URL=https://<authenticated-deployment> pnpm --dir apps/web \
 *   test:browser concurrent-product-reproduction.spec.ts
 */

const enabled = process.env.SHADOWBOX_CONCURRENT_PRODUCT_GATE === "1";
const fixtureEnabled =
  process.env.SHADOWBOX_DETERMINISTIC_RUNTIME_FIXTURE === "1";
const realCloudEnabled =
  process.env.SHADOWBOX_REAL_CLOUD_CONCURRENT_GATE === "1";
const workspaceName = process.env.SHADOWBOX_CONCURRENT_WORKSPACE ?? "Shadowbox";

test.describe("real product concurrent thread reproduction gate", () => {
  test.skip(
    !enabled,
    "Set SHADOWBOX_CONCURRENT_PRODUCT_GATE=1 with an authenticated route and deterministic runtime fixture or deployed real-cloud route.",
  );
  test.skip(
    enabled && !fixtureEnabled && !realCloudEnabled,
    "Choose SHADOWBOX_DETERMINISTIC_RUNTIME_FIXTURE=1 or SHADOWBOX_REAL_CLOUD_CONCURRENT_GATE=1; an unqualified run is not proof.",
  );

  test("keeps concurrent prompts, workflow rows, approval, stop, and replay scoped", async ({
    page,
  }, testInfo) => {
    const correlations: Correlation[] = [];
    const createdSessionIds: string[] = [];
    observeProductCorrelations(page, correlations, createdSessionIds);

    await page.goto("/agents/");
    await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();

    const workspace = newTaskButton(page);
    await expect(workspace).toBeVisible();

    // Thread A: a short non-tool prompt.
    await workspace.click();
    const threadA = await selectNewestTask(page, createdSessionIds);
    const promptA = "Return the word A.";
    await sendPrompt(page, promptA);
    await expect(page.getByText(promptA, { exact: true })).toBeVisible();
    const turnA = await waitForCorrelation(correlations, threadA.sessionId);
    await settleCurrentTurn(page);

    // Thread B: a tool-capable prompt. Keep it active at the approval gate.
    await newTaskButton(page).click();
    const threadB = await selectNewestTask(page, createdSessionIds);
    const promptB = "Inspect the workspace and report the current branch.";
    await sendPrompt(page, promptB);
    await expect(page.getByText(promptB, { exact: true })).toBeVisible();
    const turnB = await waitForCorrelation(correlations, threadB.sessionId);
    await expect(page.getByTestId("lifecycle-workflow")).toBeVisible();

    // Switch away and back while B is still alive. The visible B controls
    // must not follow the selected sidebar row into A.
    await selectTask(page, threadA);
    const promptA2 = "Return the word A2.";
    await sendPrompt(page, promptA2);
    const turnA2 = await waitForCorrelation(
      correlations,
      threadA.sessionId,
      turnA.turnId,
    );
    await selectTask(page, threadB);
    await assertLifecycleIdentity(page, turnB);
    await selectTask(page, threadA);
    await assertLifecycleIdentity(page, turnA2);
    await selectTask(page, threadB);
    await assertLifecycleIdentity(page, turnB);

    // Stop B, verify one terminal settlement, then submit a follow-up on B.
    await stopCurrentTurn(page);
    await expect(page.getByTestId("lifecycle-terminal-settled")).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(() => countTerminalEvents(page, turnB), {
        timeout: 120_000,
      })
      .toBe(1);

    const followUp = "Confirm the stopped run is settled, then say B2.";
    await sendPrompt(page, followUp);
    const turnB2 = await waitForCorrelation(
      correlations,
      threadB.sessionId,
      turnB.turnId,
    );
    await settleCurrentTurn(page);
    await assertLifecycleIdentity(page, turnB2);

    const titleBeforeReload = await selectedTaskTitle(page, threadB);
    await page.reload();
    await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();
    await selectTask(page, threadB);
    await expect(page.getByText(followUp, { exact: true })).toBeVisible();
    await expect(page.getByTestId("lifecycle-terminal-settled")).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(() => selectedTaskTitle(page, threadB), { timeout: 30_000 })
      .toBe(titleBeforeReload);

    // Attach only server-issued correlation values; prompts and credentials
    // are deliberately excluded from failure evidence.
    await testInfo.attach("concurrency-correlations.json", {
      body: JSON.stringify(correlations, null, 2),
      contentType: "application/json",
    });
  });

  test("reports typed secure-runtime unavailability", async ({ page }) => {
    test.skip(
      process.env.SHADOWBOX_SECURE_RUNTIME_UNAVAILABLE_FIXTURE !== "1",
      "Set SHADOWBOX_SECURE_RUNTIME_UNAVAILABLE_FIXTURE=1 on the controlled unavailable-runtime fixture.",
    );

    await page.goto("/agents/");
    await newTaskButton(page).click();
    const task = page.getByRole("option", { selected: true });
    await expect(task).toBeVisible();
    await task.click();
    await sendPrompt(page, "Run the secure-runtime unavailable fixture.");
    await expect(page.getByText(/sandbox/i)).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText("PROVIDER_UNAVAILABLE", { exact: true }),
    ).toHaveCount(0);
  });
});

interface Correlation {
  readonly sessionId: string;
  readonly turnId: string;
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox").last();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function settleCurrentTurn(page: Page): Promise<void> {
  await expect(page.getByTestId("lifecycle-terminal-settled")).toBeVisible({
    timeout: 120_000,
  });
}

async function stopCurrentTurn(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Stop generation" }),
  ).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Stop generation" }).click();
}

interface ThreadHandle {
  readonly sessionId: string;
  readonly title: string;
}

async function selectNewestTask(
  page: Page,
  createdSessionIds: string[],
): Promise<ThreadHandle> {
  const task = page.getByRole("option", { selected: true });
  await expect(task).toBeVisible();
  const title = (await task.textContent())?.trim();
  if (!title) throw new Error("Created task has no visible title");
  await task.click();
  await expect
    .poll(() => createdSessionIds.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const sessionId = createdSessionIds.at(-1);
  if (!sessionId) throw new Error("Created task has no server session ID");
  return { sessionId, title };
}

async function selectTask(page: Page, thread: ThreadHandle): Promise<void> {
  const task = page
    .getByRole("option")
    .filter({ hasText: thread.title })
    .first();
  await expect(task).toBeVisible();
  await task.click();
}

function newTaskButton(page: Page) {
  return page.getByRole("button", { name: `New task in ${workspaceName}` });
}

async function selectedTaskTitle(
  page: Page,
  thread: ThreadHandle,
): Promise<string> {
  const task = page
    .getByRole("option")
    .filter({ hasText: thread.title })
    .first();
  await expect(task).toBeVisible();
  return (await task.textContent())?.trim() ?? "";
}

function observeProductCorrelations(
  page: Page,
  correlations: Correlation[],
  createdSessionIds: string[],
): void {
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/sessions") &&
      request.method() === "POST"
    ) {
      try {
        const body = request.postDataJSON() as { sessionId?: unknown };
        if (typeof body.sessionId === "string") {
          createdSessionIds.push(body.sessionId);
        }
      } catch {
        // The response assertion below remains the source of truth.
      }
    }
  });
  page.on("response", async (response) => {
    if (
      !response.url().endsWith("/chat") ||
      response.request().method() !== "POST"
    ) {
      return;
    }
    const sessionId = await requestSessionId(response);
    const turnId = response.headers()["x-turn-id"]?.trim();
    if (
      !sessionId ||
      !turnId ||
      correlations.some((item) => item.turnId === turnId)
    ) {
      return;
    }
    correlations.push({ sessionId, turnId });
  });
}

async function requestSessionId(
  response: import("@playwright/test").Response,
): Promise<string | null> {
  try {
    const body = response.request().postDataJSON() as { sessionId?: unknown };
    return typeof body.sessionId === "string" ? body.sessionId : null;
  } catch {
    return null;
  }
}

async function waitForCorrelation(
  correlations: Correlation[],
  sessionId: string,
  previousTurnId?: string,
): Promise<Correlation> {
  await expect
    .poll(
      () =>
        correlations
          .filter(
            (item) =>
              item.sessionId === sessionId && item.turnId !== previousTurnId,
          )
          .at(-1)?.turnId,
      { timeout: 120_000 },
    )
    .toBeTruthy();
  const correlation = correlations
    .filter(
      (item) => item.sessionId === sessionId && item.turnId !== previousTurnId,
    )
    .at(-1);
  if (!correlation)
    throw new Error(`No server turn correlation for ${sessionId}`);
  return correlation;
}

async function assertLifecycleIdentity(
  page: Page,
  correlation: Correlation,
): Promise<void> {
  const brainBaseUrl =
    process.env.VITE_BRAIN_BASE_URL ?? "http://127.0.0.1:8788";
  const response = await page.request.get(
    `${brainBaseUrl}/api/run/events?runId=${encodeURIComponent(correlation.turnId)}`,
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    events?: Array<{ turnId?: string; itemId?: string }>;
  };
  const events = payload.events ?? [];
  expect(events.length).toBeGreaterThan(0);
  expect(new Set(events.map((event) => event.turnId))).toEqual(
    new Set([correlation.turnId]),
  );
  for (const itemId of new Set(
    events.map((event) => event.itemId).filter(Boolean),
  )) {
    await expect(page.getByTestId(`lifecycle-item-${itemId}`)).toBeVisible();
  }
}

async function countTerminalEvents(
  page: Page,
  turn: Correlation,
): Promise<number> {
  const brainBaseUrl =
    process.env.VITE_BRAIN_BASE_URL ?? "http://127.0.0.1:8788";
  const response = await page.request.get(
    `${brainBaseUrl}/api/run/events?runId=${encodeURIComponent(turn.turnId)}`,
  );
  if (!response.ok()) return 0;
  const payload = (await response.json()) as {
    events?: Array<{ type?: string; turnId?: string }>;
  };
  return (payload.events ?? []).filter(
    (event) =>
      event.turnId === turn.turnId &&
      (event.type === "turn.completed" ||
        event.type === "turn.cancelled" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"),
  ).length;
}
