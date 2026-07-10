import { expect, type Locator, type Page } from "@playwright/test";

export type ProductThread = {
  readonly id: string;
  readonly title: string;
};

export type ProductTurn = {
  readonly id: string;
  readonly prompt: string;
};

const THREAD_ROW = '[data-testid^="thread-"][data-thread-id]';

/**
 * Selectors in this file are the product-gate contract for Plan 039.
 * Every selector is keyed by a server-issued identity; visible copy and list
 * position are intentionally not used as lifecycle identity.
 */
export function threadRow(page: Page, threadId: string): Locator {
  return page.locator(`[data-testid="thread-${threadId}"]`);
}

export function turnSurface(
  page: Page,
  threadId: string,
  turnId: string,
): Locator {
  return page.locator(`[data-testid="thread-${threadId}-turn-${turnId}"]`);
}

export function turnPart(
  page: Page,
  threadId: string,
  turnId: string,
  partId: string,
): Locator {
  return page.locator(
    `[data-testid="thread-${threadId}-turn-${turnId}-part-${partId}"]`,
  );
}

export async function createThread(page: Page): Promise<ProductThread> {
  await page.getByTitle("New Task").first().click();
  const row = page.locator(THREAD_ROW).last();
  await expect(row).toBeVisible();

  const id = await row.getAttribute("data-thread-id");
  if (!id) {
    throw new Error("Product gate could not read the server-issued thread id");
  }

  return { id, title: (await row.innerText()).trim() };
}

export async function selectThread(
  page: Page,
  thread: ProductThread,
): Promise<void> {
  await threadRow(page, thread.id).click();
  await expect(
    page.locator(`[data-thread-surface="${thread.id}"]`),
  ).toBeVisible();
}

export async function submitPrompt(
  page: Page,
  prompt: string,
): Promise<ProductTurn> {
  const composer = page
    .getByRole("textbox", { name: /prompt|message/i })
    .last();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const promptNode = page
    .locator('[data-testid^="turn-"][data-turn-id][data-kind="user_prompt"]')
    .last();
  await expect(promptNode).toContainText(prompt);
  const id = await promptNode.getAttribute("data-turn-id");
  if (!id) {
    throw new Error("Product gate could not read the server-issued turn id");
  }

  return { id, prompt };
}

export async function assertTurnScopedLifecycle(
  page: Page,
  thread: ProductThread,
  turn: ProductTurn,
): Promise<void> {
  const surface = turnSurface(page, thread.id, turn.id);
  await expect(surface).toBeVisible();
  await expect(surface.locator(`[data-turn-id="${turn.id}"]`)).toContainText(
    turn.prompt,
  );

  for (const kind of [
    "typed_part",
    "workflow",
    "approval",
    "spinner",
    "terminal",
    "final",
  ]) {
    await expect(
      surface.locator(
        `[data-testid="thread-${thread.id}-turn-${turn.id}-${kind}"]`,
      ),
    ).toBeVisible();
  }
}

export async function stopTurnOnce(
  page: Page,
  thread: ProductThread,
  turn: ProductTurn,
): Promise<void> {
  const surface = turnSurface(page, thread.id, turn.id);
  const stop = surface.getByRole("button", { name: "Stop generation" });
  await stop.click();
  await expect(
    surface.locator(
      `[data-testid="thread-${thread.id}-turn-${turn.id}-terminal"]`,
    ),
  ).toHaveAttribute("data-status", /cancelled|interrupted|stopped/);
  await expect(stop).toHaveCount(0);
}
