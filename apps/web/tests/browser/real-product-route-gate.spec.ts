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
    await composer.fill("Create the deterministic product-gate change.");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByTestId("lifecycle-workflow")).toBeVisible();
    await expect(page.getByTestId("lifecycle-terminal-settled")).toBeVisible({
      timeout: 120_000,
    });
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
