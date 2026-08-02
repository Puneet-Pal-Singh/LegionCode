import { expect, test, type Page } from "@playwright/test";

const CHAT_A_PROMPT =
  "Read README.md. Add a short \"Demo\" section that says LegionCode can inspect and edit a repository through an isolated agent workspace. Change no other file.";
const CHAT_B_PROMPT =
  "Read README.md. Add one sentence explaining that separate tasks use isolated workspaces. Change no other file.";
const STOP_PROMPT =
  "Read README.md and explain what you would change, but wait before making any edit.";

test.describe("real product Plan 049 route gate", () => {
  test("runs two isolated chats, refreshes replay, and settles Stop", async ({
    browser,
  }) => {
    const storageState = process.env.SHADOWBOX_PLAYWRIGHT_STORAGE_STATE;
    if (!storageState) {
      test.skip(
        true,
        "requires SHADOWBOX_PLAYWRIGHT_STORAGE_STATE with an authenticated deterministic repository fixture",
      );
      return;
    }
    const contextA = await browser.newContext(
      { storageState },
    );
    const contextB = await browser.newContext(
      { storageState },
    );
    const chatA = await contextA.newPage();
    const chatB = await contextB.newPage();
    const failures: string[] = [];
    for (const page of [chatA, chatB]) {
      page.on("response", (response) => {
        if ([404, 428, 500].includes(response.status())) {
          failures.push(`${response.status()} ${response.url()}`);
        }
      });
    }

    try {
      await openComposer(chatA);
      await openComposer(chatB);
      await createIndependentChat(chatB);

      await submit(chatA, CHAT_A_PROMPT);
      await submit(chatB, CHAT_B_PROMPT);
      await expect(chatA.getByTestId("canonical-workflow")).toBeVisible();
      await expect(chatB.getByTestId("canonical-workflow")).toBeVisible();

      const scopeA = await readCanonicalScope(chatA);
      const scopeB = await readCanonicalScope(chatB);
      expect(scopeA.workspaceId).not.toBe(scopeB.workspaceId);
      expect(scopeA.threadId).not.toBe(scopeB.threadId);
      expect(scopeA.turnId).not.toBe(scopeB.turnId);
      expect(scopeA.runAttemptId).not.toBe(scopeB.runAttemptId);

      await refreshDuringWork(chatA);
      await settleCompletedTurn(chatA);
      await settleCompletedTurn(chatB);
      await assertCompletedReview(chatA);
      await assertCompletedReview(chatB);
      await assertNoCrossChatContent(chatA, CHAT_B_PROMPT);
      await assertNoCrossChatContent(chatB, CHAT_A_PROMPT);

      await startAndStop(chatA);
      await expect(
        chatA.getByTestId("canonical-workflow"),
      ).toHaveAttribute("data-terminal-state", "interrupted");
      await expect(chatA.getByTestId(/-spinner$/)).toHaveCount(0);
      await chatA.reload();
      await expect(
        chatA.getByTestId("canonical-workflow"),
      ).toHaveAttribute("data-terminal-state", "interrupted");

      expect(failures, failures.join("\n")).toEqual([]);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

async function openComposer(page: Page): Promise<void> {
  await page.goto("/agents/");
  await expect(page.getByRole("textbox").last()).toBeVisible({
    timeout: 30_000,
  });
}

async function createIndependentChat(page: Page): Promise<void> {
  const newTask = page.getByRole("button", { name: /New task in /i }).first();
  await expect(newTask).toBeVisible();
  await newTask.click();
  await expect(page.getByRole("textbox").last()).toBeVisible();
}

async function submit(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox").last();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
}

async function readCanonicalScope(page: Page): Promise<{
  threadId: string;
  workspaceId: string;
  turnId: string;
  runAttemptId: string;
}> {
  const surface = page.locator("section[data-turn-id]").last();
  await expect(surface).toBeVisible();
  return {
    threadId: (await surface.getAttribute("data-thread-id")) ?? "",
    workspaceId: (await surface.getAttribute("data-workspace-id")) ?? "",
    turnId: (await surface.getAttribute("data-turn-id")) ?? "",
    runAttemptId: (await surface.getAttribute("data-run-attempt-id")) ?? "",
  };
}

async function refreshDuringWork(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("canonical-workflow")).toBeVisible();
}

async function settleCompletedTurn(page: Page): Promise<void> {
  await expect(page.getByTestId("canonical-workflow")).toHaveAttribute(
    "data-terminal-state",
    "completed",
    { timeout: 120_000 },
  );
}

async function assertCompletedReview(page: Page): Promise<void> {
  await expect(page.getByTestId("completed-turn-review")).toBeVisible();
  await expect(page.getByTestId("completed-turn-review")).toContainText(
    "README.md",
  );
}

async function assertNoCrossChatContent(
  page: Page,
  otherPrompt: string,
): Promise<void> {
  await expect(page.locator("body")).not.toContainText(otherPrompt);
}

async function startAndStop(page: Page): Promise<void> {
  await submit(page, STOP_PROMPT);
  await expect(page.getByTestId("canonical-workflow")).toBeVisible();
  await page.getByRole("button", { name: "Stop generation" }).click();
}
