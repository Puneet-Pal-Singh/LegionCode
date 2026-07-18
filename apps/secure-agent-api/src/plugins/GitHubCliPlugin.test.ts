import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { GitHubCliPlugin } from "./GitHubCliPlugin";
import { runSafeCommand } from "./security/SafeCommand";
import { pluginTestExecutionContext } from "./test-support/PluginExecutionContext";

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

describe("GitHubCliPlugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const execute = GitHubCliPlugin.prototype.execute;
    vi.spyOn(GitHubCliPlugin.prototype, "execute").mockImplementation(function (
      this: GitHubCliPlugin,
      sandbox,
      payload,
      onLog,
    ) {
      return execute.call(
        this,
        sandbox,
        payload,
        onLog,
        pluginTestExecutionContext(payload),
      );
    });
  });

  it("requires a GitHub token for github_cli actions", async () => {
    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "actions_run_get",
      owner: "acme",
      repo: "career-crew",
      actionsRunId: 123,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub token is required");
  });

  it("normalizes pull request checks through bounded gh api calls", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          head: { sha: "abc1234def5678" },
        }),
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              id: 9001,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              details_url: "https://example.com/check/9001",
              started_at: "2026-04-24T10:00:00Z",
              completed_at: "2026-04-24T10:02:00Z",
            },
          ],
        }),
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "pr_checks_get",
      owner: "acme",
      repo: "career-crew",
      number: 228,
      token: "ghp_test",
      runId: "run_gh_cli_checks_1",
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toMatchObject({
      pullRequestNumber: 228,
      headSha: "abc1234def5678",
      totalCount: 1,
      checkRuns: [
        expect.objectContaining({
          id: 9001,
          name: "lint",
          conclusion: "failure",
        }),
      ],
    });

    const secondCallArgs = (runSafeCommandMock.mock.calls[1]?.[1] as {
      args?: string[];
      env?: Record<string, string | undefined>;
    }).args;
    const thirdCallArgs = (runSafeCommandMock.mock.calls[2]?.[1] as {
      args?: string[];
      env?: Record<string, string | undefined>;
    }).args;
    const secondCallEnv = (runSafeCommandMock.mock.calls[1]?.[1] as {
      args?: string[];
      env?: Record<string, string | undefined>;
    }).env;
    expect(secondCallArgs).toContain("/repos/acme/career-crew/pulls/228");
    expect(thirdCallArgs).toContain(
      "/repos/acme/career-crew/commits/abc1234def5678/check-runs",
    );
    expect(secondCallArgs?.some((entry) => entry.includes("GH_TOKEN"))).toBe(false);
    expect(secondCallEnv?.GH_TOKEN).toBe("ghp_test");
  });

  it("returns trailing actions job logs with bounded tail lines", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "line-1\nline-2\nline-3\nline-4",
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "actions_job_logs_get",
      owner: "acme",
      repo: "career-crew",
      actionsJobId: 12345,
      tailLines: 2,
      token: "ghp_test",
      runId: "run_gh_cli_logs_1",
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toEqual({
      actionsJobId: 12345,
      tailLines: 2,
      totalLines: 4,
      truncated: true,
      logsTail: "line-3\nline-4",
      sourceTruncated: false,
    });
  });

  it("classifies 403 gh api failures as scope/permission boundaries", async () => {
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
        stderr: "HTTP 403: Resource not accessible by integration",
      } satisfies SafeCommandResult);

    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "actions_run_get",
      owner: "acme",
      repo: "career-crew",
      actionsRunId: 999,
      token: "ghp_test",
      runId: "run_gh_cli_scope_1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("insufficient token scope or permissions");
  });

  it("creates pull request comments through bounded gh api POST endpoint", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      } satisfies SafeCommandResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          id: 55,
          body: "Looks good to me.",
          html_url: "https://github.com/acme/career-crew/pull/228#issuecomment-55",
          created_at: "2026-04-24T12:00:00Z",
          updated_at: "2026-04-24T12:00:00Z",
          user: { login: "shadowbox-bot" },
        }),
        stderr: "",
      } satisfies SafeCommandResult);

    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "pr_comment",
      owner: "acme",
      repo: "career-crew",
      number: 228,
      body: "Looks good to me.",
      token: "ghp_test",
      ghCliPrCommentEnabled: true,
      runId: "run_gh_cli_comment_1",
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(String(result.output))).toMatchObject({
      pullRequestNumber: 228,
      commentId: 55,
      body: "Looks good to me.",
      author: "shadowbox-bot",
    });

    const secondCallArgs = (runSafeCommandMock.mock.calls[1]?.[1] as {
      args?: string[];
      env?: Record<string, string | undefined>;
    }).args;
    const secondCallEnv = (runSafeCommandMock.mock.calls[1]?.[1] as {
      args?: string[];
      env?: Record<string, string | undefined>;
    }).env;
    expect(secondCallArgs).toContain("POST");
    expect(secondCallArgs).toContain("/repos/acme/career-crew/issues/228/comments");
    expect(secondCallArgs).toContain("--raw-field");
    expect(secondCallArgs).toContain("body=Looks good to me.");
    expect(secondCallArgs?.some((entry) => entry.includes("GH_TOKEN"))).toBe(false);
    expect(secondCallEnv?.GH_TOKEN).toBe("ghp_test");
  });

  it("denies pr_comment when the mutation flag is disabled", async () => {
    const runSafeCommandMock = vi.mocked(runSafeCommand);
    runSafeCommandMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } satisfies SafeCommandResult);

    const plugin = new GitHubCliPlugin();
    const result = await plugin.execute(asSandbox(), {
      action: "pr_comment",
      owner: "acme",
      repo: "career-crew",
      number: 228,
      body: "Looks good to me.",
      token: "ghp_test",
      ghCliPrCommentEnabled: false,
      runId: "run_gh_cli_comment_2",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("GH_CLI_PR_COMMENT_ENABLED");
    expect(runSafeCommandMock).toHaveBeenCalledTimes(0);
  });
});
