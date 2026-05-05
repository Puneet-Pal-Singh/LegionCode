import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { GitPlugin } from "./GitPlugin";
import { runSafeCommand } from "./security/SafeCommand";

vi.mock("./security/SafeCommand", () => ({
  runSafeCommand: vi.fn(),
}));

interface SafeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function asSandbox(): Sandbox {
  return {} as Sandbox;
}

describe("GitPlugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses --cached when requesting staged diff content", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-console.log('old')\n+console.log('new')\n",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_diff",
      runId: "run_git_diff_1",
      path: "src/example.ts",
      staged: true,
    });

    expect(result.success).toBe(true);

    const diffCommandSpec = runSafeCommandMock.mock.calls[1]?.[1] as
      | { args?: string[] }
      | undefined;
    expect(diffCommandSpec?.args).toContain("--cached");
    expect(diffCommandSpec?.args).not.toContain("--staged");
  });

  it("materializes untracked file content as a new-file diff", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "src/new.ts\n",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "export const value = 1;\n",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_diff",
      runId: "run_git_diff_untracked",
      path: "src/new.ts",
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output)) as {
      isNewFile: boolean;
      hunks: Array<{
        lines: Array<{
          type: string;
          content: string;
          newLineNumber?: number;
        }>;
      }>;
    };
    expect(output.isNewFile).toBe(true);
    expect(output.hunks[0]?.lines).toEqual([
      {
        type: "added",
        content: "export const value = 1;",
        newLineNumber: 1,
      },
    ]);

    const diffCommandSpec = runSafeCommandMock.mock.calls[1]?.[1] as
      | { args?: string[] }
      | undefined;
    expect(diffCommandSpec?.args).toEqual(
      expect.arrayContaining(["diff", "--", "src/new.ts"]),
    );
  });

  it("hydrates commit identity from GitHub token when local identity is missing", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "not set",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "not set",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "commit ok",
        stderr: "",
      } satisfies SafeCommandResult);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42,
            login: "puneet",
            name: "Puneet Singh",
            email: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              email: "puneet@example.com",
              primary: true,
              verified: true,
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_1",
      message: "fix(runtime): hydrate commit identity from github profile",
      token: "ghp_test",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/emails",
      expect.any(Object),
    );
    expect(result.output).toEqual({
      content: "Changes committed",
      commitIdentity: {
        source: "github_profile",
        verified: true,
      },
    });

    const writeNameArgs = (runSafeCommandMock.mock.calls[3]?.[1] as {
      args?: string[];
    }).args;
    const writeEmailArgs = (runSafeCommandMock.mock.calls[4]?.[1] as {
      args?: string[];
    }).args;
    expect(writeNameArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Puneet Singh"]),
    );
    expect(writeEmailArgs).toEqual(
      expect.arrayContaining(["config", "user.email", "puneet@example.com"]),
    );
  });

  it("prefers OAuth identity over model-provided commit identity and stale git config", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Random User",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "random@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "commit ok",
        stderr: "",
      } satisfies SafeCommandResult);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 42,
            login: "puneet",
            name: "Puneet Singh",
            email: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              email: "puneet@example.com",
              primary: true,
              verified: true,
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_2",
      message: "feat: use oauth identity for commit",
      token: "ghp_test",
      authorName: "Shubh",
      authorEmail: "shubh@example.com",
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      content: "Changes committed",
      commitIdentity: {
        source: "github_profile",
        verified: true,
      },
    });
    const writeNameArgs = (runSafeCommandMock.mock.calls[3]?.[1] as {
      args?: string[];
    }).args;
    const writeEmailArgs = (runSafeCommandMock.mock.calls[4]?.[1] as {
      args?: string[];
    }).args;
    expect(writeNameArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Puneet Singh"]),
    );
    expect(writeEmailArgs).toEqual(
      expect.arrayContaining(["config", "user.email", "puneet@example.com"]),
    );
  });

  it("pushes HEAD to the requested remote branch ref", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_push",
      runId: "run_git_push_1",
      remote: "origin",
      branch: "style/redesign-footer",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Changes pushed");
    const pushArgs = (runSafeCommandMock.mock.calls[1]?.[1] as {
      args?: string[];
    }).args;
    expect(pushArgs).toEqual(
      expect.arrayContaining(["push", "-u", "origin", "HEAD:style/redesign-footer"]),
    );
  });

  it("surfaces commit failure from stdout when stderr is empty", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Puneet Singh",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "puneet@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "nothing to commit",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_fail_1",
      message: "feat: add coming soon indicator",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("nothing to commit");
  });

  it("rolls back user.name when writing user.email fails during identity hydration", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Existing User",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "existing@example.com",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "write failed",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "git_commit",
      runId: "run_git_commit_rollback_1",
      message: "fix: test rollback path",
      authorName: "OAuth User",
      authorEmail: "oauth@example.com",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Git commit author could not be written to this workspace before committing.",
    );
    const rollbackArgs = (runSafeCommandMock.mock.calls[5]?.[1] as {
      args?: string[];
    }).args;
    expect(rollbackArgs).toEqual(
      expect.arrayContaining(["config", "user.name", "Existing User"]),
    );
  });
});
