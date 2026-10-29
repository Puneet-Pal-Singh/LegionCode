import { describe, expect, it } from "vitest";
import { APP_SERVER_PROTOCOL_VERSION, createAppServerClient } from "@legioncode/sdk";

function createClient(response: unknown, onRequest?: () => void) {
  return createAppServerClient({
    clientId: "web",
    clientVersion: "0.1.0",
    transport: {
      request: async () => {
        onRequest?.();
        return response as never;
      },
    },
  });
}

describe("hosted Git operations", () => {
  it("surfaces JSON error payloads for commit failures", async () => {
    const client = createClient({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "git/commit",
      ok: false,
      error: { code: "not_found", message: "Not Found" },
    });

    await expect(client.commitGitChanges({
      runId: "run-123",
      payload: { message: "feat: test", files: ["src/main.ts"] },
    })).rejects.toThrow("Not Found");
  });

  it("normalizes not-a-repository status into a recoverable response", async () => {
    const client = createClient({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "git/status",
      ok: true,
      result: {
        files: [],
        ahead: 0,
        behind: 0,
        branch: "",
        repoIdentity: null,
        commitIdentity: null,
        hasStaged: false,
        hasUnstaged: false,
        gitAvailable: false,
        recoverableCode: "NOT_A_GIT_REPOSITORY",
      },
    });

    await expect(client.getGitStatus({ runId: "run-123" })).resolves.toMatchObject({
      gitAvailable: false,
      recoverableCode: "NOT_A_GIT_REPOSITORY",
    });
  });

  it("fails fast on malformed git status payloads", async () => {
    const client = createClient({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "git/status",
      ok: true,
      result: { branch: "main", gitAvailable: true },
    });

    await expect(client.getGitStatus({ runId: "run-123" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("validates commit request payloads before posting", async () => {
    let calls = 0;
    const client = createClient({}, () => { calls += 1; });

    await expect(client.commitGitChanges({
      runId: "",
      payload: { message: "feat: test", files: ["src/main.ts"] },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("validates commit files before posting", async () => {
    let calls = 0;
    const client = createClient({}, () => { calls += 1; });

    await expect(client.commitGitChanges({
      runId: "run-123",
      payload: { message: "feat: test", files: [] },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
