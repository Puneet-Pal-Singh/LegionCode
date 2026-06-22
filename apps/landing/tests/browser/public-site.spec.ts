import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("homepage exposes the product and primary routes", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/LegionCode/);
  await expect(page.locator('meta[name="darkreader-lock"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "The open-source multi-agent coding workspace.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Cloud Agents" }).first(),
  ).toHaveAttribute("href", "/agents/");
  await expect(
    page.getByRole("link", { name: "Star on GitHub" }).first(),
  ).toHaveAttribute(
    "href",
    "https://github.com/Puneet-Pal-Singh/LegionCode",
  );
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("cloud page records a private-alpha access request", async ({
  page,
}) => {
  await page.route("**/api/waitlist", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Your private-alpha request has been recorded.",
      }),
    });
  });
  await page.goto("/cloud/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Run a team of coding agents in the cloud/,
    }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Work email" }).fill("dev@example.com");
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your private-alpha request has been recorded.",
  );
  await expect(
    page.getByRole("link", {
      name: "Already approved? Sign in to Cloud Agents",
    }),
  ).toHaveAttribute("href", "/agents/");
});

test("mobile navigation remains usable and contained", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile" });
  await expect(mobileNavigation.getByRole("link", { name: "Docs" })).toHaveAttribute(
    "href",
    "/docs/",
  );
  await expect(mobileNavigation.getByRole("link", { name: "Open Agents" })).toHaveAttribute(
    "href",
    "/agents/",
  );
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeFocused();
  await expectNoHorizontalOverflow(page);
});
