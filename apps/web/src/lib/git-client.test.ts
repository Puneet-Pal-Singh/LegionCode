import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitGitChanges,
  getGitDiff,
  getGitStatus,
  stageGitFiles,
} from "./git-client.js";
import { _resetEndpointCache } from "./platform-endpoints.js";

const originalEnv = { ...import.meta.env };

function setEnv(key: string, value: string): void {
  (import.meta.env as unknown as Record<string, string>)[key] = value;
}

describe("git-client", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _resetEndpointCache();
    setEnv("VITE_BRAIN_BASE_URL", "https://brain.local");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.assign(import.meta.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("requests git diff through the canonical Brain endpoint", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          oldPath: "src/main.ts",
          newPath: "src/main.ts",
          hunks: [],
          isBinary: false,
          isNewFile: false,
          isDeleted: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await getGitDiff({
      runId: "run-123",
      sessionId: "session-123",
      path: "src/main.ts",
      staged: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://brain.local/api/git/diff?runId=run-123&path=src%2Fmain.ts&sessionId=session-123&staged=true",
    );
  });

  it("surfaces JSON error payloads for commit failures", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Not Found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      commitGitChanges({
        runId: "run-123",
        sessionId: "session-123",
        payload: { message: "feat: test", files: ["src/main.ts"] },
      }),
    ).rejects.toThrow("Not Found");
  });

  it("posts stage requests with the unified stage contract", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await stageGitFiles({
      runId: "run-123",
      sessionId: "session-123",
      files: ["src/main.ts"],
      unstage: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe("https://brain.local/api/git/stage");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      runId: "run-123",
      sessionId: "session-123",
      files: ["src/main.ts"],
      unstage: true,
    });
  });

  it("normalizes not-a-repository status into a recoverable response", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: "fatal: not a git repository",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      getGitStatus({
        runId: "run-123",
        sessionId: "session-123",
      }),
    ).resolves.toMatchObject({
      gitAvailable: false,
      recoverableCode: "NOT_A_GIT_REPOSITORY",
    });
  });

  it("fails fast on malformed git status payloads", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          branch: "main",
          gitAvailable: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      getGitStatus({
        runId: "run-123",
        sessionId: "session-123",
      }),
    ).rejects.toThrow("Invalid git status response");
  });

  it("validates commit request payloads before posting", async () => {
    await expect(
      commitGitChanges({
        runId: "",
        sessionId: "session-123",
        payload: { message: "feat: test", files: ["src/main.ts"] },
      }),
    ).rejects.toThrow();
  });

  it("validates commit files before posting", async () => {
    await expect(
      commitGitChanges({
        runId: "run-123",
        sessionId: "session-123",
        payload: { message: "feat: test", files: [] },
      }),
    ).rejects.toThrow();
  });
});
