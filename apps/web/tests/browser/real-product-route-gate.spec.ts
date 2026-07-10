import { expect, test } from "@playwright/test";

const enabled = process.env.SHADOWBOX_REAL_PRODUCT_GATE === "1";

test.describe("real product route lifecycle gate", () => {
  test.skip(
    !enabled,
    "Set SHADOWBOX_REAL_PRODUCT_GATE=1 with an authenticated real route and deterministic runtime backend.",
  );

  test("submits through /agents/, settles, and replays the canonical turn", async ({
    page,
  }) => {
    await page.goto("/agents/");
    const composer = page.getByRole("textbox").last();
    const prompt = "Create the deterministic product-gate change.";
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText(prompt)).toBeVisible();
    await expect(page.getByTestId("lifecycle-workflow")).toBeVisible();
    await expect(page.getByTestId("lifecycle-approval")).toBeVisible();
    await page.getByRole("button", { name: /Allow once|Approve/i }).click();
    await expect(
      page.locator(
        '[data-testid^="lifecycle-item-"][data-kind="tool_call"], [data-testid^="lifecycle-item-"][data-kind="command_execution"], [data-testid^="lifecycle-item-"][data-kind="file_change"]',
      ),
    ).toBeVisible();
    await expect(page.getByTestId("lifecycle-terminal-settled")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("completed-turn-review")).toBeVisible();
    await page
      .getByTestId("completed-turn-review")
      .getByRole("button", { name: "Review" })
      .click();
    await expect(
      page.getByTestId("canonical-turn-review-sidebar"),
    ).toBeVisible();
    const terminalState = await page
      .getByTestId("lifecycle-terminal-settled")
      .textContent();

    await page.reload();
    await expect(page.getByTestId("lifecycle-terminal-settled")).toHaveText(
      terminalState ?? "completed",
    );
    await expect(page.getByTestId("lifecycle-workflow")).toBeVisible();
  });
});
