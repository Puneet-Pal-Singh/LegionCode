import { expect, test, type Page, type Response } from "@playwright/test";

/**
 * Real product concurrent-thread reproduction gate.
 *
 * This test is deliberately environment-gated. A skip is reported by
 * Playwright and is never evidence that the authenticated product path works.
 * It has no mock fallback: its selectors and correlations are the public
 * browser contract supplied by the deployed product.
 *
 * Deterministic fixture command:
 *   SHADOWBOX_CONCURRENT_PRODUCT_GATE=1 \
 *   SHADOWBOX_DETERMINISTIC_RUNTIME_FIXTURE=1 pnpm --dir apps/web test:browser \
 *   concurrent-product-reproduction.spec.ts
 *
 * Real-cloud command:
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
const terminalEventTypes = new Set([
  "turn.completed",
  "turn.interrupted",
  "turn.failed",
]);

test.describe("real product concurrent thread reproduction gate", () => {
  test.skip(
    !enabled,
    "Set SHADOWBOX_CONCURRENT_PRODUCT_GATE=1 with an authenticated route and deterministic fixture or deployed real-cloud route.",
  );
  test.skip(
    enabled && !fixtureEnabled && !realCloudEnabled,
    "Choose SHADOWBOX_DETERMINISTIC_RUNTIME_FIXTURE=1 or SHADOWBOX_REAL_CLOUD_CONCURRENT_GATE=1; an unqualified run is not proof.",
  );

  test("keeps concurrent prompts, workflow, approval, stop, and replay scoped", async ({
    page,
  }, testInfo) => {
    const correlations: TurnScope[] = [];
    observeServerCorrelations(page, correlations);

    await page.goto("/agents/");
    await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();

    // A short turn creates A. Its canonical identity is read only from the
    // server response, never from a client-generated session value or title.
    await createAndSelectDraftThread(page);
    const promptA = "Return the word A.";
    const turnA = await sendAndCapture(page, correlations, promptA);
    await waitForTerminal(page, turnA);
    await assertScopedSurface(page, turnA, promptA, {
      terminal: true,
      final: true,
    });

    // B enters the tool/approval path and remains live while A receives A2.
    await createAndSelectDraftThread(page);
    const promptB =
      "Inspect the workspace and request the deterministic tool action.";
    const turnB = await sendAndCapture(page, correlations, promptB);
    await assertScopedSurface(page, turnB, promptB, {
      tool: true,
      workflow: true,
      approval: true,
      spinner: true,
    });

    await selectThread(page, turnA.threadId);
    const promptA2 = "Return the word A2.";
    const turnA2 = await sendAndCapture(page, correlations, promptA2);
    expect(turnA2.threadId).toBe(turnA.threadId);

    // Selection changes while both turns are alive must never move B's
    // lifecycle projection onto A, or vice versa.
    await selectThread(page, turnB.threadId);
    await assertScopedSurface(page, turnB, promptB, {
      tool: true,
      workflow: true,
      approval: true,
      spinner: true,
    });
    await selectThread(page, turnA.threadId);
    await assertScopedSurface(page, turnA2, promptA2, { spinner: true });
    await selectThread(page, turnB.threadId);
    await assertScopedSurface(page, turnB, promptB, {
      tool: true,
      workflow: true,
      approval: true,
      spinner: true,
    });

    await stopTurn(page, turnB);
    await waitForInterruptedTerminal(page, turnB);
    await assertScopedSurface(page, turnB, promptB, {
      terminal: true,
      final: true,
    });

    // The follow-up is admitted only after B's single terminal projection.
    const followUp = "Confirm the stopped run is settled, then say B2.";
    const turnB2 = await sendAndCapture(page, correlations, followUp);
    expect(turnB2.threadId).toBe(turnB.threadId);
    await assertScopedSurface(page, turnB2, followUp, { spinner: true });

    // Background completion creates B's unread marker. Reload must preserve
    // B's title and marker, and selecting B acknowledges B alone.
    const titleBeforeReload = await threadRow(page, turnB.threadId).innerText();
    await selectThread(page, turnA.threadId);
    await waitForTerminal(page, turnB2);
    await expect(threadRow(page, turnB.threadId)).toHaveAttribute(
      "data-unread",
      "true",
    );
    await expect(threadRow(page, turnA.threadId)).not.toHaveAttribute(
      "data-unread",
      "true",
    );

    await page.reload();
    await expect(page.getByRole("listbox", { name: "Tasks" })).toBeVisible();
    await expect(threadRow(page, turnB.threadId)).toContainText(
      titleBeforeReload,
    );
    await expect(threadRow(page, turnB.threadId)).toHaveAttribute(
      "data-unread",
      "true",
    );
    await selectThread(page, turnB.threadId);
    await assertScopedSurface(page, turnB2, followUp, {
      terminal: true,
      final: true,
    });
    await expect(threadRow(page, turnB.threadId)).not.toHaveAttribute(
      "data-unread",
      "true",
    );
    await expect(threadRow(page, turnA.threadId)).not.toHaveAttribute(
      "data-unread",
      "true",
    );

    // Server-issued correlations only: prompts, tokens, and credentials are
    // intentionally excluded from failure artifacts.
    await testInfo.attach("concurrency-correlations.json", {
      body: JSON.stringify(correlations, null, 2),
      contentType: "application/json",
    });
  });
});

interface TurnScope {
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
}

async function createAndSelectDraftThread(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: `New task in ${workspaceName}` })
    .click();
  await expect(page.getByRole("option", { selected: true })).toBeVisible();
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox").last();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function sendAndCapture(
  page: Page,
  correlations: TurnScope[],
  prompt: string,
): Promise<TurnScope> {
  const observedCount = correlations.length;
  await sendPrompt(page, prompt);
  return await waitForNewTurn(correlations, observedCount);
}

async function selectThread(page: Page, threadId: string): Promise<void> {
  await threadRow(page, threadId).click();
  await expect(threadRow(page, threadId)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

function threadRow(page: Page, threadId: string) {
  return page.getByTestId(`thread-${threadId}`);
}

function turnSurface(page: Page, turn: TurnScope) {
  return page.getByTestId(`thread-${turn.threadId}-turn-${turn.turnId}`);
}

async function assertScopedSurface(
  page: Page,
  turn: TurnScope,
  prompt: string,
  expected: {
    readonly tool?: boolean;
    readonly workflow?: boolean;
    readonly approval?: boolean;
    readonly spinner?: boolean;
    readonly terminal?: boolean;
    readonly final?: boolean;
  } = {},
): Promise<void> {
  const surface = turnSurface(page, turn);
  await expect(surface).toBeVisible({ timeout: 120_000 });
  await expect(surface).toHaveAttribute("data-thread-id", turn.threadId);
  await expect(surface).toHaveAttribute("data-turn-id", turn.turnId);
  await expect(surface).toHaveAttribute(
    "data-run-attempt-id",
    turn.runAttemptId,
  );
  await expect(surface.getByText(prompt, { exact: true })).toBeVisible();

  await expect(
    surface.getByTestId(`${turnSurfaceId(turn)}-typed-part`),
  ).toBeVisible({
    timeout: 120_000,
  });
  if (expected.tool) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-tool`),
    ).toBeVisible();
  }
  if (expected.workflow) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-workflow`),
    ).toBeVisible();
  }
  if (expected.approval) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-approval`),
    ).toBeVisible();
  }
  if (expected.spinner) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-spinner`),
    ).toBeVisible();
  }
  if (expected.terminal) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-terminal`),
    ).toBeVisible();
  }
  if (expected.final) {
    await expect(
      surface.getByTestId(`${turnSurfaceId(turn)}-final`),
    ).toBeVisible();
  }
}

async function stopTurn(page: Page, turn: TurnScope): Promise<void> {
  const surface = turnSurface(page, turn);
  const stop = surface.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  await stop.click();
  await expect(stop).toHaveCount(0);
}

async function waitForTerminal(page: Page, turn: TurnScope): Promise<void> {
  await expect
    .poll(() => countTerminalEvents(page, turn), { timeout: 120_000 })
    .toBe(1);
}

async function waitForInterruptedTerminal(
  page: Page,
  turn: TurnScope,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const events = await terminalEvents(page, turn);
        return events.map((event) => event.type);
      },
      { timeout: 120_000 },
    )
    .toEqual(["turn.interrupted"]);
}

function observeServerCorrelations(
  page: Page,
  correlations: TurnScope[],
): void {
  page.on("response", async (response) => {
    if (!isChatResponse(response)) return;
    const turn = responseScope(response);
    if (!turn || correlations.some((item) => item.turnId === turn.turnId))
      return;
    correlations.push(turn);
  });
}

function isChatResponse(response: Response): boolean {
  return (
    response.url().endsWith("/chat") && response.request().method() === "POST"
  );
}

function responseScope(response: Response): TurnScope | null {
  const headers = response.headers();
  const threadId = headers["x-thread-id"]?.trim();
  const turnId = headers["x-turn-id"]?.trim();
  const runAttemptId = headers["x-run-attempt-id"]?.trim();
  return threadId && turnId && runAttemptId
    ? { threadId, turnId, runAttemptId }
    : null;
}

async function waitForNewTurn(
  correlations: TurnScope[],
  observedCount: number,
): Promise<TurnScope> {
  await expect
    .poll(() => correlations.length, { timeout: 120_000 })
    .toBeGreaterThan(observedCount);
  const turn = correlations.at(-1);
  if (!turn)
    throw new Error(
      "Chat response omitted canonical thread/turn/run-attempt headers",
    );
  return turn;
}

async function countTerminalEvents(
  page: Page,
  turn: TurnScope,
): Promise<number> {
  return (await terminalEvents(page, turn)).length;
}

async function terminalEvents(
  page: Page,
  turn: TurnScope,
): Promise<Array<Partial<TurnScope> & { type?: string }>> {
  const brainBaseUrl =
    process.env.VITE_BRAIN_BASE_URL ?? "http://127.0.0.1:8788";
  const response = await page.request.get(
    `${brainBaseUrl}/turns/${encodeURIComponent(turn.turnId)}/lifecycle-events`,
  );
  if (!response.ok()) return [];
  const payload = (await response.json()) as {
    events?: Array<Partial<TurnScope> & { type?: string }>;
  };
  const events = payload.events ?? [];
  for (const event of events) {
    expect(event.threadId).toBe(turn.threadId);
    expect(event.turnId).toBe(turn.turnId);
  }
  return events.filter(
    (event) =>
      event.runAttemptId === turn.runAttemptId &&
      terminalEventTypes.has(event.type ?? ""),
  );
}

function turnSurfaceId(turn: TurnScope): string {
  return `thread-${turn.threadId}-turn-${turn.turnId}`;
}
