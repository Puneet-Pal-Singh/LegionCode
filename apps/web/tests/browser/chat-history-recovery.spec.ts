import { expect, test } from "@playwright/test";

const SESSION_ID = "session_history_fixture_600";
const SECOND_SESSION_ID = "session_history_fixture_scope_404";
const CHAT_TITLE = "Durable history fixture";
const LEGACY_IDLE_SESSION_ID = "session_legacy_idle_history";

test.describe("saved history recovery", () => {
  test("loads a cold-cache New Task / idle chat before choosing setup", async ({ page }) => {
    const executionWrites: string[] = [];
    let historyReads = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/(?:turn\/start|chat)(?:\?|$)/u.test(request.url())) {
        executionWrites.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.addInitScript(({ sessionId }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("legioncode:active-session-id:v4", sessionId);
      localStorage.setItem(`legioncode:session-context:${sessionId}`, JSON.stringify({
        repoOwner: "fixture-owner",
        repoName: "fixture-repo",
        fullName: "fixture-owner/fixture-repo",
        branch: "main",
      }));
    }, { sessionId: LEGACY_IDLE_SESSION_ID });

    await page.route("**/auth/session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { id: "user-fixture", login: "fixture", avatar: "", email: null, name: "Fixture" },
      }),
    }));
    await page.route("**/api/sessions", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [
        {
          id: LEGACY_IDLE_SESSION_ID,
          title: "New Task",
          titleSource: "default",
          repository: "fixture-owner/fixture-repo",
          activeRunId: null,
          mode: "build",
          status: "idle",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
      ] }),
    }));
    await page.route("**/turn/scope**", (route) => route.fulfill({ status: 404, body: "scope unavailable" }));
    await page.route("**/api/chat/history**", (route) => {
      historyReads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messages: [
            { id: "legacy-idle-user", role: "user", content: "Previously saved prompt", createdAt: "2026-10-02T00:00:00.000Z" },
            { id: "legacy-idle-assistant", role: "assistant", content: "Previously saved answer", createdAt: "2026-10-02T00:00:01.000Z" },
          ],
          nextCursor: null,
          snapshot: "2",
        }),
      });
    });

    await page.goto("/");
    await expect(page.getByTestId(`thread-${LEGACY_IDLE_SESSION_ID}`)).toBeVisible({ timeout: 5_000 });
    await expect.soft(page.getByText("Previously saved answer", { exact: true })).toBeVisible({ timeout: 5_000 });
    expect.soft(historyReads).toBeGreaterThan(0);
    expect.soft(executionWrites).toEqual([]);
  });

  test("reads a 600-message chat with no active run or recoverable turn scope", async ({ page }) => {
    const executionWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/(?:chat|execute)(?:\?|$)/u.test(request.url())) {
        executionWrites.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.addInitScript(({ sessionId }) => {
      if (window.name === "history-fixture-initialized") return;
      localStorage.setItem("legioncode:active-session-id:v4", sessionId);
      localStorage.setItem(`legioncode:session-context:${sessionId}`, JSON.stringify({
        repoOwner: "fixture-owner",
        repoName: "fixture-repo",
        fullName: "fixture-owner/fixture-repo",
        branch: "main",
      }));
      window.name = "history-fixture-initialized";
    }, { sessionId: SESSION_ID });

    await page.route("**/auth/session", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { id: "user-fixture", login: "fixture", avatar: "", email: null, name: "Fixture" },
      }),
    }));
    await page.route("**/api/sessions", (route) => {
      if (route.request().method() !== "GET") {
        executionWrites.push(`${route.request().method()} ${route.request().url()}`);
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [
          {
            id: SESSION_ID,
            title: CHAT_TITLE,
            titleSource: "user",
            repository: "fixture-owner/fixture-repo",
            activeRunId: null,
            mode: "build",
            status: "completed",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-03T00:00:00.000Z",
          },
          {
            id: SECOND_SESSION_ID,
            title: "Scope recovery fixture",
            titleSource: "user",
            repository: "fixture-owner/fixture-repo",
            activeRunId: "run_fixture123456",
            mode: "build",
            status: "completed",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
          },
        ] }),
      });
    });
    await page.route("**/turn/scope**", (route) => route.fulfill({ status: 404, body: "scope unavailable" }));
    await page.route("**/turn/start**", (route) => {
      executionWrites.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 500, body: "history reads must not bootstrap execution" });
    });
    await page.route("**/api/chat/history**", async (route) => {
      const url = new URL(route.request().url());
      const requestedSession = url.searchParams.get("session");
      expect([SESSION_ID, SECOND_SESSION_ID]).toContain(requestedSession);
      expect(url.searchParams.has("runId")).toBe(false);
      if (requestedSession === SECOND_SESSION_ID) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            messages: [{ id: "scope-fixture-message", role: "assistant", content: "History survives scope loss", createdAt: "2026-10-03T00:00:00.000Z" }],
            nextCursor: null,
            snapshot: "0",
          }),
        });
      }
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? Number(cursor) / 50 : 0;
      const messages = Array.from({ length: 50 }, (_, offset) => {
        const index = start * 50 + offset;
        return {
          id: `fixture-message-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: index === 599 ? "Saved assistant answer 599" : `Saved message ${index}`,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        };
      });
      const nextPage = start + 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messages,
          nextCursor: nextPage === 12 ? null : `${nextPage * 50}`,
          snapshot: "600",
        }),
      });
    });
    await page.goto("/");
    await expect(page.getByTestId(`thread-${SESSION_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Saved assistant answer 599", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-history-state")).toHaveCount(0);
    await page.getByTestId(`thread-${SECOND_SESSION_ID}`).click();
    await expect(page.getByText("History survives scope loss", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-history-state")).toHaveCount(0);
    await page.getByTestId(`thread-${SESSION_ID}`).click();
    await expect(page.getByText("Saved assistant answer 599", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByText("Saved assistant answer 599", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(executionWrites).toEqual([]);
  });
});
