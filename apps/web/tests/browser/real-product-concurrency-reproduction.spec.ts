import { expect, test } from "@playwright/test";
import {
  assertTurnScopedLifecycle,
  createThread,
  selectThread,
  stopTurnOnce,
  submitPrompt,
  threadRow,
  turnSurface,
} from "./concurrent-product-reproduction";

const enabled = process.env.SHADOWBOX_REAL_CONCURRENCY_GATE === "1";

test.describe("Plan 039.1 real-product concurrent-thread reproduction", () => {
  test.skip(
    !enabled,
    "Set SHADOWBOX_REAL_CONCURRENCY_GATE=1 against an authenticated deployed /agents/ route with deterministic runtime and secure-runtime fixtures.",
  );

  test("keeps concurrent thread/turn lifecycle identity through stop and reload", async ({
    page,
  }) => {
    await page.goto("/agents/");

    const threadA = await createThread(page);
    await selectThread(page, threadA);
    const turnA1 = await submitPrompt(page, "Thread A first prompt");

    const threadB = await createThread(page);
    await selectThread(page, threadB);
    const turnB1 = await submitPrompt(
      page,
      "Thread B inspect the workspace and request the deterministic tool action",
    );

    await selectThread(page, threadA);
    const turnA2 = await submitPrompt(page, "Thread A concurrent follow-up");

    await selectThread(page, threadB);
    await selectThread(page, threadA);
    await selectThread(page, threadB);

    await assertTurnScopedLifecycle(page, threadA, turnA1);
    await assertTurnScopedLifecycle(page, threadA, turnA2);
    await assertTurnScopedLifecycle(page, threadB, turnB1);
    await expect(threadRow(page, threadA.id)).toHaveAttribute(
      "data-thread-id",
      threadA.id,
    );
    await expect(threadRow(page, threadB.id)).toHaveAttribute(
      "data-thread-id",
      threadB.id,
    );

    await stopTurnOnce(page, threadB, turnB1);
    const turnB2 = await submitPrompt(page, "Thread B follow-up after stop");
    await assertTurnScopedLifecycle(page, threadB, turnB2);

    const terminalA = await turnSurface(page, threadA.id, turnA2.id)
      .locator(
        `[data-testid="thread-${threadA.id}-turn-${turnA2.id}-terminal"]`,
      )
      .textContent();
    const titleA = await threadRow(page, threadA.id).textContent();

    await page.reload();
    await selectThread(page, threadA);
    await expect(
      turnSurface(page, threadA.id, turnA2.id).locator(
        `[data-testid="thread-${threadA.id}-turn-${turnA2.id}-terminal"]`,
      ),
    ).toHaveText(terminalA ?? "");
    await expect(threadRow(page, threadA.id)).toContainText(titleA ?? "");
    await expect(
      page.locator(`[data-thread-id="${threadB.id}"][data-unread="true"]`),
    ).toHaveCount(0);

    await selectThread(page, threadB);
    await expect(
      turnSurface(page, threadB.id, turnB2.id).locator(
        `[data-testid="thread-${threadB.id}-turn-${turnB2.id}-final"]`,
      ),
    ).toBeVisible();
  });

  test("maps secure-runtime unavailability to a typed sandbox error", async ({
    page,
  }) => {
    await page.goto("/agents/");
    const thread = await createThread(page);
    await selectThread(page, thread);
    const turn = await submitPrompt(
      page,
      "Exercise the secure runtime unavailable fixture",
    );

    const surface = turnSurface(page, thread.id, turn.id);
    await expect(
      surface.locator(
        `[data-testid="thread-${thread.id}-turn-${turn.id}-error"]`,
      ),
    ).toHaveAttribute("data-error-code", "SECURE_RUNTIME_UNAVAILABLE");
    await expect(surface).not.toContainText("PROVIDER_UNAVAILABLE");
  });
});
